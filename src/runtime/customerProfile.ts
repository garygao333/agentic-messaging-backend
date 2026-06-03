import { supabase } from '../supabase.js';

interface InferredCustomerProfile {
  displayName: string | null;
  phone: string | null;
  appleId: string | null;
  email: string | null;
}

export interface CustomerIdentityInput {
  displayName?: string | null;
  phone?: string | null;
  appleId?: string | null;
  email?: string | null;
}

const GENERIC_DISPLAY_NAMES = new Set(['apple customer', 'messages sender', 'unknown messages sender']);
const SELF_IDENTIFIED_SOURCE = 'app_clip_self_identified';

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
  const normalized = value.replace(/[^\d+]/g, '');
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (normalized.startsWith('+')) return `+${digits}`;
  return digits.length === 10 ? `+1${digits}` : normalized;
}

function asEmail(value: string | null): string | null {
  if (!value) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function identityFrom(input: CustomerIdentityInput): InferredCustomerProfile {
  const appleId = clean(input.appleId);
  const email = asEmail(clean(input.email)) ?? asEmail(appleId);
  return {
    displayName: clean(input.displayName),
    phone: asPhone(clean(input.phone)),
    appleId,
    email,
  };
}

function inferProfile(raw: unknown): InferredCustomerProfile {
  const phone = asPhone(
    findByKey(
      raw,
      new Set([
        'phone',
        'phonenumber',
        'mobile',
        'mobilenumber',
        'msisdn',
        'sourceaddress',
        'sourcephone',
        'senderphone',
        'senderphonenumber',
        'fromphone',
        'phoneorappleid',
      ]),
    ),
  );
  const email = asEmail(
    findByKey(
      raw,
      new Set(['email', 'emailaddress', 'appleid', 'appleidaddress', 'senderappleid', 'fromappleid', 'phoneorappleid']),
    ),
  );
  const displayName = clean(
    findByKey(raw, new Set(['displayname', 'customername', 'name', 'handle', 'displayhandle', 'sendername', 'fromname'])),
  );

  return {
    displayName,
    phone,
    appleId: email,
    email,
  };
}

function isGenericDisplayName(value: unknown): boolean {
  return !clean(value) || GENERIC_DISPLAY_NAMES.has(clean(value)!.toLowerCase());
}

function displayNameFor(customerId: string, existingDisplayName: unknown, inferred: InferredCustomerProfile): string {
  const existing = clean(existingDisplayName);
  if (existing && !isGenericDisplayName(existing)) return existing;
  return inferred.displayName ?? inferred.phone ?? inferred.appleId ?? inferred.email ?? customerId;
}

function attributesObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canReplaceExisting(value: unknown, attributes: Record<string, unknown>): boolean {
  return !clean(value) || attributes.identitySource === SELF_IDENTIFIED_SOURCE;
}

async function updateConversationDisplayName(customerId: string, displayName: string): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, customer_name')
      .eq('customer_id', customerId);
    if (error || !data) return;
    const ids = data
      .filter((row) => isGenericDisplayName(row.customer_name) || clean(row.customer_name) === customerId)
      .map((row) => row.id)
      .filter(Boolean);
    if (!ids.length) return;
    await supabase.from('conversations').update({ customer_name: displayName }).in('id', ids);
  } catch (err) {
    console.warn('[customer-profile] conversation display sync skipped:', err);
  }
}

export async function touchCustomerProfile(customerId: string, raw?: unknown): Promise<void> {
  const inferred = inferProfile(raw);
  const now = new Date().toISOString();
  const hasProviderIdentity = Boolean(inferred.displayName || inferred.phone || inferred.appleId || inferred.email);

  try {
    const { data: existing, error: readError } = await supabase
      .from('customer_profiles')
      .select('display_name, phone, apple_id, email, attributes')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (readError) throw readError;

    const existingAttributes = attributesObject(existing?.attributes);
    const displayName = displayNameFor(customerId, existing?.display_name, inferred);
    const row: Record<string, unknown> = {
      customer_id: customerId,
      display_name: displayName,
      phone: existing?.phone ?? inferred.phone,
      apple_id: existing?.apple_id ?? inferred.appleId,
      email: existing?.email ?? inferred.email,
      last_seen_at: now,
      updated_at: now,
    };
    if (hasProviderIdentity) {
      row.attributes = {
        ...existingAttributes,
        providerIdentitySource: '1440_webhook_payload',
        providerIdentityTrust: 'provider_payload_unverified',
        providerIdentityUpdatedAt: now,
        providerIdentityFieldsProvided: {
          displayName: Boolean(inferred.displayName),
          phone: Boolean(inferred.phone),
          appleId: Boolean(inferred.appleId),
          email: Boolean(inferred.email),
        },
      };
    }

    if (existing) {
      const { error } = await supabase.from('customer_profiles').update(row).eq('customer_id', customerId);
      if (error) throw error;
      await updateConversationDisplayName(customerId, displayName);
      return;
    }

    const { error } = await supabase.from('customer_profiles').insert({
      ...row,
      first_seen_at: now,
    });
    if (error) throw error;
    await updateConversationDisplayName(customerId, displayName);
  } catch (err) {
    console.warn('[customer-profile] touch skipped:', err);
  }
}

export async function upsertCustomerIdentity(customerId: string, input: CustomerIdentityInput): Promise<void> {
  const inferred = identityFrom(input);
  if (!inferred.displayName && !inferred.phone && !inferred.appleId && !inferred.email) return;
  const now = new Date().toISOString();

  try {
    const { data: existing, error: readError } = await supabase
      .from('customer_profiles')
      .select('display_name, phone, apple_id, email, attributes')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (readError) throw readError;

    const existingAttributes = attributesObject(existing?.attributes);
    const allowSelfUpdate = canReplaceExisting(existing?.display_name, existingAttributes);
    const displayName =
      inferred.displayName && (allowSelfUpdate || isGenericDisplayName(existing?.display_name))
        ? inferred.displayName
        : displayNameFor(customerId, existing?.display_name, inferred);
    const row = {
      customer_id: customerId,
      display_name: displayName,
      phone: canReplaceExisting(existing?.phone, existingAttributes) ? inferred.phone ?? existing?.phone ?? null : existing?.phone,
      apple_id: canReplaceExisting(existing?.apple_id, existingAttributes)
        ? inferred.appleId ?? existing?.apple_id ?? null
        : existing?.apple_id,
      email: canReplaceExisting(existing?.email, existingAttributes) ? inferred.email ?? existing?.email ?? null : existing?.email,
      attributes: {
        ...existingAttributes,
        identitySource: SELF_IDENTIFIED_SOURCE,
        identityTrust: 'self_reported_unverified',
        identityUpdatedAt: now,
        identityFieldsProvided: {
          displayName: Boolean(inferred.displayName),
          phone: Boolean(inferred.phone),
          appleId: Boolean(inferred.appleId),
          email: Boolean(inferred.email),
        },
      },
      last_seen_at: now,
      updated_at: now,
    };

    if (existing) {
      const { error } = await supabase.from('customer_profiles').update(row).eq('customer_id', customerId);
      if (error) throw error;
      await updateConversationDisplayName(customerId, row.display_name);
      return;
    }

    const { error } = await supabase.from('customer_profiles').insert({
      ...row,
      first_seen_at: now,
    });
    if (error) throw error;
    await updateConversationDisplayName(customerId, row.display_name);
  } catch (err) {
    console.warn('[customer-profile] self-identified upsert skipped:', err);
  }
}
