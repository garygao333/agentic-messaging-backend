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
}

function rowsToHistory(messages: any): HistoryTurn[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.text === 'string')
    .map((m) => ({ role: m.role === 'customer' ? 'customer' : 'agent', text: m.text }));
}

/** Set the agent this customer's thread is testing. */
export async function setActiveAgent(customerId: string, agentId: string): Promise<void> {
  memRouting.set(customerId, agentId);
  if (!(await ready())) return;
  try {
    const { data } = await supabase
      .from('conversations')
      .select('id')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (data?.id) {
      await supabase
        .from('conversations')
        .update({ active_agent_id: agentId, agent_id: agentId })
        .eq('id', data.id);
    } else {
      await supabase.from('conversations').insert({
        agent_id: agentId,
        active_agent_id: agentId,
        customer_id: customerId,
        customer_name: 'Apple Customer',
        status: 'Open',
        messages: [],
      });
    }
  } catch (err) {
    console.warn('[conversations] setActiveAgent persist failed:', err);
  }
}

/** Load the current conversation state for a customer (history + active agent). */
export async function loadState(customerId: string): Promise<ConversationState> {
  const memAgent = memRouting.get(customerId) ?? null;
  if (!(await ready())) return { id: null, messages: [], activeAgentId: memAgent };
  try {
    const { data } = await supabase
      .from('conversations')
      .select('id, messages, active_agent_id')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!data) return { id: null, messages: [], activeAgentId: memAgent };
    return {
      id: data.id,
      messages: rowsToHistory(data.messages),
      activeAgentId: data.active_agent_id ?? memAgent,
    };
  } catch (err) {
    console.warn('[conversations] loadState failed:', err);
    return { id: null, messages: [], activeAgentId: memAgent };
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
    messages.push({
      id: crypto.randomUUID(),
      role: turn.role,
      text: turn.text,
      timestamp: new Date().toISOString(),
    });
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
