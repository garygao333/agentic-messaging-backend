# Changelog

## 0.1.1 - 2026-06-02

### Changed
- Touch/upsert `customer_profiles` on every inbound Apple Messages webhook so operator surfaces can show last-seen customer context even before a verified phone or Apple ID is known.
- Best-effort infer customer phone/email/Apple ID/display name from webhook payloads when 1440 includes those fields.
- Document the current shared runtime model with the app: one business Apple Messages sender, many customer senders keyed by Apple/1440 `customer_id`, and active-agent routing per customer thread.

### Synced With App
- Matches app `1.0.1`, which defaults the operator sidebar expanded and shows customer line/handle context in the Unified Inbox.
