/**
 * Server-side Supabase client. Uses the service-role key when present
 * (bypasses RLS); otherwise the anon key under permissive MVP RLS.
 *
 * Column names are snake_case in Postgres; the app's domain models are
 * camelCase. The mappers here mirror app `src/services/supabaseApi.ts`.
 */
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { env } from './env.js';

// Node < 22 has no global WebSocket; supabase-js's realtime client needs one
// at construction time. Polyfill so this runs on Node 20 (and Railway).
if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = WebSocket;
}

export const supabase = createClient(env.supabaseUrl, env.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface AgentRow {
  id: string;
  name: string;
  company_name: string;
  website: string;
  business_type: string;
  use_case: string;
  integrations: string[];
  prompt: string;
  guardrails: string;
  handoff_destination: string;
  welcome_message: string;
  suggested_actions: string[];
  test_users: unknown[];
  status: 'Draft' | 'Generating' | 'Test Mode' | 'Deployed';
  created_by_customer_id?: string | null;
  setup_id?: string | null;
  provenance?: Record<string, unknown>;
}

export async function getAgent(id: string): Promise<AgentRow | null> {
  const { data, error } = await supabase.from('agents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as AgentRow) ?? null;
}
