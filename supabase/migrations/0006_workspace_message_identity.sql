-- Persist the Apple Messages sender that verified a Supabase workspace user.
-- This makes Messages verification a one-time account connection instead of
-- frontend-only state that disappears after local storage/session churn.

alter table public.auth_codes
  add column if not exists workspace_user_id uuid,
  add column if not exists display_handle text,
  add column if not exists customer_id text;

create index if not exists auth_codes_workspace_user_idx
  on public.auth_codes (workspace_user_id, created_at desc);

create index if not exists auth_codes_customer_id_idx
  on public.auth_codes (customer_id);

create table if not exists public.workspace_message_identities (
  id                 uuid primary key default gen_random_uuid(),
  workspace_user_id  uuid not null unique,
  customer_id         text not null,
  display_handle      text,
  verified_at         timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists workspace_message_identities_customer_idx
  on public.workspace_message_identities (customer_id);

alter table public.workspace_message_identities enable row level security;
do $$ begin
  create policy "mvp_all_workspace_message_identities"
    on public.workspace_message_identities for all
    using (true)
    with check (true);
exception when duplicate_object then null; end $$;
