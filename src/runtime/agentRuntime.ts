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

let reqCounter = 0;
const nextRequestId = () => `amb-${Date.now()}-${reqCounter++}`;

/** Cheap heuristic for "get me a human". Decision: latest-wins, no LLM classifier for MVP. */
function wantsHuman(text: string): boolean {
  return /\b(human|agent|representative|real person|speak to someone|talk to someone)\b/i.test(text);
}

export async function runAgentTurn(
  customerId: string,
  customerText: string,
  mspConversationId: string | null,
): Promise<void> {
  const state: ConversationState = await loadState(customerId);
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

  // Persist the customer turn, then build full history (prior turns + this one).
  await appendTurn(state.id, { role: 'customer', text: customerText });
  const history: HistoryTurn[] = [...state.messages, { role: 'customer', text: customerText }];

  // Human handoff: flag the conversation, escalate in 1440, tell the customer.
  if (wantsHuman(customerText)) {
    await appendTurn(state.id, { role: 'agent', text: 'Connecting you with a team member.' }, 'Needs Human');
    if (mspConversationId) {
      try {
        await requestAgent(mspConversationId, 'Customer requested a human');
      } catch (err) {
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
  } else {
    await sendText(customerId, reply);
  }
  await appendTurn(state.id, { role: 'agent', text: reply });
}
