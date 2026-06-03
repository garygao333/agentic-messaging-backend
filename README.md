# Agentic Messaging Backend

Backend for the Agentic Messaging Apple Messages for Business demo.

This repo owns the server-only side of the product: 1440 MSP webhooks, outbound
Messages sends, OpenAI calls, Supabase service-role writes, live agent routing,
handoff/operator APIs, and runtime plugins. The sibling Expo/App Clip repo is
`/Users/chert/agentic-messaging`.

Read `PLAN.md` first. It is the canonical product direction for both repos.

## Current Product Shape

Agentic Messaging is a one-business-line demo:

1. A customer texts the shared Apple Messages for Business line.
2. This backend receives the 1440 webhook and identifies the sender by
   Apple/1440 `customer_id` (`urn:mbid:...`).
3. If that customer has no active agent, the backend should send an App Clip
   setup entry point.
4. The App Clip collects the business brief.
5. Setup completion creates/generates the agent, activates it for the same
   customer thread, and confirms in Messages.
6. Later edits route into the full mobile app.

The old operator-first flow, manual test-user deployment gate, and workspace
user-first onboarding are no longer the primary demo path.

## Main Code Paths

- `src/index.ts` - Hono entrypoint and route registration.
- `src/routes/webhook.ts` - 1440 inbound webhook and debug ring buffer.
- `src/runtime/` - command handling, customer/conversation persistence, active
  agent routing, response buffering, handoff control, appointments, and live
  agent turns.
- `src/routes/agents.ts` - app-auth-gated LLM endpoints for generation and
  preview.
- `src/routes/operator.ts` - operator/observability APIs for inbox, customers,
  handoffs, appointments, replies, pause/resume, and trust settings.
- `src/msp/` - 1440 payload parsing and outbound send/request-agent helpers.
- `src/llm/` - OpenAI client, prompts, config generation, and chat replies.
- `src/runtime/plugins/` - optional vertical behavior after an agent is active.
- `supabase/migrations/` - backend-owned database additions.

## Shared Contracts

- Apply the app repo's `supabase/migrations/0001_init.sql` before backend
  migrations.
- `MSP_BUSINESS_ID` must match the app's `EXPO_PUBLIC_AMB_BIZ_ID`.
- `APP_SHARED_TOKEN`, when set, gates app/debug/operator endpoints called from
  the Expo app and local tools.
- Messages command bodies must stay aligned with the app's
  `src/lib/messageLinks.ts`: `LOGIN {code}`, `START_AGENT_SETUP`,
  `AGENT_SETUP_COMPLETE {setup_id}`, `TEST_AGENT {agent_id}`, and
  `REDEPLOY {agent_id}`.
- First-run setup should not require Supabase Auth or a pre-existing workspace
  user. It needs enough customer/thread context to bind the generated agent to
  `conversations.customer_id` and `conversations.active_agent_id`.

## Run Locally

```bash
npm install
npm run dev
npm run typecheck
```

Required `.env` values are documented in `.env.example`. Do not copy secrets
into docs, logs, commits, or the app repo.

Health check:

```bash
curl http://localhost:8787/health
```

## Useful Docs

- `AGENT.md` - repo context for future coding agents.
- `PLAN.md` - synced product direction and build order.
- `CHANGELOG.md` - version history synced with the app repo.
