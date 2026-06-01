# Agentic Messaging Backend Design

## System Role

This backend is the AMB and AI runtime for Agentic Messaging. It owns server-only secrets, the 1440 MSP webhook, outbound AMB sends, OpenAI calls, auth-code verification, conversation persistence, and the future human handoff runtime.

The paired app at `/Users/chert/agentic-messaging` is the operator control plane. The backend must make app preview behavior and live Messages behavior converge.

## Current Runtime Flow

1. **App auth via Messages**
   - App asks backend to issue a six-digit code.
   - Backend inserts an `auth_codes` row.
   - App opens AMB with `LOGIN {code}`.
   - 1440 forwards inbound text to `/webhook`.
   - Backend marks the matching code verified and replies in Messages.

2. **Agent routing**
   - User texts `TEST_AGENT {agent_id}`.
   - Backend stores active agent routing by Apple `customer_id`.
   - Future plain messages route to that active agent.

3. **Agent reply**
   - Backend loads conversation state.
   - Backend loads the active agent from Supabase.
   - Backend builds history and calls OpenAI.
   - Backend sends text or quick replies through 1440.
   - Backend appends messages to the conversation row.

4. **Current human handoff**
   - A regex detects explicit requests for a human.
   - Backend marks the conversation `Needs Human`.
   - If 1440 conversation id is available, backend calls `/request-agent`.
   - Backend tells the customer a team member is being connected.

## Key Discrepancies

- **Handoff is a trigger, not a runtime.** There is no durable handoff session, queue, assignment, SLA, summary, or audit trail.
- **AI can continue after escalation.** Conversation status is not part of loaded runtime state, so bot suppression is not guaranteed.
- **Persistence is too lossy.** Messages are stored as a JSON array with read-modify-write updates. Advanced operations need event/message rows and idempotency.
- **No operator APIs.** The app cannot claim, assign, send human replies, resolve, or return a conversation to the agent through backend APIs.
- **Webhook trust is unfinished.** Signature verification and debug payload policy need production treatment.
- **Routing is not multi-tenant safe yet.** `TEST_AGENT {uuid}` needs ownership, status, and test-user authorization checks.
- **Auth code verification is not identity binding yet.** Codes need session/customer binding, attempts, and atomic one-time consumption.

## Shared V0 Contract

These decisions keep the backend and app moving in parallel.

### Primary V0 Persona

Support lead or owner-operator at a service business. The backend should optimize for a controlled pilot where one workspace can create, test, deploy, and supervise AMB agents with reliable human fallback.

### Handoff Source Of Truth

The backend owns handoff state and runtime transitions. The app renders and operates that state. 1440 `/request-agent` is an integration action, not the product's only source of truth.

### Status Mapping

| Runtime state | App label | Backend rule |
|---|---|---|
| `bot_active` | Open | AI may respond normally. |
| `handoff_requested` | Needs Human | Create handoff session, pause normal AI. |
| `queued` | Needs Human | Await claim/assignment. |
| `assigned` | Assigned | Human owner selected. |
| `human_active` | Human Active | Human replies allowed; bot paused. |
| `resolved` | Resolved | No bot reply unless reopened. |
| `returned_to_agent` | Returned to Agent | AI may respond again. |
| `closed` | Closed | Terminal until new inbound reopens or creates a new conversation. |

V0 may keep the existing `conversation_status` enum for compatibility, but new runtime code should introduce a richer handoff/session state and map it to app labels.

### Auth Flow Contract

- `POST /auth/messages/start` issues `{ code, messageBody, expiresAt }`.
- `LOGIN {code}` through `/webhook` marks that code verified.
- `POST /auth/messages/verify` returns `{ ok }`.
- Codes expire after 10 minutes.
- Next hardening: attempt limits, customer/session binding, and atomic one-time consumption.

### Preview Contract

Backend preview must become the app's source of truth for Conversation Lab:

```ts
type PreviewReply = {
  reply: string;
  suggestedActions?: string[];
  trace?: {
    intent?: string;
    confidence?: number;
    guardrail?: string;
    handoffRisk?: 'low' | 'medium' | 'high';
    handoffReason?: string;
    knowledgeUsed?: string[];
  };
};
```

Backend Phase 1 must include shared prompt assembly, trace generation, escalation evaluation, and response shape alignment before the app invests in the full Conversation Lab.

### Realtime Contract

Backend writes conversation, event, and handoff rows to Supabase. App consumes Supabase Realtime where possible, with polling fallback. Rows that drive UI counts must be durable: conversation status, handoff status, last message, priority, assignee, and timestamps.

### TestFlight Authorization Contract

Before TestFlight, `TEST_AGENT` and `REDEPLOY` must check at least:

- agent exists;
- agent belongs to the pilot workspace;
- agent is in the right deployment/test status;
- sender is allowed for that agent or the pilot is explicitly single-tenant.

### Schema Boundary

Backend migrations own runtime/handoff/auth/event tables. App migrations own baseline app domain tables and owner-authored configuration. Backend service-role writes runtime state. App reads operational views and writes configuration only through constrained policies or backend endpoints.

## Preview-Production Parity Contract

The backend should be the only place that decides how an agent responds. The app may simulate UI, but the answer logic should flow through backend endpoints.

Required contract:

- `POST /agents/generate` returns the agent brief, prompt, guardrails, suggested actions, handoff policy, and test scenarios.
- `POST /agents/:id/preview-message` runs the same reply stack as live AMB, minus outbound send.
- Live webhook replies and preview replies share prompt assembly, guardrails, escalation detection, and trace generation.
- Every preview turn can return a trace object for the app's Conversation Lab.

## Handoff Runtime Model

### Conversation State

Conversation status should become an explicit state machine:

- `bot_active`
- `handoff_requested`
- `queued`
- `assigned`
- `human_active`
- `bot_paused`
- `resolved`
- `returned_to_agent`
- `closed`

### Handoff Session

Each escalation should create a durable handoff session:

- `id`
- `conversation_id`
- `agent_id`
- `customer_id`
- `msp_conversation_id`
- `trigger`
- `reason`
- `priority`
- `status`
- `summary`
- `suggested_reply`
- `assigned_team`
- `assigned_operator`
- `sla_deadline`
- `requested_at`
- `assigned_at`
- `resolved_at`
- `returned_to_agent_at`
- `last_error`

### Conversation Events

Use an append-only event table for auditability:

- inbound customer message
- AI reply
- quick reply sent
- handoff requested
- request-agent succeeded/failed
- operator claimed
- human reply sent
- internal note added
- resolved
- returned to agent
- AMB close/handback event

## API Plan

### Auth

- `POST /auth/messages/start`
- `POST /auth/messages/verify`
- Later: bind code to app session/user/customer and consume atomically.

### Agent Runtime

- `POST /agents/generate`
- `POST /agents/:id/preview-message`
- `POST /agents/:id/deploy`
- `POST /agents/:id/redeploy`
- Preview response must include optional trace fields before the app ships Conversation Lab.

### Conversations

- `GET /conversations`
- `GET /conversations/:id`
- `GET /agents/:id/conversations`
- `GET /conversations/:id/events`

### Handoff

- `GET /handoffs?status=queued`
- `POST /handoffs/:id/claim`
- `POST /handoffs/:id/assign`
- `POST /handoffs/:id/reply`
- `POST /handoffs/:id/note`
- `POST /handoffs/:id/resolve`
- `POST /handoffs/:id/return-to-agent`

## Escalation Intelligence

Regex detection is only Phase 0. Advanced handoff should combine:

- Explicit human request.
- Repeated failure or repeated user rephrasing.
- Frustration/sentiment.
- Unsupported intent.
- Sensitive domain.
- Low model confidence.
- Business-hour policy.
- Test-user/VIP rules.
- Agent availability.
- Guardrail hit.

The backend should generate a concise handoff brief from the transcript before alerting the human.

## 1440 / AMB Requirements

- Persist `msp_conversation_id` whenever present.
- Process `agent_handback` and `close` events into conversation state.
- Make `/request-agent` idempotent for one active handoff session.
- Add delivery/failure event support.
- Use quick replies and later list/time pickers where they reduce typing.
- Keep App Clip setup flow, but make setup correlation durable.

## Supabase Schema Plan

Current baseline:

- `agents`
- `conversations`
- `setups`
- `auth_codes`

Add:

- `conversation_messages`
- `conversation_events`
- `handoff_sessions`
- `handoff_notes`
- `agent_handoff_policies`
- `agent_test_scenarios`
- `agent_deployments`
- optional `teams` / `operators`

Keep JSON columns only for flexible draft config. Use rows for runtime events and operational state.

## Security And Operations

### Phase 0 Guardrails

- Set `APP_SHARED_TOKEN` in Railway and local app env.
- Verify 1440 webhook signatures or shared secret once confirmed.
- Remove or redact raw debug webhook payloads before production.
- Add rate limiting for auth, webhook, and LLM endpoints.
- Add idempotency keys for inbound webhook events and outbound sends.
- Do not expose service-role Supabase or OpenAI secrets to the app repo.

### Observability

- Structured logs with request id, conversation id, agent id, customer id hash, and event type.
- Debug endpoint should show redacted recent events, not raw payloads.
- Handoff failures should be visible in the app and logs.
- Add smoke checks for `/health`, auth-code issuance, and preview-message.

## Development Plan

### Phase 0: Stabilize And Align

- Keep local backend on `8787`, app on `8081`, hosted Railway in sync.
- Keep `/health` green.
- Keep auth-code issuance and verification working.
- Add CORS for app-facing endpoints.
- Document local/staging/prod env profiles.

### Phase 1: Durable Runtime

- Add message/event tables.
- Persist MSP conversation id.
- Add idempotent inbound processing.
- Load conversation status in runtime and suppress bot replies during human-active states.
- Implement the preview-production parity contract: shared prompt assembly, preview trace shape, escalation evaluation, and suggested actions.

### Phase 2: Handoff State Machine

- Add `handoff_sessions`.
- Create sessions on escalation.
- Store reason, summary, priority, SLA.
- Process `agent_handback` and `close`.

### Phase 3: Operator APIs

- Claim, assign, reply, note, resolve, return to agent.
- App-authenticated and audited.
- Outbound human replies go through 1440.

### Phase 4: Smarter Escalation

- Replace regex-only escalation with policy plus classifier signals.
- Generate handoff brief and suggested reply.
- Track false positives/false negatives from operator actions.

### Phase 5: AMB-Native Advanced Features

- Rich interactive messages.
- Forms, list/time pickers.
- App Clip handoff/setup improvements.
- Delivery/failure hooks.
- Authenticated customer identity binding.

## Review Questions

- Should the first operator workspace live entirely in the app, or should 1440 live-agent tooling remain the primary human surface?
- Which handoff triggers matter most for the first impressive demo?
- What SLA/availability assumptions should the default product use?
- Do we need multi-tenant org/user modeling before TestFlight, or can TestFlight remain a controlled single-tenant pilot?
