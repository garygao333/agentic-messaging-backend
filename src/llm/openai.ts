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

export interface WebSearchResponse {
  text: string;
  sources: Array<{ title?: string; url: string }>;
  usedSearch: boolean;
}

export interface WebSearchOptions {
  jsonSchema?: Record<string, unknown>;
  requireSearch?: boolean;
}

class OpenAIResponseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string | null,
  ) {
    super(message);
  }
}

function outputText(response: any): string {
  if (typeof response?.output_text === 'string') return response.output_text;
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function addSource(out: Array<{ title?: string; url: string }>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url : null;
  if (!url || !/^https?:\/\//i.test(url)) return;
  const title = typeof record.title === 'string' ? record.title : undefined;
  if (!out.some((item) => item.url === url)) out.push({ title, url });
}

function collectSearchSources(response: unknown): Array<{ title?: string; url: string }> {
  const out: Array<{ title?: string; url: string }> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'web_search_call') {
      const action = record.action && typeof record.action === 'object'
        ? (record.action as Record<string, unknown>)
        : {};
      const sources = Array.isArray(action.sources) ? action.sources : [];
      sources.forEach((source) => addSource(out, source));
    }
    if (record.type === 'url_citation') addSource(out, record);
    if (Array.isArray(record.annotations)) record.annotations.forEach(visit);
    if (Array.isArray(record.content)) record.content.forEach(visit);
    if (Array.isArray(record.output)) record.output.forEach(visit);
  };
  visit(response);
  return out;
}

function usedWebSearch(response: unknown): boolean {
  const output = (response as any)?.output;
  return Array.isArray(output) && output.some((item) => item?.type === 'web_search_call');
}

function assertCompleted(payload: any): void {
  const status = typeof payload?.status === 'string' ? payload.status : '';
  if (!status || status === 'completed') return;
  const detail = payload?.error?.message ?? payload?.incomplete_details?.reason ?? status;
  throw new OpenAIResponseError(`OpenAI response ${status}: ${detail}`, undefined, payload?.error?.code, payload?.id);
}

function unsupportedToolError(err: unknown): boolean {
  if (!(err instanceof OpenAIResponseError)) return false;
  if (err.status !== 400) return false;
  return /web_search|external_web_access|unknown tool|invalid tool|unsupported tool|not supported|not available/i.test(err.message);
}

async function createResponse(params: Record<string, unknown>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = typeof payload?.error?.message === 'string'
        ? payload.error.message
        : `OpenAI Responses API returned ${res.status}`;
      throw new OpenAIResponseError(
        message,
        res.status,
        typeof payload?.error?.code === 'string' ? payload.error.code : undefined,
        res.headers.get('x-request-id') ?? payload?.id ?? null,
      );
    }
    assertCompleted(payload);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function responseWithWebSearch(
  input: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const params: Record<string, unknown> = {
    model: process.env.OPENAI_RESEARCH_MODEL ?? env.openaiModel,
    input,
    tools: [{ type: 'web_search', external_web_access: true }],
    tool_choice: options.requireSearch ? 'required' : 'auto',
    include: ['web_search_call.action.sources'],
    store: false,
  };
  if (options.jsonSchema) {
    params.text = {
      format: {
        type: 'json_schema',
        name: 'business_research',
        strict: true,
        schema: options.jsonSchema,
      },
    };
  }

  try {
    const response = await createResponse(params);
    return {
      text: outputText(response),
      sources: collectSearchSources(response).slice(0, 12),
      usedSearch: usedWebSearch(response),
    };
  } catch (err) {
    if (!unsupportedToolError(err)) throw err;
    const fallback = {
      ...params,
      tools: [{ type: 'web_search_preview' }],
      include: ['web_search_call.action.sources'],
    };
    const response = await createResponse(fallback);
    return {
      text: outputText(response),
      sources: collectSearchSources(response).slice(0, 12),
      usedSearch: usedWebSearch(response),
    };
  }
}
