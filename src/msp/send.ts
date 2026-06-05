/**
 * 1440 MSP outbound wrapper — POST /send-message-api.
 *
 * Auth: Bearer <MSP_API_KEY> + X-Business-Id: <MSP_BUSINESS_ID>.
 * `destinationId` is the customer's opaque `urn:mbid:` (from inbound
 * headers.source_id). Standard/interactive messages MUST use urn:mbid:.
 */
import { env } from '../env.js';
import { readFileSync } from 'node:fs';
import {
  hasApplePayMerchantIdentityConfig,
  requestApplePayMerchantSession,
} from './applePaySession.js';

const AMB_EXTENSION_BID =
  'com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.icloud.apps.messages.business.extension';

let defaultRichLinkImageBase64: string | null | undefined;
let defaultInteractiveImageBase64: string | null | undefined;

export interface PickerItem {
  identifier: string;
  title: string;
  subtitle?: string;
  order?: number;
  imageIdentifier?: string;
}

export interface ListPickerSection {
  title: string;
  multipleSelection?: boolean;
  order?: number;
  items: PickerItem[];
}

export interface TimePickerSlot {
  identifier: string;
  startTime: string;
  duration: number;
  title?: string;
  subtitle?: string;
}

export interface ApplePayRequestInput {
  title: string;
  subtitle?: string;
  merchantName: string;
  totalLabel: string;
  totalAmount: string;
  currencyCode: string;
  countryCode: string;
  lineItems?: Array<{ label: string; amount: string; type?: 'final' | 'pending' }>;
  requestIdentifier: string;
}

function richLinkImageBase64(): string | undefined {
  if (defaultRichLinkImageBase64 !== undefined) return defaultRichLinkImageBase64 ?? undefined;
  try {
    defaultRichLinkImageBase64 = readFileSync(
      new URL('../../brand/chert-richlink.png', import.meta.url),
    ).toString('base64');
  } catch {
    defaultRichLinkImageBase64 = null;
  }
  return defaultRichLinkImageBase64 ?? undefined;
}

function interactiveImageBase64(): string | undefined {
  if (defaultInteractiveImageBase64 !== undefined) return defaultInteractiveImageBase64 ?? undefined;
  try {
    defaultInteractiveImageBase64 = readFileSync(
      new URL('../../brand/chert-richlink.png', import.meta.url),
    ).toString('base64');
  } catch {
    defaultInteractiveImageBase64 = null;
  }
  return defaultInteractiveImageBase64 ?? undefined;
}

function interactiveImages() {
  const data = interactiveImageBase64();
  return data ? [{ identifier: 'agentic', data, description: 'Agentic' }] : undefined;
}

function interactiveBubble(title: string, subtitle?: string, style: 'icon' | 'small' | 'large' = 'small') {
  return {
    title,
    subtitle: subtitle ?? 'Tap to respond',
    style,
    ...(interactiveImageBase64() ? { imageIdentifier: 'agentic' } : {}),
  };
}

async function post(body: unknown): Promise<any> {
  const res = await fetch(`${env.mspApiBase}/send-message-api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.mspApiKey}`,
      'X-Business-Id': env.mspBusinessId,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`1440 send ${res.status}: ${text}`);
  }
  return json;
}

export function sendText(destinationId: string, text: string) {
  return post({ destinationId, messageType: 'text', content: { text } });
}

export function sendRichLink(
  destinationId: string,
  input: {
    url: string;
    title: string;
    body?: string;
    imageBase64Png?: string;
  },
) {
  const imageBase64Png = input.imageBase64Png ?? richLinkImageBase64();
  return post({
    destinationId,
    messageType: 'rich_link',
    content: {
      url: input.url,
      title: input.title,
      body: input.body ?? input.url,
      ...(imageBase64Png ? { imageData: imageBase64Png } : {}),
    },
  });
}

/**
 * Quick Reply interactive message. Maps an agent's `suggestedActions` to
 * tappable buttons. `actions` become items with identifier === title.
 */
export function sendQuickReply(
  destinationId: string,
  summaryText: string,
  actions: string[],
  requestIdentifier: string,
) {
  return post({
    destinationId,
    messageType: 'interactive',
    content: {
      interactiveData: {
        bid: AMB_EXTENSION_BID,
        data: {
          ...(interactiveImages() ? { images: interactiveImages() } : {}),
          version: '1.0',
          requestIdentifier,
          'quick-reply': {
            summaryText,
            items: actions.map((title) => ({ identifier: title, title })),
          },
        },
        receivedMessage: { title: summaryText, subtitle: 'Tap to respond', style: 'icon' },
        replyMessage: { title: 'Thanks!', style: 'icon' },
      },
    },
  });
}

export function sendListPicker(
  destinationId: string,
  input: {
    title: string;
    subtitle?: string;
    sections: ListPickerSection[];
    requestIdentifier: string;
  },
) {
  return post({
    destinationId,
    messageType: 'interactive',
    content: {
      interactiveData: {
        bid: AMB_EXTENSION_BID,
        data: {
          ...(interactiveImages() ? { images: interactiveImages() } : {}),
          version: '1.0',
          requestIdentifier: input.requestIdentifier,
          listPicker: input.sections.map((section, sectionIndex) => ({
            title: section.title,
            multipleSelection: Boolean(section.multipleSelection),
            order: section.order ?? sectionIndex,
            listPickerItem: section.items.map((item, itemIndex) => ({
              identifier: item.identifier,
              title: item.title,
              ...(item.subtitle ? { subtitle: item.subtitle } : {}),
              ...(item.imageIdentifier ? { imageIdentifier: item.imageIdentifier } : {}),
              order: item.order ?? itemIndex,
            })),
          })),
        },
        receivedMessage: interactiveBubble(input.title, input.subtitle, 'small'),
        replyMessage: interactiveBubble(input.title, input.subtitle, 'small'),
      },
    },
  });
}

export function sendTimePicker(
  destinationId: string,
  input: {
    title: string;
    subtitle?: string;
    event: {
      identifier: string;
      title: string;
      timezoneOffset?: number;
      location?: {
        title: string;
        latitude?: number;
        longitude?: number;
        radius?: number;
      };
      timeslots: TimePickerSlot[];
    };
    requestIdentifier: string;
  },
) {
  return post({
    destinationId,
    messageType: 'interactive',
    content: {
      interactiveData: {
        bid: AMB_EXTENSION_BID,
        data: {
          ...(interactiveImages() ? { images: interactiveImages() } : {}),
          version: '1.0',
          requestIdentifier: input.requestIdentifier,
          event: {
            identifier: input.event.identifier,
            title: input.event.title,
            ...(interactiveImageBase64() ? { imageIdentifier: 'agentic' } : {}),
            ...(typeof input.event.timezoneOffset === 'number'
              ? { timezoneOffset: input.event.timezoneOffset }
              : {}),
            ...(input.event.location ? { location: input.event.location } : {}),
            timeslots: input.event.timeslots.map((slot) => ({
              identifier: slot.identifier,
              startTime: slot.startTime,
              duration: slot.duration,
            })),
          },
        },
        receivedMessage: interactiveBubble(input.title, input.subtitle, 'small'),
        replyMessage: interactiveBubble(input.title, input.subtitle, 'small'),
      },
    },
  });
}

export function canSendApplePayRequest(): boolean {
  return hasApplePayMerchantIdentityConfig();
}

export async function sendApplePayRequest(destinationId: string, input: ApplePayRequestInput) {
  if (!hasApplePayMerchantIdentityConfig()) {
    throw new Error('Apple Pay merchant configuration is not available');
  }
  const merchantSession = await requestApplePayMerchantSession();

  return post({
    destinationId,
    messageType: 'interactive',
    content: {
      interactiveData: {
        bid: AMB_EXTENSION_BID,
        data: {
          ...(interactiveImages() ? { images: interactiveImages() } : {}),
          version: '1.0',
          requestIdentifier: input.requestIdentifier,
          payment: {
            endpoints: {
              paymentGatewayUrl: env.applePayPaymentGatewayUrl,
              ...(env.applePayFallbackUrl ? { fallbackUrl: env.applePayFallbackUrl } : {}),
            },
            merchantSession,
            paymentRequest: {
              applePay: {
                merchantIdentifier: env.applePayMerchantIdentifier,
                merchantCapabilities: ['supports3DS', 'supportsDebit', 'supportsCredit'],
                supportedNetworks: ['amex', 'visa', 'discover', 'masterCard'],
              },
              countryCode: input.countryCode,
              currencyCode: input.currencyCode,
              lineItems: input.lineItems ?? [],
              total: {
                label: input.totalLabel,
                amount: input.totalAmount,
                type: 'final',
              },
            },
          },
        },
        receivedMessage: interactiveBubble(
          input.title,
          input.subtitle ?? `${input.totalLabel} ${input.totalAmount} ${input.currencyCode}`,
          'large',
        ),
        replyMessage: {
          title: 'Apple Pay',
          subtitle: input.totalLabel,
          style: 'small',
        },
      },
    },
  });
}

/** App Clip rich link carrying setup correlation params. */
export function sendAppClip(destinationId: string, params: Record<string, string>) {
  return post({ destinationId, messageType: 'app-clip', content: { params } });
}

export function sendTypingIndicator(destinationId: string) {
  return post({ type: 'typing-indicator', destinationId });
}

/** Escalate the 1440 conversation to a human agent (sets agent_needed). */
export async function requestAgent(conversationId: string, reason?: string): Promise<any> {
  const res = await fetch(`${env.mspApiBase}/request-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.mspApiKey}`,
      'X-Business-Id': env.mspBusinessId,
    },
    body: JSON.stringify({ conversationId, ...(reason ? { reason } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`1440 request-agent ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
