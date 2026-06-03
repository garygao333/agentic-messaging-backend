# Changelog

## 0.1.9 - 2026-06-03

### Fixed
- Added a fast LLM handoff router before normal agent replies so support,
  human, callback, frustration, billing/account, and unsupported live-system
  requests create real `handoff_sessions` instead of only producing text that
  says a human can help.
- Kept deterministic support/human/callback matching as a fallback for obvious
  requests and interactive support quick replies.

## 0.1.8 - 2026-06-03

### Changed
- Added OpenAI Responses web-search research during agent generation so
  business websites/names can ground the generated prompt, guardrails, welcome
  message, and suggested actions.
- Strengthened generated and live prompts for same-thread Apple Messages agents:
  collect domain-specific details, avoid live-system claims, qualify researched
  facts, and hand off for account, booking, billing, or policy work.
- Made live quick replies domain-aware for travel, appointment, and ecommerce
  agents, including broader airline language such as check-in, delays, seats,
  itinerary, cancellation, and baggage.

### Fixed
- Prevented generic setup-category buttons such as E-commerce, Healthcare, Home
  services, or Book demo from leaking into non-builder agent setup confirmations
  or live runtime quick replies.
- Validated and sanitized business research profiles before accepting them from
  setup routes or existing Supabase provenance, and preserved research through
  schema-drift fallbacks.
- Hardened OpenAI research error handling so auth, rate-limit, timeout, or server
  failures do not trigger a second paid request or expose raw provider errors to
  clients.

## 0.1.7 - 2026-06-03

### Fixed
- Added a web setup-link fallback when 1440 rejects `messageType: app-clip`
  because the Apple Business account has no App Clip configured. Customers can
  still open `/appclip` from Messages and complete onboarding with the same
  setup id, setup token, and Messages sender id.

## 0.1.6 - 2026-06-03

### Fixed
- Kept no-active-agent Messages onboarding working when live Supabase has not
  applied the App Clip setup provenance columns yet. Setup and agent writes now
  retry after removing missing additive columns and keep the setup binding in
  process memory as a compatibility fallback.
- Included `customer_id` in App Clip setup params so older schemas can still
  bind completion back to the originating Messages sender.
- Fixed response buffering so failed no-active-agent setup writes do not create
  an unhandled promise rejection that crashes the Node process.

## 0.1.5 - 2026-06-03

### Changed
- Added masked webhook field-shape diagnostics so Railway logs can show whether
  1440 provided sender, phone-like, email-like, or display-name-like fields
  without dumping raw payloads or message text.
- Added App Clip self-identification support to setup completion and stores
  name/phone/email context as `self_reported_unverified` customer profile data.
- Tagged provider-inferred webhook identity separately from App Clip
  self-identified profile context.
- Added an operator reset endpoint for one-number testing that clears a
  sender's profile, conversations, handoffs, appointments, setup bindings,
  workspace identity, auth codes, and linked generated agents where available.

### Fixed
- Avoid storing empty App Clip identity objects when the customer skips the
  optional identification step.
- Prevent self-reported identity from blindly overwriting existing non-empty
  profile fields unless the previous value was also self-reported.
- Made sender reset tolerate older Supabase schemas that do not yet have the
  App Clip setup provenance columns.

### Synced With App
- Matches app `1.0.5`, which adds the optional identity step and flow/test-case
  documentation.

## 0.1.4 - 2026-06-03

### Changed
- Strengthened App Clip-generated prompts for same-thread Apple Messages
  activation, business grounding, concrete handoff rules, and concise tappable
  suggested replies.
- Hardened live reply prompts and reply cleanup so agents avoid unsupported
  booking/refund/email/ticket claims and stay short enough for Messages.
- Sent generated suggested actions after App Clip completion as a best-effort
  quick reply in the activated thread.

### Fixed
- Made public App Clip setup completion one-time by rejecting completed setups,
  stripping public prompt/config overrides, forcing server-side generation, and
  clearing setup token hashes after successful activation.
- Require a Supabase service-role key in production so the backend cannot boot
  against authenticated RLS with an anon key.
- Sanitized stored and runtime quick-reply labels before they reach 1440 MSP.

### Synced With App
- Matches app `1.0.4`, which clarifies sender/thread UX and fails closed when a
  bound App Clip cannot reach the backend.

## 0.1.3 - 2026-06-03

### Changed
- Removed stale operator-first planning docs so `PLAN.md` remains the single
  source of truth for the App Clip-first demo flow.
- Rewrote the backend README around the current one-business-line Messages
  runtime and documented runtime plugins as post-activation behavior.
- Added durable App Clip setup/customer binding, setup-token validation, and
  agent provenance for the one-business-line demo flow.
- Added App Clip setup completion endpoints that create/generate/deploy an
  agent, activate it for the bound customer thread, and return setup/agent
  payloads to the app.
- Changed no-active-agent inbound Messages handling to send/reuse App Clip setup
  instead of telling customers to open the full app.
- Hardened public setup completion so caller-supplied customer and agent IDs
  cannot hijack another setup.

### Synced With App
- Matches app `1.0.3`, which adds the App Clip-first setup UI and completion
  client for same-thread activation.

## 0.1.2 - 2026-06-03

### Changed
- Reoriented the backend plan around the App Clip-first demo flow: no-agent customers should receive setup, App Clip completion should create/generate/activate immediately, and the same Messages thread should route to the generated agent.
- Documented the mobile app as the later edit/manage surface instead of the first-run control plane.
- Synced repo context with the app so future backend work avoids treating operator auth, test users, or manual deploy gates as the primary first-run path.

### Synced With App
- Matches app `1.0.2`, which documents the matching App Clip setup, immediate same-thread activation, and later full-app edit/manage direction.

## 0.1.1 - 2026-06-02

### Changed
- Touch/upsert `customer_profiles` on every inbound Apple Messages webhook so operator surfaces can show last-seen customer context even before a verified phone or Apple ID is known.
- Best-effort infer customer phone/email/Apple ID/display name from webhook payloads when 1440 includes those fields.
- Document the current shared runtime model with the app: one business Apple Messages sender, many customer senders keyed by Apple/1440 `customer_id`, and active-agent routing per customer thread.

### Synced With App
- Matches app `1.0.1`, which defaults the operator sidebar expanded and shows customer line/handle context in the Unified Inbox.
