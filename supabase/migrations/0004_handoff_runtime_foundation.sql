-- Handoff/runtime foundations. Apply after 0003_messaging_backend.sql.
-- Idempotent and intentionally compatible with the app's existing
-- conversation_status enum ('Open', 'Needs Human', 'Resolved').

-- 1) Persist the 1440/MSP conversation id when present on inbound webhooks.
alter table public.conversations
  add column if not exists msp_conversation_id text;

create index if not exists conversations_msp_conversation_id_idx
  on public.conversations (msp_conversation_id);

-- 2) Append-only-ish runtime event log for UI realtime, debugging, and audit.
create table if not exists public.conversation_events (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid references public.conversations(id) on delete cascade,
  agent_id            uuid references public.agents(id) on delete set null,
  customer_id         text,
  msp_conversation_id text,
  event_type          text not null,
  actor               text not null default 'system',
  body                text,
  payload             jsonb not null default '{}'::jsonb,
  idempotency_key     text,
  created_at          timestamptz not null default now()
);

create unique index if not exists conversation_events_idempotency_key_idx
  on public.conversation_events (idempotency_key)
  where idempotency_key is not null;

create index if not exists conversation_events_conversation_created_idx
  on public.conversation_events (conversation_id, created_at desc);

create index if not exists conversation_events_customer_created_idx
  on public.conversation_events (customer_id, created_at desc);

create index if not exists conversation_events_type_created_idx
  on public.conversation_events (event_type, created_at desc);

alter table public.conversation_events enable row level security;
do $$ begin
  create policy "mvp_all_conversation_events" on public.conversation_events for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- 3) Durable handoff state machine. This is the richer runtime state; the
-- conversations.status column remains the app-facing label for v0.
create table if not exists public.handoff_sessions (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references public.conversations(id) on delete cascade,
  agent_id              uuid references public.agents(id) on delete set null,
  customer_id           text,
  msp_conversation_id   text,
  trigger               text not null default 'explicit_request',
  reason                text,
  priority              text not null default 'normal',
  status                text not null default 'handoff_requested',
  summary               text,
  suggested_reply       text,
  assigned_team         text,
  assigned_operator     text,
  sla_deadline          timestamptz,
  requested_at          timestamptz not null default now(),
  assigned_at           timestamptz,
  resolved_at           timestamptz,
  returned_to_agent_at  timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint handoff_sessions_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint handoff_sessions_status_check
    check (status in (
      'handoff_requested',
      'queued',
      'assigned',
      'human_active',
      'bot_paused',
      'resolved',
      'returned_to_agent',
      'closed'
    ))
);

create index if not exists handoff_sessions_conversation_created_idx
  on public.handoff_sessions (conversation_id, created_at desc);

create index if not exists handoff_sessions_status_requested_idx
  on public.handoff_sessions (status, requested_at desc);

create index if not exists handoff_sessions_agent_status_idx
  on public.handoff_sessions (agent_id, status);

create index if not exists handoff_sessions_assigned_operator_idx
  on public.handoff_sessions (assigned_operator)
  where assigned_operator is not null;

create unique index if not exists handoff_sessions_one_active_per_conversation_idx
  on public.handoff_sessions (conversation_id)
  where status in ('handoff_requested', 'queued', 'assigned', 'human_active', 'bot_paused');

alter table public.handoff_sessions enable row level security;
do $$ begin
  create policy "mvp_all_handoff_sessions" on public.handoff_sessions for all using (true) with check (true);
exception when duplicate_object then null; end $$;
