import type { HistoryTurn } from '../../llm/reply.js';
import type { getAgent } from '../../supabase.js';

export type RuntimeAgent = NonNullable<Awaited<ReturnType<typeof getAgent>>>;

export interface RuntimePluginContext {
  agent: RuntimeAgent;
  customerId: string;
  customerText: string;
  conversationId: string | null;
  agentId: string;
  mspConversationId: string | null;
  customerName?: string | null;
  history: HistoryTurn[];
  nextRequestId: () => string;
}

export interface RuntimePlugin {
  id: string;
  label: string;
  matches: (agent: RuntimeAgent) => boolean;
  handleTurn: (context: RuntimePluginContext) => Promise<boolean>;
}
