/**
 * App → backend auth guard for the LLM endpoints (they spend money).
 * MVP: a shared bearer token (APP_SHARED_TOKEN). If unset, the guard is
 * disabled with a warning — fine for local dev, NOT for production.
 *
 * Upgrade path: verify the caller's Supabase session JWT with SUPABASE_JWT_SECRET.
 */
import type { MiddlewareHandler } from 'hono';
import { env } from './env.js';

let warnedOpenAuth = false;

export const requireAppAuth: MiddlewareHandler = async (c, next) => {
  if (!env.appSharedToken) {
    if (!warnedOpenAuth) {
      warnedOpenAuth = true;
      console.warn('[auth] APP_SHARED_TOKEN unset — app/operator endpoints are OPEN. Set it before deploying.');
    }
    return next();
  }
  const header = c.req.header('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token !== env.appSharedToken) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};
