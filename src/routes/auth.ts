import { Hono } from 'hono';
import { requireAppAuth } from '../auth.js';
import { supabase } from '../supabase.js';

export const auth = new Hono();

auth.use('/auth/*', requireAppAuth);

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const loginBody = (code: string) => `LOGIN ${code}`;

auth.post('/auth/messages/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = genCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await supabase.from('auth_codes').insert({
    code,
    apple_id: typeof body.handle === 'string' ? body.handle : null,
    verified: false,
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[auth] failed to issue login code:', error);
    return c.json({ error: 'could not issue login code' }, 500);
  }

  return c.json({ code, messageBody: loginBody(code), expiresAt });
});

auth.post('/auth/messages/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code ?? '').trim();
  if (!code) return c.json({ ok: false }, 400);

  const { data, error } = await supabase
    .from('auth_codes')
    .select('id, expires_at, verified')
    .eq('code', code)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[auth] failed to verify login code:', error);
    return c.json({ error: 'could not verify login code' }, 500);
  }

  const row = data?.[0];
  const ok = Boolean(
    row?.verified &&
      (!row.expires_at || new Date(row.expires_at).getTime() >= Date.now()),
  );

  return c.json({ ok });
});
