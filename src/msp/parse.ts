/**
 * Normalize 1440 inbound webhook payloads (plain + Bot Webhook shapes) into a
 * single internal event. Per the docs, the Bot Webhook delivers pre-decrypted
 * `interactiveResponse` + `textBody`; we prefer those when present.
 *
 * Direction reversal: on inbound, the CUSTOMER is `headers.source_id`
 * (urn:mbid:) — use it as the `destinationId` when replying.
 */
export interface InboundEvent {
  eventType: string; // message.received | interactive | close | typing_start | ...
  customerId: string | null; // urn:mbid: — reply target
  conversationId: string | null;
  /** Plain text body, or the human-readable summary of an interactive reply. */
  text: string | null;
  /** Identifiers the customer selected (quick reply / list picker), if any. */
  selections: string[];
  attachments: any[];
  interactive: any | null;
  tapbacks: any[];
  raw: any;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length ? v : null;
}

export function parseInbound(body: any): InboundEvent {
  const headers = body?.headers ?? {};
  const payload = body?.payload ?? {};
  const customerId =
    str(headers.source_id) ?? str(payload.sourceId) ?? str(payload.from) ?? null;

  // Text: plain message body, or Bot Webhook's textBody summary.
  const text =
    str(payload?.data?.body?.text) ??
    str(payload?.body) ??
    str(payload?.textBody) ??
    str(body?.textBody) ??
    null;

  // Interactive selections (Bot Webhook pre-parsed shape).
  const ir = payload?.interactiveResponse ?? body?.interactiveResponse ?? null;
  const selections: string[] = [];
  if (ir) {
    if (ir.selectedItem?.identifier) selections.push(String(ir.selectedItem.identifier));
    if (Array.isArray(ir.selectedItems)) {
      for (const it of ir.selectedItems) if (it?.identifier) selections.push(String(it.identifier));
    }
  }
  const attachments = Array.isArray(payload?.attachments)
    ? payload.attachments
    : Array.isArray(body?.attachments)
      ? body.attachments
      : [];
  const tapbacks = Array.isArray(payload?.tapbacks)
    ? payload.tapbacks
    : Array.isArray(body?.tapbacks)
      ? body.tapbacks
      : [];

  return {
    eventType: str(body?.event_type) ?? str(payload?.type) ?? 'unknown',
    customerId,
    conversationId: str(body?.conversation_id),
    text,
    selections,
    attachments,
    interactive: ir,
    tapbacks,
    raw: body,
  };
}
