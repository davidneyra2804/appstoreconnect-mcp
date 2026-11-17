/**
 * The five app-scoped read tools added on top of the first seven:
 * app info, pricing, availability, in-app purchases and analytics.
 *
 * Driven by fixtures; no network and no real credentials.
 *
 * The suite also locks the read-only contract of these tools: every request
 * they make is a GET, and the scope check runs before the protected resource
 * is read.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
import {
  FakeAppStoreApi,
  SCOPE,
  analyticsReportFixture,
  analyticsReportRequestFixture,
  appAvailabilityFixture,
  appCategoryFixture,
  appInfoFixture,
  appInfoLocalizationFixture,
  appPricePointFixture,
  inAppPurchaseFixture,
  makeTestKeyPair,
  outOfScopeAppFixture,
  scopedAppFixture,
  territoryAvailabilityFixture,
  territoryFixture,
} from './fixtures.js';

async function connect(
  api: FakeAppStoreApi,
  config: { bundleId?: string; appId?: string; appStoreSku?: string } = {},
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

describe('get_app_info_details', () => {
  it('reads the app info with its localizations', async () => {
    const api = new FakeAppStoreApi();
    api.onDocumentWithIncluded(
      '/v1/apps/1234567890/appInfos',
      [appInfoFixture()],
      [appInfoLocalizationFixture(), appCategoryFixture()],
    );

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app_info_details',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /1 App Store info\(s\)/);
    assert.match(text, /Age rating: 4\+/);
    assert.match(text, /en-US: Fixture App/);
    assert.match(text, /Does things/);

    await client.close();
    await server.close();
  });

  it('reports an app without any info', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/appInfos', []);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app_info_details',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No App Store info found/);

    await client.close();
    await server.close();
  });

  it('requests the app info endpoint', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/appInfos', []);

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_app_info_details',
      arguments: { appId: '1234567890' },
    });

    const request = api.requests.find((entry) => entry.url.includes('/appInfos'));
    assert.ok(request, 'The app info endpoint was never read');
    assert.match(request.url, /include=appInfoLocalizations/);

    await client.close();
    await server.close();
  });
});

describe('get_app_pricing', () => {
  it('reads the price points with their territory', async () => {
    const api = new FakeAppStoreApi();
    api.onDocumentWithIncluded(
      '/v1/apps/1234567890/appPricePoints',
      [appPricePointFixture()],
      [territoryFixture()],
    );

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app_pricing',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /1 price point\(s\)/);
    assert.match(text, /USA \(USD\)/);
    assert.match(text, /Customer price: 0\.99/);
    assert.match(text, /Developer proceeds: 0\.69/);

    await client.close();
    await server.close();
  });

  it('reports an app without price points', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/appPricePoints', []);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app_pricing',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No price points found/);

    await client.close();
    await server.close();
  });

  it('requests the price point endpoint', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/appPricePoints', []);

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_app_pricing',
      arguments: { appId: '1234567890' },
    });

    const request = api.requests.find((entry) => entry.url.includes('/appPricePoints'));
    assert.ok(request, 'The price point endpoint was never read');
    assert.match(request.url, /include=territory/);

    await client.close();
    await server.close();
  });
});

describe('get_app_availability', () => {
  it('reads the availability of every territory', async () => {
    const api = new FakeAppStoreApi();
    api.onDocumentWithIncluded(
      '/v1/apps/1234567890/appAvailabilityV2',
      [appAvailabilityFixture()],
      [territoryAvailabilityFixture(), territoryFixture()],
    );

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app_availability',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /Availability id: av1/);
    assert.match(text, /1 listed, 1 available/);
    assert.match(text, /USA: available, released 2026-01-10/);
    assert.match(text, /AVAILABLE_FOR_SALE/);

    await client.close();
    await server.close();
  });

  it('reports an app without availability', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/appAvailabilityV2', []);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app_availability',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No availability found/);

    await client.close();
    await server.close();
  });

  it('requests the availability endpoint', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/appAvailabilityV2', []);

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_app_availability',
      arguments: { appId: '1234567890' },
    });

    const request = api.requests.find((entry) => entry.url.includes('/appAvailabilityV2'));
    assert.ok(request, 'The availability endpoint was never read');
    assert.match(request.url, /include=territoryAvailabilities/);

    await client.close();
    await server.close();
  });
});

describe('get_in_app_purchases', () => {
  it('reads the in-app purchases', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/inAppPurchasesV2', [inAppPurchaseFixture()]);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_in_app_purchases',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /1 in-app purchase\(s\)/);
    assert.match(text, /Coins 100/);
    assert.match(text, /com\.example\.fixture\.coins100/);
    assert.match(text, /Type: CONSUMABLE/);
    assert.match(text, /State: READY_TO_SUBMIT/);

    await client.close();
    await server.close();
  });

  it('reports an app without in-app purchases', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/inAppPurchasesV2', []);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_in_app_purchases',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /No in-app purchases found/);

    await client.close();
    await server.close();
  });

  it('reads the current v2 endpoint and not the legacy one', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/inAppPurchasesV2', []);

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_in_app_purchases',
      arguments: { appId: '1234567890' },
    });

    const v2 = api.requests.find((entry) => entry.url.includes('/inAppPurchasesV2'));
    assert.ok(v2, 'The v2 in-app purchase endpoint was never read');

    const legacy = api.requests.find(
      (entry) => entry.url.includes('/inAppPurchases') && !entry.url.includes('V2'),
    );
    assert.equal(legacy, undefined, 'The legacy in-app purchase endpoint must not be read');

    await client.close();
    await server.close();
  });
});

describe('get_analytics', () => {
  it('reads the analytics report requests with their reports', async () => {
    const api = new FakeAppStoreApi();
    api.onDocumentWithIncluded(
      '/v1/apps/1234567890/analyticsReportRequests',
      [analyticsReportRequestFixture()],
      [analyticsReportFixture()],
    );

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_analytics',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /1 analytics report request\(s\)/);
    assert.match(text, /Access type: ONGOING/);
    assert.match(text, /App Sessions \[APP_USAGE\]/);

    await client.close();
    await server.close();
  });

  it('reports an app without report requests', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/analyticsReportRequests', []);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_analytics',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /No analytics report requests found/);
    assert.match(text, /only reads them/);

    await client.close();
    await server.close();
  });

  it('never creates a report request', async () => {
    // Creating a report request is a POST. The tool must only read the
    // requests that already exist.
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/analyticsReportRequests', []);

    const { client, server } = await connect(api);
    await client.callTool({
      name: 'get_analytics',
      arguments: { appId: '1234567890' },
    });

    assert.deepEqual(
      [...new Set(api.verbs)],
      ['GET'],
      `The analytics tool used a non-GET verb: ${[...new Set(api.verbs)].join(', ')}`,
    );

    await client.close();
    await server.close();
  });
});

describe('the five new tools are read-only and scoped', () => {
  const NEW_TOOLS = [
    { name: 'get_app_info_details', path: '/appInfos' },
    { name: 'get_app_pricing', path: '/appPricePoints' },
    { name: 'get_app_availability', path: '/appAvailabilityV2' },
    { name: 'get_in_app_purchases', path: '/inAppPurchasesV2' },
    { name: 'get_analytics', path: '/analyticsReportRequests' },
  ];

  it('uses GET for every request', async () => {
    const api = new FakeAppStoreApi();
    for (const tool of NEW_TOOLS) {
      api.onDocument(`/v1/apps/1234567890${tool.path}`, []);
    }

    const { client, server } = await connect(api);

    for (const tool of NEW_TOOLS) {
      await client.callTool({ name: tool.name, arguments: { appId: '1234567890' } });
    }

    assert.ok(api.verbs.length > 0);
    assert.deepEqual(
      [...new Set(api.verbs)],
      ['GET'],
      `A new tool used a non-GET verb: ${[...new Set(api.verbs)].join(', ')}`,
    );

    await client.close();
    await server.close();
  });

  it('denies an app outside the configured scope before reading it', async () => {
    for (const tool of NEW_TOOLS) {
      const api = new FakeAppStoreApi();
      // The app does not match the configured bundle id, so the scope check
      // must refuse it.
      api.on(`/v1/apps/${SCOPE.appId}`, { data: outOfScopeAppFixture() });
      api.onDocument(`/v1/apps/${SCOPE.appId}${tool.path}`, []);

      const { client, server } = await connect(api, { bundleId: SCOPE.bundleId });
      const result = await client.callTool({
        name: tool.name,
        arguments: { appId: SCOPE.appId },
      });

      assert.equal(result.isError, true, `The tool ${tool.name} ignored the scope`);
      assert.match(textOf(result), /Access denied/);

      const reads = api.requests.filter((entry) => entry.url.includes(tool.path));
      assert.equal(
        reads.length,
        0,
        `The tool ${tool.name} read the protected resource despite the scope`,
      );

      await client.close();
      await server.close();
    }
  });

  it('allows an app inside the configured scope', async () => {
    for (const tool of NEW_TOOLS) {
      const api = new FakeAppStoreApi();
      api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
      api.onDocument(`/v1/apps/${SCOPE.appId}${tool.path}`, []);

      const { client, server } = await connect(api, { bundleId: SCOPE.bundleId });
      const result = await client.callTool({
        name: tool.name,
        arguments: { appId: SCOPE.appId },
      });

      assert.notEqual(
        result.isError,
        true,
        `The tool ${tool.name} denied an app inside the scope`,
      );

      await client.close();
      await server.close();
    }
  });

  it('rejects a missing app id before any request', async () => {
    for (const tool of NEW_TOOLS) {
      const api = new FakeAppStoreApi();

      const { client, server } = await connect(api);
      const result = await client.callTool({ name: tool.name, arguments: {} });

      assert.equal(result.isError, true);
      assert.match(textOf(result), /Missing required argument "appId"/);
      assert.equal(
        api.requests.length,
        0,
        `The tool ${tool.name} reached the API without its required argument`,
      );

      await client.close();
      await server.close();
    }
  });

  it('surfaces an App Store Connect API error', async () => {
    for (const tool of NEW_TOOLS) {
      const api = new FakeAppStoreApi();
      api.onError(`/v1/apps/1234567890${tool.path}`, 403, {
        errors: [{ status: '403', title: 'Forbidden', detail: 'The key cannot read it' }],
      });

      const { client, server } = await connect(api);
      const result = await client.callTool({
        name: tool.name,
        arguments: { appId: '1234567890' },
      });

      assert.equal(result.isError, true);
      assert.match(textOf(result), /App Store Connect API error 403/);

      await client.close();
      await server.close();
    }
  });
});
