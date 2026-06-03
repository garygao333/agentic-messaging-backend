import type { AgentRow } from '../supabase.js';
import { complete, type ChatMessage } from './openai.js';
import type { HistoryTurn } from './reply.js';

export interface HandoffDecision {
  handoff: boolean;
  reason: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  trigger:
    | 'none'
    | 'explicit_request'
    | 'support_option'
    | 'frustration'
    | 'unsupported_action'
    | 'sensitive_or_risky';
}

const DEFAULT_DECISION: HandoffDecision = {
  handoff: false,
  reason: '',
  priority: 'normal',
  trigger: 'none',
};

const SYSTEM_PROMPT = [
  'You are a fast handoff router for an Apple Messages for Business AI agent.',
  'Decide whether the latest customer message should pause automation and create a real human handoff.',
  'Return ONLY JSON with keys: handoff, reason, priority, trigger.',
  'Set handoff=true when the latest message asks for a human, representative, operator, live agent, contact support, customer support, callback, or uses a support/contact quick reply.',
  'Set handoff=true when the latest message shows strong frustration, asks for billing/refund/account/identity/security work, or asks for live-system actions the bot cannot safely complete.',
  'Set handoff=false for ordinary domain questions the agent can answer or clarify, even if the customer uses the word "support" casually.',
  'Do not hand off just because the product is called an agent or the customer is asking how an AI agent works.',
  'priority must be one of low, normal, high, urgent. trigger must be one of none, explicit_request, support_option, frustration, unsupported_action, sensitive_or_risky.',
].join('\n');

function clean(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function parseDecision(value: string): HandoffDecision {
  const parsed = JSON.parse(value);
  const priority = ['low', 'normal', 'high', 'urgent'].includes(parsed?.priority)
    ? parsed.priority
    : 'normal';
  const trigger = [
    'none',
    'explicit_request',
    'support_option',
    'frustration',
    'unsupported_action',
    'sensitive_or_risky',
  ].includes(parsed?.trigger)
    ? parsed.trigger
    : parsed?.handoff
      ? 'explicit_request'
      : 'none';
  return {
    handoff: parsed?.handoff === true,
    reason: clean(parsed?.reason, 160) || (parsed?.handoff ? 'Customer requested a human' : ''),
    priority,
    trigger,
  };
}

function timeoutDecision(ms: number): Promise<HandoffDecision> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(DEFAULT_DECISION), ms);
  });
}

export async function classifyHandoffIntent(
  agent: Pick<AgentRow, 'name' | 'company_name' | 'business_type' | 'use_case' | 'handoff_destination'>,
  history: HistoryTurn[],
  customerText: string,
  metadata: { interactive?: unknown; attachments?: unknown[] },
): Promise<HandoffDecision> {
  const recent = history.slice(-6).map((turn) => ({
    role: turn.role,
    text: clean(turn.text, 260),
    kind: turn.kind ?? 'text',
  }));
  const userPayload = {
    latestMessage: clean(customerText, 500),
    latestWasInteractiveTap: Boolean(metadata.interactive),
    latestHasAttachments: Array.isArray(metadata.attachments) && metadata.attachments.length > 0,
    agent: {
      name: agent.name,
      company: agent.company_name,
      businessType: agent.business_type,
      useCase: agent.use_case,
      handoffDestination: agent.handoff_destination,
    },
    recentHistory: recent,
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(userPayload) },
  ];
  return Promise.race([
    complete(messages, { json: true }).then(parseDecision).catch(() => DEFAULT_DECISION),
    timeoutDecision(3500),
  ]);
}
