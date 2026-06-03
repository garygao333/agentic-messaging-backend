import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './env.js';
import { auth } from './routes/auth.js';
import { agents } from './routes/agents.js';
import { operator } from './routes/operator.js';
import { setup } from './routes/setup.js';
import { webhook } from './routes/webhook.js';

const app = new Hono();

app.use(
  '/auth/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  }),
);
app.use(
  '/agents/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['POST', 'OPTIONS'],
  }),
);
app.use(
  '/operator/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  }),
);
app.use(
  '/app-clip/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['POST', 'OPTIONS'],
  }),
);
app.use(
  '/setup/*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['POST', 'OPTIONS'],
  }),
);

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'agentic-messaging-backend',
  }),
);

app.route('/', auth);
app.route('/', agents);
app.route('/', operator);
app.route('/', setup);
app.route('/', webhook);

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[backend] listening on :${info.port} (supabase=${env.usingServiceKey ? 'service' : 'anon'})`);
});
