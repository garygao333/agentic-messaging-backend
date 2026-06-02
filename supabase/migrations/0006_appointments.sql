-- Operator-visible appointment records extracted from live Messages bookings.

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  customer_id text,
  customer_name text not null default 'Apple Customer',
  service_identifier text,
  service_title text,
  service_subtitle text,
  slot_identifier text,
  starts_at timestamptz,
  duration_seconds integer,
  location_title text,
  status text not null default 'collecting',
  payment_status text not null default 'not_required',
  payment_amount text,
  payment_currency text not null default 'USD',
  patient_details jsonb not null default '{}'::jsonb,
  extraction jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists appointments_agent_idx on public.appointments (agent_id, starts_at desc);
create index if not exists appointments_conversation_idx on public.appointments (conversation_id);
create unique index if not exists appointments_conversation_unique_idx
  on public.appointments (conversation_id)
  where conversation_id is not null;
create index if not exists appointments_customer_idx on public.appointments (customer_id);
create index if not exists appointments_status_idx on public.appointments (status);

create or replace function public.upsert_appointment_for_conversation(p_patch jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if nullif(p_patch->>'conversation_id', '') is null then
    raise exception 'conversation_id is required'
      using errcode = '23502';
  end if;

  insert into public.appointments (
    conversation_id,
    agent_id,
    customer_id,
    customer_name,
    service_identifier,
    service_title,
    service_subtitle,
    slot_identifier,
    starts_at,
    duration_seconds,
    location_title,
    status,
    payment_status,
    payment_amount,
    payment_currency,
    patient_details,
    extraction,
    updated_at
  )
  values (
    (p_patch->>'conversation_id')::uuid,
    nullif(p_patch->>'agent_id', '')::uuid,
    nullif(p_patch->>'customer_id', ''),
    coalesce(nullif(p_patch->>'customer_name', ''), 'Apple Customer'),
    nullif(p_patch->>'service_identifier', ''),
    nullif(p_patch->>'service_title', ''),
    case when p_patch ? 'service_subtitle' then nullif(p_patch->>'service_subtitle', '') else null end,
    nullif(p_patch->>'slot_identifier', ''),
    case
      when p_patch ? 'starts_at' and nullif(p_patch->>'starts_at', '') is not null
      then (p_patch->>'starts_at')::timestamptz
      else null
    end,
    case
      when p_patch ? 'duration_seconds' and nullif(p_patch->>'duration_seconds', '') is not null
      then (p_patch->>'duration_seconds')::integer
      else null
    end,
    case when p_patch ? 'location_title' then nullif(p_patch->>'location_title', '') else null end,
    coalesce(nullif(p_patch->>'status', ''), 'collecting'),
    coalesce(nullif(p_patch->>'payment_status', ''), 'not_required'),
    nullif(p_patch->>'payment_amount', ''),
    coalesce(nullif(p_patch->>'payment_currency', ''), 'USD'),
    coalesce(p_patch->'patient_details', '{}'::jsonb),
    coalesce(p_patch->'extraction', '{}'::jsonb),
    coalesce(nullif(p_patch->>'updated_at', '')::timestamptz, now())
  )
  on conflict (conversation_id) where conversation_id is not null
  do update set
    agent_id = excluded.agent_id,
    customer_id = excluded.customer_id,
    customer_name = excluded.customer_name,
    service_identifier = case
      when p_patch ? 'service_identifier' then excluded.service_identifier
      else public.appointments.service_identifier
    end,
    service_title = case
      when p_patch ? 'service_title' then excluded.service_title
      else public.appointments.service_title
    end,
    service_subtitle = case
      when p_patch ? 'service_subtitle' then excluded.service_subtitle
      else public.appointments.service_subtitle
    end,
    slot_identifier = case
      when p_patch ? 'slot_identifier' then excluded.slot_identifier
      else public.appointments.slot_identifier
    end,
    starts_at = case
      when p_patch ? 'starts_at' then excluded.starts_at
      else public.appointments.starts_at
    end,
    duration_seconds = case
      when p_patch ? 'duration_seconds' then excluded.duration_seconds
      else public.appointments.duration_seconds
    end,
    location_title = case
      when p_patch ? 'location_title' then excluded.location_title
      else public.appointments.location_title
    end,
    status = case
      when p_patch ? 'status' then excluded.status
      else public.appointments.status
    end,
    payment_status = case
      when p_patch ? 'payment_status' then excluded.payment_status
      else public.appointments.payment_status
    end,
    payment_amount = case
      when p_patch ? 'payment_amount' then excluded.payment_amount
      else public.appointments.payment_amount
    end,
    payment_currency = case
      when p_patch ? 'payment_currency' then excluded.payment_currency
      else public.appointments.payment_currency
    end,
    patient_details = excluded.patient_details,
    extraction = excluded.extraction,
    updated_at = excluded.updated_at
  returning id into v_id;

  return v_id;
end;
$$;

alter table public.appointments enable row level security;

do $$ begin
  create policy "mvp_all_appointments" on public.appointments for all using (true) with check (true);
exception when duplicate_object then null; end $$;
