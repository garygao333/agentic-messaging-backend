-- Prefer the Messages sender identifier over the old demo "Apple Customer" label.

alter table if exists public.appointments
  alter column customer_name set default 'Unknown Messages sender';

create or replace function public.upsert_conversation_active_agent(
  p_customer_id text,
  p_agent_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.conversations (
    customer_id,
    agent_id,
    active_agent_id,
    customer_name,
    status,
    messages
  )
  values (
    p_customer_id,
    p_agent_id,
    p_agent_id,
    coalesce(nullif(p_customer_id, ''), 'Unknown Messages sender'),
    'Open',
    '[]'::jsonb
  )
  on conflict (customer_id) where customer_id is not null
  do update set
    agent_id = excluded.agent_id,
    active_agent_id = excluded.active_agent_id,
    customer_name = case
      when public.conversations.customer_name is null
        or public.conversations.customer_name in ('Apple Customer', 'Messages sender', 'Unknown Messages sender')
      then excluded.customer_name
      else public.conversations.customer_name
    end,
    status = 'Open',
    messages = coalesce(public.conversations.messages, excluded.messages)
  returning id into v_id;

  return v_id;
end;
$$;

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
    coalesce(nullif(p_patch->>'customer_name', ''), nullif(p_patch->>'customer_id', ''), 'Unknown Messages sender'),
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
    status = excluded.status,
    payment_status = excluded.payment_status,
    payment_amount = excluded.payment_amount,
    payment_currency = excluded.payment_currency,
    patient_details = excluded.patient_details,
    extraction = excluded.extraction,
    updated_at = excluded.updated_at
  returning id into v_id;

  return v_id;
end;
$$;

update public.conversations
set customer_name = customer_id
where customer_id is not null
  and customer_name in ('Apple Customer', 'Messages sender', 'Unknown Messages sender');

update public.appointments
set customer_name = coalesce(customer_id, 'Unknown Messages sender')
where customer_name in ('Apple Customer', 'Messages sender', 'Unknown Messages sender');
