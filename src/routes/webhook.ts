/** 1440 inbound webhook (plain + Bot Webhook). Always 200s fast; work is best-effort. */
import { Hono } from 'hono';
import { parseInbound } from '../msp/parse.js';
import { handleInbound } from '../runtime/handlers.js';
import { requireAppAuth } from '../auth.js';

export const webhook = new Hono();

// --- DEBUG: ring buffer of the last few raw inbound payloads. ---
// Lets us inspect exactly what 1440 sends without Railway log access.
// Auth-gated by APP_SHARED_TOKEN. Remove entirely before production.
interface DebugEntry {
  at: string;
  event: string | null;
  parsed: {
    eventType: string;
    customerId: string | null;
    conversationId: string | null;
    text: string | null;
    selections: string[];
  };
  fieldMap: WebhookFieldMap;
}

interface WebhookFieldMap {
  topLevelKeys: string[];
  identityCandidates: {
    senderIds: string[];
    conversationIds: string[];
    phoneLike: string[];
    emailLike: string[];
    displayNames: string[];
  };
  notablePaths: string[];
}

function pathLooksLike(path: string, terms: string[]): boolean {
  const normalized = path.toLowerCase().replace(/[^a-z0-9]/g, '');
  return terms.some((term) => normalized.includes(term));
}

function valueLooksLikePhone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && /^[+\d().\-\s]+$/.test(value);
}

function valueLooksLikeEmail(value: unknown): boolean {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function summarizeValue(value: unknown): string {
  if (typeof value !== 'string') return typeof value;
  if (value.startsWith('urn:mbid:')) return `urn:mbid:${value.slice(9, 21)}...`;
  if (valueLooksLikeEmail(value)) {
    const [local, domain] = value.split('@');
    return `${(local ?? '').slice(0, 2)}***@${domain ?? 'unknown'}`;
  }
  if (valueLooksLikePhone(value)) {
    const digits = value.replace(/\D/g, '');
    return `phone:***${digits.slice(-4)}`;
  }
  return `text:${value.length}`;
}

function pushCandidate(list: string[], path: string, value: unknown): void {
  const item = `${path}=${summarizeValue(value)}`;
  if (!list.includes(item)) list.push(item);
}

function inspectWebhookFields(raw: unknown): WebhookFieldMap {
  const topLevelKeys =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw as Record<string, unknown>).sort()
      : [];
  const fieldMap: WebhookFieldMap = {
    topLevelKeys,
    identityCandidates: {
      senderIds: [],
      conversationIds: [],
      phoneLike: [],
      emailLike: [],
      displayNames: [],
    },
    notablePaths: [],
  };
  const notableTerms = [
    'source',
    'sender',
    'from',
    'customer',
    'conversation',
    'phone',
    'mobile',
    'msisdn',
    'email',
    'apple',
    'handle',
    'name',
    'destination',
  ];

  function visit(value: unknown, path: string, depth: number): void {
    if (depth > 7 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.slice(0, 10).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== 'object') {
      if (!pathLooksLike(path, notableTerms) && !valueLooksLikePhone(value) && !valueLooksLikeEmail(value)) return;
      if (fieldMap.notablePaths.length < 80) fieldMap.notablePaths.push(`${path}:${typeof value}`);
      if (pathLooksLike(path, ['source', 'sender', 'from', 'customerid', 'abcuserid']) || String(value).startsWith('urn:mbid:')) {
        pushCandidate(fieldMap.identityCandidates.senderIds, path, value);
      }
      if (pathLooksLike(path, ['conversationid', 'conversation'])) {
        pushCandidate(fieldMap.identityCandidates.conversationIds, path, value);
      }
      if (pathLooksLike(path, ['phone', 'mobile', 'msisdn']) || valueLooksLikePhone(value)) {
        pushCandidate(fieldMap.identityCandidates.phoneLike, path, value);
      }
      if (pathLooksLike(path, ['email', 'appleid']) || valueLooksLikeEmail(value)) {
        pushCandidate(fieldMap.identityCandidates.emailLike, path, value);
      }
      if (pathLooksLike(path, ['displayname', 'customername', 'sendername', 'fromname', 'handle', 'name'])) {
        pushCandidate(fieldMap.identityCandidates.displayNames, path, value);
      }
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  }

  visit(raw, '', 0);
  return fieldMap;
}
const recentWebhooks: DebugEntry[] = [];
function record(e: DebugEntry) {
  recentWebhooks.unshift(e);
  if (recentWebhooks.length > 25) recentWebhooks.pop();
}

function headerSecretCandidates(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearer?.[1]) candidates.push(bearer[1].trim());
  const token = /^Token\s+(.+)$/i.exec(trimmed);
  if (token?.[1]) candidates.push(token[1].trim());
  return candidates;
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  const paddedA = a.padEnd(len, '\0');
  const paddedB = b.padEnd(len, '\0');
  let diff = 0;
  for (let i = 0; i < len; i += 1) {
    diff |= paddedA.charCodeAt(i) ^ paddedB.charCodeAt(i);
  }
  return diff === 0 && a.length === b.length;
}

function verifyWebhookRequest(c: any): boolean {
  const expected = process.env.MSP_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  const headerNames = [
    'Authorization',
    'X-Webhook-Secret',
    'X-Webhook-Token',
    'X-MSP-Webhook-Secret',
    'X-MSP-Webhook-Token',
    'X-1440-Webhook-Secret',
    'X-1440-Webhook-Token',
    'X-1440-Signature',
    'X-Webhook-Signature',
  ];
  const candidates = headerNames.flatMap((name) => headerSecretCandidates(c.req.header(name)));
  return candidates.some((candidate) => constantTimeEqual(candidate, expected));
}

function conversationIdFromHeaders(c: any): string | null {
  return (
    c.req.header('X-Conversation-Id') ??
    c.req.header('X-MSP-Conversation-Id') ??
    c.req.header('X-1440-Conversation-Id') ??
    null
  );
}

webhook.get('/debug/webhooks', requireAppAuth, (c) =>
  c.json({ count: recentWebhooks.length, recent: recentWebhooks }),
);

webhook.post('/webhook', async (c) => {
  if (!verifyWebhookRequest(c)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }

  const evt = parseInbound(body);
  const event = c.req.header('X-Webhook-Event') ?? evt.eventType;
  const conversationId = evt.conversationId ?? conversationIdFromHeaders(c);
  const fieldMap = inspectWebhookFields(body);

  record({
    at: new Date().toISOString(),
    event,
    parsed: {
      eventType: evt.eventType,
      customerId: evt.customerId,
      conversationId,
      text: evt.text,
      selections: evt.selections,
    },
    fieldMap,
  });
  console.log(`[webhook] event=${event} customer=${evt.customerId ?? 'none'} textPresent=${Boolean(evt.text)}`);
  console.log(
    `[webhook:fields] ${JSON.stringify({
      event,
      topLevelKeys: fieldMap.topLevelKeys,
      senderIds: fieldMap.identityCandidates.senderIds,
      conversationIds: fieldMap.identityCandidates.conversationIds,
      phoneLike: fieldMap.identityCandidates.phoneLike,
      emailLike: fieldMap.identityCandidates.emailLike,
      displayNames: fieldMap.identityCandidates.displayNames,
    })}`,
  );

  // Drive the agent on any customer-originated message that carries content.
  // NOTE: 1440 uses event_type "text" for text messages (not "message.received"
  // as the docs show), so match on content presence, excluding signal-only events.
  const IGNORE = ['typing_start', 'typing_end', 'close', 'agent_handback'];
  const isIgnored = IGNORE.some((t) => event.endsWith(t));
  const hasContent = evt.text !== null || evt.selections.length > 0 || evt.tapbacks.length > 0;
  const actionable = !isIgnored && hasContent;

  if (actionable && evt.customerId) {
    // Fire-and-forget so we ACK 1440 quickly (it retries non-2xx up to 3x).
    handleInbound(evt.customerId, evt.text, evt.selections, conversationId, {
      eventType: event,
      attachments: evt.attachments,
      interactive: evt.interactive,
      tapbacks: evt.tapbacks,
      raw: evt.raw,
    }).catch((err) => console.error('[webhook] handler error:', err));
  } else {
    console.log(`[webhook] ignored event=${event} customer=${evt.customerId ?? 'none'}`);
  }

  return c.json({ ok: true });
});
