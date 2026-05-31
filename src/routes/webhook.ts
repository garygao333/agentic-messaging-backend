/** 1440 inbound webhook (plain + Bot Webhook). Always 200s fast; work is best-effort. */
import { Hono } from 'hono';
import { parseInbound } from '../msp/parse.js';
import { handleInbound } from '../runtime/handlers.js';

export const webhook = new Hono();

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

  // Only customer-originated message/interactive events drive the agent.
  const actionable =
    event.endsWith('message.received') || event.endsWith('interactive') || evt.eventType === 'message.received';

  if (actionable && evt.customerId) {
    // Fire-and-forget so we ACK 1440 quickly (it retries non-2xx up to 3x).
    handleInbound(evt.customerId, evt.text, evt.selections, evt.conversationId).catch((err) =>
      console.error('[webhook] handler error:', err),
    );
  } else {
    console.log(`[webhook] ignored event=${event} customer=${evt.customerId ?? 'none'}`);
  }

  return c.json({ ok: true });
});
