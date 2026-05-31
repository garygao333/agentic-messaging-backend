/** Low-level OpenAI chat client. Mirrors the app's settings (temp 0.6, json mode). */
import OpenAI from 'openai';
import { env } from '../env.js';

const client = new OpenAI({ apiKey: env.openaiKey });

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function complete(
  messages: ChatMessage[],
  opts: { json?: boolean } = {},
): Promise<string> {
  const res = await client.chat.completions.create({
    model: env.openaiModel,
    messages,
    temperature: 0.6,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  });
  return res.choices[0]?.message?.content ?? '';
}
