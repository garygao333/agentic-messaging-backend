# Apple Messages for Business Backend — Build Plan

**Repo:** `agentic-messaging-backend` (currently empty — greenfield)
**Sibling app:** `../agentic-messaging-app` (Expo, already built — the UI control plane)
**MSP:** **1440** (`https://msp.1440.co/functions/v1`) — confirmed from the API docs
**Deploy target:** Railway (long-running Node service, stable HTTPS webhook, holds secrets server-side)

---

## 1. What's already built (System 1 — the Expo app)

Verified by reading the app repo:

| Piece | Status | File |
|---|---|---|
| Domain models | ✅ | `src/types/models.ts` (`Agent`, `Conversation`, `Setup`, `Message`, `TestUser`) |
| Supabase schema | ✅ | `supabase/migrations/0001_init.sql` + `0002_agent_messaging.sql` — `agents` / `conversations` / `setups`, jsonb nested collections, **permissive RLS** |
| App→DB CRUD | ✅ | `src/services/supabaseApi.ts` — app reads/writes Supabase **directly** (camelCase ↔ snake_case mappers) |
| Mock fallback | ✅ | `src/services/mockApi.ts` |
| LLM client (contract) | ✅ | `src/services/llm.ts` — `generateAgentConfig()` + `chatReply()`, already supports `EXPO_PUBLIC_LLM_PROXY_URL` to point at us; falls back to templates |
| Prompt templates | ✅ | `src/lib/generate.ts` — `defaultPrompt`, `defaultGuardrails`, `previewFor` (the fallback logic we should mirror) |
| AMB deep-link protocol | ✅ | `src/lib/messageLinks.ts` — builds `bcrw.apple.com/urn:biz:<id>?body=<cmd>` for all 5 commands |
| Backend selector | ✅ | `src/lib/runtime.ts` |

**The integration surface is therefore fixed and small:** the Supabase schema, the 5 protocol command bodies, and the two LLM endpoint shapes. We build against those — no app source dependency.

---

## 2. What's left to build (System 2 — this backend)

Everything. The directory is empty. Scope, in dependency order:

1. **Scaffold** — Node + TypeScript + Hono (lightweight, TS-native, trivial on Railway). Supabase service client, OpenAI SDK, env loader, `/health`.
2. **LLM endpoints** (`POST /agents/generate`, `POST /agents/:id/preview-message`) — *one shared prompt-construction module* reused by the live runtime. This alone unblocks the App-Store-safe app build (drop the client key).
3. **1440 echo bot** — inbound webhook receiver + outbound `send-message-api` wrapper, round-tripping on the test account.
4. **Protocol handlers** — parse the 5 command bodies, read/write Supabase, idempotent on retries.
5. **Agent runtime** — load agent config, build system prompt (same module as #2), call LLM, send reply, persist the turn to `conversations.messages`, map `suggestedActions` → quick replies, detect handoff → `status='Needs Human'`.
6. **App Clip link generation** — `send-message-api` `type: "app-clip"` carrying `setup_id`.
7. **LOGIN 2FA verification** + RLS hardening.

---

## 3. How the 1440 API maps to our needs

From the docs you gave me:

| We need | 1440 mechanism |
|---|---|
| Auth to 1440 | `Authorization: Bearer <API_KEY>` + `X-Business-Id: <BUSINESS_ID>` |
| Send text/quick-reply/list/rich-link/app-clip | `POST /send-message-api`, dispatched by `messageType` / `type` |
| Receive customer messages | Inbound webhook (configure URL in **Business Accounts → Webhook URL**) |
| Read interactive replies cleanly | **Bot Webhook** — pre-decrypted `interactiveResponse` + `textBody`, no MSP creds needed to read selections |
| Reply target | inbound `headers.source_id` (customer `urn:mbid:`) → outbound `destinationId` |
| Protocol commands (`LOGIN …`, `START_AGENT_SETUP`, …) | arrive as the **text body** of `message.received` (`payload.body` / `data.body.text`) |
| Quick replies / list picker | `messageType: "interactive"` (raw Apple `interactiveData`) |
| Escalate to human | `POST /request-agent` (sets `agent_needed`) |

**Gotchas baked into the design** (from the docs): `destinationId` direction reversal inbound vs outbound; `urn:mbid:` for everything except invitations (`tel:+`); closed/opted-out → 403; customer must have messaged first; interactive images <200KB base64 inline.

---

## 4. Proposed repo structure

```
agentic-messaging-backend/
  src/
    index.ts                 # Hono app, route mounting, /health
    env.ts                   # typed env loader (fail fast on missing)
    supabase.ts              # service-role client
    llm/
      prompt.ts              # SHARED system-prompt construction (the consolidation)
      generate.ts            # /agents/generate logic
      reply.ts               # next-reply logic (preview ≡ live runtime)
    routes/
      agents.ts              # POST /agents/generate, /agents/:id/preview-message
      webhook.ts             # POST /webhook — 1440 inbound + bot webhook
    msp/
      send.ts                # 1440 send-message-api wrapper (text, interactive, app-clip)
      parse.ts               # normalize inbound payload shapes → {customerId, text, interactive}
    runtime/
      handlers.ts            # the 5 protocol command handlers
      agentRuntime.ts        # live LLM turn + persist + handoff
    auth.ts                  # app→backend bearer/JWT guard; LOGIN code verify
  package.json  tsconfig.json  railway.json  .env.example  README.md
```

---

## 5. Env / secrets (mapped to 1440 + Railway)

```bash
# Supabase (shared DB) — SERVICE key, server-side only
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# LLM
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# 1440 MSP
MSP_API_BASE=https://msp.1440.co/functions/v1
MSP_API_KEY=                 # Bearer
MSP_BUSINESS_ID=             # X-Business-Id (see open question re: AMB_BIZ_ID)
MSP_WEBHOOK_SECRET=          # if 1440 signs inbound webhooks (TBC)
AMB_BIZ_ID=914e49f4-2b03-4e2b-987f-8c8f45e40294

# App → backend auth
APP_SHARED_TOKEN=            # interim MVP; OR:
SUPABASE_JWT_SECRET=         # verify the app's Supabase session JWT
```

Railway: one service, set all of the above in Railway Variables, expose the generated `*.up.railway.app` URL as the webhook + the app's `EXPO_PUBLIC_LLM_PROXY_URL`.

---

## 6. Milestones (ship-order)

1. **Scaffold + `/health` on Railway** — proves deploy + secrets.
2. **LLM endpoints live** → app swaps `llm.ts` to us, removes the client key → **unblocks the App Store build**.
3. **Echo bot** — webhook in, text out, on the 1440 test account.
4. **Protocol handlers** wired to Supabase.
5. **Agent runtime** — real live replies + handoff + persistence.
6. **App Clip links** + **LOGIN verify** + RLS hardening.

**"It works":** test user texts the biz account → App Clip setup → agent generated → deployed in the app → user chats the live agent in Messages → conversation shows up in the app's Conversations screen.

---

## 7. Decisions I'm making by default (tell me if any are wrong)

- **Hono over Express/Fastify** — lightweight, TS-first, clean webhook ergonomics on Railway.
- **App→backend auth = shared bearer token for MVP**, upgrade to Supabase JWT verification later.
- **Routing = per `TEST_AGENT {agent_id}` command** sets the active agent for that conversation thread; persisted on the conversation. (Simplest; matches the protocol.)
- **"Latest wins" deploy** for MVP — no version history table yet (add later if you want auditability).
- **Use the Bot Webhook** payload shape (pre-decrypted) as the primary path; handle the plain webhook shape as fallback.
- **Mirror the app's template fallbacks** (`generate.ts`) so behavior degrades gracefully if the LLM errors.
```
