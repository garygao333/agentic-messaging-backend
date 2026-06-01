-- Operator product foundations. Apply after 0004_handoff_runtime_foundation.sql.
-- Idempotent. These tables back customer profile context, trust/safety controls,
-- and operator-visible handoff notes/audit without replacing the existing app
-- conversations table.

-- 1) Customer profile/context keyed by Apple Messages customer id.
create table if not exists public.customer_profiles (
  id             uuid primary key default gen_random_uuid(),
  customer_id    text not null unique,
  display_name   text,
  apple_id       text,
  email          text,
  phone          text,
  trust_level    text not null default 'standard',
  safety_notes   text,
  tags           jsonb not null default '[]'::jsonb,
  attributes     jsonb not null default '{}'::jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint customer_profiles_trust_level_check
    check (trust_level in ('standard', 'trusted', 'watch', 'restricted'))
);

create index if not exists customer_profiles_customer_id_idx
  on public.customer_profiles (customer_id);

create index if not exists customer_profiles_last_seen_idx
  on public.customer_profiles (last_seen_at desc);

alter table public.customer_profiles enable row level security;
do $$ begin
  create policy "mvp_all_customer_profiles" on public.customer_profiles for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- 2) Operator-editable trust/safety settings. Null agent_id is the global
-- workspace default; agent rows can override it later.
create table if not exists public.trust_safety_settings (
  id                                  uuid primary key default gen_random_uuid(),
  agent_id                            uuid references public.agents(id) on delete cascade,
  ai_replies_enabled                  boolean not null default true,
  auto_handoff_enabled                boolean not null default true,
  high_risk_auto_pause                boolean not null default true,
  require_human_on_low_confidence     boolean not null default false,
  require_human_on_sensitive_topics   boolean not null default true,
  moderation_mode                     text not null default 'balanced',
  blocked_terms                       text[] not null default '{}'::text[],
  escalation_keywords                 text[] not null default '{}'::text[],
  sensitive_topics                    text[] not null default '{}'::text[],
  business_hours                      jsonb not null default '{}'::jsonb,
  updated_by                          text,
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now(),
  constraint trust_safety_moderation_mode_check
    check (moderation_mode in ('off', 'light', 'balanced', 'strict'))
);

create unique index if not exists trust_safety_settings_global_idx
  on public.trust_safety_settings ((true))
  where agent_id is null;

create unique index if not exists trust_safety_settings_agent_idx
  on public.trust_safety_settings (agent_id)
  where agent_id is not null;

alter table public.trust_safety_settings enable row level security;
do $$ begin
  create policy "mvp_all_trust_safety_settings" on public.trust_safety_settings for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- 3) Internal handoff notes for operator collaboration.
create table if not exists public.handoff_notes (
  id                  uuid primary key default gen_random_uuid(),
  handoff_session_id  uuid references public.handoff_sessions(id) on delete cascade,
  conversation_id     uuid references public.conversations(id) on delete cascade,
  author_type         text not null default 'operator',
  author_id           text,
  body                text not null,
  visibility          text not null default 'internal',
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  constraint handoff_notes_visibility_check
    check (visibility in ('internal', 'customer_visible')),
  constraint handoff_notes_author_type_check
    check (author_type in ('operator', 'system', 'agent'))
);

create index if not exists handoff_notes_handoff_created_idx
  on public.handoff_notes (handoff_session_id, created_at desc);

create index if not exists handoff_notes_conversation_created_idx
  on public.handoff_notes (conversation_id, created_at desc);

alter table public.handoff_notes enable row level security;
do $$ begin
  create policy "mvp_all_handoff_notes" on public.handoff_notes for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- 4) Structured handoff audit trail for state transitions and operator actions.
create table if not exists public.handoff_audit_events (
  id                  uuid primary key default gen_random_uuid(),
  handoff_session_id  uuid references public.handoff_sessions(id) on delete cascade,
  conversation_id     uuid references public.conversations(id) on delete cascade,
  actor_type          text not null default 'operator',
  actor_id            text,
  action              text not null,
  from_status         text,
  to_status           text,
  note                text,
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  constraint handoff_audit_actor_type_check
    check (actor_type in ('operator', 'system', 'agent', 'msp'))
);

create index if not exists handoff_audit_handoff_created_idx
  on public.handoff_audit_events (handoff_session_id, created_at desc);

create index if not exists handoff_audit_conversation_created_idx
  on public.handoff_audit_events (conversation_id, created_at desc);

create index if not exists handoff_audit_action_created_idx
  on public.handoff_audit_events (action, created_at desc);

alter table public.handoff_audit_events enable row level security;
do $$ begin
  create policy "mvp_all_handoff_audit_events" on public.handoff_audit_events for all using (true) with check (true);
exception when duplicate_object then null; end $$;
