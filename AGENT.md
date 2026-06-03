# Agentic Messaging Backend Repo Context

## Purpose
This repo is the server side of Agentic Messaging: a TypeScript/Hono backend for an Apple Messages for Business demo using the 1440 MSP test account. A customer texts one shared business Apple line, receives an App Clip setup entry point when no agent is active, describes the agent they want, and then immediately chats with the generated agent in the same Messages thread.

The sibling app lives at `/Users/chert/agentic-messaging`. That Expo/App Clip app collects first-run setup and later edit/manage intent. Treat the two repos as one system: the app captures the brief; this backend turns it into live AMB behavior on the shared business line.

## Structure
- `PLAN.md` - synced product direction. Read this before changing setup, App Clip, routing, deploy, or auth assumptions.
- `src/index.ts` - Hono app entrypoint with `/health`, agent LLM routes, and `/webhook`.
- `src/env.ts` - required environment loading for Supabase, OpenAI, 1440 MSP, and app auth.
- `src/routes/auth.ts` - app-auth-gated Messages sender verification and workspace identity endpoints.
- `src/routes/agents.ts` - app-auth-gated LLM endpoints: `/agents/generate` and `/agents/:id/preview-message`.
- `src/routes/operator.ts` - app-auth-gated operator endpoints for live conversations, customer profiles, handoffs, appointments, operator replies, pause/resume, and trust settings.
- `src/routes/webhook.ts` - 1440 inbound webhook plus auth-gated debug ring buffer.
- `src/runtime/` - command handling, login verification, customer profile touch/upsert, active-agent routing, conversation persistence, response buffering, handoff control, appointments, and live agent turns.
- `src/runtime/plugins/` - optional vertical-specific live behavior. Keep custom flows here instead of growing `agentRuntime.ts`.
- `src/msp/` - 1440 payload parsing and outbound send/request-agent helpers.
- `src/llm/` - OpenAI client, prompts, config generation, and chat replies.
- `supabase/migrations/0003_messaging_backend.sql` - shared DB additions for AMB customer routing and login codes.
- `supabase/migrations/0004_*.sql` through `0009_*.sql` - runtime/operator foundations: handoffs, customer profiles, trust settings, appointments, workspace Messages identity, authenticated RLS tightening, and atomic runtime upserts.

## App Relationship
- The shared Supabase DB starts with app migration `/Users/chert/agentic-messaging/supabase/migrations/0001_init.sql`; apply that before this repo's `0003`.
- The app's AMB deep-link commands in `src/lib/messageLinks.ts` must stay aligned with `src/runtime/commands.ts`.
- `MSP_BUSINESS_ID` should match the app's `EXPO_PUBLIC_AMB_BIZ_ID`.
- `APP_SHARED_TOKEN` gates backend endpoints called by the app/debug tools. If set, clients must send `Authorization: Bearer <token>`.
- App Clip setup is the first-run builder. It should not require Supabase Auth or a pre-existing workspace user. The backend must preserve enough customer/thread context to activate the generated agent in the same Messages conversation.
- The app displays conversations, handoffs, and customer profiles from the operator endpoints as secondary management/observability surfaces.
- The app currently uses mock/Supabase-local generation with backend preview support; this backend's `/agents/*` LLM endpoints are ready for the full live app generation swap.

## Shared Runtime Model
- One configured Apple Messages for Business sender/business id is shared by the demo through `MSP_BUSINESS_ID`.
- Each inbound customer is keyed by Apple/1440's opaque `customer_id` (`urn:mbid:...`) parsed from the webhook source id. That id is also the outbound `destinationId`.
- `conversations.customer_id` identifies the customer thread; `active_agent_id` identifies which test agent handles that customer's messages.
- `customer_profiles` stores operator-facing customer context: display name, phone, Apple ID, email, tags, notes, and last-seen. Real phone numbers are captured only when 1440/webhook payloads or verification flows provide them, so runtime and UI must tolerate opaque ids.
- A customer with no active agent should be guided into App Clip setup. Completing setup should create/generate the agent and immediately set `conversations.active_agent_id` for that customer.

## Local Development
```bash
npm install
npm run dev
npm run typecheck
```

Required local `.env` values: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` or `SUPABASE_ANON_KEY`, `OPENAI_API_KEY`, `MSP_API_KEY`, `MSP_BUSINESS_ID`, and preferably `APP_SHARED_TOKEN`.

Health check:
```bash
curl http://localhost:8787/health
```

## Notes For Agents
- Never expose or copy secrets from `.env` into docs, logs, commits, or the app repo.
- When adding a custom customer workflow, prefer a runtime plugin in `src/runtime/plugins/` and register it in `registry.ts`.
- Do not reintroduce "test users" or operator deploy gates as the primary first-run path. Those can remain later management concepts.
- Persistence intentionally degrades until `0003` is applied; after `0003`, conversations can be keyed by Apple `customer_id` and login codes can be verified.
- The webhook must respond quickly to 1440; keep runtime work best-effort/fire-and-forget from the request path.
