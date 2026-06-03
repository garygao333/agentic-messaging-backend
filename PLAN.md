# Agentic Messaging Direction Plan

**Version:** 0.1.3
**Synced app version:** `agentic-messaging` 1.0.3
**Date:** 2026-06-03

## Product Direction

Agentic Messaging is now a one-business-line Apple Messages demo, not an operator-first SaaS control plane.

There is no separate "user" in the first-run flow. The only primary actor is the customer texting the shared Apple Messages for Business line. The backend should treat that customer as both the person starting setup and the first live tester of the agent.

## Canonical Flow

1. Customer texts the configured Apple Messages for Business line.
2. Backend receives the 1440 webhook and identifies the sender by Apple/1440 `customer_id` (`urn:mbid:...`).
3. If no active agent exists for that customer, backend sends an App Clip setup entry point.
4. App Clip collects the minimum brief:
   - company website or business name
   - what the agent should do
   - tone/business context
   - optional handoff instruction
5. App Clip creates the agent draft through the shared app/backend model.
6. Backend immediately generates the agent config, marks it live for that same customer thread, and sends a confirmation in Messages.
7. Customer continues texting the same business line and is now talking to the newly created agent.
8. If the customer wants to edit the agent, backend/app sends a second App Clip or install prompt that routes into the full mobile app for management.

## What Changes From The Previous Model

- Remove the assumption that a workspace operator signs in first, creates an agent, deploys it, and invites test users.
- Remove "test users" as the primary deploy gate for the demo flow.
- Treat `START_AGENT_SETUP` and first inbound plain text as possible setup starts.
- Treat App Clip setup completion as the deployment event for that customer thread.
- Keep the dashboard/mobile app as a later management surface, not the first product surface.
- Keep operator inbox/handoff capabilities, but they are secondary demo support tools.

## Backend Responsibilities

- Parse inbound customer messages from 1440 and keep responding quickly.
- Maintain `customer_profiles` for every inbound sender.
- Maintain `conversations.customer_id` and `conversations.active_agent_id` as the core routing state.
- Send setup App Clips when a customer has no active agent.
- Provide a backend endpoint or command path for App Clip setup completion that:
  - creates or updates the agent,
  - generates prompt/guardrails/actions,
  - sets the agent as active for the customer,
  - persists the conversation state,
  - confirms deployment in Messages.
- Continue supporting runtime plugins for vertical flows once the agent is active.
- Support an edit/install handoff path for customers who want to change the generated agent.

## App Responsibilities

- App Clip is the first-run builder UI.
- Full mobile app is the edit/manage surface after the customer already has an agent.
- App must not require Supabase Auth or a pre-existing workspace user for the initial demo setup.
- App should pass enough setup context to the backend to bind the created agent to the current `customer_id`.

## Data Model Direction

Current useful tables:
- `customer_profiles`
- `conversations`
- `agents`
- `setups`
- `handoff_sessions`
- `appointments`

Needed next:
- `setups.customer_id` or equivalent setup ownership by Apple/1440 customer id.
- `agents.created_by_customer_id` or similar provenance.
- A clear "active demo agent per customer" invariant, using `conversations.active_agent_id`.
- Optional later: `business_lines` if this grows beyond one Apple Messages sender.

## Command Direction

Keep:
- `START_AGENT_SETUP`
- `AGENT_SETUP_COMPLETE {setup_id}`
- `REDEPLOY {agent_id}` for edit flows

De-emphasize:
- `LOGIN {code}` for first-run setup
- `TEST_AGENT {agent_id}` as the primary activation path

Add or redefine:
- First plain text from a no-agent customer should be allowed to start setup.
- `AGENT_SETUP_COMPLETE {setup_id}` should activate immediately, not tell the customer to open the app and deploy later.

## Build Order

1. Update product copy/docs to App Clip-first demo flow.
2. Add setup/customer binding in Supabase migrations.
3. Add backend setup-complete runtime endpoint/handler that creates, generates, deploys, and activates in one flow.
4. Simplify App Clip form to the minimum brief and remove test-user-first language.
5. Update runtime no-agent fallback to send setup App Clip instead of telling the customer to open the app.
6. Add edit-agent App Clip/install handoff after the agent exists.
7. Keep dashboard/inbox as internal observability and later management, not the main launch path.

## Acceptance Criteria

- A new customer can text the business line and create an agent without using the full app first.
- After App Clip completion, the same Messages thread immediately routes to the generated agent.
- The customer can ask to change the agent and receive an edit/install path.
- The backend, app repo docs, changelogs, and package versions describe the same flow.
