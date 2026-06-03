/**
 * LOGIN {code} 2FA verification. The app issues a code into `auth_codes`
 * (migrations/0003); the customer texts it; we mark it verified.
 *
 * Until 0003 lands (or if the app isn't yet persisting codes), this degrades to
 * an acknowledgement so the flow isn't blocked.
 */
import { supabase } from '../supabase.js';

export type LoginResult = 'verified' | 'invalid' | 'unavailable';

function handleParts(handle: string | null): {
  displayName: string | null;
  phone: string | null;
  appleId: string | null;
  email: string | null;
} {
  const clean = handle?.trim() || null;
  if (!clean) return { displayName: null, phone: null, appleId: null, email: null };
  const looksPhone = /^\+?[0-9 ()-]{7,}$/.test(clean);
  const looksEmail = clean.includes('@');
  return {
    displayName: clean,
    phone: looksPhone ? clean : null,
    appleId: looksEmail ? clean : null,
    email: looksEmail ? clean : null,
  };
}

async function bindCustomerProfile(customerId: string, handle: string | null): Promise<void> {
  const parts = handleParts(handle);
  try {
    const { error } = await supabase.from('customer_profiles').upsert(
      {
        customer_id: customerId,
        display_name: parts.displayName ?? customerId,
        phone: parts.phone,
        apple_id: parts.appleId,
        email: parts.email,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'customer_id' },
    );
    if (error) console.warn('[login] customer profile bind skipped:', error);
  } catch (err) {
    console.warn('[login] customer profile bind unavailable:', err);
  }
}

async function bindWorkspaceIdentity(
  workspaceUserId: string | null,
  customerId: string | null | undefined,
  handle: string | null,
): Promise<void> {
  if (!workspaceUserId || !customerId) return;

  try {
    const now = new Date().toISOString();
    const { error } = await supabase.from('workspace_message_identities').upsert(
      {
        workspace_user_id: workspaceUserId,
        customer_id: customerId,
        display_handle: handle,
        verified_at: now,
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: 'workspace_user_id' },
    );
    if (error) console.warn('[login] workspace identity bind skipped:', error);
  } catch (err) {
    console.warn('[login] workspace identity bind unavailable:', err);
  }
}

export async function verifyLoginCode(
  code: string,
  customerId?: string | null,
): Promise<LoginResult> {
  try {
    const { data, error } = await supabase
      .from('auth_codes')
      .select('id, workspace_user_id, apple_id, display_handle, expires_at')
      .eq('code', code)
      .eq('verified', false)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return 'unavailable'; // table missing (0003 not applied)
    const row = data?.[0];
    if (!row) return 'invalid';
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 'invalid';
    await supabase
      .from('auth_codes')
      .update({ verified: true, customer_id: customerId ?? null })
      .eq('id', row.id);
    const handle = row.display_handle ?? row.apple_id ?? null;
    if (customerId) await bindCustomerProfile(customerId, handle);
    await bindWorkspaceIdentity(row.workspace_user_id ?? null, customerId, handle);
    return 'verified';
  } catch {
    return 'unavailable';
  }
}
