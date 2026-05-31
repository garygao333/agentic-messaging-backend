import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';
import { agents } from './routes/agents.js';
import { webhook } from './routes/webhook.js';

const app = new Hono();

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'agentic-messaging-backend',
    supabaseKey: env.usingServiceKey ? 'service' : 'anon',
    model: env.openaiModel,
    businessId: env.mspBusinessId,
  }),
);

app.route('/', agents);
app.route('/', webhook);

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[backend] listening on :${info.port} (supabase=${env.usingServiceKey ? 'service' : 'anon'})`);
});
