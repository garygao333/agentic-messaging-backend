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
  parsed: { eventType: string; customerId: string | null; text: string | null; selections: string[] };
  raw: unknown;
}
const recentWebhooks: DebugEntry[] = [];
function record(e: DebugEntry) {
  recentWebhooks.unshift(e);
  if (recentWebhooks.length > 25) recentWebhooks.pop();
}

webhook.get('/debug/webhooks', requireAppAuth, (c) =>
  c.json({ count: recentWebhooks.length, recent: recentWebhooks }),
);

webhook.post('/webhook', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }

  // TODO(security): verify 1440's signature/secret here once confirmed
  // (env.mspWebhookSecret). 1440's exact webhook-auth mechanism is TBC.

  const evt = parseInbound(body);
  const event = c.req.header('X-Webhook-Event') ?? evt.eventType;

  record({
    at: new Date().toISOString(),
    event,
    parsed: {
      eventType: evt.eventType,
      customerId: evt.customerId,
      text: evt.text,
      selections: evt.selections,
    },
    raw: body,
  });
  console.log(`[webhook] event=${event} customer=${evt.customerId ?? 'none'} text=${JSON.stringify(evt.text)}`);

  // Drive the agent on any customer-originated message that carries content.
  // NOTE: 1440 uses event_type "text" for text messages (not "message.received"
  // as the docs show), so match on content presence, excluding signal-only events.
  const IGNORE = ['typing_start', 'typing_end', 'close', 'agent_handback'];
  const isIgnored = IGNORE.some((t) => event.endsWith(t));
  const hasContent = evt.text !== null || evt.selections.length > 0;
  const actionable = !isIgnored && hasContent;

  if (actionable && evt.customerId) {
    // Fire-and-forget so we ACK 1440 quickly (it retries non-2xx up to 3x).
    handleInbound(evt.customerId, evt.text, evt.selections, evt.conversationId, {
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
