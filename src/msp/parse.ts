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

function firstStr(...values: unknown[]): string | null {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return null;
}

function addSelection(selections: string[], value: unknown): void {
  const text = str(value);
  if (text && !selections.includes(text)) selections.push(text);
}

function addSelectedItem(selections: string[], value: any): void {
  if (!value || typeof value !== 'object') return;
  addSelection(selections, value.identifier ?? value.title ?? value.value);
}

function addSelectedArray(selections: string[], value: any): void {
  if (!Array.isArray(value)) return;
  for (const item of value) addSelectedItem(selections, item);
}

function valuesArray(...values: unknown[]): any[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      if (value.length > 0) return value;
      continue;
    }
    if (value && typeof value === 'object') return [value];
  }
  return [];
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function tapbackSummary(tapbacks: any[]): string | null {
  if (tapbacks.length === 0) return null;
  const labels = tapbacks.map((tapback) => {
    if (typeof tapback === 'string') return tapback;
    if (!tapback || typeof tapback !== 'object') return null;

    const reaction = firstStr(
      tapback.summary,
      tapback.reaction,
      tapback.tapback,
      tapback.type,
      tapback.name,
      tapback.label,
      tapback.value,
      tapback.action,
    );
    const target = firstStr(
      tapback.targetText,
      tapback.messageText,
      tapback.text,
      tapback.body,
      tapback.message?.text,
      tapback.target?.text,
    );
    const removed =
      tapback.removed === true ||
      tapback.isRemoved === true ||
      tapback.deleted === true ||
      /remove|delete/i.test(str(tapback.action) ?? '');

    if (reaction && target) {
      return `${removed ? 'removed ' : ''}${reaction} "${truncate(target)}"`;
    }
    if (reaction) return removed ? `removed ${reaction}` : reaction;
    if (target) return `reaction to "${truncate(target)}"`;
    return null;
  });
  const clean = labels.filter((label): label is string => Boolean(label));
  if (clean.length === 0) return tapbacks.length === 1 ? 'Tapback received' : `${tapbacks.length} tapbacks received`;
  return clean.length === 1 ? `Tapback: ${clean[0]}` : `Tapbacks: ${clean.join(', ')}`;
}

export function parseInbound(body: any): InboundEvent {
  const headers = body?.headers ?? body?.payload?.headers ?? {};
  const payload = body?.payload ?? {};
  const data = payload?.data ?? body?.data ?? {};
  const dataHeaders = data?.headers ?? {};
  const customerId =
    firstStr(
      headers.source_id,
      headers.sourceId,
      headers['source-id'],
      payload.source_id,
      payload.sourceId,
      payload.from,
      payload.customerId,
      body.source_id,
      body.sourceId,
      body.from,
      body.customerId,
    ) ?? null;

  // Text: plain message body, or Bot Webhook's textBody summary.
  const tapbacks = valuesArray(
    payload?.tapbacks,
    body?.tapbacks,
    data?.tapbacks,
    data?.body?.tapbacks,
    payload?.tapback,
    body?.tapback,
    data?.tapback,
    data?.body?.tapback,
  );
  const text =
    firstStr(
      data?.body?.text,
      payload?.body,
      payload?.textBody,
      body?.textBody,
      body?.text,
      data?.textBody,
    ) ??
    tapbackSummary(tapbacks) ??
    null;

  // Interactive selections (Bot Webhook pre-parsed shape + raw MSP interactiveData).
  const ir =
    payload?.interactiveResponse ??
    body?.interactiveResponse ??
    payload?.interactiveData ??
    body?.interactiveData ??
    null;
  const selections: string[] = [];
  if (ir) {
    addSelection(selections, ir.selectedItem?.identifier ?? ir.selectedItem?.title);
    if (Array.isArray(ir.selectedItems)) {
      for (const it of ir.selectedItems) addSelection(selections, it?.identifier ?? it?.title);
    }
    const quickReply = ir.data?.['quick-reply'] ?? ir['quick-reply'];
    addSelection(selections, quickReply?.selectedIdentifier);
    const selectedIndex = Number(quickReply?.selectedIndex);
    if (Number.isInteger(selectedIndex) && Array.isArray(quickReply?.items)) {
      const selected = quickReply.items[selectedIndex];
      addSelection(selections, selected?.identifier ?? selected?.title);
    }

    const listPicker = ir.data?.listPicker ?? ir.listPicker;
    if (Array.isArray(listPicker)) {
      for (const section of listPicker) {
        addSelection(selections, section?.selectedIdentifier);
        addSelectedItem(selections, section?.selectedItem);
        addSelectedArray(selections, section?.selectedItems);
        const selectedListIndex = Number(section?.selectedIndex);
        const items = Array.isArray(section?.listPickerItem) ? section.listPickerItem : [];
        if (Number.isInteger(selectedListIndex) && items[selectedListIndex]) {
          addSelectedItem(selections, items[selectedListIndex]);
        }
      }
    } else if (listPicker && typeof listPicker === 'object') {
      addSelection(selections, listPicker.selectedIdentifier);
      addSelectedItem(selections, listPicker.selectedItem);
      addSelectedArray(selections, listPicker.selectedItems);
    }

    const event = ir.data?.event ?? ir.event;
    if (event && typeof event === 'object') {
      addSelection(
        selections,
        event.selectedIdentifier ??
          event.selectedTimeIdentifier ??
          event.selectedTimeSlotIdentifier ??
          event.selectedTimeslotIdentifier,
      );
      addSelectedItem(selections, event.selectedItem ?? event.selectedTimeSlot ?? event.selectedTimeslot);
      addSelectedArray(selections, event.selectedItems ?? event.selectedTimeSlots ?? event.selectedTimeslots);
    }

    const payment = ir.data?.payment ?? ir.payment;
    if (payment && typeof payment === 'object') {
      addSelection(selections, payment.status ?? payment.paymentStatus ?? payment.authorizationStatus);
    }
  }
  const attachments = Array.isArray(payload?.attachments)
    ? payload.attachments
    : Array.isArray(body?.attachments)
      ? body.attachments
      : [];

  return {
    eventType: firstStr(body?.event_type, body?.eventType, payload?.event_type, payload?.eventType, payload?.type) ?? 'unknown',
    customerId,
    conversationId:
      firstStr(
        body?.conversation_id,
        body?.conversationId,
        body?.conversation?.id,
        body?.conversation?.conversation_id,
        body?.conversation?.conversationId,
        payload?.conversation_id,
        payload?.conversationId,
        payload?.conversation?.id,
        payload?.conversation?.conversation_id,
        payload?.conversation?.conversationId,
        data?.conversation_id,
        data?.conversationId,
        data?.conversation?.id,
        data?.conversation?.conversation_id,
        data?.conversation?.conversationId,
        headers?.conversation_id,
        headers?.conversationId,
        headers?.['conversation-id'],
        headers?.msp_conversation_id,
        headers?.mspConversationId,
        dataHeaders?.conversation_id,
        dataHeaders?.conversationId,
        dataHeaders?.['conversation-id'],
      ) ??
      null,
    text,
    selections,
    attachments,
    interactive: ir,
    tapbacks,
    raw: body,
  };
}
