-- Messaging-backend additions (System 2). Apply in the SHARED Supabase project
-- after the app's 0001/0002. Idempotent. Requires service-role (DDL).
--
-- These close two gaps the backend needs but the app schema doesn't yet cover:
--   1. correlating an Apple customer (urn:mbid:) to a conversation row
--   2. verifying LOGIN 2FA codes the app issues
-- Pending owner sign-off on the open decisions before we depend on them.

-- 1) Customer ↔ conversation correlation + active-agent persistence.
alter table public.conversations
  add column if not exists customer_id text,        -- urn:mbid: opaque Apple id
  add column if not exists active_agent_id uuid references public.agents(id) on delete set null;

create index if not exists conversations_customer_id_idx
  on public.conversations (customer_id);

-- 2) LOGIN 2FA codes issued by the app, verified by the backend.
create table if not exists public.auth_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  apple_id    text,                  -- e.g. garygao@sas.upenn.edu
  verified    boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '10 minutes')
);
create index if not exists auth_codes_code_idx on public.auth_codes (code);

alter table public.auth_codes enable row level security;
do $$ begin
  create policy "mvp_all_auth_codes" on public.auth_codes for all using (true) with check (true);
exception when duplicate_object then null; end $$;
