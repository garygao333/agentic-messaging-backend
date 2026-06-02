import { env } from '../env.js';
import {
  recordCustomerTurn,
  runAgentTurn,
  type InboundTurnMetadata,
} from './agentRuntime.js';

interface PendingReply {
  timer: NodeJS.Timeout;
  texts: string[];
  metadatas: InboundTurnMetadata[];
  mspConversationId: string | null;
}

const pendingReplies = new Map<string, PendingReply>();
const customerChains = new Map<string, Promise<void>>();

function mergeMetadata(items: InboundTurnMetadata[]): InboundTurnMetadata {
  const merged: InboundTurnMetadata = {};
  for (const item of items) {
    if (item.eventType) merged.eventType = item.eventType;
    if (Array.isArray(item.attachments) && item.attachments.length > 0) {
      merged.attachments = [...(Array.isArray(merged.attachments) ? merged.attachments : []), ...item.attachments];
    }
    if (item.interactive) merged.interactive = item.interactive;
    if (Array.isArray(item.tapbacks) && item.tapbacks.length > 0) {
      merged.tapbacks = [...(Array.isArray(merged.tapbacks) ? merged.tapbacks : []), ...item.tapbacks];
    }
    if (item.raw) merged.raw = item.raw;
  }
  return merged;
}

function scheduleFlush(customerId: string, pending: PendingReply): void {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingReplies.delete(customerId);
    const combinedText = pending.texts.join('\n');
    runAgentTurn(customerId, combinedText, pending.mspConversationId, mergeMetadata(pending.metadatas), {
      recordCustomerTurn: false,
    })
      .catch((err) => console.error('[response-buffer] delayed agent turn failed:', err));
  }, Math.max(0, env.agentResponseBufferMs));
  pending.timer.unref?.();
}

async function enqueueBufferedAgentTurn(
  customerId: string,
  customerText: string,
  mspConversationId: string | null,
  metadata: InboundTurnMetadata,
): Promise<void> {
  await recordCustomerTurn(customerId, customerText, mspConversationId, metadata);

  if (env.agentResponseBufferMs <= 0) {
    const existing = pendingReplies.get(customerId);
    if (existing) {
      clearTimeout(existing.timer);
      pendingReplies.delete(customerId);
    }
    await runAgentTurn(customerId, customerText, mspConversationId, metadata, {
      recordCustomerTurn: false,
    });
    return;
  }

  const existing = pendingReplies.get(customerId);
  if (existing) {
    existing.texts.push(customerText);
    existing.metadatas.push(metadata);
    existing.mspConversationId = mspConversationId ?? existing.mspConversationId;
    scheduleFlush(customerId, existing);
    return;
  }

  const pending: PendingReply = {
    timer: setTimeout(() => {}, 0),
    texts: [customerText],
    metadatas: [metadata],
    mspConversationId,
  };
  pendingReplies.set(customerId, pending);
  scheduleFlush(customerId, pending);
}

export async function bufferAgentTurn(
  customerId: string,
  customerText: string,
  mspConversationId: string | null,
  metadata: InboundTurnMetadata = {},
): Promise<void> {
  const previous = customerChains.get(customerId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => enqueueBufferedAgentTurn(customerId, customerText, mspConversationId, metadata));

  customerChains.set(
    customerId,
    next.finally(() => {
      if (customerChains.get(customerId) === next) customerChains.delete(customerId);
    }),
  );

  await next;
}

export function pendingBufferedReplyCount(): number {
  return pendingReplies.size;
}
