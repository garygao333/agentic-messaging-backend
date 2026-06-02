import { Hono } from 'hono';
import { supabase } from '../supabase.js';

export const auth = new Hono();

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const loginBody = (code: string) => `LOGIN ${code}`;

function bearerToken(header?: string) {
  return header?.replace(/^Bearer\s+/i, '').trim() || '';
}

async function getWorkspaceUser(c: any) {
  const token = bearerToken(c.req.header('Authorization'));
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function requireWorkspaceUser(c: any) {
  const user = await getWorkspaceUser(c);
  if (!user) {
    return {
      user: null,
      response: c.json({ error: 'Sign in before connecting Messages.' }, 401),
    };
  }
  return { user, response: null };
}

function mapIdentity(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    displayHandle: row.display_handle ?? null,
    verifiedAt: row.verified_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
  };
}

async function getIdentity(workspaceUserId: string) {
  const { data, error } = await supabase
    .from('workspace_message_identities')
    .select('id, customer_id, display_handle, verified_at, last_seen_at')
    .eq('workspace_user_id', workspaceUserId)
    .maybeSingle();

  if (error) throw error;
  return mapIdentity(data);
}

auth.get('/auth/messages/identity', async (c) => {
  const { user, response } = await requireWorkspaceUser(c);
  if (response) return response;

  try {
    const identity = await getIdentity(user!.id);
    return c.json({ connected: Boolean(identity), identity });
  } catch (error) {
    console.error('[auth] failed to load Messages identity:', error);
    return c.json({ error: 'could not load Messages identity' }, 500);
  }
});

auth.patch('/auth/messages/identity', async (c) => {
  const { user, response } = await requireWorkspaceUser(c);
  if (response) return response;

  const body = await c.req.json().catch(() => ({}));
  const rawHandle = typeof body.displayHandle === 'string' ? body.displayHandle.trim() : '';
  const displayHandle = rawHandle || null;

  try {
    const { data, error } = await supabase
      .from('workspace_message_identities')
      .update({
        display_handle: displayHandle,
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_user_id', user!.id)
      .select('id, customer_id, display_handle, verified_at, last_seen_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) return c.json({ error: 'Messages is not connected for this workspace.' }, 404);
    return c.json({ identity: mapIdentity(data) });
  } catch (error) {
    console.error('[auth] failed to update Messages identity:', error);
    return c.json({ error: 'could not update Messages identity' }, 500);
  }
});

auth.post('/auth/messages/start', async (c) => {
  const { user, response } = await requireWorkspaceUser(c);
  if (response) return response;

  const body = await c.req.json().catch(() => ({}));
  const code = genCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const displayHandle = typeof body.handle === 'string' ? body.handle.trim() : '';

  const { error } = await supabase.from('auth_codes').insert({
    code,
    workspace_user_id: user!.id,
    apple_id: displayHandle || null,
    display_handle: displayHandle || null,
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
  const { user, response } = await requireWorkspaceUser(c);
  if (response) return response;

  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code ?? '').trim();
  if (!code) return c.json({ ok: false }, 400);

  const { data, error } = await supabase
    .from('auth_codes')
    .select('id, customer_id, display_handle, expires_at, verified')
    .eq('code', code)
    .eq('workspace_user_id', user!.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[auth] failed to verify login code:', error);
    return c.json({ error: 'could not verify login code' }, 500);
  }

  const row = data?.[0];
  const expired = Boolean(row?.expires_at && new Date(row.expires_at).getTime() < Date.now());
  const ok = Boolean(row?.verified && !expired);
  let identity = ok ? await getIdentity(user!.id).catch(() => null) : null;

  if (ok && !identity && row?.customer_id) {
    const now = new Date().toISOString();
    const { data: upserted, error: identityError } = await supabase
      .from('workspace_message_identities')
      .upsert(
        {
          workspace_user_id: user!.id,
          customer_id: row.customer_id,
          display_handle: row.display_handle ?? null,
          verified_at: now,
          last_seen_at: now,
          updated_at: now,
        },
        { onConflict: 'workspace_user_id' },
      )
      .select('id, customer_id, display_handle, verified_at, last_seen_at')
      .maybeSingle();

    if (identityError) console.warn('[auth] identity upsert skipped:', identityError);
    identity = mapIdentity(upserted);
  }

  return c.json({
    ok,
    status: expired ? 'expired' : ok ? 'verified' : 'pending',
    identity,
  });
});
