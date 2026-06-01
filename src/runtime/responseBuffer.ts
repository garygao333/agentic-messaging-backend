import { env } from '../env.js';
import {
  recordCustomerTurn,
  runAgentTurn,
  type InboundTurnMetadata,
} from './agentRuntime.js';

interface PendingReply {
  timer: NodeJS.Timeout;
  texts: string[];
  mspConversationId: string | null;
}

const pendingReplies = new Map<string, PendingReply>();
const customerChains = new Map<string, Promise<void>>();

function scheduleFlush(customerId: string, pending: PendingReply): void {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingReplies.delete(customerId);
    const combinedText = pending.texts.join('\n');
    runAgentTurn(customerId, combinedText, pending.mspConversationId, {}, { recordCustomerTurn: false })
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
    existing.mspConversationId = mspConversationId ?? existing.mspConversationId;
    scheduleFlush(customerId, existing);
    return;
  }

  const pending: PendingReply = {
    timer: setTimeout(() => {}, 0),
    texts: [customerText],
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
