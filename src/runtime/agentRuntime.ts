/**
 * Live customer turn. Runs the SHARED reply logic (identical to the in-app
 * preview), sends via 1440, persists both turns, and handles human handoff.
 *
 * History is loaded from the conversation row (multi-turn) when 0003 is applied;
 * otherwise it degrades to single-turn. Persistence is best-effort and never
 * throws into the request path.
 */
import { getAgent } from '../supabase.js';
import { chatReply, type HistoryTurn } from '../llm/reply.js';
import { requestAgent, sendQuickReply, sendText } from '../msp/send.js';
import { appendTurn, loadState, type ConversationState } from './conversations.js';
import {
  createHandoffSession,
  isActiveHandoffStatus,
  logConversationEvent,
  updateHandoffSession,
} from './handoff.js';

let reqCounter = 0;
const nextRequestId = () => `amb-${Date.now()}-${reqCounter++}`;

/** Cheap heuristic for "get me a human". Decision: latest-wins, no LLM classifier for MVP. */
function wantsHuman(text: string): boolean {
  return /\b(human|agent|representative|real person|speak to someone|talk to someone)\b/i.test(text);
}

function isHumanPaused(state: ConversationState): boolean {
  return state.status === 'Needs Human' || isActiveHandoffStatus(state.activeHandoffStatus);
}

function handoffSummary(history: HistoryTurn[]): string {
  const recent = history.slice(-6).map((turn) => `${turn.role}: ${turn.text}`);
  return recent.join('\n').slice(0, 1200);
}

export interface InboundTurnMetadata {
  eventType?: string;
  attachments?: unknown[];
  interactive?: unknown;
  tapbacks?: unknown[];
  raw?: unknown;
}

interface RunAgentTurnOptions {
  recordCustomerTurn?: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

function messageKind(metadata: InboundTurnMetadata): string {
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const tapbacks = Array.isArray(metadata.tapbacks) ? metadata.tapbacks : [];
  if (attachments.length > 0) return 'attachment';
  if (metadata.interactive) return 'quick_reply';
  if (tapbacks.length > 0) return 'tapback';
  if (metadata.eventType === 'close') return 'close';
  return 'text';
}

export async function recordCustomerTurn(
  customerId: string,
  customerText: string,
  mspConversationId: string | null,
  metadata: InboundTurnMetadata = {},
): Promise<ConversationState> {
  const state: ConversationState = await loadState(customerId, mspConversationId);
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const tapbacks = Array.isArray(metadata.tapbacks) ? metadata.tapbacks : [];

  // Persist the customer turn before any runtime decision so operator surfaces
  // can see new customer text even while the bot is paused for handoff.
  await appendTurn(state.id, {
    role: 'customer',
    text: customerText,
    kind: messageKind(metadata),
    attachments,
    interactive: metadata.interactive,
    tapbacks,
    payload: metadata.raw && typeof metadata.raw === 'object' ? { raw: metadata.raw } : undefined,
  });
  await logConversationEvent({
    conversationId: state.id,
    agentId: state.activeAgentId,
    customerId,
    mspConversationId,
    eventType: 'customer_message',
    actor: 'customer',
    body: customerText,
  });

  return state;
}

export async function runAgentTurn(
  customerId: string,
  customerText: string,
  mspConversationId: string | null,
  metadata: InboundTurnMetadata = {},
  options: RunAgentTurnOptions = {},
): Promise<void> {
  const shouldRecord = options.recordCustomerTurn !== false;
  const state: ConversationState = shouldRecord
    ? await recordCustomerTurn(customerId, customerText, mspConversationId, metadata)
    : await loadState(customerId, mspConversationId);

  if (isHumanPaused(state)) {
    const waiting =
      'A team member is already taking a look. Hang tight - we will follow up here soon.';
    await logConversationEvent({
      conversationId: state.id,
      agentId: state.activeAgentId,
      customerId,
      mspConversationId,
      eventType: 'bot_suppressed_handoff_active',
      actor: 'system',
      body: waiting,
      payload: {
        conversationStatus: state.status,
        handoffStatus: state.activeHandoffStatus,
      },
    });
    await sendText(customerId, waiting);
    return;
  }

  const agentId = state.activeAgentId;
  if (!agentId) {
    await sendText(customerId, 'Open the app to pick an agent to test, or text START_AGENT_SETUP.');
    return;
  }

  const agent = await getAgent(agentId);
  if (!agent) {
    await sendText(customerId, 'That agent is no longer available. Please start setup again.');
    return;
  }

  // Build full history from prior turns + this one.
  const history: HistoryTurn[] = shouldRecord
    ? [...state.messages, { role: 'customer', text: customerText }]
    : state.messages;

  // Human handoff: create/reuse a durable session, escalate in 1440, tell the customer.
  if (wantsHuman(customerText)) {
    const reason = 'Customer requested a human';
    const session = await createHandoffSession({
      conversationId: state.id,
      agentId,
      customerId,
      mspConversationId,
      trigger: 'explicit_request',
      reason,
      priority: 'normal',
      summary: handoffSummary(history),
    });
    await appendTurn(state.id, { role: 'agent', text: 'Connecting you with a team member.' }, 'Needs Human');
    await logConversationEvent({
      conversationId: state.id,
      agentId,
      customerId,
      mspConversationId,
      eventType: 'handoff_requested',
      actor: 'system',
      body: reason,
      payload: { handoffSessionId: session?.id ?? null },
    });
    if (mspConversationId) {
      try {
        await requestAgent(mspConversationId, reason);
        await updateHandoffSession(session?.id ?? null, { status: 'queued', lastError: null });
        await logConversationEvent({
          conversationId: state.id,
          agentId,
          customerId,
          mspConversationId,
          eventType: 'request_agent_succeeded',
          actor: 'msp',
          payload: { handoffSessionId: session?.id ?? null },
        });
      } catch (err) {
        await updateHandoffSession(session?.id ?? null, { lastError: errText(err) });
        await logConversationEvent({
          conversationId: state.id,
          agentId,
          customerId,
          mspConversationId,
          eventType: 'request_agent_failed',
          actor: 'msp',
          body: errText(err),
          payload: { handoffSessionId: session?.id ?? null },
        });
        console.warn('[runtime] request-agent failed:', err);
      }
    }
    const dest = agent.handoff_destination ? ` (${agent.handoff_destination})` : '';
    await sendText(customerId, `No problem — I'm connecting you with a team member${dest}. Hang tight!`);
    return;
  }

  const reply = await chatReply({ prompt: agent.prompt, guardrails: agent.guardrails }, history);

  const actions = Array.isArray(agent.suggested_actions)
    ? agent.suggested_actions.map(String).filter(Boolean).slice(0, 4)
    : [];

  if (actions.length >= 2) {
    await sendQuickReply(customerId, reply, actions, nextRequestId());
    await logConversationEvent({
      conversationId: state.id,
      agentId,
      customerId,
      mspConversationId,
      eventType: 'quick_reply_sent',
      actor: 'agent',
      body: reply,
      payload: { actions },
    });
  } else {
    await sendText(customerId, reply);
    await logConversationEvent({
      conversationId: state.id,
      agentId,
      customerId,
      mspConversationId,
      eventType: 'ai_reply',
      actor: 'agent',
      body: reply,
    });
  }
  await appendTurn(state.id, {
    role: 'agent',
    text: reply,
    ...(actions.length >= 2
      ? {
          kind: 'quick_reply',
          interactive: {
            type: 'quick_reply',
            title: reply,
            subtitle: 'Tap to respond',
            items: actions.map((title) => ({ id: title, title })),
          },
        }
      : {}),
  });
}
