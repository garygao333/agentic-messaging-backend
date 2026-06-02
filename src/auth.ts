/**
 * App → backend auth guard for the LLM endpoints (they spend money).
 * MVP: a shared bearer token (APP_SHARED_TOKEN). If unset, the guard is
 * disabled with a warning — fine for local dev, NOT for production.
 *
 * Upgrade path: verify the caller's Supabase session JWT with SUPABASE_JWT_SECRET.
 */
import type { MiddlewareHandler } from 'hono';
import { env } from './env.js';
import { supabase } from './supabase.js';

let warnedOpenAuth = false;

async function isSupabaseUserToken(token: string): Promise<boolean> {
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  return Boolean(!error && data.user);
}

export const requireAppAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();

  if (env.appSharedToken && token === env.appSharedToken) {
    return next();
  }

  if (await isSupabaseUserToken(token)) {
    return next();
  }

  if (!env.appSharedToken && !env.requireAppAuth) {
    if (!warnedOpenAuth) {
      warnedOpenAuth = true;
      console.warn('[auth] APP_SHARED_TOKEN unset — app/operator endpoints are OPEN. Set it before deploying.');
    }
    return next();
  }

  return c.json({ error: 'unauthorized' }, 401);
};
