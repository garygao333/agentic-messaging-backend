import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { env } from '../env.js';
import { logConversationEvent } from '../runtime/handoff.js';

export const payments = new Hono();

function domainAssociationFile(): string | null {
  if (env.applePayDomainAssociationText) return env.applePayDomainAssociationText;
  if (env.applePayDomainAssociationBase64) {
    return Buffer.from(env.applePayDomainAssociationBase64, 'base64').toString('utf8');
  }
  if (env.applePayDomainAssociationPath) return readFileSync(env.applePayDomainAssociationPath, 'utf8');
  return null;
}

function shallowShape(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(input).map(([key, entry]) => {
      if (entry === null || entry === undefined) return [key, entry];
      if (Array.isArray(entry)) return [key, { type: 'array', length: entry.length }];
      if (typeof entry === 'object') return [key, { type: 'object', keys: Object.keys(entry) }];
      return [key, { type: typeof entry }];
    }),
  );
}

payments.post('/payments/apple-pay/gateway', async (c) => {
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }

  await logConversationEvent({
    conversationId: null,
    eventType: 'apple_pay_gateway_callback',
    actor: 'msp',
    body: 'Apple Pay gateway callback received',
    payload: {
      receivedAt: new Date().toISOString(),
      headers: {
        contentType: c.req.header('content-type') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      },
      shape: shallowShape(body),
    },
  });

  return c.json({
    ok: true,
    status: 'received',
  });
});

payments.get('/.well-known/apple-developer-merchantid-domain-association', (c) => {
  const file = domainAssociationFile();
  if (!file) return c.text('Apple Pay domain association file is not configured', 404);
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(file);
});
