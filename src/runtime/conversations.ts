/**
 * DB-backed conversation persistence + active-agent routing.
 *
 * Source of truth = the shared `conversations` table, keyed by the customer's
 * urn:mbid: in `customer_id` and the in-flight agent in `active_agent_id`
 * (both added by migrations/0003_messaging_backend.sql).
 *
 * Until 0003 is applied, every call degrades gracefully: persistence is skipped
 * and routing falls back to an in-memory map, with a single warning. Nothing
 * here ever throws into the request path.
 */
import { supabase } from '../supabase.js';
import type { HistoryTurn } from '../llm/reply.js';
import { returnActiveHandoffsToAgent, type HandoffStatus } from './handoff.js';

const memRouting = new Map<string, string>();
let schemaReady: boolean | null = null;
let warned = false;

/** True once 0003 columns exist; cached after first probe. */
async function ready(): Promise<boolean> {
  if (schemaReady !== null) return schemaReady;
  const { error } = await supabase.from('conversations').select('customer_id').limit(1);
  schemaReady = !error;
  if (!schemaReady && !warned) {
    warned = true;
    console.warn(
      '[conversations] migrations/0003 not applied (customer_id missing) — ' +
        'using in-memory routing + skipping persistence. Apply 0003 to enable.',
    );
  }
  return schemaReady;
}

export interface ConversationState {
  id: string | null; // null when persistence unavailable
  messages: HistoryTurn[];
  activeAgentId: string | null;
  customerName: string | null;
  status: 'Open' | 'Needs Human' | 'Resolved' | null;
  mspConversationId: string | null;
  activeHandoffStatus: HandoffStatus | null;
}

function rowsToHistory(messages: any): HistoryTurn[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.text === 'string')
    .map((m) => ({
      role: m.role === 'customer' ? 'customer' : 'agent',
      text: m.text,
      ...(typeof m.kind === 'string' ? { kind: m.kind } : {}),
      ...(m.attachments ? { attachments: m.attachments } : {}),
      ...(m.interactive ? { interactive: m.interactive } : {}),
      ...(m.tapbacks ? { tapbacks: m.tapbacks } : {}),
      ...(m.richLink ? { richLink: m.richLink } : {}),
      ...(m.payload ? { payload: m.payload } : {}),
    }));
}

function publicTurn(turn: HistoryTurn): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    role: turn.role,
    text: turn.text,
    timestamp: new Date().toISOString(),
    ...(turn.kind ? { kind: turn.kind } : {}),
    ...(turn.attachments ? { attachments: turn.attachments } : {}),
    ...(turn.interactive ? { interactive: turn.interactive } : {}),
    ...(turn.tapbacks ? { tapbacks: turn.tapbacks } : {}),
    ...(turn.richLink ? { richLink: turn.richLink } : {}),
    ...(turn.payload ? { payload: turn.payload } : {}),
  };
}

/** Set the agent this customer's thread is testing. */
export async function setActiveAgent(customerId: string, agentId: string): Promise<string | null> {
  memRouting.set(customerId, agentId);
  if (!(await ready())) return null;
  try {
    const { data, error } = await supabase.rpc('upsert_conversation_active_agent', {
      p_customer_id: customerId,
      p_agent_id: agentId,
    });
    if (error) throw error;
    if (typeof data === 'string') await returnActiveHandoffsToAgent(data);
    return typeof data === 'string' ? data : null;
  } catch (err) {
    console.warn('[conversations] setActiveAgent atomic upsert failed:', err);
    return null;
  }
}

/** Load the current conversation state for a customer (history + active agent). */
export async function loadState(
  customerId: string,
  mspConversationId?: string | null,
): Promise<ConversationState> {
  const memAgent = memRouting.get(customerId) ?? null;
  if (!(await ready())) {
    return {
      id: null,
      messages: [],
      activeAgentId: memAgent,
      customerName: null,
      status: null,
      mspConversationId: mspConversationId ?? null,
      activeHandoffStatus: null,
    };
  }
  try {
    const { data } = await supabase
      .from('conversations')
      .select('id, messages, active_agent_id, customer_name, status')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!data) {
      return {
        id: null,
        messages: [],
        activeAgentId: memAgent,
        customerName: null,
        status: null,
        mspConversationId: mspConversationId ?? null,
        activeHandoffStatus: null,
      };
    }
    if (mspConversationId) {
      await persistMspConversationId(data.id, mspConversationId);
    }
    return {
      id: data.id,
      messages: rowsToHistory(data.messages),
      activeAgentId: data.active_agent_id ?? memAgent,
      customerName: data.customer_name ?? null,
      status: data.status ?? null,
      mspConversationId: mspConversationId ?? null,
      activeHandoffStatus: await loadActiveHandoffStatus(data.id),
    };
  } catch (err) {
    console.warn('[conversations] loadState failed:', err);
    return {
      id: null,
      messages: [],
      activeAgentId: memAgent,
      customerName: null,
      status: null,
      mspConversationId: mspConversationId ?? null,
      activeHandoffStatus: null,
    };
  }
}

/** Append a turn to the conversation, updating last_message + status. */
export async function appendTurn(
  conversationId: string | null,
  turn: HistoryTurn,
  status?: 'Open' | 'Needs Human' | 'Resolved',
): Promise<void> {
  if (!conversationId || !(await ready())) return;
  try {
    const { data } = await supabase
      .from('conversations')
      .select('messages')
      .eq('id', conversationId)
      .maybeSingle();
    const messages = Array.isArray(data?.messages) ? data!.messages : [];
    messages.push(publicTurn(turn));
    await supabase
      .from('conversations')
      .update({
        messages,
        last_message: turn.text,
        timestamp: new Date().toISOString(),
        ...(status ? { status } : {}),
      })
      .eq('id', conversationId);
  } catch (err) {
    console.warn('[conversations] appendTurn failed:', err);
  }
}

async function persistMspConversationId(
  conversationId: string,
  mspConversationId: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('conversations')
      .update({ msp_conversation_id: mspConversationId })
      .eq('id', conversationId);
    if (error) throw error;
  } catch (err) {
    console.warn('[conversations] msp_conversation_id persist skipped:', err);
  }
}

async function loadActiveHandoffStatus(conversationId: string): Promise<HandoffStatus | null> {
  try {
    const { data, error } = await supabase
      .from('handoff_sessions')
      .select('status')
      .eq('conversation_id', conversationId)
      .in('status', ['handoff_requested', 'queued', 'assigned', 'human_active', 'bot_paused'])
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data?.status as HandoffStatus | undefined) ?? null;
  } catch {
    return null;
  }
}
