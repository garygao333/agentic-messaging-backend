/**
 * The two consolidated LLM endpoints the app calls. Shapes match the app's
 * `src/services/llm.ts` (AgentConfig / chatReply) so pointing
 * EXPO_PUBLIC_LLM_PROXY_URL here is a trivial swap.
 */
import { Hono } from 'hono';
import { requireAppAuth } from '../auth.js';
import { getAgent } from '../supabase.js';
import { generateAgentConfig } from '../llm/generate.js';
import { chatReply } from '../llm/reply.js';

export const agents = new Hono();

agents.use('/agents/*', requireAppAuth);

// POST /agents/generate — generate an agent config from onboarding inputs.
agents.post('/agents/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const config = await generateAgentConfig({
    name: body.name ?? body.agentName ?? body.agent_name,
    companyName: body.companyName ?? body.company_name ?? body.businessName ?? body.business_name,
    website: body.website,
    businessType: body.businessType ?? body.business_type,
    useCase: body.useCase ?? body.use_case,
    tone: body.tone,
    integrations: body.integrations,
    handoffDestination:
      body.handoffDestination ??
      body.handoff_destination ??
      body.handoffInstruction ??
      body.handoff_instruction,
  });
  return c.json(config);
});

// POST /agents/:id/preview-message — next reply for the in-app preview chat.
agents.post('/agents/:id/preview-message', async (c) => {
  const id = c.req.param('id');
  const agent = await getAgent(id);
  if (!agent) return c.json({ error: 'agent not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const history = Array.isArray(body.messages)
    ? body.messages.map((m: any) => ({
        role: m.role === 'customer' ? 'customer' : 'agent',
        text: String(m.text ?? ''),
      }))
    : [];

  const reply = await chatReply(agent, history);
  return c.json({ reply });
});
