/**
 * 1440 MSP outbound wrapper — POST /send-message-api.
 *
 * Auth: Bearer <MSP_API_KEY> + X-Business-Id: <MSP_BUSINESS_ID>.
 * `destinationId` is the customer's opaque `urn:mbid:` (from inbound
 * headers.source_id). Standard/interactive messages MUST use urn:mbid:.
 */
import { env } from '../env.js';

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
        bid: 'com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.icloud.apps.messages.business.extension',
        data: {
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
