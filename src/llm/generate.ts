/**
 * `POST /agents/generate` logic — generate an agent's messaging config from
 * onboarding inputs. Response shape matches the app's `AgentConfig`
 * (src/services/llm.ts) so the client swap is a no-op.
 */
import { complete } from './openai.js';
import { researchBusinessProfile, type BusinessResearchProfile } from './businessResearch.js';
import {
  defaultGuardrails,
  defaultPrompt,
  previewFor,
  type AgentDraftInput,
} from './prompt.js';
import { uniqueActionLabels } from '../runtime/actionLabels.js';

export interface AgentConfig {
  prompt: string;
  guardrails: string;
  welcomeMessage: string;
  suggestedActions: string[];
  businessResearch?: BusinessResearchProfile | null;
}

const GENERATION_SYSTEM_PROMPT = [
  'You are a production prompt architect for Apple Messages for Business agents.',
  'The product flow is App Clip first: the customer creates the agent from an App Clip, then immediately keeps texting the same Apple Messages thread to test the live agent.',
  'Use every supplied business clue: website, company/name, business type, use case, tone, integrations, handoff destination, and researched business facts. If a field is missing, stay generic instead of inventing details.',
  'Return ONLY valid JSON with keys: prompt, guardrails, welcomeMessage, suggestedActions.',
  'prompt: 6-9 compact sentences for the live runtime. It must define the agent identity, likely customer intents, the exact details to collect for those intents, what the agent can and cannot complete, and when to hand off.',
  'The prompt must be workflow-specific. For airlines/travel, collect flight number/date/route and clarify that live flight/account changes require official systems or human handoff. For appointments, collect service/date/time/name. For ecommerce, collect order number/email and issue type.',
  'guardrails: short bullet list as one string. Include no payment-card collection, no invented policies/prices/availability/account status, and human handoff for risky, out-of-scope, billing, identity, or live-system work.',
  'welcomeMessage: first live message after setup, 1-2 short Apple Messages sentences. Confirm the agent is live and name what it can help test.',
  'suggestedActions: array of 2-4 concise domain-specific tappable labels, each 2-24 characters, no trailing punctuation. Never return generic setup categories like E-commerce, Healthcare, Home services, or Book demo unless this exact agent is a business-builder demo.',
].join('\n');

function isBusinessBuilderDraft(draft: AgentDraftInput): boolean {
  const haystack = [
    draft.name,
    draft.companyName,
    draft.website,
    draft.businessType,
    draft.useCase,
  ].join(' ').toLowerCase();
  return /\b(chert|trychert|agentic messaging|agent builder|business builder)\b/.test(haystack);
}

function compactText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) return fallback;
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength + 1);
  return (clipped.slice(0, clipped.lastIndexOf(' ')) || clipped.slice(0, maxLength)).trim();
}

function cleanMultiline(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string'
    ? value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
    : '';
  if (!text) return fallback;
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength + 1);
  return (clipped.slice(0, clipped.lastIndexOf('\n')) || clipped.slice(0, maxLength)).trim();
}

function cleanActions(value: unknown, fallback: string[], opts: { allowSetupCategories?: boolean } = {}): string[] {
  const actions = uniqueActionLabels(value, opts);
  const cleanFallback = uniqueActionLabels(fallback, opts);
  return actions.length >= 2 ? actions : cleanFallback.length >= 2 ? cleanFallback : fallback;
}

function researchDigest(research: BusinessResearchProfile | null | undefined): string {
  if (!research || research.status !== 'researched') return '';
  const parts = [
    research.summary,
    research.offerings?.length ? `Offerings: ${research.offerings.join(', ')}` : '',
    research.locations?.length ? `Locations: ${research.locations.join('; ')}` : '',
    research.contact?.bookingUrl ? `Booking URL: ${research.contact.bookingUrl}` : '',
    research.policies?.length ? `Known policies: ${research.policies.join('; ')}` : '',
  ].filter(Boolean);
  return parts.length ? `Researched grounding facts: ${parts.join(' ')}` : '';
}

function withResearchDigest(prompt: string, research: BusinessResearchProfile | null | undefined): string {
  const digest = researchDigest(research);
  if (!digest || prompt.includes('Researched grounding facts:')) return prompt;
  return cleanMultiline(`${prompt}\n${digest}`, prompt, 2200);
}

export async function generateAgentConfig(draft: AgentDraftInput): Promise<AgentConfig> {
  const businessResearch = draft.businessResearch ?? await researchBusinessProfile(draft);
  const enrichedDraft = { ...draft, businessResearch };
  const preview = previewFor(draft.businessType);
  const fallback: AgentConfig = {
    prompt: defaultPrompt(enrichedDraft),
    guardrails: defaultGuardrails(),
    welcomeMessage: preview.agent,
    suggestedActions: preview.actions,
    businessResearch,
  };

  try {
    const content = await complete(
      [
        {
          role: 'system',
          content: GENERATION_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: JSON.stringify({
            agentName: draft.name,
            company: draft.companyName,
            website: draft.website,
            businessType: draft.businessType,
            useCase: draft.useCase,
            tone: draft.tone,
            integrations: draft.integrations,
            handoff: draft.handoffDestination,
            businessResearch,
          }),
        },
      ],
      { json: true },
    );
    const parsed = JSON.parse(content);
    const prompt = cleanMultiline(parsed.prompt, fallback.prompt, 1800);
    return {
      prompt: withResearchDigest(prompt, businessResearch),
      guardrails: cleanMultiline(parsed.guardrails, fallback.guardrails, 1200),
      welcomeMessage: compactText(parsed.welcomeMessage, fallback.welcomeMessage, 240),
      suggestedActions: cleanActions(parsed.suggestedActions, fallback.suggestedActions, {
        allowSetupCategories: isBusinessBuilderDraft(draft),
      }),
      businessResearch,
    };
  } catch (err) {
    console.warn('[llm] generateAgentConfig fell back to template:', err);
    return fallback;
  }
}
