/**
 * Test fixtures: a fake App Store Connect API and a throwaway ES256 key.
 *
 * No real Apple credentials are used anywhere in this suite.
 */

import { generateKeyPairSync } from 'node:crypto';

/**
 * Generate an ES256 key pair for signing test JWTs.
 * The private key is ephemeral and exists only in memory for the test run.
 */
export function makeTestKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** A recorded request against the fake API. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * A fake App Store Connect API.
 *
 * Routes are matched on the path of the request URL. Every recorded request
 * is kept so that a test can assert the HTTP verb used.
 */
export class FakeAppStoreApi {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Map<string, (url: URL) => unknown> = new Map();

  /** Register a JSON body for a path prefix. */
  on(pathPrefix: string, body: unknown): this {
    this.routes.set(pathPrefix, () => body);
    return this;
  }

  /** Register a JSON:API document for a path prefix. */
  onDocument(pathPrefix: string, data: unknown[], options: { next?: string } = {}): this {
    this.routes.set(pathPrefix, () => ({
      data,
      links: options.next ? { next: options.next } : {},
    }));
    return this;
  }

  /** Register an error response for a path prefix. */
  onError(pathPrefix: string, status: number, body: unknown): this {
    this.routes.set(pathPrefix, () => ({ __status: status, __body: body }));
    return this;
  }

  /** The fetch implementation to inject into the client. */
  get fetch(): (url: string, init: RequestInit) => Promise<Response> {
    return async (url, init) => {
      const parsed = new URL(url);
      const headers: Record<string, string> = {};

      for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }

      this.requests.push({ url, method: init.method ?? 'GET', headers });

      for (const [prefix, handler] of this.routes) {
        // Match the exact path first, then fall back to a prefix match.
        // The order matters: "/v1/apps/1" must not shadow
        // "/v1/apps/1/builds".
        if (parsed.pathname === prefix) {
          return this.respond(handler(parsed), prefix);
        }
      }

      for (const [prefix, handler] of this.routes) {
        if (parsed.pathname.startsWith(`${prefix}/`)) {
          return this.respond(handler(parsed), prefix);
        }
      }

      return new Response(
        JSON.stringify({
          errors: [{ status: '404', title: 'Not found', detail: `No fixture for ${parsed.pathname}` }],
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    };
  }

  /** Build the Response for a matched route. */
  private respond(result: unknown, _prefix: string): Response {
    if (result && typeof result === 'object' && '__status' in result) {
      const error = result as { __status: number; __body?: unknown };
      return new Response(JSON.stringify(error.__body), {
        status: error.__status,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** All recorded HTTP verbs. */
  get verbs(): string[] {
    return this.requests.map((request) => request.method);
  }
}

/** An app fixture. */
export function appFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'apps',
    id: '1234567890',
    attributes: {
      name: 'Fixture App',
      bundleId: 'com.example.fixture',
      sku: '123456789',
      appStoreState: 'READY_FOR_SALE',
      primaryLocale: 'en-US',
    },
    ...overrides,
  };
}

/** A version fixture. */
export function versionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'appStoreVersions',
    id: 'v1',
    attributes: {
      versionString: '1.2.3',
      platform: 'IOS',
      appStoreState: 'READY_FOR_SALE',
      releaseType: 'MANUAL',
      copyright: '2026 Example',
      earliestReleaseDate: null,
      createdDate: '2026-01-15T10:00:00Z',
    },
    ...overrides,
  };
}

/** A build fixture. */
export function buildFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'builds',
    id: 'b1',
    attributes: {
      version: '1.2.3',
      buildNumber: '42',
      processingState: 'VALID',
      uploadedDate: '2026-02-01T09:00:00Z',
      expired: false,
    },
    ...overrides,
  };
}

/** A beta group fixture. */
export function betaGroupFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'betaGroups',
    id: 'g1',
    attributes: {
      name: 'External Testers',
      isInternalGroup: false,
      publicLinkEnabled: true,
      publicLink: 'https://testflight.apple.com/join/abc',
      publicLinkLimitEnabled: true,
      publicLinkLimit: 100,
      createdDate: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

/** A review fixture. */
export function reviewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'customerReviews',
    id: 'r1',
    attributes: {
      title: 'Great app',
      rating: 5,
      reviewerNickname: 'reviewer',
      territory: 'USA',
      createdDate: '2026-03-01T12:00:00Z',
      body: 'Works well.',
    },
    ...overrides,
  };
}
