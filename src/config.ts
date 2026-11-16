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
  /** Optional: restrict every app-scoped tool to this App Store ID. */
  appStoreId?: string;
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
  const appStoreId = (env.APPLE_APP_STORE_ID ?? '').trim();

  return {
    keyId,
    issuerId,
    privateKey,
    ...(bundleId ? { bundleId } : {}),
    ...(appStoreId ? { appStoreId } : {}),
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
