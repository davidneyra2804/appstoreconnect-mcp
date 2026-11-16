/**
 * Sales report tool behaviour.
 *
 * Drives the real MCP server against the fake App Store Connect API, with
 * synthetic gzipped TSV fixtures. No network and no real credential.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
import {
  FakeAppStoreApi,
  SCOPE,
  makeTestKeyPair,
  scopedAppFixture,
} from './fixtures.js';
import {
  MIXED_CURRENCY_ROWS,
  NO_SALES_ROWS,
  SINGLE_APP_ROWS,
  renderSalesGzip,
} from './sales-fixtures.js';

const VENDOR_NUMBER = '87654321';

async function connect(
  api: FakeAppStoreApi,
  config: { bundleId?: string; appId?: string; vendorNumber?: string } = {},
): Promise<{ client: Client; server: { close: () => Promise<void> } }> {
  const { privateKey } = makeTestKeyPair();
  const silentLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as import('../src/logger.js').Logger;

  const server = createMcpServer(
    {
      keyId: 'TESTKEYID',
      issuerId: 'test-issuer',
      privateKey,
      vendorNumber: VENDOR_NUMBER,
      ...config,
    },
    { fetchImpl: api.fetch, logger: silentLogger },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

interface ToolCallResult {
  content: unknown;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const content = (result as ToolCallResult).content as { text: string }[];
  return content[0].text;
}

/** The query of the recorded sales report request. */
function salesQuery(api: FakeAppStoreApi): URLSearchParams {
  const request = api.requests.find((entry) => entry.url.includes('/v1/salesReports'));
  assert.ok(request, 'The sales report endpoint was never called');
  return new URL(request.url).searchParams;
}

describe('get_sales_report request shape', () => {
  it('asks for a daily sales summary report', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    const query = salesQuery(api);
    assert.equal(query.get('filter[frequency]'), 'DAILY');
    assert.equal(query.get('filter[reportType]'), 'SALES');
    assert.equal(query.get('filter[reportSubType]'), 'SUMMARY');
    assert.equal(query.get('filter[reportDate]'), '2026-10-30');

    await client.close();
    await server.close();
  });

  it('sends the vendor number, not the issuer id', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    const query = salesQuery(api);
    assert.equal(query.get('filter[vendorNumber]'), VENDOR_NUMBER);
    assert.notEqual(query.get('filter[vendorNumber]'), 'test-issuer');

    await client.close();
    await server.close();
  });

  it('asks for the gzipped report with the gzip accept header', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    const request = api.requests.find((entry) => entry.url.includes('/v1/salesReports'));
    assert.ok(request);
    assert.equal(request.headers.accept, 'application/a-gzip');
    assert.match(request.headers.authorization ?? '', /^Bearer /);

    await client.close();
    await server.close();
  });

  it('uses GET for the sales report', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    const request = api.requests.find((entry) => entry.url.includes('/v1/salesReports'));
    assert.ok(request);
    assert.equal(request.method, 'GET');

    await client.close();
    await server.close();
  });

  it('refuses the call when no vendor number is configured', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { privateKey } = makeTestKeyPair();
    const silentLogger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as import('../src/logger.js').Logger;

    const server = createMcpServer(
      { keyId: 'TESTKEYID', issuerId: 'test-issuer', privateKey },
      { fetchImpl: api.fetch, logger: silentLogger },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /APPLE_VENDOR_NUMBER is not set/);
    assert.equal(
      api.requests.some((entry) => entry.url.includes('/v1/salesReports')),
      false,
      'No report request may leave the process without a vendor number',
    );

    await client.close();
    await server.close();
  });
});

describe('get_sales_report argument validation', () => {
  it('rejects a malformed date before any request', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '30/10/2026' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /YYYY-MM-DD/);
    assert.equal(
      api.requests.some((entry) => entry.url.includes('/v1/salesReports')),
      false,
      'An invalid date must not produce a report request',
    );

    await client.close();
    await server.close();
  });

  it('rejects a date that is not a real calendar day', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-02-30' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not a real calendar date/);
    assert.equal(
      api.requests.some((entry) => entry.url.includes('/v1/salesReports')),
      false,
    );

    await client.close();
    await server.close();
  });

  it('rejects a date in the future', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2999-01-01' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /in the future/);
    assert.equal(
      api.requests.some((entry) => entry.url.includes('/v1/salesReports')),
      false,
    );

    await client.close();
    await server.close();
  });

  it('rejects an unknown argument', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, vendorNumber: '00000000' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown argument "vendorNumber"/);

    await client.close();
    await server.close();
  });

  it('requires an app id', async () => {
    const api = new FakeAppStoreApi();

    const { client, server } = await connect(api);
    const result = await client.callTool({ name: 'get_sales_report', arguments: {} });

    assert.equal(result.isError, true);

    await client.close();
    await server.close();
  });

  it('defaults to yesterday when no date is given', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId },
    });

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    assert.equal(salesQuery(api).get('filter[reportDate]'), yesterday);
    assert.notEqual(salesQuery(api).get('filter[reportDate]'), today);

    await client.close();
    await server.close();
  });
});

describe('get_sales_report scope enforcement', () => {
  it('denies an app outside the configured scope', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api, { bundleId: 'com.example.other' });
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Access denied/);
    assert.equal(
      api.requests.some((entry) => entry.url.includes('/v1/salesReports')),
      false,
      'The report must not be read for an app outside the scope',
    );

    await client.close();
    await server.close();
  });

  it('allows an app inside the configured scope', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api, { bundleId: SCOPE.bundleId });
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.notEqual(result.isError, true);

    await client.close();
    await server.close();
  });

  it('reports only the sales of the app in scope', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(MIXED_CURRENCY_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api, { bundleId: SCOPE.bundleId });
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /Units: 5/);
    assert.match(text, /USD 2\.10/);
    assert.match(text, /EUR 1\.30/);
    assert.doesNotMatch(text, /GBP/);

    await client.close();
    await server.close();
  });
});

describe('get_sales_report results', () => {
  it('returns the units and the proceeds of the app', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(SINGLE_APP_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /Date: 2026-10-30/);
    assert.match(text, /Units: 10/);
    assert.match(text, /USD 7\.00/);

    await client.close();
    await server.close();
  });

  it('tells a report that is not generated yet from a day without sales', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onError('/v1/salesReports', 404, {
      errors: [
        {
          status: '404',
          title: 'Not found',
          detail: 'The sales report for this date is not available yet.',
        },
      ],
    });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /has not been generated yet/);

    await client.close();
    await server.close();
  });

  it('reports a day without sales as a day without sales', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onBinary('/v1/salesReports', renderSalesGzip(NO_SALES_ROWS), 'application/a-gzip');

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /contains no sales/);

    await client.close();
    await server.close();
  });

  it('surfaces an App Store Connect error', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onError('/v1/salesReports', 400, {
      errors: [{ status: '400', title: 'Bad request', detail: 'The report subtype is invalid' }],
    });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_sales_report',
      arguments: { appId: SCOPE.appId, date: '2026-10-30' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /App Store Connect API error 400/);

    await client.close();
    await server.close();
  });
});

describe('tool inventory', () => {
  it('exposes the sales report tool as a read', async () => {
    const api = new FakeAppStoreApi();

    const { client, server } = await connect(api);
    const listed = await client.listTools();

    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('get_sales_report'));
    assert.equal(
      names.filter((name) => /^(create|update|delete|set|post|patch|write|modify|upload|submit)/.test(name))
        .length,
      0,
      'The inventory must not contain a write tool',
    );

    await client.close();
    await server.close();
  });
});
