/**
 * Tool behaviour: prioritized read contracts, scope enforcement, API errors
 * and result limits. Driven by fixtures; no network and no real credentials.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
import {
  FakeAppStoreApi,
  SCOPE,
  appFixture,
  betaGroupFixture,
  buildFixture,
  makeTestKeyPair,
  outOfScopeAppFixture,
  reviewFixture,
  scopedAppFixture,
  versionFixture,
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

describe('read tool contracts', () => {
  it('lists apps with the expected fields', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps', [appFixture()]);

    const { client, server } = await connect(api);
    const result = await client.callTool({ name: 'list_apps', arguments: {} });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /Fixture App/);
    assert.match(text, /com\.example\.fixture/);
    assert.match(text, /1234567890/);

    await client.close();
    await server.close();
  });

  it('reads one app', async () => {
    const api = new FakeAppStoreApi();
    api.on('/v1/apps/1234567890', { data: appFixture() });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /Name: Fixture App/);

    await client.close();
    await server.close();
  });

  it('lists app store versions', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/appStoreVersions', [versionFixture()]);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'list_app_store_versions',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /1\.2\.3/);

    await client.close();
    await server.close();
  });

  it('lists testflight builds', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/builds', [buildFixture()]);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'list_builds',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /1\.2\.3 \(42\)/);
    assert.match(text, /Processing: VALID/);

    await client.close();
    await server.close();
  });

  it('lists beta groups', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/betaGroups', [betaGroupFixture()]);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'list_beta_groups',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /External Testers/);
    assert.match(text, /Type: External/);

    await client.close();
    await server.close();
  });

  it('lists customer reviews and honours the limit', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument(
      '/v1/apps/1234567890/customerReviews',
      Array.from({ length: 5 }, (_, index) =>
        reviewFixture({
          id: `r${index}`,
          attributes: {
            ...(reviewFixture().attributes as Record<string, unknown>),
            title: `Review ${index}`,
            rating: index + 1,
          },
        }),
      ),
    );

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'list_customer_reviews',
      arguments: { appId: '1234567890', limit: 2 },
    });

    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.match(text, /2 customer review\(s\)/);
    assert.doesNotMatch(text, /Review 3/);

    await client.close();
    await server.close();
  });

  it('rejects a review limit outside the allowed range', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps/1234567890/customerReviews', []);

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'list_customer_reviews',
      arguments: { appId: '1234567890', limit: 5000 },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /must be an integer between 1 and 200/);

    await client.close();
    await server.close();
  });
});

describe('scope enforcement', () => {
  it('allows an app inside the configured bundle scope', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onDocument(`/v1/apps/${SCOPE.appId}/builds`, [buildFixture()]);

    const { client, server } = await connect(api, { bundleId: SCOPE.bundleId });
    const result = await client.callTool({
      name: 'list_builds',
      arguments: { appId: SCOPE.appId },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /1\.2\.3/);

    await client.close();
    await server.close();
  });

  it('denies an app outside the configured bundle scope', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: outOfScopeAppFixture() });

    const { client, server } = await connect(api, { bundleId: SCOPE.bundleId });
    const result = await client.callTool({
      name: 'list_builds',
      arguments: { appId: SCOPE.appId },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Access denied/);

    await client.close();
    await server.close();
  });

  it('allows the app when APPLE_APP_ID matches the App Store Connect app id', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onDocument(`/v1/apps/${SCOPE.appId}/builds`, [buildFixture()]);

    const { client, server } = await connect(api, { appId: SCOPE.appId });
    const result = await client.callTool({
      name: 'list_builds',
      arguments: { appId: SCOPE.appId },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /1\.2\.3/);

    await client.close();
    await server.close();
  });

  it('allows the app when APPLE_APP_STORE_SKU matches the customer-facing App Store ID', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onDocument(`/v1/apps/${SCOPE.appId}/builds`, [buildFixture()]);

    const { client, server } = await connect(api, { appStoreSku: SCOPE.appStoreSku });
    const result = await client.callTool({
      name: 'list_builds',
      arguments: { appId: SCOPE.appId },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /1\.2\.3/);

    await client.close();
    await server.close();
  });

  it('does not treat the App Store ID as the App Store Connect app id', async () => {
    // The App Store ID (sku) is not the app id. Configuring it as APPLE_APP_ID
    // must not match an app whose id differs, because that would let a scope
    // widen to an app the operator never named.
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api, { appId: SCOPE.appStoreSku });
    const result = await client.callTool({
      name: 'get_app',
      arguments: { appId: SCOPE.appId },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Access denied/);

    await client.close();
    await server.close();
  });

  it('denies an app whose App Store Connect id is outside the configured scope', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api, { appId: SCOPE.otherAppId });
    const result = await client.callTool({
      name: 'get_app',
      arguments: { appId: SCOPE.appId },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Access denied/);

    await client.close();
    await server.close();
  });

  it('denies an app whose App Store ID is outside the configured scope', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api, { appStoreSku: SCOPE.otherAppStoreSku });
    const result = await client.callTool({
      name: 'get_app',
      arguments: { appId: SCOPE.appId },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Access denied/);

    await client.close();
    await server.close();
  });

  it('denies before reading the protected resource', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onDocument(`/v1/apps/${SCOPE.appId}/builds`, [buildFixture()]);

    const { client, server } = await connect(api, { appId: SCOPE.otherAppId });
    await client.callTool({
      name: 'list_builds',
      arguments: { appId: SCOPE.appId },
    });

    const buildsRequests = api.requests.filter((request) => request.url.includes('/builds'));
    assert.equal(
      buildsRequests.length,
      0,
      'The protected resource must not be read when the app is out of scope',
    );

    await client.close();
    await server.close();
  });

  it('requires every configured scope to match', async () => {
    // A second scope variable cannot widen the first one.
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });

    const { client, server } = await connect(api, {
      appId: SCOPE.appId,
      appStoreSku: SCOPE.otherAppStoreSku,
    });
    const result = await client.callTool({
      name: 'get_app',
      arguments: { appId: SCOPE.appId },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Access denied/);

    await client.close();
    await server.close();
  });

  it('does not query the app list endpoint when the scope is set', async () => {
    const api = new FakeAppStoreApi();
    api.on(`/v1/apps/${SCOPE.appId}`, { data: scopedAppFixture() });
    api.onDocument(`/v1/apps/${SCOPE.appId}/builds`, [buildFixture()]);

    const { client, server } = await connect(api, { bundleId: SCOPE.bundleId });
    await client.callTool({ name: 'list_builds', arguments: { appId: SCOPE.appId } });

    assert.equal(
      api.requests.some((request) => request.url.includes('/v1/apps?')),
      false,
      'The scope check must not enumerate the whole account',
    );

    await client.close();
    await server.close();
  });
});

describe('error handling', () => {
  it('surfaces an App Store Connect API error', async () => {
    const api = new FakeAppStoreApi();
    api.onError('/v1/apps/1234567890', 404, {
      errors: [{ status: '404', title: 'Not found', detail: 'The app does not exist' }],
    });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app',
      arguments: { appId: '1234567890' },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /App Store Connect API error 404/);
    assert.match(textOf(result), /The app does not exist/);

    await client.close();
    await server.close();
  });

  it('reports a missing app without an error', async () => {
    const api = new FakeAppStoreApi();
    api.on('/v1/apps/1234567890', { data: null });

    const { client, server } = await connect(api);
    const result = await client.callTool({
      name: 'get_app',
      arguments: { appId: '1234567890' },
    });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /App not found/);

    await client.close();
    await server.close();
  });

  it('rejects a missing required argument', async () => {
    const api = new FakeAppStoreApi();

    const { client, server } = await connect(api);
    const result = await client.callTool({ name: 'get_app', arguments: {} });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Missing required argument "appId"/);

    await client.close();
    await server.close();
  });

  it('rejects a missing required argument before any request', async () => {
    const api = new FakeAppStoreApi();

    const { client, server } = await connect(api);
    await client.callTool({ name: 'get_app', arguments: {} });

    assert.equal(
      api.requests.length,
      0,
      'A call without its required argument must not reach the API',
    );

    await client.close();
    await server.close();
  });
});

describe('http verb discipline', () => {
  it('uses GET for every request', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps', [appFixture()]);
    api.on('/v1/apps/1234567890', { data: appFixture() });
    api.onDocument('/v1/apps/1234567890/appStoreVersions', [versionFixture()]);
    api.onDocument('/v1/apps/1234567890/builds', [buildFixture()]);
    api.onDocument('/v1/apps/1234567890/betaGroups', [betaGroupFixture()]);
    api.onDocument('/v1/apps/1234567890/customerReviews', [reviewFixture()]);

    const { client, server } = await connect(api);

    await client.callTool({ name: 'list_apps', arguments: {} });
    await client.callTool({ name: 'get_app', arguments: { appId: '1234567890' } });
    await client.callTool({ name: 'list_app_store_versions', arguments: { appId: '1234567890' } });
    await client.callTool({ name: 'list_builds', arguments: { appId: '1234567890' } });
    await client.callTool({ name: 'list_beta_groups', arguments: { appId: '1234567890' } });
    await client.callTool({ name: 'list_customer_reviews', arguments: { appId: '1234567890' } });

    assert.ok(api.verbs.length > 0);
    assert.deepEqual(
      [...new Set(api.verbs)],
      ['GET'],
      `The client used a non-GET verb: ${[...new Set(api.verbs)].join(', ')}`,
    );

    await client.close();
    await server.close();
  });

  it('sends a bearer token on every request', async () => {
    const api = new FakeAppStoreApi();
    api.onDocument('/v1/apps', [appFixture()]);

    const { client, server } = await connect(api);
    await client.callTool({ name: 'list_apps', arguments: {} });

    for (const request of api.requests) {
      assert.match(request.headers.authorization ?? '', /^Bearer /);
    }

    await client.close();
    await server.close();
  });
});
