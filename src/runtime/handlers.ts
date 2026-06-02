/**
 * Dispatch for the 5 protocol commands + plain customer text.
 * All replies go out via 1440 to the customer's urn:mbid: (customerId).
 *
 * Locked decisions (per PLAN.md §7): routing = active agent per `TEST_AGENT`,
 * persisted on the conversation; "latest wins" redeploy (no version history).
 */
import { supabase } from '../supabase.js';
import { sendAppClip, sendText } from '../msp/send.js';
import { parseCommand } from './commands.js';
import { setActiveAgent } from './conversations.js';
import type { InboundTurnMetadata } from './agentRuntime.js';
import { touchCustomerProfile } from './customerProfile.js';
import { verifyLoginCode } from './login.js';
import { bufferAgentTurn } from './responseBuffer.js';

function tapbackSummary(tapbacks: unknown): string | null {
  if (!Array.isArray(tapbacks) || tapbacks.length === 0) return null;
  const first = tapbacks[0] as any;
  const raw =
    first?.type ??
    first?.tapbackType ??
    first?.reaction ??
    first?.action ??
    first?.summary ??
    'tapback';
  return `[Tapback: ${String(raw).trim() || 'reaction'}]`;
}

function textFrom(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function testUserHandles(agent: any): string[] {
  return Array.isArray(agent?.test_users)
    ? agent.test_users
        .flatMap((user: any) => [
          textFrom(user?.phoneOrAppleId),
          textFrom(user?.phone),
          textFrom(user?.appleId),
          textFrom(user?.email),
          textFrom(user?.handle),
        ])
        .filter((value: string | null): value is string => Boolean(value))
    : [];
}

async function customerHandles(customerId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('customer_profiles')
      .select('display_name, phone, apple_id, email')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (error || !data) return [];
    return [data.display_name, data.phone, data.apple_id, data.email]
      .map(textFrom)
      .filter((value: string | null): value is string => Boolean(value));
  } catch {
    return [];
  }
}

async function canActivateAgentForCustomer(
  agentId: string,
  customerId: string,
): Promise<'ok' | 'missing' | 'not_testable' | 'not_authorized'> {
  const { data: agent, error } = await supabase
    .from('agents')
    .select('id, status, test_users')
    .eq('id', agentId)
    .maybeSingle();
  if (error || !agent) return 'missing';
  if (!['Test Mode', 'Deployed'].includes(agent.status)) return 'not_testable';

  const allowed = testUserHandles(agent);
  if (allowed.length === 0) return 'not_authorized';
  const customer = await customerHandles(customerId);
  if (!customer.some((handle) => allowed.includes(handle))) return 'not_authorized';
  return 'ok';
}

async function requireAgentActivationAccess(agentId: string, customerId: string): Promise<boolean> {
  const result = await canActivateAgentForCustomer(agentId, customerId);
  if (result === 'ok') return true;
  const message =
    result === 'missing'
      ? 'That agent is no longer available. Please open the app and try again.'
      : result === 'not_testable'
        ? 'That agent is not in Test Mode yet. Deploy it to test users from the app first.'
        : 'This Messages sender is not listed as a test user for that agent.';
  await sendText(customerId, message);
  return false;
}

export async function handleInbound(
  customerId: string,
  text: string | null,
  selections: string[],
  mspConversationId: string | null,
  metadata: InboundTurnMetadata = {},
): Promise<void> {
  // An interactive selection with no text == a quick-reply tap; treat the
  // selected label as the customer's message to the active agent.
  await touchCustomerProfile(customerId, metadata.raw);
  const effectiveText = text ?? selections[0] ?? tapbackSummary(metadata.tapbacks) ?? '';
  const cmd = parseCommand(effectiveText);

  switch (cmd.kind) {
    case 'LOGIN': {
      const result = await verifyLoginCode(cmd.code, customerId);
      const msg =
        result === 'verified'
          ? "You're verified — head back to the app to continue."
          : result === 'invalid'
            ? "That code didn't match or has expired. Please request a new one in the app."
            : `Thanks — code ${cmd.code} received. You're set in the app.`; // unavailable (pre-0003)
      await sendText(customerId, msg);
      return;
    }

    case 'START_AGENT_SETUP': {
      await sendText(
        customerId,
        "Let's set up your agent. Tap the App Clip below to get started — it only takes a minute.",
      );
      const setupId = crypto.randomUUID();
      try {
        await sendAppClip(customerId, { setup_id: setupId });
      } catch (err) {
        console.warn('[handlers] App Clip send failed (is it configured in 1440?):', err);
        await sendText(customerId, 'Open the Agentic Messaging app to continue setup.');
      }
      return;
    }

    case 'AGENT_SETUP_COMPLETE': {
      const { data } = await supabase
        .from('setups')
        .select('id, agent_id')
        .eq('id', cmd.setupId)
        .maybeSingle();
      if (!data) {
        await sendText(customerId, "Hmm, I couldn't find that setup. Please try again from the app.");
        return;
      }
      await sendText(
        customerId,
        'Setup complete! Open the Agentic Messaging app to review and deploy your agent.',
      );
      return;
    }

    case 'TEST_AGENT': {
      if (!(await requireAgentActivationAccess(cmd.agentId, customerId))) return;
      await setActiveAgent(customerId, cmd.agentId);
      await sendText(customerId, "You're now chatting with your test agent. Say hello!");
      return;
    }

    case 'REDEPLOY': {
      if (!(await requireAgentActivationAccess(cmd.agentId, customerId))) return;
      // Latest-wins: just stamp last_deployed_at and re-point the thread.
      await supabase
        .from('agents')
        .update({ last_deployed_at: new Date().toISOString() })
        .eq('id', cmd.agentId);
      await setActiveAgent(customerId, cmd.agentId);
      await sendText(customerId, 'Redeployed. Your latest agent version is now live for testing.');
      return;
    }

    case 'PLAIN': {
      await bufferAgentTurn(customerId, cmd.text, mspConversationId, metadata);
      return;
    }
  }
}
