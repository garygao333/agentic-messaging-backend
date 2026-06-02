import type { HistoryTurn } from '../../llm/reply.js';
import {
  canSendApplePayRequest,
  sendApplePayRequest,
  sendListPicker,
  sendText,
  sendTimePicker,
  type ListPickerSection,
  type TimePickerSlot,
} from '../../msp/send.js';
import { upsertAppointment } from '../appointments.js';
import { appendTurn } from '../conversations.js';
import { logConversationEvent } from '../handoff.js';
import type { RuntimeAgent, RuntimePlugin, RuntimePluginContext } from './types.js';

const PRACTICE_NAME = 'New York Dentist';
const PRACTICE_LOCATION = 'New York Dentist - Midtown Manhattan';
const DENTAL_PAYMENT_FALLBACK_URL = 'https://example.com/new-york-dentist-booking-hold';
const DENTAL_TIME_ZONE = 'America/New_York';

const DENTAL_SERVICE_ITEMS = [
  {
    identifier: 'dental_cleaning',
    title: 'Cleaning & exam',
    subtitle: 'Routine cleaning, dentist exam, X-rays if needed',
  },
  {
    identifier: 'new_patient_exam',
    title: 'New patient exam',
    subtitle: 'First visit, X-rays, records, treatment plan',
  },
  {
    identifier: 'tooth_pain',
    title: 'Tooth pain / urgent',
    subtitle: 'Urgent consult for pain, swelling, or a broken tooth',
  },
  {
    identifier: 'whitening_consult',
    title: 'Cosmetic consult',
    subtitle: 'Whitening, veneers, or Invisalign questions',
  },
] as const;

interface DentalSlotDefinition {
  identifier: string;
  dayOffset: number;
  hour: number;
  minute: number;
  titlePrefix?: string;
  subtitle: string;
}

const DENTAL_SLOT_DEFINITIONS: DentalSlotDefinition[] = [
  {
    identifier: 'slot_tomorrow_0900',
    dayOffset: 1,
    hour: 9,
    minute: 0,
    titlePrefix: 'Tomorrow',
    subtitle: 'Hygiene room available',
  },
  {
    identifier: 'slot_tomorrow_1430',
    dayOffset: 1,
    hour: 14,
    minute: 30,
    titlePrefix: 'Tomorrow',
    subtitle: 'Afternoon appointment',
  },
  {
    identifier: 'slot_nextday_1100',
    dayOffset: 2,
    hour: 11,
    minute: 0,
    subtitle: 'Good for new-patient forms',
  },
];

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function recentlySentKind(history: HistoryTurn[], kind: string): boolean {
  return history.slice(-8).some((turn) => turn.role === 'agent' && turn.kind === kind);
}

function isDentistAgent(agent: RuntimeAgent): boolean {
  const haystack = [
    agent.name,
    agent.company_name,
    agent.business_type,
    agent.use_case,
    agent.prompt,
  ]
    .join(' ')
    .toLowerCase();
  return /\b(dentist|dental|orthodont|teeth|tooth|hygienist)\b/.test(haystack);
}

function dentalServiceFor(text: string): (typeof DENTAL_SERVICE_ITEMS)[number] | null {
  const normalized = normalizeText(text);
  return (
    DENTAL_SERVICE_ITEMS.find((item) => {
      const title = normalizeText(item.title);
      return (
        normalized === item.identifier ||
        normalized.includes(title) ||
        title.includes(normalized) ||
        normalized.includes(item.identifier.replace(/_/g, ' '))
      );
    }) ??
    (/\b(clean|cleaning|exam|checkup|check up)\b/.test(normalized)
      ? DENTAL_SERVICE_ITEMS[0]
      : /\b(new patient|first visit|intake)\b/.test(normalized)
        ? DENTAL_SERVICE_ITEMS[1]
        : /\b(pain|urgent|emergency|ache|tooth)\b/.test(normalized)
          ? DENTAL_SERVICE_ITEMS[2]
          : /\b(white|whitening|cosmetic|invisalign|veneer)\b/.test(normalized)
            ? DENTAL_SERVICE_ITEMS[3]
            : null)
  );
}

function dentalSlotFor(text: string): { identifier: string; label: string } | null {
  const normalized = normalizeText(text);
  const labels = dentalSlotLabels();
  const direct = Object.entries(labels).find(([identifier, label]) => {
    const labelText = normalizeText(label);
    return (
      normalized === identifier ||
      normalized.includes(labelText) ||
      labelText.includes(normalized)
    );
  });
  if (direct) return { identifier: direct[0], label: direct[1] };
  if (/\b(9|9:00|morning)\b/.test(normalized)) {
    return { identifier: 'slot_tomorrow_0900', label: labels.slot_tomorrow_0900! };
  }
  if (/\b(2:30|2|afternoon|tomorrow)\b/.test(normalized)) {
    return { identifier: 'slot_tomorrow_1430', label: labels.slot_tomorrow_1430! };
  }
  if (/\b(wednesday|11|11:00)\b/.test(normalized)) {
    return { identifier: 'slot_nextday_1100', label: labels.slot_nextday_1100! };
  }
  return null;
}

function wantsDentalBooking(text: string): boolean {
  return hasAny(normalizeText(text), [
    /\b(book|schedule|appointment|visit|cleaning|exam|dentist|dental|tooth|teeth|pain|whitening|invisalign|veneer)\b/,
    /\b(start|hello|hi|hey|options?|what can you do)\b/,
  ]);
}

function wantsDentalPayment(text: string): boolean {
  return hasAny(normalizeText(text), [
    /\b(pay|payment|apple pay|deposit|hold|confirm|reserve|checkout)\b/,
  ]);
}

function formatAppleTime(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/:\d{2}\.\d{3}Z$/, '+0000');
}

function localDateParts(date: Date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DENTAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function addLocalDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function offsetMinutesFor(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DENTAL_TIME_ZONE,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = raw.match(/^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::?(?<minutes>\d{2}))?)?$/);
  if (!match?.groups?.sign) return 0;
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  const sign = match.groups.sign === '-' ? -1 : 1;
  return sign * (hours * 60 + minutes);
}

function zonedDateTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): Date {
  let timestamp = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMinutesFor(new Date(timestamp));
    timestamp = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute) - offset * 60_000;
  }
  return new Date(timestamp);
}

function formatSlotLabel(date: Date, prefix?: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: DENTAL_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  if (prefix) return `${prefix} at ${time}`;
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: DENTAL_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
  return `${day} at ${time}`;
}

function dentalSlotLabels(): Record<string, string> {
  const today = localDateParts();
  return Object.fromEntries(
    DENTAL_SLOT_DEFINITIONS.map((definition) => {
      const localDay = addLocalDays(today, definition.dayOffset);
      const date = zonedDateTimeToUtc({
        ...localDay,
        hour: definition.hour,
        minute: definition.minute,
      });
      return [definition.identifier, formatSlotLabel(date, definition.titlePrefix)];
    }),
  );
}

function dentalSlots(): TimePickerSlot[] {
  const today = localDateParts();
  return DENTAL_SLOT_DEFINITIONS.map((definition) => {
    const localDay = addLocalDays(today, definition.dayOffset);
    const start = zonedDateTimeToUtc({
      ...localDay,
      hour: definition.hour,
      minute: definition.minute,
    });
    return {
      identifier: definition.identifier,
      startTime: formatAppleTime(start),
      duration: 3600,
      title: formatSlotLabel(start, definition.titlePrefix),
      subtitle: definition.subtitle,
    };
  });
}

function slotStart(identifier: string): string | undefined {
  const startTime = dentalSlots().find((slot) => slot.identifier === identifier)?.startTime;
  if (!startTime) return undefined;
  const parsed = new Date(startTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : startTime;
}

function dentalListPickerSections(): ListPickerSection[] {
  return [
    {
      title: 'Visit type',
      items: DENTAL_SERVICE_ITEMS.map((item, index) => ({ ...item, order: index })),
    },
  ];
}

async function sendDentistServicePicker(context: RuntimePluginContext): Promise<void> {
  const title = 'Choose a visit type';
  const subtitle = 'New York Dentist will use this to route your visit.';
  const sections = dentalListPickerSections();
  await sendListPicker(context.customerId, {
    title,
    subtitle,
    sections,
    requestIdentifier: context.nextRequestId(),
  });
  await logConversationEvent({
    conversationId: context.conversationId,
    agentId: context.agentId,
    customerId: context.customerId,
    mspConversationId: context.mspConversationId,
    eventType: 'list_picker_sent',
    actor: 'agent',
    body: title,
    payload: { sections },
  });
  await appendTurn(context.conversationId, {
    role: 'agent',
    text: title,
    kind: 'list_picker',
    interactive: {
      type: 'list_picker',
      title,
      subtitle,
      items: sections.flatMap((section) =>
        section.items.map((item) => ({
          id: item.identifier,
          title: item.title,
          subtitle: item.subtitle,
        })),
      ),
    },
    payload: { sections },
  });
}

async function sendDentistTimePicker(
  context: RuntimePluginContext,
  serviceTitle: string,
): Promise<void> {
  const title = 'Pick an appointment time';
  const subtitle = `${serviceTitle} at ${PRACTICE_NAME}`;
  const slots = dentalSlots();
  const firstSlotDate = new Date(slots[0]!.startTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const event = {
    identifier: 'pearl_dental_booking',
    title: subtitle,
    timezoneOffset: offsetMinutesFor(firstSlotDate),
    location: {
      title: PRACTICE_LOCATION,
      latitude: 40.7506,
      longitude: -73.9935,
      radius: 80,
    },
    timeslots: slots,
  };
  await sendTimePicker(context.customerId, {
    title,
    subtitle,
    event,
    requestIdentifier: context.nextRequestId(),
  });
  await logConversationEvent({
    conversationId: context.conversationId,
    agentId: context.agentId,
    customerId: context.customerId,
    mspConversationId: context.mspConversationId,
    eventType: 'time_picker_sent',
    actor: 'agent',
    body: title,
    payload: { event },
  });
  await appendTurn(context.conversationId, {
    role: 'agent',
    text: title,
    kind: 'time_picker',
    interactive: {
      type: 'time_picker',
      title,
      subtitle,
      items: slots.map((slot) => ({
        id: slot.identifier,
        title: slot.title ?? slot.identifier,
        subtitle: slot.subtitle,
      })),
    },
    payload: { event },
  });
}

async function sendDentistApplePay(
  context: RuntimePluginContext,
  slotLabel?: string,
): Promise<void> {
  const title = 'Confirm with Apple Pay';
  const subtitle = slotLabel ? `$50 refundable hold for ${slotLabel}` : '$50 refundable booking hold';
  const paymentPreview = {
    title,
    subtitle,
    amount: '50.00',
    currencyCode: 'USD',
    merchantName: PRACTICE_NAME,
    fallbackUrl: DENTAL_PAYMENT_FALLBACK_URL,
  };

  if (canSendApplePayRequest()) {
    await sendApplePayRequest(context.customerId, {
      title,
      subtitle,
      merchantName: PRACTICE_NAME,
      totalLabel: 'New York Dentist appointment hold',
      totalAmount: '50.00',
      currencyCode: 'USD',
      countryCode: 'US',
      lineItems: [{ label: 'Refundable appointment hold', amount: '50.00', type: 'final' }],
      requestIdentifier: context.nextRequestId(),
    });
    await logConversationEvent({
      conversationId: context.conversationId,
      agentId: context.agentId,
      customerId: context.customerId,
      mspConversationId: context.mspConversationId,
      eventType: 'apple_pay_sent',
      actor: 'agent',
      body: subtitle,
      payload: { paymentPreview },
    });
  } else {
    await sendText(
      context.customerId,
      'Apple Pay is the final confirmation step. In this test workspace, merchant payment credentials are not connected yet, so I will show the payment request in the operator preview instead of charging you.',
    );
    await logConversationEvent({
      conversationId: context.conversationId,
      agentId: context.agentId,
      customerId: context.customerId,
      mspConversationId: context.mspConversationId,
      eventType: 'apple_pay_preview_only',
      actor: 'agent',
      body: subtitle,
      payload: { paymentPreview },
    });
  }

  await appendTurn(context.conversationId, {
    role: 'agent',
    text: title,
    kind: 'apple_pay',
    interactive: {
      type: 'apple_pay',
      title,
      subtitle,
      items: [
        {
          id: 'refundable_hold',
          title: '$50.00 refundable hold',
          subtitle: 'Applied to the visit or refunded after check-in',
        },
      ],
    },
    payload: { paymentPreview, liveApplePayConfigured: canSendApplePayRequest() },
  });
}

function persistAppointment(input: Parameters<typeof upsertAppointment>[0]): void {
  void upsertAppointment(input).catch((err) => {
    console.warn('[appointments] background upsert failed:', err);
  });
}

async function handleDentistTurn(context: RuntimePluginContext): Promise<boolean> {
  const service = dentalServiceFor(context.customerText);
  const slot = dentalSlotFor(context.customerText);

  if (slot || wantsDentalPayment(context.customerText)) {
    const slotLabel = slot?.label;
    const text = slotLabel
      ? `Great, I can hold ${slotLabel}. The last step is a refundable $50 appointment hold.`
      : 'I can take the refundable appointment hold through Apple Pay.';
    await sendText(context.customerId, text);
    await appendTurn(context.conversationId, { role: 'agent', text });
    persistAppointment({
      conversationId: context.conversationId,
      agentId: context.agentId,
      customerId: context.customerId,
      customerName: context.customerName ?? undefined,
      slot: slot
        ? {
            identifier: slot.identifier,
            label: slot.label,
            startsAt: slotStart(slot.identifier),
            durationSeconds: 3600,
            locationTitle: PRACTICE_LOCATION,
          }
        : null,
      status: slot ? 'scheduled' : 'collecting',
      paymentStatus: 'requested',
      paymentAmount: '50.00',
      paymentCurrency: 'USD',
      history: context.history,
    });
    await sendDentistApplePay(context, slotLabel);
    return true;
  }

  if (service) {
    const text = `Got it - ${service.title}. Here are the openings I can offer in Messages.`;
    await sendText(context.customerId, text);
    await appendTurn(context.conversationId, { role: 'agent', text });
    persistAppointment({
      conversationId: context.conversationId,
      agentId: context.agentId,
      customerId: context.customerId,
      customerName: context.customerName ?? undefined,
      service,
      status: 'collecting',
      paymentStatus: 'not_required',
      history: context.history,
    });
    await sendDentistTimePicker(context, service.title);
    return true;
  }

  if (wantsDentalBooking(context.customerText) && !recentlySentKind(context.history, 'list_picker')) {
    const text = `Hi, this is ${PRACTICE_NAME}. I can help reserve a visit. First, choose what kind of appointment you need.`;
    await sendText(context.customerId, text);
    await appendTurn(context.conversationId, { role: 'agent', text });
    persistAppointment({
      conversationId: context.conversationId,
      agentId: context.agentId,
      customerId: context.customerId,
      customerName: context.customerName ?? undefined,
      status: 'collecting',
      paymentStatus: 'not_required',
      history: context.history,
    });
    await sendDentistServicePicker(context);
    return true;
  }

  if (wantsDentalBooking(context.customerText)) {
    const text =
      'Use the visit picker above, or reply with Cleaning, New patient exam, Tooth pain, or Cosmetic consult.';
    await sendText(context.customerId, text);
    await appendTurn(context.conversationId, { role: 'agent', text });
    return true;
  }

  return false;
}

export const dentalBookingPlugin: RuntimePlugin = {
  id: 'dentist-booking',
  label: 'Dentist booking',
  matches: isDentistAgent,
  handleTurn: handleDentistTurn,
};
