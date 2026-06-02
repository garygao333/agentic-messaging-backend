/**
 * Typed environment loader. Fails fast on missing critical vars; warns on the
 * service-key fallback so we never silently run on the anon key in production.
 */
import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabaseKey = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
if (!supabaseKey) {
  throw new Error('Set SUPABASE_SERVICE_KEY (preferred) or SUPABASE_ANON_KEY');
}
if (!SUPABASE_SERVICE_KEY) {
  console.warn(
    '[env] WARNING: running on the Supabase ANON key (RLS-permissive MVP). ' +
      'Set SUPABASE_SERVICE_KEY before tightening RLS / production.',
  );
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8787),

  supabaseUrl: req('SUPABASE_URL'),
  supabaseKey,
  usingServiceKey: Boolean(SUPABASE_SERVICE_KEY),

  openaiKey: req('OPENAI_API_KEY'),
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',

  mspApiBase: process.env.MSP_API_BASE ?? 'https://msp.1440.co/functions/v1',
  mspApiKey: req('MSP_API_KEY'),
  mspBusinessId: req('MSP_BUSINESS_ID'),
  mspWebhookSecret: process.env.MSP_WEBHOOK_SECRET ?? '',

  applePayMerchantIdentifier: process.env.APPLE_PAY_MERCHANT_IDENTIFIER ?? '',
  applePayPaymentGatewayUrl: process.env.APPLE_PAY_PAYMENT_GATEWAY_URL ?? '',
  applePayFallbackUrl: process.env.APPLE_PAY_FALLBACK_URL ?? '',
  applePayMerchantSessionJson: process.env.APPLE_PAY_MERCHANT_SESSION_JSON ?? '',

  // Super admins skip Apple Messages verification and land straight on the
  // dashboard. Comma-separated emails; defaults to ian@trychert.com only.
  superAdminEmails: (process.env.SUPER_ADMIN_EMAILS ?? 'ian@trychert.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  appSharedToken: process.env.APP_SHARED_TOKEN ?? '',
  requireAppAuth:
    process.env.REQUIRE_APP_AUTH === 'true' || process.env.NODE_ENV === 'production',

  agentResponseBufferMs: Number(process.env.AGENT_RESPONSE_BUFFER_MS ?? 0),
} as const;
