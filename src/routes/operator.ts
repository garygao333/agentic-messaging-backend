import { Hono } from 'hono';
import { requireAppAuth } from '../auth.js';
import { sendText } from '../msp/send.js';
import { appendTurn } from '../runtime/conversations.js';
import { supabase } from '../supabase.js';

export const operator = new Hono();

operator.use('/operator/*', requireAppAuth);

const ACTIVE_HANDOFF_STATUSES = [
  'handoff_requested',
  'queued',
  'assigned',
  'human_active',
  'bot_paused',
];
const HANDOFF_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const CONVERSATION_SELECT_FULL =
  'id, agent_id, active_agent_id, customer_id, msp_conversation_id, customer_name, last_message, status, timestamp, messages';
const CONVERSATION_SELECT_BASE = 'id, agent_id, customer_name, last_message, status, timestamp, messages';
const AGENT_SELECT =
  'id, name, company_name, website, business_type, use_case, integrations, prompt, guardrails, handoff_destination, test_users, status, created_at, updated_at, last_deployed_at';
const HANDOFF_SELECT =
  'id, conversation_id, agent_id, customer_id, msp_conversation_id, trigger, reason, priority, status, summary, suggested_reply, assigned_team, assigned_operator, sla_deadline, requested_at, assigned_at, resolved_at, returned_to_agent_at, last_error, created_at, updated_at';
const APPOINTMENT_SELECT =
  'id, conversation_id, agent_id, customer_id, customer_name, service_identifier, service_title, service_subtitle, slot_identifier, starts_at, duration_seconds, location_title, status, payment_status, payment_amount, payment_currency, patient_details, extraction, created_at, updated_at';

const warned = new Set<string>();

function warnOnce(key: string, err: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[operator] ${key} unavailable; returning fallback:`, err);
}

function limitFromQuery(raw: string | undefined, fallback = 50): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function operatorIdFromBody(body: any): string {
  return (
    cleanText(body?.operatorId) ??
    cleanText(body?.assignedOperator) ??
    cleanText(body?.operatorName) ??
    'operator'
  );
}

function operatorNameFromBody(body: any): string | null {
  return cleanText(body?.operatorName) ?? cleanText(body?.assignedOperator);
}

function noteFromBody(body: any): string | null {
  return cleanText(body?.note) ?? cleanText(body?.reason);
}

function priorityFromBody(body: any): string {
  const priority = cleanText(body?.priority);
  return priority && HANDOFF_PRIORITIES.includes(priority) ? priority : 'normal';
}

function textArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function includesQuery(row: any, q: string): boolean {
  const needle = q.toLowerCase();
  return [
    row.customer_name,
    row.last_message,
    row.customer_id,
    row.msp_conversation_id,
    row.status,
  ].some((value) => String(value ?? '').toLowerCase().includes(needle));
}

function mapConversation(row: any) {
  return {
    id: row.id,
    agentId: row.agent_id,
    activeAgentId: row.active_agent_id ?? row.agent_id ?? null,
    customerId: row.customer_id ?? null,
    mspConversationId: row.msp_conversation_id ?? null,
    customerName: row.customer_name ?? 'Apple Customer',
    lastMessage: row.last_message ?? '',
    status: row.status ?? 'Open',
    timestamp: row.timestamp ?? null,
    messages: Array.isArray(row.messages) ? row.messages : [],
  };
}

function mapAgent(row: any) {
  return {
    id: row.id,
    name: row.name ?? 'Untitled Agent',
    companyName: row.company_name ?? '',
    website: row.website ?? '',
    businessType: row.business_type ?? '',
    useCase: row.use_case ?? '',
    integrations: Array.isArray(row.integrations) ? row.integrations : ['None'],
    prompt: row.prompt ?? '',
    guardrails: row.guardrails ?? '',
    handoffDestination: row.handoff_destination ?? '',
    testUsers: Array.isArray(row.test_users) ? row.test_users : [],
    status: row.status ?? 'Draft',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    lastDeployedAt: row.last_deployed_at ?? null,
  };
}

function mapHandoff(row: any) {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? null,
    agentId: row.agent_id ?? null,
    customerId: row.customer_id ?? null,
    mspConversationId: row.msp_conversation_id ?? null,
    trigger: row.trigger ?? null,
    reason: row.reason ?? null,
    priority: row.priority ?? 'normal',
    status: row.status ?? 'handoff_requested',
    summary: row.summary ?? null,
    suggestedReply: row.suggested_reply ?? null,
    assignedTeam: row.assigned_team ?? null,
    assignedOperator: row.assigned_operator ?? null,
    slaDeadline: row.sla_deadline ?? null,
    requestedAt: row.requested_at ?? null,
    assignedAt: row.assigned_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    returnedToAgentAt: row.returned_to_agent_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function mapCustomerProfile(row: any) {
  return {
    id: row.id ?? row.customer_id,
    customerId: row.customer_id,
    displayName: row.display_name ?? row.phone ?? row.apple_id ?? 'Apple Customer',
    appleId: row.apple_id ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    trustLevel: row.trust_level ?? 'standard',
    safetyNotes: row.safety_notes ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    attributes:
      row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
        ? row.attributes
        : {},
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function mapAppointment(row: any) {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? null,
    agentId: row.agent_id ?? null,
    customerId: row.customer_id ?? null,
    customerName: row.customer_name ?? 'Apple Customer',
    serviceIdentifier: row.service_identifier ?? null,
    serviceTitle: row.service_title ?? null,
    serviceSubtitle: row.service_subtitle ?? null,
    slotIdentifier: row.slot_identifier ?? null,
    startsAt: row.starts_at ?? null,
    durationSeconds: row.duration_seconds ?? null,
    locationTitle: row.location_title ?? null,
    status: row.status ?? 'collecting',
    paymentStatus: row.payment_status ?? 'not_required',
    paymentAmount: row.payment_amount ?? null,
    paymentCurrency: row.payment_currency ?? 'USD',
    patientDetails:
      row.patient_details && typeof row.patient_details === 'object' && !Array.isArray(row.patient_details)
        ? row.patient_details
        : {},
    extraction:
      row.extraction && typeof row.extraction === 'object' && !Array.isArray(row.extraction)
        ? row.extraction
        : {},
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function normalizeLookup(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function selectedInteractiveItem(messages: any[], interactiveKind: string) {
  const promptIndex = messages.findIndex((message: any) => message?.kind === interactiveKind);
  if (promptIndex === -1) return null;

  const prompt = messages[promptIndex];
  const items = Array.isArray(prompt?.interactive?.items) ? prompt.interactive.items : [];
  const customerTurns = messages.slice(promptIndex + 1).filter((message: any) => message?.role === 'customer');

  for (const turn of customerTurns) {
    const text = normalizeLookup(turn?.text);
    if (!text) continue;
    const match = items.find((item: any) => {
      const id = normalizeLookup(item?.id ?? item?.identifier);
      const title = normalizeLookup(item?.title);
      return text === id || text === title || text.includes(title) || title.includes(text);
    });
    if (match) return match;
  }

  return null;
}

function derivedAppointmentFromConversation(row: any) {
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const serviceTurn = messages.find((message: any) => message?.kind === 'list_picker');
  const timeTurn = messages.find((message: any) => message?.kind === 'time_picker');
  const paymentTurn = messages.find((message: any) => message?.kind === 'apple_pay');
  if (!serviceTurn && !timeTurn && !paymentTurn) return null;

  const selectedService = selectedInteractiveItem(messages, 'list_picker');
  const selectedSlot = selectedInteractiveItem(messages, 'time_picker');
  const selectedSlotPayload = selectedSlot
    ? timeTurn?.payload?.event?.timeslots?.find((slot: any) => slot?.identifier === selectedSlot.id)
    : null;
  return {
    id: `derived_${row.id}`,
    conversation_id: row.id,
    agent_id: row.active_agent_id ?? row.agent_id,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? 'Apple Customer',
    service_identifier: selectedService?.id ?? null,
    service_title: selectedService?.title ?? null,
    service_subtitle: selectedService?.subtitle ?? null,
    slot_identifier: selectedSlot?.id ?? null,
    starts_at: selectedSlotPayload?.startTime ?? null,
    duration_seconds: selectedSlotPayload?.duration ?? null,
    location_title: timeTurn?.payload?.event?.location?.title ?? null,
    status: paymentTurn ? 'payment_requested' : selectedSlot ? 'scheduled' : 'collecting',
    payment_status: paymentTurn?.payload?.liveApplePayConfigured ? 'requested' : paymentTurn ? 'preview_only' : 'not_required',
    payment_amount: paymentTurn?.payload?.paymentPreview?.amount ?? null,
    payment_currency: paymentTurn?.payload?.paymentPreview?.currencyCode ?? 'USD',
    patient_details: {},
    extraction: { source: 'conversation_fallback' },
    created_at: row.timestamp ?? null,
    updated_at: row.timestamp ?? null,
  };
}

const DEFAULT_TRUST_SETTINGS = {
  id: null as string | null,
  agentId: null as string | null,
  aiRepliesEnabled: true,
  autoHandoffEnabled: true,
  highRiskAutoPause: true,
  requireHumanOnLowConfidence: false,
  requireHumanOnSensitiveTopics: true,
  moderationMode: 'balanced',
  blockedTerms: [] as string[],
  escalationKeywords: [] as string[],
  sensitiveTopics: [] as string[],
  businessHours: {} as Record<string, unknown>,
  updatedBy: null as string | null,
  createdAt: null as string | null,
  updatedAt: null as string | null,
};

function mapTrustSettings(row: any, requestedAgentId: string | null) {
  if (!row) return { ...DEFAULT_TRUST_SETTINGS, agentId: requestedAgentId };
  return {
    id: row.id ?? null,
    agentId: row.agent_id ?? requestedAgentId,
    aiRepliesEnabled: row.ai_replies_enabled ?? DEFAULT_TRUST_SETTINGS.aiRepliesEnabled,
    autoHandoffEnabled: row.auto_handoff_enabled ?? DEFAULT_TRUST_SETTINGS.autoHandoffEnabled,
    highRiskAutoPause: row.high_risk_auto_pause ?? DEFAULT_TRUST_SETTINGS.highRiskAutoPause,
    requireHumanOnLowConfidence:
      row.require_human_on_low_confidence ?? DEFAULT_TRUST_SETTINGS.requireHumanOnLowConfidence,
    requireHumanOnSensitiveTopics:
      row.require_human_on_sensitive_topics ?? DEFAULT_TRUST_SETTINGS.requireHumanOnSensitiveTopics,
    moderationMode: row.moderation_mode ?? DEFAULT_TRUST_SETTINGS.moderationMode,
    blockedTerms: Array.isArray(row.blocked_terms) ? row.blocked_terms : [],
    escalationKeywords: Array.isArray(row.escalation_keywords) ? row.escalation_keywords : [],
    sensitiveTopics: Array.isArray(row.sensitive_topics) ? row.sensitive_topics : [],
    businessHours:
      row.business_hours && typeof row.business_hours === 'object' && !Array.isArray(row.business_hours)
        ? row.business_hours
        : {},
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function trustPatchFromBody(body: any): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const bools: Array<[string, string]> = [
    ['aiRepliesEnabled', 'ai_replies_enabled'],
    ['autoHandoffEnabled', 'auto_handoff_enabled'],
    ['highRiskAutoPause', 'high_risk_auto_pause'],
    ['requireHumanOnLowConfidence', 'require_human_on_low_confidence'],
    ['requireHumanOnSensitiveTopics', 'require_human_on_sensitive_topics'],
  ];

  for (const [camel, snake] of bools) {
    if (typeof body?.[camel] === 'boolean') patch[snake] = body[camel];
  }

  if (['off', 'light', 'balanced', 'strict'].includes(body?.moderationMode)) {
    patch.moderation_mode = body.moderationMode;
  }

  const blockedTerms = textArray(body?.blockedTerms);
  if (blockedTerms) patch.blocked_terms = blockedTerms;
  const escalationKeywords = textArray(body?.escalationKeywords);
  if (escalationKeywords) patch.escalation_keywords = escalationKeywords;
  const sensitiveTopics = textArray(body?.sensitiveTopics);
  if (sensitiveTopics) patch.sensitive_topics = sensitiveTopics;

  if (
    body?.businessHours &&
    typeof body.businessHours === 'object' &&
    !Array.isArray(body.businessHours)
  ) {
    patch.business_hours = body.businessHours;
  }

  const updatedBy = cleanText(body?.updatedBy);
  if (updatedBy) patch.updated_by = updatedBy;

  return patch;
}

async function fetchConversations(params: {
  agentId: string | null;
  status: string | null;
  q: string | null;
  limit: number;
}) {
  const fetchLimit = params.q ? Math.min(params.limit * 5, 200) : params.limit;

  async function run(select: string) {
    let query = supabase
      .from('conversations')
      .select(select)
      .order('timestamp', { ascending: false })
      .limit(fetchLimit);
    if (params.agentId) query = query.eq('agent_id', params.agentId);
    if (params.status) query = query.eq('status', params.status);
    return query;
  }

  const full = await run(CONVERSATION_SELECT_FULL);
  if (!full.error) return (full.data ?? []).filter((r) => !params.q || includesQuery(r, params.q)).slice(0, params.limit);

  const base = await run(CONVERSATION_SELECT_BASE);
  if (base.error) {
    warnOnce('conversations list', base.error);
    return [];
  }
  return (base.data ?? []).filter((r) => !params.q || includesQuery(r, params.q)).slice(0, params.limit);
}

async function fetchConversation(id: string): Promise<any | null> {
  const full = await supabase
    .from('conversations')
    .select(CONVERSATION_SELECT_FULL)
    .eq('id', id)
    .maybeSingle();
  if (!full.error) return full.data;

  const base = await supabase
    .from('conversations')
    .select(CONVERSATION_SELECT_BASE)
    .eq('id', id)
    .maybeSingle();
  if (base.error) {
    warnOnce('conversation detail', base.error);
    return null;
  }
  return base.data;
}

async function fetchHandoff(id: string) {
  const { data, error } = await supabase
    .from('handoff_sessions')
    .select(HANDOFF_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    warnOnce('handoff detail', error);
    return null;
  }
  return data;
}

async function fetchActiveHandoffForConversation(conversationId: string | null) {
  if (!conversationId) return null;
  const { data, error } = await supabase
    .from('handoff_sessions')
    .select(HANDOFF_SELECT)
    .eq('conversation_id', conversationId)
    .in('status', ACTIVE_HANDOFF_STATUSES)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    warnOnce('active handoff detail', error);
    return null;
  }
  return data;
}

async function addHandoffNote(input: {
  handoffId: string;
  conversationId: string | null;
  operatorId: string | null;
  note: string | null;
}) {
  if (!input.note) return;
  const { error } = await supabase.from('handoff_notes').insert({
    handoff_session_id: input.handoffId,
    conversation_id: input.conversationId,
    author_type: 'operator',
    author_id: input.operatorId,
    body: input.note,
  });
  if (error) warnOnce('handoff notes', error);
}

async function addHandoffAudit(input: {
  handoffId: string;
  conversationId: string | null;
  operatorId: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
}) {
  const { error } = await supabase.from('handoff_audit_events').insert({
    handoff_session_id: input.handoffId,
    conversation_id: input.conversationId,
    actor_type: 'operator',
    actor_id: input.operatorId,
    action: input.action,
    from_status: input.fromStatus,
    to_status: input.toStatus,
    note: input.note,
  });
  if (error) warnOnce('handoff audit', error);
}

async function addConversationEvent(input: {
  conversationId: string | null;
  agentId: string | null;
  customerId: string | null;
  mspConversationId: string | null;
  operatorId: string | null;
  action: string;
  note: string | null;
  handoffId: string | null;
}) {
  const { error } = await supabase.from('conversation_events').insert({
    conversation_id: input.conversationId,
    agent_id: input.agentId,
    customer_id: input.customerId,
    msp_conversation_id: input.mspConversationId,
    event_type: input.action,
    actor: 'operator',
    body: input.note,
    payload: {
      ...(input.handoffId ? { handoffSessionId: input.handoffId } : {}),
      operatorId: input.operatorId,
    },
  });
  if (error) warnOnce('conversation events', error);
}

async function setConversationStatus(conversationId: string | null, status: 'Open' | 'Needs Human' | 'Resolved') {
  if (!conversationId) return;
  const { error } = await supabase
    .from('conversations')
    .update({ status, timestamp: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) warnOnce('conversation status update', error);
}

async function refreshConversation(fallback: any) {
  return (fallback?.id ? await fetchConversation(fallback.id) : null) ?? fallback;
}

async function setConversationHandoffState(
  conversation: any,
  body: any,
  input: {
    toStatus: 'bot_paused' | 'human_active';
    action: string;
    conversationStatus: 'Needs Human';
    defaultReason: string;
  },
): Promise<{ handoff: any | null; error?: 'handoff unavailable' }> {
  const operatorId = operatorIdFromBody(body);
  const note = noteFromBody(body);
  const now = new Date().toISOString();
  const existing = await fetchActiveHandoffForConversation(conversation.id);
  const assignedOperator = cleanText(body?.assignedOperator) ?? operatorId;
  const patch: Record<string, unknown> = {
    status: input.toStatus,
    reason: note ?? input.defaultReason,
    priority: priorityFromBody(body),
    assigned_team: cleanText(body?.team) ?? cleanText(body?.assignedTeam),
    assigned_operator: assignedOperator,
    updated_at: now,
  };
  if (input.toStatus === 'human_active') patch.assigned_at = existing?.assigned_at ?? now;

  const result = existing
    ? await supabase
        .from('handoff_sessions')
        .update(patch)
        .eq('id', existing.id)
        .select(HANDOFF_SELECT)
        .single()
    : await supabase
        .from('handoff_sessions')
        .insert({
          conversation_id: conversation.id,
          agent_id: conversation.active_agent_id ?? conversation.agent_id ?? null,
          customer_id: conversation.customer_id ?? null,
          msp_conversation_id: conversation.msp_conversation_id ?? null,
          trigger: input.action,
          summary: cleanText(body?.summary),
          suggested_reply: cleanText(body?.suggestedReply),
          ...patch,
        })
        .select(HANDOFF_SELECT)
        .single();

  if (result.error) {
    warnOnce(input.action, result.error);
    return { handoff: null, error: 'handoff unavailable' };
  }

  await setConversationStatus(conversation.id, input.conversationStatus);
  await addHandoffNote({
    handoffId: result.data.id,
    conversationId: conversation.id,
    operatorId,
    note,
  });
  await addHandoffAudit({
    handoffId: result.data.id,
    conversationId: conversation.id,
    operatorId,
    action: input.action,
    fromStatus: existing?.status ?? null,
    toStatus: input.toStatus,
    note,
  });
  await addConversationEvent({
    conversationId: conversation.id,
    agentId: conversation.active_agent_id ?? conversation.agent_id ?? null,
    customerId: conversation.customer_id ?? null,
    mspConversationId: conversation.msp_conversation_id ?? null,
    operatorId,
    action: input.action,
    note,
    handoffId: result.data.id,
  });

  return { handoff: result.data };
}

async function returnConversationToAgent(
  conversation: any,
  body: any,
): Promise<{ handoff: any | null; error?: 'handoff unavailable' }> {
  const operatorId = operatorIdFromBody(body);
  const note = noteFromBody(body);
  const now = new Date().toISOString();
  const existing = await fetchActiveHandoffForConversation(conversation.id);
  let handoff = null;

  if (existing) {
    const { data, error } = await supabase
      .from('handoff_sessions')
      .update({
        status: 'returned_to_agent',
        returned_to_agent_at: now,
        updated_at: now,
      })
      .eq('id', existing.id)
      .select(HANDOFF_SELECT)
      .single();
    if (error) {
      warnOnce('conversation resume', error);
      return { handoff: null, error: 'handoff unavailable' };
    }
    handoff = data;
    await addHandoffNote({
      handoffId: existing.id,
      conversationId: conversation.id,
      operatorId,
      note,
    });
    await addHandoffAudit({
      handoffId: existing.id,
      conversationId: conversation.id,
      operatorId,
      action: 'conversation_resumed',
      fromStatus: existing.status ?? null,
      toStatus: 'returned_to_agent',
      note,
    });
  }

  await setConversationStatus(conversation.id, 'Open');
  await addConversationEvent({
    conversationId: conversation.id,
    agentId: conversation.active_agent_id ?? conversation.agent_id ?? null,
    customerId: conversation.customer_id ?? null,
    mspConversationId: conversation.msp_conversation_id ?? null,
    operatorId,
    action: 'conversation_resumed',
    note,
    handoffId: existing?.id ?? null,
  });

  return { handoff };
}

async function transitionHandoff(
  c: any,
  input: {
    toStatus: 'assigned' | 'resolved' | 'returned_to_agent';
    action: string;
    conversationStatus: 'Open' | 'Needs Human' | 'Resolved';
  },
) {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const operatorId =
    cleanText(body.operatorId) ?? cleanText(body.assignedOperator) ?? cleanText(body.operatorName) ?? 'operator';
  const note = cleanText(body.note) ?? cleanText(body.reason);
  const now = new Date().toISOString();

  const current = await fetchHandoff(id);
  if (!current) return c.json({ error: 'handoff not found' }, 404);

  const patch: Record<string, unknown> = {
    status: input.toStatus,
    updated_at: now,
  };
  if (input.toStatus === 'assigned') {
    patch.assigned_operator = operatorId;
    patch.assigned_team = cleanText(body.team) ?? cleanText(body.assignedTeam);
    patch.assigned_at = now;
  }
  if (input.toStatus === 'resolved') patch.resolved_at = now;
  if (input.toStatus === 'returned_to_agent') patch.returned_to_agent_at = now;

  const { data, error } = await supabase
    .from('handoff_sessions')
    .update(patch)
    .eq('id', id)
    .select(HANDOFF_SELECT)
    .single();

  if (error) {
    warnOnce(`handoff ${input.action}`, error);
    return c.json({ error: 'handoff unavailable' }, 503);
  }

  await setConversationStatus(current.conversation_id ?? null, input.conversationStatus);
  await addHandoffNote({
    handoffId: id,
    conversationId: current.conversation_id ?? null,
    operatorId,
    note,
  });
  await addHandoffAudit({
    handoffId: id,
    conversationId: current.conversation_id ?? null,
    operatorId,
    action: input.action,
    fromStatus: current.status ?? null,
    toStatus: input.toStatus,
    note,
  });
  await addConversationEvent({
    conversationId: current.conversation_id ?? null,
    agentId: current.agent_id ?? null,
    customerId: current.customer_id ?? null,
    mspConversationId: current.msp_conversation_id ?? null,
    operatorId,
    action: input.action,
    note,
    handoffId: id,
  });

  return c.json({ handoff: mapHandoff(data) });
}

async function exactTrustSettingsRow(agentId: string | null) {
  const query = supabase.from('trust_safety_settings').select('*');
  const result = agentId ? await query.eq('agent_id', agentId).maybeSingle() : await query.is('agent_id', null).maybeSingle();
  if (result.error) {
    warnOnce('trust settings', result.error);
    return { row: null, available: false };
  }
  return { row: result.data, available: true };
}

async function inheritedTrustSettingsRow(agentId: string | null) {
  const exact = await exactTrustSettingsRow(agentId);
  if (!exact.available || exact.row || !agentId) return exact;
  return exactTrustSettingsRow(null);
}

operator.get('/operator/conversations', async (c) => {
  const rows = await fetchConversations({
    agentId: cleanText(c.req.query('agentId')),
    status: cleanText(c.req.query('status')),
    q: cleanText(c.req.query('q')) ?? cleanText(c.req.query('search')),
    limit: limitFromQuery(c.req.query('limit')),
  });
  return c.json({ conversations: rows.map(mapConversation) });
});

operator.get('/operator/agents', async (c) => {
  const limit = limitFromQuery(c.req.query('limit'), 100);
  const { data, error } = await supabase
    .from('agents')
    .select(AGENT_SELECT)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) {
    warnOnce('agents list', error);
    return c.json({ agents: [] });
  }
  return c.json({ agents: (data ?? []).map(mapAgent) });
});

operator.get('/operator/conversations/:id/customer-profile', async (c) => {
  const conversation = await fetchConversation(c.req.param('id'));
  if (!conversation) return c.json({ error: 'conversation not found' }, 404);

  const customerId = conversation.customer_id ?? null;
  let profile = null;
  if (customerId) {
    const { data, error } = await supabase
      .from('customer_profiles')
      .select('*')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (error) warnOnce('customer profile', error);
    else profile = data;
  }

  return c.json({
    conversation: mapConversation(conversation),
    profile: {
      id: profile?.id ?? null,
      customerId,
      displayName: profile?.display_name ?? conversation.customer_name ?? 'Apple Customer',
      appleId: profile?.apple_id ?? null,
      email: profile?.email ?? null,
      phone: profile?.phone ?? null,
      trustLevel: profile?.trust_level ?? 'standard',
      safetyNotes: profile?.safety_notes ?? null,
      tags: Array.isArray(profile?.tags) ? profile.tags : [],
      attributes:
        profile?.attributes && typeof profile.attributes === 'object' && !Array.isArray(profile.attributes)
          ? profile.attributes
          : {},
      firstSeenAt: profile?.first_seen_at ?? null,
      lastSeenAt: profile?.last_seen_at ?? null,
      createdAt: profile?.created_at ?? null,
      updatedAt: profile?.updated_at ?? null,
    },
  });
});

operator.post('/operator/conversations/:id/messages', async (c) => {
  const conversation = await fetchConversation(c.req.param('id'));
  if (!conversation) return c.json({ error: 'conversation not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const text = cleanText(body.text) ?? cleanText(body.message) ?? cleanText(body.body);
  if (!text) return c.json({ error: 'text is required' }, 400);

  const customerId = conversation.customer_id ?? null;
  if (!customerId) {
    return c.json({ error: 'conversation is missing customer_id' }, 409);
  }

  const pauseAgent = body.pauseAgent !== false;
  let handoff = null;
  if (pauseAgent) {
    const state = await setConversationHandoffState(conversation, body, {
      toStatus: 'human_active',
      action: 'operator_message_takeover',
      conversationStatus: 'Needs Human',
      defaultReason: 'Operator sent a customer-visible message',
    });
    if (state.error) return c.json({ error: state.error }, 503);
    handoff = state.handoff;
  }

  try {
    await sendText(customerId, text);
  } catch (err) {
    warnOnce('operator send message', err);
    return c.json({ error: 'message send failed' }, 502);
  }

  const operatorId = operatorIdFromBody(body);
  const operatorName = operatorNameFromBody(body);
  await appendTurn(
    conversation.id,
    {
      role: 'agent',
      text,
      kind: 'text',
      payload: {
        actor: 'operator',
        operatorId,
        ...(operatorName ? { operatorName } : {}),
      },
    },
    pauseAgent ? 'Needs Human' : undefined,
  );
  await addConversationEvent({
    conversationId: conversation.id,
    agentId: conversation.active_agent_id ?? conversation.agent_id ?? null,
    customerId,
    mspConversationId: conversation.msp_conversation_id ?? null,
    operatorId,
    action: 'operator_message_sent',
    note: text,
    handoffId: handoff?.id ?? null,
  });

  const updated = await refreshConversation(conversation);
  return c.json({
    delivered: true,
    conversation: mapConversation(updated),
    handoff: handoff ? mapHandoff(handoff) : null,
    message: {
      role: 'agent',
      text,
      kind: 'text',
      payload: {
        actor: 'operator',
        operatorId,
        ...(operatorName ? { operatorName } : {}),
      },
    },
  });
});

operator.post('/operator/conversations/:id/pause', async (c) => {
  const conversation = await fetchConversation(c.req.param('id'));
  if (!conversation) return c.json({ error: 'conversation not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const state = await setConversationHandoffState(conversation, body, {
    toStatus: 'bot_paused',
    action: 'conversation_paused',
    conversationStatus: 'Needs Human',
    defaultReason: 'Operator paused automated replies',
  });
  if (state.error) return c.json({ error: state.error }, 503);

  const updated = await refreshConversation(conversation);
  return c.json({
    conversation: mapConversation(updated),
    handoff: state.handoff ? mapHandoff(state.handoff) : null,
  });
});

operator.post('/operator/conversations/:id/resume', async (c) => {
  const conversation = await fetchConversation(c.req.param('id'));
  if (!conversation) return c.json({ error: 'conversation not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const state = await returnConversationToAgent(conversation, body);
  if (state.error) return c.json({ error: state.error }, 503);

  const updated = await refreshConversation(conversation);
  return c.json({
    conversation: mapConversation(updated),
    handoff: state.handoff ? mapHandoff(state.handoff) : null,
  });
});

operator.get('/operator/customer-profiles', async (c) => {
  const limit = limitFromQuery(c.req.query('limit'));
  const q = cleanText(c.req.query('q')) ?? cleanText(c.req.query('search'));
  let query = supabase
    .from('customer_profiles')
    .select('*')
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .limit(q ? Math.min(limit * 5, 200) : limit);

  const { data, error } = await query;
  if (error) {
    warnOnce('customer profiles list', error);
    return c.json({ profiles: [] });
  }

  const profiles = (data ?? []).filter((row) => {
    if (!q) return true;
    return [
      row.display_name,
      row.customer_id,
      row.apple_id,
      row.email,
      row.phone,
      ...(Array.isArray(row.tags) ? row.tags : []),
    ].some((value) => String(value ?? '').toLowerCase().includes(q.toLowerCase()));
  });

  return c.json({ profiles: profiles.slice(0, limit).map(mapCustomerProfile) });
});

operator.get('/operator/customer-profiles/:customerId', async (c) => {
  const customerId = c.req.param('customerId');
  const { data, error } = await supabase
    .from('customer_profiles')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (error) {
    warnOnce('customer profile direct', error);
    return c.json({
      profile: {
        customerId,
        displayName: 'Apple Customer',
        trustLevel: 'standard',
        tags: [],
        attributes: {},
      },
    });
  }
  return c.json({
    profile: {
      id: data?.id ?? null,
      customerId,
      displayName: data?.display_name ?? 'Apple Customer',
      appleId: data?.apple_id ?? null,
      email: data?.email ?? null,
      phone: data?.phone ?? null,
      trustLevel: data?.trust_level ?? 'standard',
      safetyNotes: data?.safety_notes ?? null,
      tags: Array.isArray(data?.tags) ? data.tags : [],
      attributes: data?.attributes ?? {},
      firstSeenAt: data?.first_seen_at ?? null,
      lastSeenAt: data?.last_seen_at ?? null,
      createdAt: data?.created_at ?? null,
      updatedAt: data?.updated_at ?? null,
    },
  });
});

operator.get('/operator/handoffs', async (c) => {
  const limit = limitFromQuery(c.req.query('limit'));
  const status = cleanText(c.req.query('status'));
  const statuses = status && status !== 'all' ? status.split(',').map((s) => s.trim()).filter(Boolean) : null;

  let query = supabase
    .from('handoff_sessions')
    .select(HANDOFF_SELECT)
    .order('requested_at', { ascending: false })
    .limit(limit);
  if (statuses?.length) query = query.in('status', statuses);
  if (!statuses && status !== 'all') query = query.in('status', ACTIVE_HANDOFF_STATUSES);
  const agentId = cleanText(c.req.query('agentId'));
  if (agentId) query = query.eq('agent_id', agentId);
  const assignedOperator = cleanText(c.req.query('assignedOperator'));
  if (assignedOperator) query = query.eq('assigned_operator', assignedOperator);

  const { data, error } = await query;
  if (error) {
    warnOnce('handoffs list', error);
    return c.json({ handoffs: [] });
  }
  return c.json({ handoffs: (data ?? []).map(mapHandoff) });
});

operator.get('/operator/appointments', async (c) => {
  const limit = limitFromQuery(c.req.query('limit'), 100);
  const agentId = cleanText(c.req.query('agentId'));
  const status = cleanText(c.req.query('status'));
  const customerId = cleanText(c.req.query('customerId'));

  let query = supabase
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .order('starts_at', { ascending: true, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (agentId) query = query.eq('agent_id', agentId);
  if (status && status !== 'all') query = query.eq('status', status);
  if (customerId) query = query.eq('customer_id', customerId);

  const { data, error } = await query;
  if (!error) {
    return c.json({ appointments: (data ?? []).map(mapAppointment), source: 'appointments' });
  }

  warnOnce('appointments list', error);
  const rows = await fetchConversations({ agentId, status: null, q: null, limit });
  const derived = rows
    .map(derivedAppointmentFromConversation)
    .filter(Boolean)
    .filter((row: any) => !status || status === 'all' || row.status === status)
    .filter((row: any) => !customerId || row.customer_id === customerId)
    .slice(0, limit);
  return c.json({ appointments: derived.map(mapAppointment), source: 'conversations' });
});

operator.post('/operator/handoffs/:id/claim', (c) =>
  transitionHandoff(c, {
    toStatus: 'assigned',
    action: 'operator_claimed',
    conversationStatus: 'Needs Human',
  }),
);

operator.post('/operator/handoffs/:id/resolve', (c) =>
  transitionHandoff(c, {
    toStatus: 'resolved',
    action: 'handoff_resolved',
    conversationStatus: 'Resolved',
  }),
);

operator.post('/operator/handoffs/:id/return', (c) =>
  transitionHandoff(c, {
    toStatus: 'returned_to_agent',
    action: 'handoff_returned_to_agent',
    conversationStatus: 'Open',
  }),
);

operator.post('/operator/handoffs/:id/return-to-agent', (c) =>
  transitionHandoff(c, {
    toStatus: 'returned_to_agent',
    action: 'handoff_returned_to_agent',
    conversationStatus: 'Open',
  }),
);

operator.get('/operator/trust-settings', async (c) => {
  const agentId = cleanText(c.req.query('agentId'));
  const { row, available } = await inheritedTrustSettingsRow(agentId);
  return c.json({ settings: mapTrustSettings(row, agentId), persisted: available && Boolean(row) });
});

operator.patch('/operator/trust-settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const agentId = cleanText(c.req.query('agentId')) ?? cleanText(body.agentId);
  const patch = trustPatchFromBody(body);
  const now = new Date().toISOString();

  const existing = await exactTrustSettingsRow(agentId);
  if (!existing.available) {
    return c.json({
      settings: {
        ...DEFAULT_TRUST_SETTINGS,
        ...mapTrustSettings(patch, agentId),
        id: null,
        agentId,
        updatedAt: now,
      },
      persisted: false,
    });
  }

  const rowPatch = { ...patch, updated_at: now };
  const result = existing.row
    ? await supabase
        .from('trust_safety_settings')
        .update(rowPatch)
        .eq('id', existing.row.id)
        .select('*')
        .single()
    : await supabase
        .from('trust_safety_settings')
        .insert({ agent_id: agentId, ...rowPatch })
        .select('*')
        .single();

  if (result.error) {
    warnOnce('trust settings update', result.error);
    return c.json({ settings: mapTrustSettings({ ...patch, updated_at: now }, agentId), persisted: false });
  }

  return c.json({ settings: mapTrustSettings(result.data, agentId), persisted: true });
});
