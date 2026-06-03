import { Hono } from 'hono';
import { requireAppAuth } from '../auth.js';
import { completeAppClipSetup } from '../runtime/setup.js';

export const setup = new Hono();

setup.use('/setup/*', requireAppAuth);

function text(body: any, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function bool(body: any, key: string, fallback: boolean): boolean {
  return typeof body?.[key] === 'boolean' ? body[key] : fallback;
}

function customerIdentityInput(body: any, identity: any) {
  const customerIdentity = {
    displayName:
      text(body, 'displayName', 'display_name', 'customerName', 'customer_name') ??
      text(identity, 'displayName', 'display_name', 'name'),
    phone:
      text(body, 'phone', 'phoneNumber', 'phone_number') ??
      text(identity, 'phone', 'phoneNumber', 'phone_number'),
    appleId:
      text(body, 'appleId', 'apple_id') ??
      text(identity, 'appleId', 'apple_id'),
    email:
      text(body, 'email', 'emailAddress', 'email_address') ??
      text(identity, 'email', 'emailAddress', 'email_address'),
  };
  return Object.values(customerIdentity).some(Boolean) ? customerIdentity : undefined;
}

function setupInput(body: any) {
  const setup = body?.setup && typeof body.setup === 'object' ? body.setup : {};
  const agent = body?.agent && typeof body.agent === 'object' ? body.agent : {};
  const config = body?.config && typeof body.config === 'object' ? body.config : {};
  const brief = body?.brief && typeof body.brief === 'object' ? body.brief : {};
  const identity =
    body?.identity && typeof body.identity === 'object'
      ? body.identity
      : brief?.identity && typeof brief.identity === 'object'
        ? brief.identity
        : {};
  const companyNameOrWebsite = text(brief, 'companyNameOrWebsite', 'company_name_or_website');

  return {
    setupId: text(body, 'setupId', 'setup_id') ?? text(setup, 'id', 'setupId', 'setup_id'),
    setupToken:
      text(body, 'setupToken', 'setup_token') ??
      text(setup, 'setupToken', 'setup_token'),
    customerId:
      text(body, 'customerId', 'customer_id') ??
      text(setup, 'customerId', 'customer_id'),
    mspConversationId:
      text(body, 'mspConversationId', 'msp_conversation_id') ??
      text(setup, 'mspConversationId', 'msp_conversation_id'),
    agentId:
      text(body, 'agentId', 'agent_id') ??
      text(setup, 'agentId', 'agent_id') ??
      text(agent, 'id', 'agentId', 'agent_id'),
    name:
      text(body, 'name', 'agentName', 'agent_name') ??
      text(agent, 'name', 'agentName', 'agent_name'),
    companyName:
      text(body, 'companyName', 'company_name') ??
      text(body, 'businessName', 'business_name') ??
      text(brief, 'companyName', 'company_name') ??
      (companyNameOrWebsite && !/[./]/.test(companyNameOrWebsite) ? companyNameOrWebsite : null) ??
      text(setup, 'companyName', 'company_name') ??
      text(agent, 'companyName', 'company_name'),
    website:
      text(body, 'website') ??
      text(brief, 'website') ??
      (companyNameOrWebsite && /[./]/.test(companyNameOrWebsite) ? companyNameOrWebsite : null) ??
      text(setup, 'website') ??
      text(agent, 'website'),
    businessType:
      text(body, 'businessType', 'business_type') ??
      text(setup, 'businessType', 'business_type') ??
      text(agent, 'businessType', 'business_type'),
    useCase:
      text(body, 'useCase', 'use_case') ??
      text(brief, 'useCase', 'use_case') ??
      text(setup, 'useCase', 'use_case') ??
      text(agent, 'useCase', 'use_case'),
    tone: text(body, 'tone') ?? text(brief, 'tone') ?? text(setup, 'tone'),
    handoffDestination:
      text(body, 'handoffDestination', 'handoff_destination') ??
      text(body, 'handoffInstruction', 'handoff_instruction') ??
      text(brief, 'handoffDestination', 'handoff_destination') ??
      text(brief, 'handoffInstruction', 'handoff_instruction') ??
      text(setup, 'handoffDestination', 'handoff_destination') ??
      text(agent, 'handoffDestination', 'handoff_destination'),
    integrations: body.integrations ?? setup.integrations ?? agent.integrations,
    testUsers: body.testUsers ?? body.test_users ?? setup.testUsers ?? setup.test_users ?? agent.testUsers ?? agent.test_users,
    prompt: text(body, 'prompt') ?? text(config, 'prompt') ?? text(agent, 'prompt'),
    guardrails: text(body, 'guardrails') ?? text(config, 'guardrails') ?? text(agent, 'guardrails'),
    welcomeMessage:
      text(body, 'welcomeMessage', 'welcome_message') ??
      text(config, 'welcomeMessage', 'welcome_message') ??
      text(agent, 'welcomeMessage', 'welcome_message'),
    suggestedActions:
      body.suggestedActions ??
      body.suggested_actions ??
      config.suggestedActions ??
      config.suggested_actions ??
      agent.suggestedActions ??
      agent.suggested_actions,
    customerIdentity: customerIdentityInput(body, identity),
    setupContext: {
      ...(body.context && typeof body.context === 'object' ? body.context : {}),
      ...(body.setupContext && typeof body.setupContext === 'object' ? body.setupContext : {}),
      ...(body.source ? { source: body.source } : {}),
      ...(body.setupToken ? { setupTokenPresent: true } : {}),
    },
    completionPayload: {
      source: 'app_auth_endpoint',
      receivedAt: new Date().toISOString(),
      brief,
      clientSource: body.source ?? null,
      ...(body.completionPayload && typeof body.completionPayload === 'object'
        ? body.completionPayload
        : {}),
    },
  };
}

async function handleComplete(c: any) {
  const body = await c.req.json().catch(() => ({}));
  const rawInput = setupInput(body);
  const isPublicAppClip = c.req.path.startsWith('/app-clip/');
  const input = isPublicAppClip
    ? {
        ...rawInput,
        customerId: null,
        mspConversationId: null,
        agentId: null,
        testUsers: undefined,
        prompt: null,
        guardrails: null,
        welcomeMessage: null,
        suggestedActions: undefined,
      }
    : rawInput;
  if (!input.customerId && !input.setupId) {
    return c.json({ error: 'customerId or setupId is required' }, 400);
  }
  if (isPublicAppClip && (!input.setupId || !input.setupToken)) {
    return c.json({ error: 'setupId and setupToken are required' }, 400);
  }

  try {
    const result = await completeAppClipSetup(input, {
      sendConfirmation: isPublicAppClip ? true : bool(body, 'sendConfirmation', true),
      forceGenerate: isPublicAppClip ? true : bool(body, 'forceGenerate', false),
      requireExistingSetup: isPublicAppClip,
      requireSetupToken: isPublicAppClip,
      trustRequestBinding: !isPublicAppClip,
      allowAgentOverride: !isPublicAppClip,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error('[setup-route] setup completion failed:', err);
    const message = err instanceof Error ? err.message : 'setup completion failed';
    const status =
      /already completed/i.test(message)
        ? 409
        : /token|customer did not match/i.test(message)
          ? 401
          : /customer_id|required/i.test(message)
            ? 400
            : 500;
    return c.json({ error: message }, status);
  }
}

setup.post('/app-clip/setup/complete', handleComplete);
setup.post('/setup/complete', handleComplete);
