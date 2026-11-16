/**
 * Configuration handling and log redaction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  isSecretKey,
  loadConfig,
  normalizePrivateKey,
  redactSecret,
  resolvePrivateKey,
} from '../src/config.js';
import { formatForLog } from '../src/logger.js';
import { makeTestKeyPair } from './fixtures.js';

describe('configuration', () => {
  it('requires the key id, issuer id and a private key', () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), ConfigError);
    assert.throws(
      () => loadConfig({ APPLE_KEY_ID: 'K' } as NodeJS.ProcessEnv),
      /APPLE_ISSUER_ID/,
    );
  });

  it('loads the private key from a .p8 path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-mcp-'));
    const keyPath = join(dir, 'key.p8');
    writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n');

    const key = resolvePrivateKey({ APPLE_PRIVATE_KEY_PATH: keyPath } as NodeJS.ProcessEnv);
    assert.match(key, /BEGIN PRIVATE KEY/);

    const config = loadConfig({
      APPLE_KEY_ID: 'K',
      APPLE_ISSUER_ID: 'I',
      APPLE_PRIVATE_KEY_PATH: keyPath,
    } as NodeJS.ProcessEnv);

    assert.equal(config.keyId, 'K');
    assert.equal(config.issuerId, 'I');
    assert.match(config.privateKey, /BEGIN PRIVATE KEY/);
  });

  it('decodes a base64 encoded private key', () => {
    const { privateKey } = makeTestKeyPair();
    const encoded = Buffer.from(privateKey, 'utf8').toString('base64');
    const decoded = normalizePrivateKey(encoded);
    assert.match(decoded, /BEGIN PRIVATE KEY/);
  });

  it('repairs escaped newlines in an inline private key', () => {
    const repaired = normalizePrivateKey('-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----');
    assert.ok(repaired.includes('\n'));
    assert.ok(!repaired.includes('\\n'));
  });

  it('reads the optional scope variables', () => {
    const { privateKey } = makeTestKeyPair();
    const config = loadConfig({
      APPLE_KEY_ID: 'K',
      APPLE_ISSUER_ID: 'I',
      APPLE_PRIVATE_KEY: privateKey,
      APPLE_BUNDLE_ID: 'com.example.app',
      APPLE_APP_STORE_ID: '123',
    } as NodeJS.ProcessEnv);

    assert.equal(config.bundleId, 'com.example.app');
    assert.equal(config.appStoreId, '123');
  });
});

describe('redaction', () => {
  it('never prints a secret value', () => {
    const secret = 'super-secret-private-key-material';
    const redacted = redactSecret(secret);

    assert.ok(!redacted.includes(secret));
    assert.match(redacted, new RegExp(`<redacted len=${secret.length} fp=[0-9a-f]{8}>`));
  });

  it('detects secret key names', () => {
    assert.equal(isSecretKey('APPLE_PRIVATE_KEY'), true);
    assert.equal(isSecretKey('authorization'), true);
    assert.equal(isSecretKey('token'), true);
    assert.equal(isSecretKey('appId'), false);
  });

  it('redacts secret fields of a logged object', () => {
    const { privateKey } = makeTestKeyPair();
    const line = formatForLog({
      keyId: 'ABC123',
      privateKey,
      issuerId: 'issuer',
    });

    assert.ok(!line.includes(privateKey));
    assert.match(line, /keyId=ABC123/);
    assert.match(line, /issuerId=issuer/);
    assert.match(line, /privateKey=<redacted/);
  });

  it('truncates a long string in a log line', () => {
    const line = formatForLog({ body: 'x'.repeat(2000) });
    assert.ok(line.length < 700, `Log line is ${line.length} chars long`);
    assert.match(line, /\(\+\d+ chars\)/);
  });

  it('redacts a secret inside an error message', () => {
    const { privateKey } = makeTestKeyPair();
    const line = formatForLog(new Error(`failed with key ${privateKey}`));
    assert.ok(!line.includes(privateKey));
  });

  it('redacts a PEM block embedded in free text', () => {
    const { privateKey } = makeTestKeyPair();
    const line = formatForLog(new Error(`the request body was: ${privateKey}`));

    assert.ok(!line.includes('BEGIN PRIVATE KEY'), 'The PEM header survived redaction');
    assert.ok(!line.includes('END PRIVATE KEY'), 'The PEM footer survived redaction');
    assert.match(line, /<redacted pem-block>/);
  });

  it('redacts a bearer token in free text', () => {
    const line = formatForLog('Authorization: Bearer AAAABBBBCCCCDDDD');
    assert.ok(!line.includes('AAAABBBBCCCCDDDD'), 'The bearer token survived redaction');
    assert.match(line, /Bearer <redacted>/);
  });

  it('redacts a basic credential in free text', () => {
    const line = formatForLog('authorization: Basic ZZZZYYYYXXXX');
    assert.ok(!line.includes('ZZZZYYYYXXXX'), 'The basic credential survived redaction');
    assert.match(line, /Basic <redacted>/);
  });

  it('redacts a token named field in free text', () => {
    const line = formatForLog('body was {"privateKey":"SUPERSECRETVALUE"}');
    assert.ok(!line.includes('SUPERSECRETVALUE'), 'The token value survived redaction');
  });
});
