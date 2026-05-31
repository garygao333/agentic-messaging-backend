# Agentic Messaging — End-to-End Integration Plan

> **What this is:** the single source of truth for finishing "Lovable for Apple Messages for
> Business" across the **backend** (this repo, System 2) and the **Expo app** (System 1,
> `agentic-messaging-app`). Two agents work from this: a backend agent and an app agent. Read the
> top section, then your half, then the **Bridge** section (shared contracts both sides must match).

---

## 0. The product, in one breath

A company texts the Agentic Messaging business account → sets up a test agent via an App Clip →
reviews/manages/deploys it in the mobile app → test users chat the live agent in Apple Messages for
Business → conversations show up in the app. The backend owns **all LLM calls** (App-Store-safe key)
and the **live agent runtime**; the app is the **UI control plane** and does Supabase CRUD directly.

```
Messages ──(1440 MSP webhook)──▶ Backend (Railway) ──LLM──▶ reply ──(1440 send)──▶ Messages
   ▲                                   │  writes conversations/messages
   │                                   ▼
 App Clip / deep links            Supabase (shared DB)  ◀──reads/writes CRUD── Expo App
```

**Architecture rule:** the app keeps doing CRUD straight to Supabase. The backend owns messaging +
runtime + LLM and writes conversation activity. They meet at three contracts: the **Supabase schema**,
the **2 LLM HTTP endpoints**, and the **auth_codes handshake** (see Bridge).

### Locked decisions (from the owner)
- **Scope:** wire the *full* loop now (LLM seam + LOGIN 2FA + conversations fetch + env).
- **App→backend auth:** **shared bearer token** (`APP_SHARED_TOKEN` on the backend ⇄
  `EXPO_PUBLIC_BACKEND_TOKEN` in the app). Upgrade to Supabase JWT later.
- **Agent↔conversation routing:** active agent per `TEST_AGENT {id}`, persisted on the conversation.
- **Versioning:** "latest wins" for MVP (no version history table).

---

## 1. Current status (verified live, 2026-05-31)

**Backend — DONE & deployed** (`https://agentic-messaging-backend-production.up.railway.app`):
- Hono/TS service on Railway, on the Supabase **service-role key**. `/health` green.
- `POST /agents/generate` and `POST /agents/:id/preview-message` — live, real GPT-4o-mini.
- `POST /webhook` — 1440 inbound → parse → 5-command protocol + agent runtime.
- Agent runtime: loads agent, shared prompt, OpenAI reply, **persists turns**, maps
  `suggested_actions`→quick replies, human handoff (`status='Needs Human'` + 1440 `/request-agent`).
- LOGIN verify against `auth_codes`; App Clip link send; `setups` lookup.
- **Proven end-to-end:** texted `TEST_AGENT <id>` → routed, conversation row created/persisted,
  reply delivered to the test phone. Inbound→LLM→outbound→Supabase all confirmed.

**Database — migrations applied:** `0001` (core), `0002` (welcome_message + suggested_actions),
`0003` (conversations.customer_id + active_agent_id, auth_codes table). All present in the live DB.

**App — NOT yet wired to the backend.** Still calls OpenAI directly / template fallback via
`services/llm.ts`. Already in Supabase mode (`EXPO_PUBLIC_USE_SUPABASE=true`), so CRUD is live.

**Known temporary state:**
- 1440 is using **Webhook Forwarding** (all inbound, raw) → `/webhook`, Bot Webhook off.
- `APP_SHARED_TOKEN` is **generated** and set in the backend's local `.env`. **Owner must set the
  same value on Railway** and give it to the app agent as `EXPO_PUBLIC_BACKEND_TOKEN`. Until it's on
  Railway, the deployed endpoints remain open (the guard no-ops when the var is unset).
- `/debug/webhooks` is now **auth-gated** by `APP_SHARED_TOKEN`; remove entirely before production.
- OpenAI key is the same one shipped in the app binary — **rotate it**.

---

## 2. BACKEND — what's left (this repo)

1. **Set `APP_SHARED_TOKEN` on Railway.** ✅ Generated and in the backend's local `.env`; the guard
   exists (`src/auth.ts`) and now also protects `/debug/webhooks`. **Remaining (owner):** add the
   value to Railway Variables and share it with the app agent (`EXPO_PUBLIC_BACKEND_TOKEN`).
2. **Switch 1440 to the Bot Webhook** (from Webhook Forwarding) once the app relies on quick replies
   / handoff. Why: Bot Webhook delivers **pre-decrypted** interactive payloads (quick-reply taps
   parse cleanly via `src/msp/parse.ts`) and respects the per-conversation AI gate (so the bot stops
   when a human takes over — correct handoff semantics). Webhook Forwarding sends raw, encrypted
   interactive refs we can't read, and keeps firing after handoff. **Action (owner, dashboard):**
   point Bot Webhook → `/webhook`, turn Webhook Forwarding off. (Parser already handles both shapes
   + the `text` event_type quirk.)
3. **`/debug/webhooks`** is now **auth-gated** by `APP_SHARED_TOKEN` (kept for the app-integration
   pass). **Remove it entirely** (route + ring buffer in `src/routes/webhook.ts`) before production.
4. **Webhook signature verification** — confirm 1440's mechanism (per-subscription secret? header?),
   then verify in the webhook handler using `MSP_WEBHOOK_SECRET`. Currently unverified (TODO noted).
5. **Multi-turn for interactive replies** — once on Bot Webhook, quick-reply taps arrive as
   `interactiveResponse`; `parse.ts` extracts `selections` and `handlers.ts` already treats a tap as
   the selected label. Verify end-to-end after the Bot Webhook switch.
6. **(Later) RLS hardening, rate limiting, structured logging/metrics** — see §6.

> Backend needs **no** new endpoints for the app wiring — `/agents/generate`,
> `/agents/:id/preview-message`, and `auth_codes` verification are all built and tested.

---

## 3. APP — what's left (`agentic-messaging-app`, for the app agent)

The app is already in Supabase mode and does CRUD correctly. Three changes wire it to the backend.
**Do not change the `ApiClient` shape or the screens' call sites** — only the seam implementations.

### 3.1 Rewrite `src/services/llm.ts` to call the backend (NOT raw OpenAI)
> ⚠️ The old `EXPO_PUBLIC_LLM_PROXY_URL` path POSTs a raw OpenAI chat-completions body and expects an
> OpenAI-shaped response. The backend speaks a **different contract**. So this is a real rewrite, not
> an env flip. Keep the deterministic template fallback (from `src/lib/generate.ts`) for
> offline/demo/no-backend.

- New env: `EXPO_PUBLIC_BACKEND_URL`, `EXPO_PUBLIC_BACKEND_TOKEN`. `llmConfigured = Boolean(BACKEND_URL)`.
- `generateAgentConfig(draft)` → `POST ${BACKEND_URL}/agents/generate`
  - headers: `Authorization: Bearer ${BACKEND_TOKEN}`, `Content-Type: application/json`
  - body: `{ name, companyName, website, businessType, useCase, integrations, handoffDestination }`
  - response: `{ prompt, guardrails, welcomeMessage, suggestedActions }` → return as `AgentConfig`.
  - on error / no backend → existing template fallback.
- `chatReply(agent, history)` → `POST ${BACKEND_URL}/agents/${agent.id}/preview-message`
  - body: `{ messages: history.map(m => ({ role: m.role, text: m.text })) }` (`role` is `'customer'|'agent'`)
  - response: `{ reply }`.
  - **Precondition:** the agent must exist in Supabase (it does in Supabase mode — created before
    preview). In mock/demo mode, fall back to templates (no backend call).
- **Remove** `EXPO_PUBLIC_OPENAI_API_KEY` usage entirely.

### 3.2 Close the LOGIN 2FA loop in `src/services/supabaseApi.ts`
The app issues a code; the user texts `LOGIN <code>`; the backend marks it verified; the app polls.
`auth_codes` has permissive RLS, so the app's **anon key can insert/select** it.
- `authMessagesStart(handle)`: `genCode()`, then `INSERT` into `auth_codes`
  `{ code, apple_id: handle ?? null }` (let `verified`/`expires_at` default). Return
  `{ code, messageBody: loginBody(code) }`.
- `authMessagesVerify(handle, code)`: poll `auth_codes` where `code = code` for `verified = true`
  (e.g. 2s interval, ~60s timeout) → `{ ok: true }`; timeout → `{ ok: false }`.
- `src/app/verify.tsx`: optionally auto-poll after the user sends the code (keep "Simulate" only for
  demo mode). `mockApi` stays as-is for demo.

### 3.3 Hydrate conversations in Supabase mode
Backend writes conversation rows (`agent_id`, `customer_id`, `messages`, `status`,
`last_message`). The conversations screen reads the store via `selectConversationsFor`. **Verify**
that `src/app/(app)/agents/[id]/manage.tsx` (or the conversations screen) calls
`api.listConversations(agentId)` on mount in Supabase mode — if not, add it — so backend-written
threads hydrate the store. (Backend defaults `customer_name` to `"Apple Customer"`.)

### 3.4 App `.env`
- Add `EXPO_PUBLIC_BACKEND_URL=https://agentic-messaging-backend-production.up.railway.app`
- Add `EXPO_PUBLIC_BACKEND_TOKEN=<same value as backend APP_SHARED_TOKEN>` (owner provides)
- Keep `EXPO_PUBLIC_USE_SUPABASE=true` + the Supabase URL/anon key.
- **Remove** `EXPO_PUBLIC_OPENAI_API_KEY` and `EXPO_PUBLIC_LLM_PROXY_URL` (superseded).

---

## 4. BRIDGE — the shared contracts (both sides must match)

### 4.1 Shared bearer token
Owner generates one secret. Set it as `APP_SHARED_TOKEN` (Railway Variables) **and**
`EXPO_PUBLIC_BACKEND_TOKEN` (app `.env`). The app sends it as `Authorization: Bearer <token>` on the
two LLM calls; the backend's `requireAppAuth` checks it.
> ⚠️ `EXPO_PUBLIC_*` vars are bundled into the app binary, so this token is extractable. It blocks
> casual/anonymous spend, not a determined attacker. Upgrade to Supabase-JWT verification before any
> public release (the backend has a hook for this in `src/auth.ts`).

### 4.2 LLM endpoint contracts (frozen — app & backend must agree)
```
POST /agents/generate              Bearer auth
  req  { name, companyName, website, businessType, useCase, integrations[], handoffDestination }
  res  { prompt, guardrails, welcomeMessage, suggestedActions[] }

POST /agents/:id/preview-message   Bearer auth
  req  { messages: [{ role: "customer"|"agent", text }] }
  res  { reply }                   (loads agent :id from Supabase; 404 if missing)
```

### 4.3 `auth_codes` handshake (LOGIN 2FA)
Table (migration `0003`): `{ id, code, apple_id, verified, created_at, expires_at (now()+10min) }`.
- **App writes** the issued code (`authMessagesStart`), then **polls** `verified`.
- **Backend flips** `verified=true` when the user texts `LOGIN <code>` (already implemented).
- Codes expire in 10 min; expired/unknown → backend replies "didn't match or expired".

### 4.4 Conversations contract
- **Backend writes:** `conversations` rows keyed by `customer_id` (urn:mbid:), with `agent_id`,
  `active_agent_id`, `messages` jsonb (`{id, role, text, timestamp}`), `last_message`, `status`.
- **App reads:** `listConversations(agentId)` by `agent_id`. They appear under that agent.

### 4.5 Deep-link / command protocol (already aligned)
App builds `https://bcrw.apple.com/urn:biz:<AMB_BIZ_ID>?body=<cmd>` (`src/lib/messageLinks.ts`);
backend handles all five: `LOGIN {code}`, `START_AGENT_SETUP`, `AGENT_SETUP_COMPLETE {setup_id}`,
`TEST_AGENT {agent_id}`, `REDEPLOY {agent_id}`. `AMB_BIZ_ID` = `914e49f4-2b03-4e2b-987f-8c8f45e40294`
(== 1440 `X-Business-Id`). The deploy→"Open in Messages"→`TEST_AGENT`→live-chat loop works today.

### 4.6 End-to-end acceptance test (the "it works" milestone)
1. App: "Continue with Messages" → texts `LOGIN <code>` → app auto-verifies (auth_codes) → signs in.
2. App Clip setup → generate (calls backend `/agents/generate`) → preview chat (calls
   `/agents/:id/preview-message`) → Deploy.
3. "Open in Messages" → `TEST_AGENT <id>` → chat the live agent → replies arrive.
4. App → agent → Conversations: the thread + messages appear.

---

## 5. Sequencing (recommended order)
1. **Owner:** generate token → set `APP_SHARED_TOKEN` (Railway) + give value to app agent.
2. **Backend:** remove `/debug/webhooks`; switch 1440 to Bot Webhook; rotate OpenAI key.
3. **App:** §3.1 llm.ts rewrite → verify generate + preview against the live backend.
4. **App:** §3.2 LOGIN loop + §3.3 conversations fetch + §3.4 env.
5. **Both:** run §4.6 acceptance test on the test device.
6. Then harden (§6).

---

## 6. Beyond MVP — to be a real "Lovable for AMB"
- **Native App Clip** target + App Clip configured in 1440 (so `START_AGENT_SETUP` sends a real
  clip). Define how `setup_id` carries Clip → full app on handoff.
- **Apple/MSP production onboarding** beyond the test account (brand registration, review).
- **Real auth + RLS hardening:** replace the mock session with Supabase Auth; tighten the permissive
  MVP RLS to per-user/org on `agents`/`conversations`/`setups`/`auth_codes`.
- **Webhook signature verification** (`MSP_WEBHOOK_SECRET`).
- **Agent versioning** (replace latest-wins) for auditable deploy/redeploy.
- **Richer interactive types:** list pickers, time pickers, forms, rich links, Apple Pay, auth
  requests, Business Update invitations (`tel:+`).
- **Ops:** rate limiting (webhook + LLM), structured logging/metrics, retention/consent compliance.
- **iMessage dedup awareness:** Apple silently drops repeated identical outbound bodies — rotate
  phrasing in any auto-reply/state-machine text.

---

## 7. Reference (no secrets — those live in env/Railway/owner)
- Backend URL: `https://agentic-messaging-backend-production.up.railway.app`
- Repo (backend): `github.com/garygao333/agentic-messaging-backend` (backend is the repo root)
- AMB biz id / 1440 X-Business-Id: `914e49f4-2b03-4e2b-987f-8c8f45e40294`
- Supabase project ref: `gsadcteyuplycuwskvru`
- Test agent id (Healthcare Intake): `d9cb6ef1-b5d2-4e01-99d3-eed21ec7a88c`
- Env var names — backend: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`,
  `MSP_API_BASE`, `MSP_API_KEY`, `MSP_BUSINESS_ID`, `MSP_WEBHOOK_SECRET`, `APP_SHARED_TOKEN`.
  App: `EXPO_PUBLIC_USE_SUPABASE`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
  `EXPO_PUBLIC_AMB_BIZ_ID`, `EXPO_PUBLIC_BACKEND_URL`, `EXPO_PUBLIC_BACKEND_TOKEN`.
