import { readFileSync } from 'node:fs';
import https from 'node:https';
import { env } from '../env.js';

function normalizePem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function loadPem(input: {
  pem: string;
  base64: string;
  path: string;
  label: string;
}): string {
  if (input.pem) return normalizePem(input.pem);
  if (input.base64) return Buffer.from(input.base64, 'base64').toString('utf8');
  if (input.path) return readFileSync(input.path, 'utf8');
  throw new Error(`Apple Pay ${input.label} is not configured`);
}

function merchantIdentityCertificate(): string {
  return loadPem({
    pem: env.applePayMerchantIdentityCertPem,
    base64: env.applePayMerchantIdentityCertBase64,
    path: env.applePayMerchantIdentityCertPath,
    label: 'merchant identity certificate',
  });
}

function merchantIdentityKey(): string {
  return loadPem({
    pem: env.applePayMerchantIdentityKeyPem,
    base64: env.applePayMerchantIdentityKeyBase64,
    path: env.applePayMerchantIdentityKeyPath,
    label: 'merchant identity private key',
  });
}

export function hasApplePayMerchantIdentityConfig(): boolean {
  return Boolean(
    env.applePayMerchantIdentifier &&
      env.applePayPaymentGatewayUrl &&
      ((env.applePayMerchantIdentityCertPem && env.applePayMerchantIdentityKeyPem) ||
        (env.applePayMerchantIdentityCertBase64 && env.applePayMerchantIdentityKeyBase64) ||
        (env.applePayMerchantIdentityCertPath && env.applePayMerchantIdentityKeyPath) ||
        env.applePayMerchantSessionJson),
  );
}

export async function requestApplePayMerchantSession(): Promise<Record<string, unknown>> {
  if (env.applePayMerchantSessionJson) {
    const parsed = JSON.parse(env.applePayMerchantSessionJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('APPLE_PAY_MERCHANT_SESSION_JSON is not an object');
  }

  if (!env.applePayMerchantIdentifier || !env.applePayPaymentGatewayUrl) {
    throw new Error('Apple Pay merchant identifier or payment gateway URL is not configured');
  }

  const endpoint = new URL(env.applePayMerchantSessionEndpoint);
  const body = JSON.stringify({
    merchantIdentifier: env.applePayMerchantIdentifier,
    displayName: env.applePayMerchantDisplayName,
    initiative: 'messaging',
    initiativeContext: env.applePayPaymentGatewayUrl,
  });

  const text = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || 443,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        cert: merchantIdentityCertificate(),
        key: merchantIdentityKey(),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Apple Pay merchant session ${res.statusCode}: ${responseText}`));
            return;
          }
          resolve(responseText);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Apple Pay merchant session timed out')));
    req.on('error', reject);
    req.end(body);
  });

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Apple Pay merchant session response was not an object');
  }
  return parsed as Record<string, unknown>;
}
