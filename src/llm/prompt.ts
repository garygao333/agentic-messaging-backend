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
  agent: 'I can help with that. Would you like to track an order, start a return, or talk to a human?',
  actions: ['Track order', 'Start return', 'Talk to an agent'],
};

export function previewFor(businessType: string | undefined) {
  return PREVIEW_BY_TYPE[businessType ?? ''] ?? DEFAULT_PREVIEW;
}

export function defaultPrompt(a: AgentDraftInput): string {
  const company = a.companyName || 'the company';
  const type = a.businessType || 'customer support';
  const useCase = a.useCase ? ` Focus area: ${a.useCase}.` : '';
  return (
    `You are ${a.name || 'a helpful assistant'}, the Apple Messages for Business agent for ${company} ` +
    `(${type}).${useCase} Greet customers warmly, understand their request, and offer clear ` +
    `suggested actions. Keep replies short and friendly. Escalate to a human when the customer ` +
    `asks, is frustrated, or the request is outside your scope.`
  );
}

export function defaultGuardrails(): string {
  return (
    '• Never share internal pricing, discounts, or refunds beyond published policy.\n' +
    '• Do not collect payment card numbers in chat.\n' +
    '• Hand off to a human for legal, medical, or billing disputes.\n' +
    '• Stay on topic; politely decline unrelated requests.'
  );
}

/**
 * Build the runtime system prompt from a stored agent. This is the single
 * source of truth used by BOTH preview and live Messages replies.
 */
export function buildSystemPrompt(agent: Pick<AgentRow, 'prompt' | 'guardrails'>): string {
  return (
    `${agent.prompt}\n\n` +
    (agent.guardrails ? `Guardrails:\n${agent.guardrails}\n\n` : '') +
    'Keep replies to 1-3 short sentences, friendly and helpful, as if texting a customer.'
  );
}
