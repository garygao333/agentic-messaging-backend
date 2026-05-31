/**
 * LOGIN {code} 2FA verification. The app issues a code into `auth_codes`
 * (migrations/0003); the customer texts it; we mark it verified.
 *
 * Until 0003 lands (or if the app isn't yet persisting codes), this degrades to
 * an acknowledgement so the flow isn't blocked.
 */
import { supabase } from '../supabase.js';

export type LoginResult = 'verified' | 'invalid' | 'unavailable';

export async function verifyLoginCode(code: string): Promise<LoginResult> {
  try {
    const { data, error } = await supabase
      .from('auth_codes')
      .select('id, expires_at')
      .eq('code', code)
      .eq('verified', false)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return 'unavailable'; // table missing (0003 not applied)
    const row = data?.[0];
    if (!row) return 'invalid';
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 'invalid';
    await supabase.from('auth_codes').update({ verified: true }).eq('id', row.id);
    return 'verified';
  } catch {
    return 'unavailable';
  }
}
