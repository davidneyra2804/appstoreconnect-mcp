/**
 * STDIO transport integration.
 *
 * Starts the built server as a child process, drives it with real JSON-RPC
 * frames over stdin, and asserts that stdout carries protocol frames only
 * while every diagnostic lands on stderr.
 *
 * Covers acceptance criterion 2.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { makeTestKeyPair } from './fixtures.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SERVER_ENTRY = join(REPO_ROOT, 'dist', 'stdio.js');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Run the server over stdio and send the given JSON-RPC requests.
 * The process is stopped after the responses arrive.
 */
async function runStdio(
  requests: unknown[],
  env: Record<string, string> = {},
  waitMs = 4000,
): Promise<RunResult> {
  const { privateKey } = makeTestKeyPair();

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      APPLE_KEY_ID: 'TESTKEYID',
      APPLE_ISSUER_ID: 'test-issuer',
      APPLE_PRIVATE_KEY: privateKey,
      LOG_LEVEL: 'debug',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  const code = await new Promise<number | null>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolvePromise(null);
    }, waitMs);

    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolvePromise(exitCode);
    });
  });

  return { stdout, stderr, code, signal: child.signalCode };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

describe('stdio transport', () => {
  it('answers initialize on stdout with a JSON-RPC frame', async () => {
    const result = await runStdio([INITIALIZE]);

    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length > 0, 'The server wrote nothing to stdout');

    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc: string; id: number };
      assert.equal(parsed.jsonrpc, '2.0');
      assert.equal(typeof parsed.id, 'number');
    }

    const response = JSON.parse(lines[0]) as {
      id: number;
      result: { serverInfo: { name: string; version: string }; capabilities: unknown };
    };
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, 'appstoreconnect-mcp-readonly');
    assert.deepEqual(Object.keys(response.result.capabilities as object), ['tools']);
  });

  it('keeps stdout free of diagnostics and puts them on stderr', async () => {
    const result = await runStdio([INITIALIZE]);

    // Every stdout line must be parsable as a JSON-RPC frame.
    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    for (const line of lines) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `stdout carries a non-JSON line: ${line.slice(0, 120)}`,
      );
    }

    // The startup diagnostics must be on stderr instead.
    assert.match(result.stderr, /Starting read-only App Store Connect MCP server/);
    assert.match(result.stderr, /Server connected over stdio/);
  });

  it('lists the read-only tools over stdio', async () => {
    const result = await runStdio([
      INITIALIZE,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    ]);

    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    const responses = lines.map((line) => JSON.parse(line) as { id: number; result?: { tools: { name: string }[] } });

    const toolsResponse = responses.find((response) => response.id === 2);
    assert.ok(toolsResponse, 'No response for tools/list');

    const names = (toolsResponse.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'get_app',
      'list_app_store_versions',
      'list_apps',
      'list_beta_groups',
      'list_builds',
      'list_customer_reviews',
    ]);

    for (const name of names) {
      assert.ok(
        !/^(create|update|delete|remove|add|set|submit|upload|cancel|revoke)/.test(name),
        `The stdio inventory exposes a write tool: ${name}`,
      );
    }
  });

  it('exits with an error and an empty stdout when the configuration is missing', async () => {
    const result = await runStdio([INITIALIZE], { APPLE_KEY_ID: '', APPLE_ISSUER_ID: '' });

    assert.equal(result.stdout.trim(), '', 'stdout must stay empty on a configuration error');
    assert.match(result.stderr, /Configuration error/);
    assert.notEqual(result.code, 0);
  });

  it('never writes the private key to stdout or stderr', async () => {
    const { privateKey } = makeTestKeyPair();
    const dir = mkdtempSync(join(tmpdir(), 'asc-mcp-'));
    const keyPath = join(dir, 'key.p8');
    writeFileSync(keyPath, privateKey);

    const result = await runStdio([INITIALIZE], {
      APPLE_PRIVATE_KEY: '',
      APPLE_PRIVATE_KEY_PATH: keyPath,
    });

    const pemBody = privateKey.split('\n').slice(1, 3).join('');
    assert.ok(!result.stdout.includes(pemBody), 'The private key reached stdout');
    assert.ok(!result.stderr.includes(pemBody), 'The private key reached stderr');
  });
});
