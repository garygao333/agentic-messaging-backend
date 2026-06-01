import { supabase } from '../supabase.js';

export type HandoffStatus =
  | 'handoff_requested'
  | 'queued'
  | 'assigned'
  | 'human_active'
  | 'bot_paused'
  | 'resolved'
  | 'returned_to_agent'
  | 'closed';

export type HandoffPriority = 'low' | 'normal' | 'high' | 'urgent';

const ACTIVE_HANDOFF_STATUSES: HandoffStatus[] = [
  'handoff_requested',
  'queued',
  'assigned',
  'human_active',
  'bot_paused',
];

let warnedEvents = false;
let warnedHandoffs = false;

export interface RuntimeEventInput {
  conversationId: string | null;
  agentId?: string | null;
  customerId?: string | null;
  mspConversationId?: string | null;
  eventType: string;
  actor?: 'customer' | 'agent' | 'operator' | 'system' | 'msp';
  body?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export interface HandoffSession {
  id: string;
  status: HandoffStatus;
}

export interface CreateHandoffSessionInput {
  conversationId: string | null;
  agentId: string | null;
  customerId: string;
  mspConversationId: string | null;
  trigger: string;
  reason: string;
  priority?: HandoffPriority;
  summary?: string | null;
  suggestedReply?: string | null;
}

export interface UpdateHandoffSessionInput {
  status?: HandoffStatus;
  reason?: string | null;
  priority?: HandoffPriority;
  summary?: string | null;
  suggestedReply?: string | null;
  assignedTeam?: string | null;
  assignedOperator?: string | null;
  assignedAt?: string | null;
  resolvedAt?: string | null;
  returnedToAgentAt?: string | null;
  lastError?: string | null;
}

export function isActiveHandoffStatus(status: string | null | undefined): boolean {
  return ACTIVE_HANDOFF_STATUSES.includes(status as HandoffStatus);
}

export async function logConversationEvent(input: RuntimeEventInput): Promise<void> {
  try {
    const { error } = await supabase.from('conversation_events').insert({
      conversation_id: input.conversationId,
      agent_id: input.agentId ?? null,
      customer_id: input.customerId ?? null,
      msp_conversation_id: input.mspConversationId ?? null,
      event_type: input.eventType,
      actor: input.actor ?? 'system',
      body: input.body ?? null,
      payload: input.payload ?? {},
      idempotency_key: input.idempotencyKey ?? null,
    });
    if (error) throw error;
  } catch (err) {
    if (!warnedEvents) {
      warnedEvents = true;
      console.warn('[handoff] conversation_events write skipped:', err);
    }
  }
}

export async function createHandoffSession(
  input: CreateHandoffSessionInput,
): Promise<HandoffSession | null> {
  if (!input.conversationId) return null;

  const row = {
    conversation_id: input.conversationId,
    agent_id: input.agentId,
    customer_id: input.customerId,
    msp_conversation_id: input.mspConversationId,
    trigger: input.trigger,
    reason: input.reason,
    priority: input.priority ?? 'normal',
    status: 'handoff_requested' satisfies HandoffStatus,
    summary: input.summary ?? null,
    suggested_reply: input.suggestedReply ?? null,
    updated_at: new Date().toISOString(),
  };

  try {
    const existing = await findActiveHandoff(input.conversationId);
    if (existing) {
      const { error } = await supabase
        .from('handoff_sessions')
        .update({
          reason: input.reason,
          priority: input.priority ?? 'normal',
          summary: input.summary ?? null,
          suggested_reply: input.suggestedReply ?? null,
          msp_conversation_id: input.mspConversationId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      if (error) throw error;
      return existing;
    }

    const { data, error } = await supabase
      .from('handoff_sessions')
      .insert(row)
      .select('id, status')
      .single();
    if (error) throw error;
    return data as HandoffSession;
  } catch (err) {
    const existing = await findActiveHandoff(input.conversationId).catch(() => null);
    if (existing) return existing;
    if (!warnedHandoffs) {
      warnedHandoffs = true;
      console.warn('[handoff] handoff_sessions write skipped:', err);
    }
    return null;
  }
}

export async function updateHandoffSession(
  sessionId: string | null,
  patch: UpdateHandoffSessionInput,
): Promise<void> {
  if (!sessionId) return;
  try {
    const row: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.reason !== undefined) row.reason = patch.reason;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.summary !== undefined) row.summary = patch.summary;
    if (patch.suggestedReply !== undefined) row.suggested_reply = patch.suggestedReply;
    if (patch.assignedTeam !== undefined) row.assigned_team = patch.assignedTeam;
    if (patch.assignedOperator !== undefined) row.assigned_operator = patch.assignedOperator;
    if (patch.assignedAt !== undefined) row.assigned_at = patch.assignedAt;
    if (patch.resolvedAt !== undefined) row.resolved_at = patch.resolvedAt;
    if (patch.returnedToAgentAt !== undefined) row.returned_to_agent_at = patch.returnedToAgentAt;
    if (patch.lastError !== undefined) row.last_error = patch.lastError;

    const { error } = await supabase.from('handoff_sessions').update(row).eq('id', sessionId);
    if (error) throw error;
  } catch (err) {
    if (!warnedHandoffs) {
      warnedHandoffs = true;
      console.warn('[handoff] handoff_sessions update skipped:', err);
    }
  }
}

export async function returnActiveHandoffsToAgent(conversationId: string | null): Promise<void> {
  if (!conversationId) return;
  const now = new Date().toISOString();
  try {
    const { error } = await supabase
      .from('handoff_sessions')
      .update({
        status: 'returned_to_agent' satisfies HandoffStatus,
        returned_to_agent_at: now,
        updated_at: now,
      })
      .eq('conversation_id', conversationId)
      .in('status', ACTIVE_HANDOFF_STATUSES);
    if (error) throw error;
  } catch (err) {
    if (!warnedHandoffs) {
      warnedHandoffs = true;
      console.warn('[handoff] return-to-agent update skipped:', err);
    }
  }
}

async function findActiveHandoff(conversationId: string): Promise<HandoffSession | null> {
  const { data, error } = await supabase
    .from('handoff_sessions')
    .select('id, status')
    .eq('conversation_id', conversationId)
    .in('status', ACTIVE_HANDOFF_STATUSES)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as HandoffSession | null) ?? null;
}
