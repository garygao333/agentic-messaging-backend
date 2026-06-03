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
  kind?: string;
  attachments?: unknown[];
  interactive?: unknown;
  tapbacks?: unknown[];
  richLink?: unknown;
  payload?: Record<string, unknown>;
}

const EMPTY_REPLY = "Sorry, I didn't catch that. Could you rephrase?";
const UNSUPPORTED_ACTION_REPLY =
  "I can't complete that directly in Messages, but I can collect the details and connect you with the team.";

const UNSUPPORTED_COMPLETION_RE =
  /\b(i('|’)ve|i have|i just|all set|done)[^.!?\n]{0,100}\b(booked|scheduled|cancelled|canceled|refunded|processed|submitted|sent|emailed|updated|changed|ordered|charged|transferred|connected|opened (a )?ticket|created (a )?ticket)\b/i;

function compact(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampReply(text: string): string {
  const reply = compact(text);
  if (!reply) return EMPTY_REPLY;
  if (/as an ai language model/i.test(reply)) return EMPTY_REPLY;
  if (UNSUPPORTED_COMPLETION_RE.test(reply)) return UNSUPPORTED_ACTION_REPLY;

  const hasUrl = /\bhttps?:\/\/|\bwww\.|\b[\w-]+\.(com|net|org|io|co|ai)\b/i.test(reply);
  const short = hasUrl
    ? reply
    : (reply.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((item) => item.trim()).filter(Boolean) ?? [reply])
        .slice(0, 3)
        .join(' ');
  if (short.length <= 420) return short;
  const clipped = short.slice(0, 421);
  return `${(clipped.slice(0, clipped.lastIndexOf(' ')) || clipped.slice(0, 420)).trim()}...`;
}

function turnContent(turn: HistoryTurn): string {
  const text = compact(turn.text);
  if (text) return text;
  if (Array.isArray(turn.attachments) && turn.attachments.length > 0) {
    return turn.role === 'customer'
      ? '[Customer sent an attachment. If you cannot inspect it, ask them to describe it.]'
      : '[Agent sent an attachment.]';
  }
  if (turn.interactive) {
    return turn.role === 'customer'
      ? '[Customer tapped an Apple Messages interactive option.]'
      : '[Agent sent an Apple Messages interactive option.]';
  }
  if (Array.isArray(turn.tapbacks) && turn.tapbacks.length > 0) {
    return '[Customer sent a tapback reaction.]';
  }
  return '[Empty message]';
}

export async function chatReply(
  agent: Pick<AgentRow, 'prompt' | 'guardrails'> &
    Partial<Pick<AgentRow, 'company_name' | 'website' | 'business_type' | 'use_case' | 'handoff_destination'>>,
  history: HistoryTurn[],
): Promise<string> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(agent) },
      ...history.slice(-16).map<ChatMessage>((m) => ({
        role: m.role === 'customer' ? 'user' : 'assistant',
        content: turnContent(m),
      })),
    ];
    const reply = await complete(messages);
    return clampReply(reply);
  } catch (err) {
    console.warn('[llm] chatReply error:', err);
    return "I'm having trouble responding right now. Please try again in a moment.";
  }
}
