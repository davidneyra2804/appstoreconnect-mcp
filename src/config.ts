/**
 * Runtime configuration for the read-only App Store Connect MCP server.
 *
 * Every value comes from the environment. No credential is ever read from a
 * file that could be committed, and no default points at a real account.
 */

import { readFileSync } from 'node:fs';

export interface AppStoreConfig {
  /** App Store Connect API Key ID (the `.p8` key identifier). */
  keyId: string;
  /** App Store Connect Issuer ID (also the Apple team identifier). */
  issuerId: string;
  /** PEM private key content, ES256 signing key. */
  privateKey: string;
  /** Optional: restrict every app-scoped tool to this bundle ID. */
  bundleId?: string;
  /**
   * Optional: restrict every app-scoped tool to this App Store Connect
   * resource id.
   *
   * This is the opaque `id` of the `apps` resource, the same value the
   * `appId` argument of every tool takes. It is NOT the customer-facing
   * App Store ID: see `appStoreSku`.
   */
  appId?: string;
  /**
   * Optional: restrict every app-scoped tool to this customer-facing App
   * Store ID, which Apple exposes as the `sku` attribute of the `apps`
   * resource.
   */
  appStoreSku?: string;
  /**
   * Optional: the vendor number of the App Store Connect account.
   *
   * This is the number shown in App Store Connect under Payments and
   * Financial Reports. It is NOT the issuer id and NOT the App Store ID:
   * Apple rejects the sales report request when the wrong value is sent.
   */
  vendorNumber?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Keys whose value must never appear in a log line, an error message or a
 * tool response. Matched case-insensitively against the whole key.
 */
const SECRET_KEYS = new Set([
  'privatekey',
  'authorization',
  'token',
  'jwt',
  'bearer',
  'password',
  'secret',
  'apikey',
  'key',
]);

/** Redact a secret value, keeping only a short non-reversible fingerprint. */
export function redactSecret(value: string): string {
  if (!value) return '<empty>';
  // Fingerprint over the content, never the content itself.
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return `<redacted len=${value.length} fp=${hash.toString(16).padStart(8, '0')}>`;
}

/**
 * Build the configuration from an environment map.
 *
 * The private key may be supplied either inline (`APPLE_PRIVATE_KEY`) or as a
 * path to the downloaded `.p8` file (`APPLE_PRIVATE_KEY_PATH`). Exactly one of
 * the two must be present.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppStoreConfig {
  const keyId = (env.APPLE_KEY_ID ?? '').trim();
  const issuerId = (env.APPLE_ISSUER_ID ?? '').trim();
  const privateKey = resolvePrivateKey(env);

  const missing: string[] = [];
  if (!keyId) missing.push('APPLE_KEY_ID');
  if (!issuerId) missing.push('APPLE_ISSUER_ID');
  if (!privateKey) missing.push('APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_PATH');

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'The server runs read-only and still requires a key to call the App Store Connect API.',
    );
  }

  const bundleId = (env.APPLE_BUNDLE_ID ?? '').trim();
  const appId = (env.APPLE_APP_ID ?? '').trim();
  const appStoreSku = (env.APPLE_APP_STORE_SKU ?? '').trim();
  const vendorNumber = (env.APPLE_VENDOR_NUMBER ?? '').trim();

  // `APPLE_APP_STORE_ID` was ambiguous: it was documented as the customer-facing
  // App Store ID (Apple's `sku`) but the tools address apps by the App Store
  // Connect resource id. It is rejected with a precise message rather than
  // silently interpreted, so a misconfigured scope never denies the wrong app.
  const deprecated = (env.APPLE_APP_STORE_ID ?? '').trim();
  if (deprecated) {
    throw new ConfigError(
      'APPLE_APP_STORE_ID is ambiguous and is no longer accepted. ' +
        'Use APPLE_APP_ID for the App Store Connect app id (the value the tools take as appId), ' +
        'or APPLE_APP_STORE_SKU for the customer-facing App Store ID (the sku attribute).',
    );
  }

  return {
    keyId,
    issuerId,
    privateKey,
    ...(bundleId ? { bundleId } : {}),
    ...(appId ? { appId } : {}),
    ...(appStoreSku ? { appStoreSku } : {}),
    ...(vendorNumber ? { vendorNumber } : {}),
  };
}

/**
 * Read the private key from the inline value or from the `.p8` path.
 * The key is normalised so that escaped newlines survive environment round-trips.
 */
export function resolvePrivateKey(env: NodeJS.ProcessEnv = process.env): string {
  const inline = env.APPLE_PRIVATE_KEY;
  if (inline && inline.trim()) {
    return normalizePrivateKey(inline);
  }

  const keyPath = (env.APPLE_PRIVATE_KEY_PATH ?? '').trim();
  if (!keyPath) return '';

  const raw = readFileSync(keyPath, 'utf8');
  return normalizePrivateKey(raw);
}

/**
 * Normalise a PEM private key.
 *
 * Accepts raw PEM, base64-encoded PEM, and PEM with literal `\n` escapes.
 */
export function normalizePrivateKey(value: string): string {
  let key = value.trim();

  if (!key.includes('BEGIN PRIVATE KEY')) {
    const decoded = Buffer.from(key, 'base64').toString('utf8').trim();
    if (decoded.includes('BEGIN PRIVATE KEY')) {
      key = decoded;
    }
  }

  return key.replace(/\\n/g, '\n');
}

/**
 * True when the given key name holds a secret and its value must be redacted.
 */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SECRET_KEYS.has(normalized)) return true;
  return normalized.includes('private_key') || normalized.includes('apikey');
}
