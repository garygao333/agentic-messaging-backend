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
import {
  requestAgent,
  sendQuickReply,
  sendRichLink,
  sendText,
} from '../msp/send.js';
import { appendTurn, loadState, type ConversationState } from './conversations.js';
import {
  createHandoffSession,
  isActiveHandoffStatus,
  logConversationEvent,
  updateHandoffSession,
} from './handoff.js';
import { runRuntimePlugins } from './plugins/registry.js';
import { startAppClipSetup } from './setup.js';

const nextRequestId = () => crypto.randomUUID();
const CHERT_WEBSITE_URL = 'https://trychert.com';
const CHERT_DEMO_URL = 'https://cal.com/team/chert/chert-call';
const GENERAL_ACTIONS = ['Book demo', 'See API features', 'Check fit', 'Talk to founder'];

type ActionIntent = 'intro' | 'menu' | 'api' | 'fit' | 'none';

interface ActionPlan {
  intent: ActionIntent;
  prompt: string;
  actions: string[];
}

interface RichLinkPlan {
  url: string;
  title: string;
  body: string;
  reason: 'website' | 'demo';
}

function isChertAgent(agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>): boolean {
  const haystack = [agent.name, agent.company_name, agent.website, agent.use_case, agent.prompt]
    .join(' ')
    .toLowerCase();
  return /\b(chert|trychert|agentic messaging)\b/.test(haystack);
}

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
  if (metadata.interactive) return interactiveKind(metadata.interactive);
  if (tapbacks.length > 0) return 'tapback';
  if (metadata.eventType === 'close') return 'close';
  return 'text';
}

function isTapbackOnly(customerText: string, metadata: InboundTurnMetadata): boolean {
  const tapbacks = Array.isArray(metadata.tapbacks) ? metadata.tapbacks : [];
  if (tapbacks.length > 0) return true;
  return /^(loved|liked|disliked|laughed at|emphasized|questioned|removed a (heart|like|dislike|laugh|emphasis|question mark) from)\s+[“"][\s\S]+[”"]$/i.test(
    customerText.trim(),
  );
}

function interactiveKind(interactive: unknown): string {
  const value = interactive as any;
  if (value?.data?.listPicker || value?.listPicker) return 'list_picker';
  if (value?.data?.event || value?.event) return 'time_picker';
  if (value?.data?.payment || value?.payment) return 'apple_pay';
  if (value?.data?.['quick-reply'] || value?.['quick-reply']) return 'quick_reply';
  return 'quick_reply';
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueActions(actions: string[]): string[] {
  const seen = new Set<string>();
  return actions
    .map((action) => action.trim())
    .filter((action) => {
      const key = action.toLowerCase();
      if (!action || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function customerTurnCount(history: HistoryTurn[]): number {
  return history.filter((turn) => turn.role === 'customer').length;
}

function recentlySentQuickReply(history: HistoryTurn[], prompt?: string): boolean {
  const target = prompt ? normalizeText(prompt) : null;
  return history.slice(-8).some((turn) => {
    if (turn.role !== 'agent') return false;
    if (turn.kind === 'quick_reply' || turn.interactive) {
      return !target || normalizeText(turn.text) === target;
    }
    return /pick (a|the)|choose|what kind of|which messages feature|tap to respond/i.test(
      turn.text,
    );
  });
}

function inferActionPlan(customerText: string, history: HistoryTurn[]): ActionPlan {
  const text = normalizeText(customerText);
  const asksForMenu = hasAny(text, [
    /\b(options?|choices?|menu|next steps?)\b/,
    /\bwhat can you do\b/,
    /\bhelp me choose\b/,
  ]);
  const asksAboutApi = hasAny(text, [
    /\b(api|apis|webhook|webhooks|msp|apple messages|imessage|messages for business)\b/,
    /\b(features?|rich links?|quick replies|list picker|carousel|time picker|tapbacks?|attachments?|handoff)\b/,
  ]);
  const asksAboutFit = hasAny(text, [
    /\b(check fit|fit|use cases?|for my|my business|my store|e-?commerce|shopify)\b/,
    /\bhealthcare|home services?|hospitality|clinic|restaurant|retail\b/,
  ]);
  const greeting =
    customerTurnCount(history) <= 2 &&
    hasAny(text, [/\b(hi|hello|hey|who are you|what is this|how does this work)\b/]);

  if (asksAboutApi) {
    return {
      intent: 'api',
      prompt: 'Which Messages feature should I show next?',
      actions: ['Rich links', 'Quick replies', 'Human handoff', 'Book demo'],
    };
  }

  if (asksAboutFit) {
    return {
      intent: 'fit',
      prompt: 'What kind of conversation are you testing?',
      actions: ['E-commerce', 'Healthcare', 'Home services', 'Book demo'],
    };
  }

  if (asksForMenu) {
    return {
      intent: 'menu',
      prompt: 'Pick the path that fits:',
      actions: GENERAL_ACTIONS,
    };
  }

  if (greeting) {
    return {
      intent: 'intro',
      prompt: 'Pick the path that fits:',
      actions: GENERAL_ACTIONS,
    };
  }

  return { intent: 'none', prompt: '', actions: [] };
}

function shouldSendActionPlan(
  plan: ActionPlan,
  history: HistoryTurn[],
  metadata: InboundTurnMetadata,
): boolean {
  if (plan.actions.length < 2) return false;
  if (plan.intent === 'none') return false;

  // Interactive taps should not echo the same card back. The exception is when
  // the tap intentionally drills into a different branch, like API features.
  if (metadata.interactive && plan.intent !== 'api' && plan.intent !== 'fit') return false;
  if (recentlySentQuickReply(history, plan.prompt)) return false;
  return true;
}

function richLinksFor(agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>, customerText: string): RichLinkPlan[] {
  if (!isChertAgent(agent)) return [];
  const text = normalizeText(customerText);
  const links: RichLinkPlan[] = [];
  const wantsDemoLink = hasAny(text, [
    /\b(book|schedule|demo|call|meeting|calendar|kickoff)\b/,
    /\b(founder|gary|talk to founder)\b/,
  ]);
  const wantsWebsiteLink = hasAny(text, [
    /\b(website|web site|site|homepage|home page|learn more|company page)\b/,
    /\btrychert\b/,
    /trychert\.com/,
  ]);
  const genericLinkAsk = /\b(url|link)\b/.test(text);

  if (wantsWebsiteLink || (genericLinkAsk && !wantsDemoLink)) {
    links.push({
      url: CHERT_WEBSITE_URL,
      title: 'Chert',
      body: CHERT_WEBSITE_URL,
      reason: 'website',
    });
  }

  if (wantsDemoLink) {
    links.push({
      url: CHERT_DEMO_URL,
      title: 'Book a Chert call',
      body: CHERT_DEMO_URL,
      reason: 'demo',
    });
  }

  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

async function sendRichLinkWithFallback(input: {
  customerId: string;
  conversationId: string | null;
  agentId: string;
  mspConversationId: string | null;
  link: RichLinkPlan;
}): Promise<void> {
  try {
    await sendRichLink(input.customerId, {
      url: input.link.url,
      title: input.link.title,
      body: input.link.body,
    });
    await logConversationEvent({
      conversationId: input.conversationId,
      agentId: input.agentId,
      customerId: input.customerId,
      mspConversationId: input.mspConversationId,
      eventType: 'rich_link_sent',
      actor: 'agent',
      body: input.link.url,
      payload: { richLink: input.link },
    });
    await appendTurn(input.conversationId, {
      role: 'agent',
      text: input.link.url,
      kind: 'rich_link',
      richLink: input.link,
      payload: { richLink: input.link },
    });
  } catch (err) {
    console.warn('[runtime] rich-link send failed:', err);
    await logConversationEvent({
      conversationId: input.conversationId,
      agentId: input.agentId,
      customerId: input.customerId,
      mspConversationId: input.mspConversationId,
      eventType: 'rich_link_failed',
      actor: 'msp',
      body: errText(err),
      payload: { richLink: input.link },
    });
    await sendText(input.customerId, input.link.url);
    await appendTurn(input.conversationId, {
      role: 'agent',
      text: input.link.url,
      kind: 'text',
      payload: { richLinkFallback: input.link },
    });
  }
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
    await logConversationEvent({
      conversationId: state.id,
      agentId: state.activeAgentId,
      customerId,
      mspConversationId,
      eventType: 'bot_suppressed_handoff_active',
      actor: 'system',
      body: customerText,
      payload: {
        conversationStatus: state.status,
        handoffStatus: state.activeHandoffStatus,
      },
    });
    return;
  }

  const agentId = state.activeAgentId;
  if (!agentId) {
    await startAppClipSetup({
      customerId,
      mspConversationId,
      initialText: customerText,
      raw: metadata.raw,
    });
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

  if (isTapbackOnly(customerText, metadata)) {
    await logConversationEvent({
      conversationId: state.id,
      agentId,
      customerId,
      mspConversationId,
      eventType: 'bot_suppressed_tapback',
      actor: 'system',
      body: customerText,
    });
    return;
  }

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

  const pluginHandled = await runRuntimePlugins({
    agent,
    customerId,
    customerText,
    conversationId: state.id,
    agentId,
    mspConversationId,
    customerName: state.customerName,
    history,
    nextRequestId,
  });
  if (pluginHandled) return;

  const reply = await chatReply({ prompt: agent.prompt, guardrails: agent.guardrails }, history);

  const actionPlan = inferActionPlan(customerText, history);
  const configuredActions = Array.isArray(agent.suggested_actions)
    ? agent.suggested_actions.map(String).filter(Boolean)
    : [];
  const useConfiguredActions =
    configuredActions.length > 0 && (actionPlan.intent === 'intro' || actionPlan.intent === 'menu');
  const actions = uniqueActions(useConfiguredActions ? configuredActions : actionPlan.actions);
  const sendActions = shouldSendActionPlan({ ...actionPlan, actions }, history, metadata);
  const richLinks = richLinksFor(agent, customerText);

  await sendText(customerId, reply);
  await logConversationEvent({
    conversationId: state.id,
    agentId,
    customerId,
    mspConversationId,
    eventType: 'ai_reply',
    actor: 'agent',
    body: reply,
    payload: {
      actionIntent: actionPlan.intent,
      actionPrompt: actionPlan.prompt || null,
      richLinkReasons: richLinks.map((link) => link.reason),
    },
  });
  await appendTurn(state.id, { role: 'agent', text: reply });

  for (const link of richLinks) {
    await sendRichLinkWithFallback({
      customerId,
      conversationId: state.id,
      agentId,
      mspConversationId,
      link,
    });
  }

  if (sendActions) {
    await sendQuickReply(customerId, actionPlan.prompt, actions, nextRequestId());
    await logConversationEvent({
      conversationId: state.id,
      agentId,
      customerId,
      mspConversationId,
      eventType: 'quick_reply_sent',
      actor: 'agent',
      body: actionPlan.prompt,
      payload: { actions, precedingReply: reply, actionIntent: actionPlan.intent },
    });
    await appendTurn(state.id, {
      role: 'agent',
      text: actionPlan.prompt,
      kind: 'quick_reply',
      interactive: {
        type: 'quick_reply',
        title: actionPlan.prompt,
        subtitle: 'Tap to respond',
        items: actions.map((title) => ({ id: title, title })),
      },
    });
  }
}
