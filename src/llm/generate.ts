/**
 * `POST /agents/generate` logic — generate an agent's messaging config from
 * onboarding inputs. Response shape matches the app's `AgentConfig`
 * (src/services/llm.ts) so the client swap is a no-op.
 */
import { complete } from './openai.js';
import {
  defaultGuardrails,
  defaultPrompt,
  previewFor,
  type AgentDraftInput,
} from './prompt.js';

export interface AgentConfig {
  prompt: string;
  guardrails: string;
  welcomeMessage: string;
  suggestedActions: string[];
}

const GENERATION_SYSTEM_PROMPT = [
  'You design runtime configs for Apple Messages for Business agents.',
  'The product flow is App Clip first: the customer creates the agent from an App Clip, then immediately keeps texting the same Apple Messages thread to test the live agent.',
  'Use every supplied business clue: website, company/name, business type, use case, tone, integrations, and handoff destination. If a field is missing, stay generic instead of inventing details.',
  'Return ONLY valid JSON with keys: prompt, guardrails, welcomeMessage, suggestedActions.',
  'prompt: 4-6 compact sentences for the live runtime. Include business grounding, same-thread first-run behavior, Apple Messages texting style, concrete handoff rules, and a rule not to claim unsupported external actions.',
  'guardrails: short bullet list as one string. Include no payment-card collection, no invented policies/prices/availability, and human handoff for risky or out-of-scope work.',
  'welcomeMessage: first live message after setup, 1-2 short Apple Messages sentences. Confirm the agent is live in this thread and invite a test customer request.',
  'suggestedActions: array of 2-4 concise tappable labels, each 2-24 characters, no trailing punctuation.',
].join('\n');

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

function cleanAction(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`.!?]+$/g, '')
    .trim()
    .slice(0, 24)
    .trim();
}

function cleanActions(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<string>();
  const actions = value
    .map(cleanAction)
    .filter((action) => {
      const key = action.toLowerCase();
      if (!action || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
  return actions.length >= 2 ? actions : fallback;
}

export async function generateAgentConfig(draft: AgentDraftInput): Promise<AgentConfig> {
  const preview = previewFor(draft.businessType);
  const fallback: AgentConfig = {
    prompt: defaultPrompt(draft),
    guardrails: defaultGuardrails(),
    welcomeMessage: preview.agent,
    suggestedActions: preview.actions,
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
          }),
        },
      ],
      { json: true },
    );
    const parsed = JSON.parse(content);
    return {
      prompt: cleanMultiline(parsed.prompt, fallback.prompt, 1800),
      guardrails: cleanMultiline(parsed.guardrails, fallback.guardrails, 1200),
      welcomeMessage: compactText(parsed.welcomeMessage, fallback.welcomeMessage, 240),
      suggestedActions: cleanActions(parsed.suggestedActions, fallback.suggestedActions),
    };
  } catch (err) {
    console.warn('[llm] generateAgentConfig fell back to template:', err);
    return fallback;
  }
}
