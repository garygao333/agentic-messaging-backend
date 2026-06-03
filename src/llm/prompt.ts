/**
 * THE CONSOLIDATION POINT.
 *
 * Both the in-app preview (`POST /agents/:id/preview-message`) and the live
 * Messages runtime build their system prompt here, so "preview ≡ production".
 *
 * Mirrors the app's `src/lib/generate.ts` + `src/services/llm.ts` fallbacks so
 * behaviour degrades to the same deterministic templates if the LLM errors.
 */
import type { AgentRow } from '../supabase.js';

export interface AgentDraftInput {
  name?: string;
  companyName?: string;
  website?: string;
  businessType?: string;
  useCase?: string;
  tone?: string;
  integrations?: string[];
  handoffDestination?: string;
}

const PREVIEW_BY_TYPE: Record<string, { agent: string; actions: string[] }> = {
  'Shopify / E-commerce': {
    agent: 'I can help with that. Would you like to track an order, start a return, or talk to a human?',
    actions: ['Track order', 'Start return', 'Talk to an agent'],
  },
  'Home Services': {
    agent: 'Happy to help. Want to book a visit, get a quote, or reschedule an appointment?',
    actions: ['Book a visit', 'Get a quote', 'Reschedule'],
  },
  Hospitality: {
    agent: 'Welcome! Would you like to make a reservation, check availability, or ask about amenities?',
    actions: ['Reservation', 'Availability', 'Amenities'],
  },
  'Healthcare Intake': {
    agent: 'I can help you get started. Would you like to schedule an appointment or complete intake?',
    actions: ['Schedule', 'Start intake', 'Talk to staff'],
  },
};

const DEFAULT_PREVIEW = {
  agent: 'Your Messages agent is live in this thread. Send a customer question to test it, or pick a starting point.',
  actions: ['Ask a question', 'See options', 'Talk to a human'],
};

export function previewFor(businessType: string | undefined) {
  return PREVIEW_BY_TYPE[businessType ?? ''] ?? DEFAULT_PREVIEW;
}

export function defaultPrompt(a: AgentDraftInput): string {
  const company = a.companyName || 'the company';
  const type = a.businessType || 'customer support';
  const website = a.website ? ` Ground responses in ${a.website}.` : '';
  const useCase = a.useCase || 'answer customer questions and route requests';
  const tone = a.tone ? ` Use this tone and business context: ${a.tone}.` : '';
  const handoff = a.handoffDestination
    ? ` When a customer asks for a human, is frustrated, or needs work outside chat, hand off to ${a.handoffDestination}.`
    : ' When a customer asks for a human, is frustrated, or needs work outside chat, hand off to the team.';
  return (
    `You are ${a.name || 'a helpful assistant'}, the Apple Messages for Business agent for ${company} ` +
    `(${type}). This agent was created from an App Clip and is tested in the same Messages thread, ` +
    `so treat the customer as both the setup owner and first tester unless they say otherwise.${website} ` +
    `Focus on: ${useCase}.${tone} Keep replies short, channel-native, and useful in Apple Messages. ` +
    `Offer concrete next steps or concise suggested actions when helpful.${handoff}`
  );
}

export function defaultGuardrails(): string {
  return (
    '• Do not claim to place orders, book appointments, issue refunds, update accounts, send emails, or open tickets unless a connected runtime tool already did it.\n' +
    '• Do not collect payment card numbers, passwords, one-time codes, or sensitive medical/legal details in chat.\n' +
    '• Hand off to a human when the customer asks, seems frustrated, or needs legal, medical, billing, account, or policy exceptions.\n' +
    '• Stay grounded in the provided business website/name/use case/tone. Do not invent policies, prices, availability, or links.\n' +
    '• Keep replies concise and natural for Apple Messages.'
  );
}

/**
 * Build the runtime system prompt from a stored agent. This is the single
 * source of truth used by BOTH preview and live Messages replies.
 */
export function buildSystemPrompt(
  agent: Pick<AgentRow, 'prompt' | 'guardrails'> &
    Partial<Pick<AgentRow, 'company_name' | 'website' | 'business_type' | 'use_case' | 'handoff_destination'>>,
): string {
  const context = [
    agent.company_name ? `Company: ${agent.company_name}` : '',
    agent.website ? `Website: ${agent.website}` : '',
    agent.business_type ? `Business type: ${agent.business_type}` : '',
    agent.use_case ? `Use case: ${agent.use_case}` : '',
    agent.handoff_destination ? `Handoff destination: ${agent.handoff_destination}` : '',
  ].filter(Boolean);

  const handoff = agent.handoff_destination
    ? `If the customer asks for a human, is frustrated, or needs unsupported work, acknowledge it and say you can connect them with ${agent.handoff_destination}.`
    : 'If the customer asks for a human, is frustrated, or needs unsupported work, acknowledge it and say you can connect them with the team.';

  return [
    agent.prompt,
    context.length ? `Business context:\n${context.join('\n')}` : '',
    agent.guardrails ? `Guardrails:\n${agent.guardrails}` : '',
    `Apple Messages runtime rules:
- Write like a business texting a customer: 1-2 short sentences, usually under 320 characters.
- Do not use markdown, long menus, or multi-paragraph explanations unless the customer explicitly asks.
- You can answer questions, ask for missing details, suggest next steps, or recommend handoff.
- Do not claim you booked, cancelled, refunded, charged, updated, emailed, opened a ticket, transferred, or changed anything unless the conversation history says a runtime tool or human already did it.
- If an attachment, account lookup, payment, booking, refund, policy exception, or external system action is needed, say what detail you need or offer handoff instead of pretending to complete it.
- ${handoff}`,
  ].filter(Boolean).join('\n\n');
}
