# Agentic Messaging Backend (System 2)

Apple Messages for Business backend for Agentic Messaging. Connects to the **1440
MSP** test account, runs the live agent runtime, and owns all LLM calls (for both
the live Messages agents and the in-app preview). Shares the Expo app's Supabase DB.

See [`PLAN.md`](./PLAN.md) for the full build plan and open decisions.

## Stack
Node 20+ · TypeScript · [Hono](https://hono.dev) · `@supabase/supabase-js` · `openai`. Deploys to **Railway**.

## Run locally
```bash
cp .env.example .env   # fill in secrets (see below)
npm install
npm run dev            # tsx watch on PORT (default 8787)
npm run typecheck
```

## Endpoints

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/health` | liveness + config echo | ✅ |
| POST | `/agents/generate` | generate agent config from onboarding inputs | ✅ |
| POST | `/agents/:id/preview-message` | next reply for the in-app preview chat | ✅ |
| POST | `/webhook` | 1440 inbound (text/interactive) → agent runtime | 🟢 built; needs `0003` + live webhook registration |

The two `/agents/*` endpoints match the app's `src/services/llm.ts` shapes — point
`EXPO_PUBLIC_LLM_PROXY_URL` at this backend and drop the client OpenAI key.

The runtime persists conversations + multi-turn history (keyed by the customer's
urn:mbid:), maps `suggested_actions` → quick replies, and escalates to a human
(1440 `/request-agent` + `status='Needs Human'`) on a handoff trigger. All
persistence degrades gracefully until `0003` is applied. 1440 send/auth verified.

### ⚠️ One manual step before the runtime persists
Apply `supabase/migrations/0003_messaging_backend.sql` — paste it into the
Supabase **SQL editor** (DDL can't go through the REST API). Until then the
backend runs fine but skips persistence and uses an in-memory routing map.

## Message protocol (inbound text body)
`LOGIN {code}` · `START_AGENT_SETUP` · `AGENT_SETUP_COMPLETE {setup_id}` ·
`TEST_AGENT {agent_id}` · `REDEPLOY {agent_id}` — handled in `src/runtime/handlers.ts`.

## Env
See `.env.example`. Critical: `SUPABASE_SERVICE_KEY` (currently running on the anon
key as a permissive-RLS stopgap), `OPENAI_API_KEY`, `MSP_API_KEY`, `MSP_BUSINESS_ID`,
`APP_SHARED_TOKEN`.

## Deploy (Railway)
```bash
railway login
railway init
railway up
# set the same vars from .env in Railway → Variables, then set the 1440
# Webhook URL (Business Accounts → Webhook URL) to https://<app>.up.railway.app/webhook
```

## Migrations
`supabase/migrations/0003_messaging_backend.sql` adds the customer↔conversation
correlation + `auth_codes` table the runtime/auth need. Apply with the service-role
key after the app's `0001`/`0002`. Pending owner sign-off on open decisions.

## Known gaps / TODO
- **Apply `0003`** (SQL editor) — unlocks conversation persistence + LOGIN verify.
- **Webhook signature verification** — 1440's mechanism TBC (`MSP_WEBHOOK_SECRET`).
- **App writes LOGIN codes to `auth_codes`** — the backend verify is built; the app
  must insert the issued code (today it only generates it client-side).
- **App Clip** — `send-message-api type:app-clip` requires an App Clip configured in 1440.
- **Set `APP_SHARED_TOKEN`** before deploying (LLM endpoints are open without it).
