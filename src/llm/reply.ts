/**
 * Next-reply logic. Used by BOTH the in-app preview chat and the live Messages
 * runtime so the two are identical. `history` roles are the app's domain roles
 * ('customer' | 'agent').
 */
import type { AgentRow } from '../supabase.js';
import { buildSystemPrompt } from './prompt.js';
import { complete, type ChatMessage } from './openai.js';

export interface HistoryTurn {
  role: 'customer' | 'agent';
  text: string;
}

export async function chatReply(
  agent: Pick<AgentRow, 'prompt' | 'guardrails'>,
  history: HistoryTurn[],
): Promise<string> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(agent) },
      ...history.map<ChatMessage>((m) => ({
        role: m.role === 'customer' ? 'user' : 'assistant',
        content: m.text,
      })),
    ];
    const reply = await complete(messages);
    return reply.trim() || "Sorry, I didn't catch that — could you rephrase?";
  } catch (err) {
    console.warn('[llm] chatReply error:', err);
    return "I'm having trouble responding right now. Please try again in a moment.";
  }
}
