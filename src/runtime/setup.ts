import { generateAgentConfig, type AgentConfig } from '../llm/generate.js';
import { sendAppClip, sendQuickReply, sendText } from '../msp/send.js';
import { supabase } from '../supabase.js';
import { appendTurn, loadState, setActiveAgent } from './conversations.js';
import { upsertCustomerIdentity, type CustomerIdentityInput } from './customerProfile.js';
import { logConversationEvent } from './handoff.js';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_BUSINESS_TYPE = 'Customer Support';

export interface SetupDraftInput {
  setupId?: string | null;
  setupToken?: string | null;
  customerId?: string | null;
  mspConversationId?: string | null;
  agentId?: string | null;
  name?: string | null;
  companyName?: string | null;
  businessName?: string | null;
  website?: string | null;
  businessType?: string | null;
  useCase?: string | null;
  tone?: string | null;
  handoffDestination?: string | null;
  integrations?: unknown;
  testUsers?: unknown;
  prompt?: string | null;
  guardrails?: string | null;
  welcomeMessage?: string | null;
  suggestedActions?: unknown;
  customerIdentity?: CustomerIdentityInput;
  setupContext?: Record<string, unknown>;
  completionPayload?: Record<string, unknown>;
}

export interface CompleteSetupOptions {
  sendConfirmation?: boolean;
  forceGenerate?: boolean;
  requireExistingSetup?: boolean;
  requireSetupToken?: boolean;
  trustRequestBinding?: boolean;
  allowAgentOverride?: boolean;
  requireCustomerMatch?: boolean;
}

export interface CompleteSetupResult {
  setupId: string;
  agentId: string;
  conversationId: string | null;
  customerId: string;
  mspConversationId: string | null;
  confirmationSent: boolean;
  generated: boolean;
  setup: Record<string, unknown> | null;
  agent: Record<string, unknown> | null;
  activated: boolean;
  messageBody?: string;
  managementPath?: string;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  const text = clean(value);
  return text || null;
}

function uuidOrNull(value: unknown): string | null {
  const text = clean(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function cleanSuggestedAction(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`.!?]+$/g, '')
    .trim()
    .slice(0, 24)
    .trim();
}

function suggestedActionsForReply(value: unknown): string[] {
  const seen = new Set<string>();
  return stringArray(value)
    .map(cleanSuggestedAction)
    .filter((action) => {
      const key = action.toLowerCase();
      if (!action || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function normalizedStringArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return stringArray(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashSetupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const unsupportedColumns = new Map<string, Set<string>>();
const memorySetups = new Map<string, Record<string, unknown>>();

function rememberUnsupportedColumn(table: string, column: string): void {
  const columns = unsupportedColumns.get(table) ?? new Set<string>();
  if (!columns.has(column)) {
    console.warn(`[setup] ${table}.${column} missing in Supabase schema; using compatibility fallback`);
  }
  columns.add(column);
  unsupportedColumns.set(table, columns);
}

function missingColumn(error: unknown): string | null {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : String(error ?? '');
  return /Could not find the '([^']+)' column/.exec(message)?.[1] ?? null;
}

function stripUnsupportedColumns<T extends Record<string, unknown>>(table: string, row: T): T {
  const columns = unsupportedColumns.get(table);
  if (!columns?.size) return row;
  const next = { ...row };
  for (const column of columns) delete next[column];
  return next;
}

async function writeWithSchemaRetry<T extends Record<string, unknown>>(
  table: string,
  row: T,
  write: (payload: T) => PromiseLike<{ data: any; error: any }>,
): Promise<{ data: any; error: any }> {
  let payload = stripUnsupportedColumns(table, row);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await write(payload);
    if (!result.error) return result;
    const column = missingColumn(result.error);
    if (!column || !(column in payload)) return result;
    rememberUnsupportedColumn(table, column);
    payload = stripUnsupportedColumns(table, payload);
  }
  return write(payload);
}

function rememberSetup(setupId: string, input: SetupDraftInput, customerId: string, agentId?: string | null): void {
  const existing = memorySetups.get(setupId) ?? {};
  const patch: Record<string, unknown> = {
    ...existing,
    id: setupId,
    customer_id: customerId,
    msp_conversation_id: nullableText(input.mspConversationId) ?? existing.msp_conversation_id ?? null,
    agent_id: agentId ?? existing.agent_id ?? null,
    setup_context: {
      ...jsonObject(existing.setup_context),
      ...jsonObject(input.setupContext),
      ...(input.customerIdentity ? { customerIdentity: input.customerIdentity } : {}),
    },
  };
  if (input.setupToken) patch.setup_token_hash = hashSetupToken(input.setupToken);
  memorySetups.set(setupId, patch);
}

function mergeRememberedSetup(setup: any): any {
  if (!setup?.id) return setup;
  const remembered = memorySetups.get(setup.id);
  return remembered ? { ...setup, ...remembered } : setup;
}

function setupTokenMatches(setup: any, token: string | null): boolean {
  const hash = nullableText(setup?.setup_token_hash);
  if (!hash) return true;
  return Boolean(token && hashSetupToken(token) === hash);
}

function setupHasToken(setup: any): boolean {
  return Boolean(nullableText(setup?.setup_token_hash));
}

function setupCompleted(setup: any): boolean {
  return Boolean(nullableText(setup?.completed_at) || nullableText(setup?.agent_id) || setup?.status === 'completed');
}

function testUsersFor(input: SetupDraftInput, customerId: string): unknown[] {
  if (Array.isArray(input.testUsers)) return input.testUsers;
  return [
    {
      id: customerId,
      name: customerId,
      phoneOrAppleId: customerId,
      handle: customerId,
      status: 'Active',
    },
  ];
}

function agentNameFor(input: SetupDraftInput, setup: any): string {
  const explicit = nullableText(input.name) ?? nullableText(setup?.agent_name);
  if (explicit) return explicit;

  const company = nullableText(input.companyName) ?? nullableText(input.businessName) ?? nullableText(setup?.company_name);
  if (company) return `${company} Messages Agent`;

  const businessType = nullableText(input.businessType) ?? nullableText(setup?.business_type);
  if (businessType) return `${businessType.split(/[/-]/)[0]?.trim() || businessType} Agent`;

  return 'Messages Agent';
}

function draftFrom(input: SetupDraftInput, setup: any) {
  const companyName =
    nullableText(input.companyName) ??
    nullableText(input.businessName) ??
    nullableText(setup?.company_name) ??
    nullableText(input.website) ??
    nullableText(setup?.website) ??
    'this business';
  const tone = nullableText(input.tone) ?? nullableText(setup?.tone);
  const useCase = nullableText(input.useCase) ?? nullableText(setup?.use_case) ?? 'Answer customer questions and help route requests.';
  return {
    name: agentNameFor(input, setup),
    companyName,
    website: nullableText(input.website) ?? nullableText(setup?.website) ?? '',
    businessType:
      nullableText(input.businessType) ??
      nullableText(setup?.business_type) ??
      DEFAULT_BUSINESS_TYPE,
    useCase,
    tone: tone ?? undefined,
    integrations: stringArray(input.integrations).length ? stringArray(input.integrations) : ['None'],
    handoffDestination:
      nullableText(input.handoffDestination) ??
      nullableText(setup?.handoff_destination) ??
      '',
  };
}

function withSetupFallback(input: SetupDraftInput, setup: any): SetupDraftInput {
  if (!setup) return input;
  return {
    ...input,
    setupId: input.setupId ?? setup.id,
    setupToken: input.setupToken,
    customerId: input.customerId ?? setup.customer_id,
    mspConversationId: input.mspConversationId ?? setup.msp_conversation_id,
    agentId: input.agentId ?? setup.agent_id,
    name: input.name ?? setup.agent_name,
    companyName: input.companyName ?? setup.company_name,
    website: input.website ?? setup.website,
    businessType: input.businessType ?? setup.business_type,
    useCase: input.useCase ?? setup.use_case,
    tone: input.tone ?? setup.tone,
    handoffDestination: input.handoffDestination ?? setup.handoff_destination,
    testUsers: input.testUsers ?? setup.test_users,
    customerIdentity: input.customerIdentity,
    setupContext: input.setupContext ?? jsonObject(setup.setup_context),
    completionPayload: input.completionPayload ?? jsonObject(setup.completion_payload),
  };
}

function configFromInput(input: SetupDraftInput): AgentConfig | null {
  const prompt = nullableText(input.prompt);
  const guardrails = nullableText(input.guardrails);
  if (!prompt || !guardrails) return null;
  return {
    prompt,
    guardrails,
    welcomeMessage: nullableText(input.welcomeMessage) ?? '',
    suggestedActions: suggestedActionsForReply(input.suggestedActions),
  };
}

function setupPatch(input: SetupDraftInput, customerId: string, agentId?: string | null, config?: AgentConfig | null) {
  const now = new Date().toISOString();
  return {
    customer_id: customerId,
    msp_conversation_id: nullableText(input.mspConversationId),
    website: clean(input.website),
    company_name: clean(input.companyName) || clean(input.businessName),
    agent_name: clean(input.name),
    business_type: clean(input.businessType),
    use_case: clean(input.useCase),
    test_users: testUsersFor(input, customerId),
    tone: clean(input.tone),
    handoff_destination: clean(input.handoffDestination),
    setup_context: {
      ...jsonObject(input.setupContext),
      ...(input.customerIdentity ? { customerIdentity: input.customerIdentity } : {}),
    },
    completion_payload: jsonObject(input.completionPayload),
    generated_config: config ?? {},
    status: agentId ? 'completed' : 'started',
    agent_id: agentId ?? null,
    completed_at: agentId ? now : null,
    updated_at: now,
    ...(input.setupToken ? { setup_token_hash: hashSetupToken(input.setupToken) } : {}),
  };
}

async function loadSetup(setupId: string | null): Promise<any | null> {
  if (!setupId) return null;
  const { data, error } = await supabase.from('setups').select('*').eq('id', setupId).maybeSingle();
  if (error) throw error;
  return mergeRememberedSetup(data ?? memorySetups.get(setupId) ?? null);
}

async function findOpenSetup(customerId: string): Promise<any | null> {
  for (const setup of memorySetups.values()) {
    if (setup.customer_id === customerId && !setup.completed_at && !setup.agent_id) return setup;
  }
  const { data, error } = await supabase
    .from('setups')
    .select('*')
    .eq('customer_id', customerId)
    .is('completed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return null;
  return data?.[0] ?? null;
}

async function upsertSetup(input: SetupDraftInput, customerId: string, agentId?: string | null, config?: AgentConfig | null): Promise<string> {
  const existingId = uuidOrNull(input.setupId);
  const patch = setupPatch(input, customerId, agentId, config);
  if (existingId) {
    const { data, error } = await writeWithSchemaRetry('setups', { id: existingId, ...patch }, (row) =>
      supabase
        .from('setups')
        .upsert(row, { onConflict: 'id' })
        .select('id')
        .single(),
    );
    if (error) throw error;
    rememberSetup(data.id, input, customerId, agentId);
    return data.id;
  }

  const { data, error } = await writeWithSchemaRetry('setups', patch, (row) =>
    supabase.from('setups').insert(row).select('id').single(),
  );
  if (error) throw error;
  rememberSetup(data.id, input, customerId, agentId);
  return data.id;
}

async function ensureAgent(input: SetupDraftInput, setup: any, setupId: string, customerId: string, options: CompleteSetupOptions) {
  const now = new Date().toISOString();
  const draft = draftFrom(input, setup);
  const existingAgentId = uuidOrNull(input.agentId) ?? uuidOrNull(setup?.agent_id);
  const existingAgent = existingAgentId
    ? await supabase.from('agents').select('*').eq('id', existingAgentId).maybeSingle()
    : null;
  if (existingAgent?.error) throw existingAgent.error;

  const existing = existingAgent?.data ?? null;
  const providedConfig = configFromInput(input);
  const needsGeneratedConfig =
    options.forceGenerate === true ||
    !providedConfig && (!existing || !nullableText(existing.prompt) || !nullableText(existing.guardrails));
  const config = providedConfig ??
    (needsGeneratedConfig
      ? await generateAgentConfig(draft)
      : {
          prompt: existing!.prompt,
          guardrails: existing!.guardrails,
          welcomeMessage: existing!.welcome_message ?? '',
          suggestedActions: stringArray(existing!.suggested_actions),
        });

  const row = {
    name: draft.name,
    company_name: draft.companyName,
    website: draft.website,
    business_type: draft.businessType,
    use_case: draft.useCase,
    integrations: normalizedStringArray(draft.integrations),
    prompt: config.prompt,
    guardrails: config.guardrails,
    handoff_destination: draft.handoffDestination,
    test_users: testUsersFor(input, customerId),
    status: 'Deployed',
    updated_at: now,
    last_deployed_at: now,
    created_by_customer_id: customerId,
    setup_id: setupId,
    provenance: {
      source: 'app_clip_setup',
      customerId,
      setupId,
      generatedAt: needsGeneratedConfig ? now : null,
    },
    welcome_message: config.welcomeMessage,
    suggested_actions: config.suggestedActions,
  };

  if (existing) {
    const { data, error } = await writeWithSchemaRetry('agents', row, (payload) =>
      supabase
        .from('agents')
        .update(payload)
        .eq('id', existing.id)
        .select('id')
        .single(),
    );
    if (error) throw error;
    return { agentId: data.id, config, generated: needsGeneratedConfig };
  }

  const { data, error } = await writeWithSchemaRetry('agents', { ...row, created_at: now }, (payload) =>
    supabase
      .from('agents')
      .insert(payload)
      .select('id')
      .single(),
  );
  if (error) throw error;
  return { agentId: data.id, config, generated: needsGeneratedConfig };
}

export async function startAppClipSetup(input: {
  customerId: string;
  mspConversationId?: string | null;
  initialText?: string | null;
  raw?: unknown;
}): Promise<{ setupId: string; appClipSent: boolean }> {
  const existing = await findOpenSetup(input.customerId);
  const existingId = uuidOrNull(existing?.id);
  const canReuseExisting = Boolean(existingId && !setupHasToken(existing));
  const setupToken = randomUUID();
  const setupId = canReuseExisting && existingId
    ? existingId
    : await upsertSetup(
        {
          customerId: input.customerId,
          setupToken,
          mspConversationId: input.mspConversationId,
          setupContext: {
            source: 'messages_no_active_agent',
            initialText: nullableText(input.initialText),
            raw: input.raw ?? null,
          },
        },
        input.customerId,
      );
  if (canReuseExisting) {
    await upsertSetup(
      {
        setupId,
        customerId: input.customerId,
        setupToken,
        mspConversationId: input.mspConversationId,
        setupContext: {
          source: 'messages_no_active_agent',
          initialText: nullableText(input.initialText),
          raw: input.raw ?? null,
        },
      },
      input.customerId,
    );
  }

  await sendText(
    input.customerId,
    "Let's set up your Messages agent. Tap the App Clip below and answer a few quick questions.",
  );

  try {
    await sendAppClip(input.customerId, {
      setup_id: setupId,
      setup_token: setupToken,
      customer_id: input.customerId,
      ...(input.mspConversationId ? { msp_conversation_id: input.mspConversationId } : {}),
    });
    await logConversationEvent({
      conversationId: null,
      customerId: input.customerId,
      mspConversationId: input.mspConversationId ?? null,
      eventType: 'app_clip_setup_sent',
      actor: 'system',
      payload: { setupId },
    });
    return { setupId, appClipSent: true };
  } catch (err) {
    console.warn('[setup] App Clip send failed:', err);
    await sendText(input.customerId, 'I created your setup session, but the App Clip did not appear. Please text START_AGENT_SETUP to retry.');
    return { setupId, appClipSent: false };
  }
}

export async function completeAppClipSetup(
  input: SetupDraftInput,
  options: CompleteSetupOptions = {},
): Promise<CompleteSetupResult> {
  const setup = await loadSetup(uuidOrNull(input.setupId));
  const token = nullableText(input.setupToken);
  if (options.requireExistingSetup && !setup) {
    throw new Error('setup not found');
  }
  if (options.requireSetupToken && (!setup || !setupHasToken(setup) || !setupTokenMatches(setup, token))) {
    throw new Error('setup token did not match');
  }
  if (options.requireSetupToken && setupCompleted(setup)) {
    throw new Error('setup already completed');
  }
  if (!options.requireSetupToken && token && setup && !setupTokenMatches(setup, token)) {
    throw new Error('setup token did not match');
  }
  if (
    options.requireCustomerMatch &&
    setup?.customer_id &&
    input.customerId &&
    setup.customer_id !== input.customerId
  ) {
    throw new Error('setup customer did not match');
  }

  const trustedInput =
    options.trustRequestBinding === false
      ? { ...input, customerId: null, agentId: options.allowAgentOverride === false ? null : input.agentId }
      : input;
  const customerId =
    options.trustRequestBinding === false
      ? nullableText(setup?.customer_id) ?? nullableText(trustedInput.customerId)
      : nullableText(setup?.customer_id) ?? nullableText(trustedInput.customerId);
  if (!customerId) {
    throw new Error('customer_id is required to complete App Clip setup');
  }

  const mergedInput = withSetupFallback(trustedInput, setup);
  if (mergedInput.customerIdentity) {
    await upsertCustomerIdentity(customerId, mergedInput.customerIdentity);
  }
  const setupId = await upsertSetup(mergedInput, customerId, uuidOrNull(mergedInput.agentId));
  const latestSetup = await loadSetup(setupId);
  const latestInput = withSetupFallback(mergedInput, latestSetup ?? setup);
  const { agentId, config, generated } = await ensureAgent(latestInput, latestSetup ?? setup, setupId, customerId, options);

  const conversationId = await setActiveAgent(customerId, agentId);
  if (!conversationId) {
    throw new Error('conversation activation failed');
  }
  await upsertSetup({ ...latestInput, setupId }, customerId, agentId, config);
  const state = await loadState(customerId, nullableText(latestInput.mspConversationId) ?? nullableText(latestSetup?.msp_conversation_id));

  let confirmationSent = false;
  const message =
    config.welcomeMessage ||
    "Setup complete. Your new Messages agent is live in this thread now, so send a message whenever you're ready.";
  if (options.sendConfirmation !== false) {
    try {
      await sendText(customerId, message);
      confirmationSent = true;
      await appendTurn(state.id ?? conversationId, { role: 'agent', text: message }, 'Open');
    } catch (err) {
      console.warn('[setup] setup confirmation send failed:', err);
    }

    const actions = suggestedActionsForReply(config.suggestedActions);
    if (confirmationSent && actions.length >= 2) {
      const prompt = 'Try the agent:';
      try {
        await sendQuickReply(customerId, prompt, actions, randomUUID());
        await appendTurn(state.id ?? conversationId, {
          role: 'agent',
          text: prompt,
          kind: 'quick_reply',
          interactive: {
            type: 'quick_reply',
            title: prompt,
            subtitle: 'Tap to respond',
            items: actions.map((title) => ({ id: title, title })),
          },
        });
        await logConversationEvent({
          conversationId: state.id ?? conversationId,
          agentId,
          customerId,
          mspConversationId: state.mspConversationId,
          eventType: 'quick_reply_sent',
          actor: 'agent',
          body: prompt,
          payload: { actions, source: 'app_clip_setup_completed' },
        });
      } catch (err) {
        console.warn('[setup] setup suggested actions send failed:', err);
      }
    }
  }

  await logConversationEvent({
    conversationId: state.id ?? conversationId,
    agentId,
    customerId,
    mspConversationId: state.mspConversationId,
    eventType: 'app_clip_setup_completed',
    actor: 'system',
    payload: { setupId, generated, confirmationSent },
  });

  if (options.requireSetupToken) {
    const { error } = await writeWithSchemaRetry(
      'setups',
      { setup_token_hash: null, updated_at: new Date().toISOString() },
      (row) => supabase.from('setups').update(row).eq('id', setupId),
    );
    if (error) throw error;
    const remembered = memorySetups.get(setupId);
    if (remembered) {
      delete remembered.setup_token_hash;
      remembered.completed_at = new Date().toISOString();
      remembered.agent_id = agentId;
      memorySetups.set(setupId, remembered);
    }
  }

  const [{ data: finalSetup }, { data: finalAgent }] = await Promise.all([
    supabase.from('setups').select('*').eq('id', setupId).maybeSingle(),
    supabase.from('agents').select('*').eq('id', agentId).maybeSingle(),
  ]);

  return {
    setupId,
    agentId,
    conversationId: state.id ?? conversationId,
    customerId,
    mspConversationId: state.mspConversationId,
    confirmationSent,
    generated,
    setup: finalSetup ?? null,
    agent: finalAgent ?? null,
    activated: Boolean(state.id ?? conversationId),
    messageBody: message,
    managementPath: `/agents/${agentId}/manage`,
  };
}
