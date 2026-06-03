-- App Clip-first setup binding and agent provenance.
-- Additive only: preserves the app-owned 0001 schema while letting the backend
-- bind an Apple/1440 customer_id to setup completion and live routing.

alter table public.setups
  add column if not exists customer_id text,
  add column if not exists msp_conversation_id text,
  add column if not exists company_name text not null default '',
  add column if not exists agent_name text not null default '',
  add column if not exists tone text not null default '',
  add column if not exists handoff_destination text not null default '',
  add column if not exists status text not null default 'started',
  add column if not exists setup_token_hash text,
  add column if not exists setup_context jsonb not null default '{}'::jsonb,
  add column if not exists generated_config jsonb not null default '{}'::jsonb,
  add column if not exists completion_payload jsonb not null default '{}'::jsonb,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists setups_customer_created_idx
  on public.setups (customer_id, created_at desc)
  where customer_id is not null;

create index if not exists setups_agent_id_idx
  on public.setups (agent_id)
  where agent_id is not null;

alter table public.agents
  add column if not exists created_by_customer_id text,
  add column if not exists setup_id uuid references public.setups(id) on delete set null,
  add column if not exists provenance jsonb not null default '{}'::jsonb,
  add column if not exists welcome_message text not null default '',
  add column if not exists suggested_actions jsonb not null default '[]'::jsonb;

create index if not exists agents_created_by_customer_idx
  on public.agents (created_by_customer_id, updated_at desc)
  where created_by_customer_id is not null;

create index if not exists agents_setup_id_idx
  on public.agents (setup_id)
  where setup_id is not null;
