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
          content:
            'You design Apple Messages for Business agents. Return ONLY JSON with keys: ' +
            'prompt (a concise system prompt, 2-4 sentences), guardrails (short bullet list as a single string), ' +
            'welcomeMessage (the first message the agent sends a customer, 1-2 sentences), ' +
            'suggestedActions (array of 2-4 short tappable reply labels).',
        },
        {
          role: 'user',
          content: JSON.stringify({
            agentName: draft.name,
            company: draft.companyName,
            website: draft.website,
            businessType: draft.businessType,
            useCase: draft.useCase,
            integrations: draft.integrations,
            handoff: draft.handoffDestination,
          }),
        },
      ],
      { json: true },
    );
    const parsed = JSON.parse(content);
    return {
      prompt: typeof parsed.prompt === 'string' && parsed.prompt ? parsed.prompt : fallback.prompt,
      guardrails:
        typeof parsed.guardrails === 'string' && parsed.guardrails
          ? parsed.guardrails
          : fallback.guardrails,
      welcomeMessage:
        typeof parsed.welcomeMessage === 'string' && parsed.welcomeMessage
          ? parsed.welcomeMessage
          : fallback.welcomeMessage,
      suggestedActions:
        Array.isArray(parsed.suggestedActions) && parsed.suggestedActions.length
          ? parsed.suggestedActions.slice(0, 4).map(String)
          : fallback.suggestedActions,
    };
  } catch (err) {
    console.warn('[llm] generateAgentConfig fell back to template:', err);
    return fallback;
  }
}
