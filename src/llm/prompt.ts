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
import { parseBusinessResearchProfile, type BusinessResearchProfile } from './businessResearch.js';

export interface AgentDraftInput {
  name?: string;
  companyName?: string;
  website?: string;
  businessType?: string;
  useCase?: string;
  tone?: string;
  integrations?: string[];
  handoffDestination?: string;
  businessResearch?: BusinessResearchProfile | null;
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
  const research = researchContext(a.businessResearch);
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
    `Offer concrete next steps or concise suggested actions when helpful.${research}${handoff}`
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

function researchContext(research?: BusinessResearchProfile | null): string {
  if (!research || research.status !== 'researched') return '';
  const contact = research.contact ?? {};
  const offerings = Array.isArray(research.offerings) ? research.offerings : [];
  const locations = Array.isArray(research.locations) ? research.locations : [];
  const policies = Array.isArray(research.policies) ? research.policies : [];
  return [
    research.summary ? ` Research summary: ${research.summary}` : '',
    offerings.length ? ` Known offerings: ${offerings.join(', ')}.` : '',
    locations.length ? ` Known locations: ${locations.join('; ')}.` : '',
    research.hours ? ` Known hours: ${research.hours}.` : '',
    contact.bookingUrl ? ` Booking URL: ${contact.bookingUrl}.` : '',
    policies.length ? ` Known policies: ${policies.join('; ')}.` : '',
  ].filter(Boolean).join('');
}

function provenanceResearch(agent: Partial<Pick<AgentRow, 'provenance'>>): BusinessResearchProfile | null {
  return parseBusinessResearchProfile(agent.provenance?.businessResearch);
}

function renderResearchForPrompt(research: BusinessResearchProfile | null): string {
  if (!research || research.status !== 'researched') return '';
  const contact = research.contact ?? {};
  const offerings = Array.isArray(research.offerings) ? research.offerings : [];
  const locations = Array.isArray(research.locations) ? research.locations : [];
  const policies = Array.isArray(research.policies) ? research.policies : [];
  const sourceUrls = Array.isArray(research.sourceUrls) ? research.sourceUrls : [];
  const lines = [
    research.businessName ? `Researched business name: ${research.businessName}` : '',
    research.website ? `Researched website: ${research.website}` : '',
    research.category ? `Category: ${research.category}` : '',
    research.summary ? `Summary: ${research.summary}` : '',
    offerings.length ? `Offerings: ${offerings.join(', ')}` : '',
    locations.length ? `Locations: ${locations.join('; ')}` : '',
    research.hours ? `Hours: ${research.hours}` : '',
    contact.phone ? `Phone: ${contact.phone}` : '',
    contact.email ? `Email: ${contact.email}` : '',
    contact.address ? `Address: ${contact.address}` : '',
    contact.bookingUrl ? `Booking URL: ${contact.bookingUrl}` : '',
    policies.length ? `Known policies: ${policies.join('; ')}` : '',
    sourceUrls.length
      ? `Research sources: ${sourceUrls.map((source) => source.url).join(', ')}`
      : '',
    `Research confidence: ${research.confidence}`,
  ].filter(Boolean);
  return lines.length ? `Researched business facts:\n${lines.join('\n')}` : '';
}

/**
 * Build the runtime system prompt from a stored agent. This is the single
 * source of truth used by BOTH preview and live Messages replies.
 */
export function buildSystemPrompt(
  agent: Pick<AgentRow, 'prompt' | 'guardrails'> &
    Partial<Pick<AgentRow, 'company_name' | 'website' | 'business_type' | 'use_case' | 'handoff_destination' | 'provenance'>>,
): string {
  const research = renderResearchForPrompt(provenanceResearch(agent));
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
    research,
    agent.guardrails ? `Guardrails:\n${agent.guardrails}` : '',
    `Apple Messages runtime rules:
- Write like a business texting a customer: 1-2 short sentences, usually under 320 characters.
- Do not use markdown, long menus, or multi-paragraph explanations unless the customer explicitly asks.
- You can answer questions, ask for missing details, suggest next steps, or recommend handoff.
- If the customer asks a domain-specific question, ask for the smallest missing detail needed for that workflow. Examples: flights need airline/flight number/date or route; appointments need service/date/time/name; orders need order number/email; quotes need location/job details.
- Never answer with generic vertical labels like "E-commerce", "Healthcare", or "Home services" unless the customer is explicitly choosing a business category during setup.
- When you do not know a policy, price, availability, account status, or booking result, say what you can collect and offer handoff. Do not fabricate.
- Treat researched facts as grounding, not live system truth. If confidence is low or the customer needs current availability, account status, price, or policy confirmation, qualify the answer and offer handoff.
- Do not send research source URLs unless the customer asks for a link or source.
- Do not claim you booked, cancelled, refunded, charged, updated, emailed, opened a ticket, transferred, or changed anything unless the conversation history says a runtime tool or human already did it.
- If an attachment, account lookup, payment, booking, refund, policy exception, or external system action is needed, say what detail you need or offer handoff instead of pretending to complete it.
- ${handoff}`,
  ].filter(Boolean).join('\n\n');
}
