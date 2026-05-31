/**
 * The 5 protocol commands the app prefills into the Messages body
 * (see app `src/lib/messageLinks.ts`). They arrive as the inbound text body.
 */
export type Command =
  | { kind: 'LOGIN'; code: string }
  | { kind: 'START_AGENT_SETUP' }
  | { kind: 'AGENT_SETUP_COMPLETE'; setupId: string }
  | { kind: 'TEST_AGENT'; agentId: string }
  | { kind: 'REDEPLOY'; agentId: string }
  | { kind: 'PLAIN'; text: string };

export function parseCommand(text: string | null): Command {
  const t = (text ?? '').trim();
  if (/^LOGIN\s+/i.test(t)) return { kind: 'LOGIN', code: t.replace(/^LOGIN\s+/i, '').trim() };
  if (/^START_AGENT_SETUP\b/i.test(t)) return { kind: 'START_AGENT_SETUP' };
  if (/^AGENT_SETUP_COMPLETE\s+/i.test(t))
    return { kind: 'AGENT_SETUP_COMPLETE', setupId: t.replace(/^AGENT_SETUP_COMPLETE\s+/i, '').trim() };
  if (/^TEST_AGENT\s+/i.test(t))
    return { kind: 'TEST_AGENT', agentId: t.replace(/^TEST_AGENT\s+/i, '').trim() };
  if (/^REDEPLOY\s+/i.test(t))
    return { kind: 'REDEPLOY', agentId: t.replace(/^REDEPLOY\s+/i, '').trim() };
  return { kind: 'PLAIN', text: t };
}
