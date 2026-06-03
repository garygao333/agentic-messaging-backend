# Runtime Plugins

Runtime plugins are vertical-specific behavior for live Messages agents after a
customer already has an active agent in the shared Apple Messages line. Keep the
core runtime generic; put custom flows here when an agent needs a native
Messages interaction pattern, custom persistence, or domain-specific decision
tree.

Do not put first-run App Clip setup, customer/thread binding, or active-agent
activation here. Those belong in the setup/runtime routing flow documented in
`PLAN.md`.

## Add A Plugin

1. Create `myPlugin.ts` that exports a `RuntimePlugin`.
2. Implement `matches(agent)` so only the intended agents use the plugin.
3. Implement `handleTurn(context)` and return `true` only when the plugin sent
   and persisted the response for this customer turn.
4. Register it in `registry.ts`.

The generic LLM reply path runs when every plugin returns `false`.

## Current Plugins

- `dentistBooking.ts` - demo dental booking flow using list picker, time picker,
  Apple Pay request/preview, and appointment persistence.
