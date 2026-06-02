-- Replace MVP-open RLS policies with authenticated-only access.
-- The backend service-role client bypasses RLS for server-owned runtime writes.

drop policy if exists "mvp_all_agents" on public.agents;
drop policy if exists "authenticated_all_agents" on public.agents;
create policy "authenticated_all_agents"
  on public.agents for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_conversations" on public.conversations;
drop policy if exists "authenticated_all_conversations" on public.conversations;
create policy "authenticated_all_conversations"
  on public.conversations for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_setups" on public.setups;
drop policy if exists "authenticated_all_setups" on public.setups;
create policy "authenticated_all_setups"
  on public.setups for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_auth_codes" on public.auth_codes;
drop policy if exists "authenticated_all_auth_codes" on public.auth_codes;
create policy "authenticated_all_auth_codes"
  on public.auth_codes for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_conversation_events" on public.conversation_events;
drop policy if exists "authenticated_all_conversation_events" on public.conversation_events;
create policy "authenticated_all_conversation_events"
  on public.conversation_events for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_handoff_sessions" on public.handoff_sessions;
drop policy if exists "authenticated_all_handoff_sessions" on public.handoff_sessions;
create policy "authenticated_all_handoff_sessions"
  on public.handoff_sessions for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_customer_profiles" on public.customer_profiles;
drop policy if exists "authenticated_all_customer_profiles" on public.customer_profiles;
create policy "authenticated_all_customer_profiles"
  on public.customer_profiles for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_trust_safety_settings" on public.trust_safety_settings;
drop policy if exists "authenticated_all_trust_safety_settings" on public.trust_safety_settings;
create policy "authenticated_all_trust_safety_settings"
  on public.trust_safety_settings for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_handoff_notes" on public.handoff_notes;
drop policy if exists "authenticated_all_handoff_notes" on public.handoff_notes;
create policy "authenticated_all_handoff_notes"
  on public.handoff_notes for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_handoff_audit_events" on public.handoff_audit_events;
drop policy if exists "authenticated_all_handoff_audit_events" on public.handoff_audit_events;
create policy "authenticated_all_handoff_audit_events"
  on public.handoff_audit_events for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_appointments" on public.appointments;
drop policy if exists "authenticated_all_appointments" on public.appointments;
create policy "authenticated_all_appointments"
  on public.appointments for all to authenticated
  using (true) with check (true);

drop policy if exists "mvp_all_workspace_message_identities" on public.workspace_message_identities;
drop policy if exists "authenticated_all_workspace_message_identities" on public.workspace_message_identities;
create policy "authenticated_all_workspace_message_identities"
  on public.workspace_message_identities for all to authenticated
  using (true) with check (true);
