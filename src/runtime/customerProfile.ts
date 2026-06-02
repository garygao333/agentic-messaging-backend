import { supabase } from '../supabase.js';

interface InferredCustomerProfile {
  displayName: string | null;
  phone: string | null;
  appleId: string | null;
  email: string | null;
}

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findByKey(raw: unknown, keys: Set<string>, depth = 0): string | null {
  if (!raw || typeof raw !== 'object' || depth > 5) return null;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = findByKey(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (keys.has(normalizedKey(key))) {
      const text = clean(value);
      if (text) return text;
    }
    const nested = findByKey(value, keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function asPhone(value: string | null): string | null {
  if (!value) return null;
  return /^\+?[0-9 ()-]{7,}$/.test(value) ? value : null;
}

function asEmail(value: string | null): string | null {
  if (!value) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function inferProfile(raw: unknown): InferredCustomerProfile {
  const phone = asPhone(
    findByKey(
      raw,
      new Set(['phone', 'phonenumber', 'mobile', 'mobilenumber', 'msisdn', 'sourceaddress']),
    ),
  );
  const email = asEmail(findByKey(raw, new Set(['email', 'emailaddress', 'appleid'])));
  const displayName = clean(
    findByKey(raw, new Set(['displayname', 'customername', 'name', 'handle', 'displayhandle'])),
  );

  return {
    displayName,
    phone,
    appleId: email,
    email,
  };
}

export async function touchCustomerProfile(customerId: string, raw?: unknown): Promise<void> {
  const inferred = inferProfile(raw);
  const now = new Date().toISOString();

  try {
    const { data: existing, error: readError } = await supabase
      .from('customer_profiles')
      .select('display_name, phone, apple_id, email')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (readError) throw readError;

    const row = {
      customer_id: customerId,
      display_name:
        existing?.display_name ??
        inferred.displayName ??
        inferred.phone ??
        inferred.email ??
        'Apple Customer',
      phone: existing?.phone ?? inferred.phone,
      apple_id: existing?.apple_id ?? inferred.appleId,
      email: existing?.email ?? inferred.email,
      last_seen_at: now,
      updated_at: now,
    };

    if (existing) {
      const { error } = await supabase.from('customer_profiles').update(row).eq('customer_id', customerId);
      if (error) throw error;
      return;
    }

    const { error } = await supabase.from('customer_profiles').insert({
      ...row,
      first_seen_at: now,
    });
    if (error) throw error;
  } catch (err) {
    console.warn('[customer-profile] touch skipped:', err);
  }
}
