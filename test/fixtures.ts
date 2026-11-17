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

  /**
   * Register a JSON:API document with related resources.
   *
   * The related resources travel in the `included` array of the same
   * response, which is how Apple returns a territory, a localization or a
   * report next to the resource that points at it.
   */
  onDocumentWithIncluded(
    pathPrefix: string,
    data: unknown[],
    included: unknown[],
    options: { next?: string } = {},
  ): this {
    this.routes.set(pathPrefix, () => ({
      data,
      included,
      links: options.next ? { next: options.next } : {},
    }));
    return this;
  }

  /** Register an error response for a path prefix. */
  onError(pathPrefix: string, status: number, body: unknown): this {
    this.routes.set(pathPrefix, () => ({ __status: status, __body: body }));
    return this;
  }

  /**
   * Register a binary response for a path prefix.
   *
   * The sales report is served as a gzipped TSV, so it cannot travel through
   * the JSON helper.
   */
  onBinary(pathPrefix: string, body: Uint8Array | Buffer, contentType: string): this {
    this.routes.set(pathPrefix, () => ({ __binary: body, __contentType: contentType }));
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
    if (result && typeof result === 'object' && '__binary' in result) {
      const binary = result as { __binary: Uint8Array | Buffer; __contentType: string };
      return new Response(binary.__binary, {
        status: 200,
        headers: { 'content-type': binary.__contentType },
      });
    }

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

/**
 * Deterministic identifiers for the scope fixtures.
 *
 * The App Store Connect app id and the customer-facing App Store ID (sku) are
 * deliberately different values, so a test that compares the wrong one against
 * the wrong scope fails instead of passing by accident.
 */
export const SCOPE = {
  /** App Store Connect app id: the opaque `id` of the apps resource. */
  appId: '1234567890',
  /** Customer-facing App Store ID: the `sku` attribute of the apps resource. */
  appStoreSku: '987654321',
  /** Bundle id of the fixture app. */
  bundleId: 'com.example.fixture',
  /** A second app, outside every scope. */
  otherAppId: '5555555555',
  otherAppStoreSku: '111222333',
  otherBundleId: 'com.example.other',
} as const;

/**
 * An app fixture whose identifiers match `SCOPE` exactly.
 *
 * Use it to prove that a correctly configured scope permits the app.
 */
export function scopedAppFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return appFixture({
    id: SCOPE.appId,
    attributes: {
      name: 'Fixture App',
      bundleId: SCOPE.bundleId,
      sku: SCOPE.appStoreSku,
      appStoreState: 'READY_FOR_SALE',
      primaryLocale: 'en-US',
    },
    ...overrides,
  });
}

/**
 * An app fixture whose identifiers match none of the scopes.
 */
export function outOfScopeAppFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return appFixture({
    id: SCOPE.otherAppId,
    attributes: {
      name: 'Other App',
      bundleId: SCOPE.otherBundleId,
      sku: SCOPE.otherAppStoreSku,
      appStoreState: 'READY_FOR_SALE',
      primaryLocale: 'en-US',
    },
    ...overrides,
  });
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

/** An app info fixture: the app-level information Apple derives. */
export function appInfoFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'appInfos',
    id: 'ai1',
    attributes: {
      appStoreState: 'READY_FOR_SALE',
      state: 'READY_FOR_SALE',
      appStoreAgeRating: '4+',
      australiaAgeRating: null,
      brazilAgeRating: null,
      brazilAgeRatingV2: null,
      franceAgeRating: null,
      koreaAgeRating: null,
    },
    relationships: {
      primaryCategory: { data: { id: 'cat1', type: 'appCategories' } },
      appInfoLocalizations: { data: [{ id: 'loc1', type: 'appInfoLocalizations' }] },
    },
    ...overrides,
  };
}

/** An app info localization fixture. */
export function appInfoLocalizationFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'appInfoLocalizations',
    id: 'loc1',
    attributes: {
      locale: 'en-US',
      name: 'Fixture App',
      subtitle: 'Does things',
      privacyPolicyUrl: 'https://example.com/privacy',
      privacyPolicyText: null,
      privacyChoicesUrl: null,
    },
    relationships: {
      appInfo: { data: { id: 'ai1', type: 'appInfos' } },
    },
    ...overrides,
  };
}

/** An app category fixture. */
export function appCategoryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'appCategories',
    id: 'cat1',
    attributes: {
      platforms: ['IOS'],
      subcategories: ['GAMES'],
    },
    ...overrides,
  };
}

/** An app price point fixture. */
export function appPricePointFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'appPricePoints',
    id: 'pp1',
    attributes: {
      customerPrice: '0.99',
      proceeds: '0.69',
    },
    relationships: {
      territory: { data: { id: 'USA', type: 'territories' } },
    },
    ...overrides,
  };
}

/** A territory fixture. */
export function territoryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'territories',
    id: 'USA',
    attributes: {
      currency: 'USD',
    },
    ...overrides,
  };
}

/** An app availability fixture. */
export function appAvailabilityFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'appAvailabilities',
    id: 'av1',
    attributes: {
      availableInNewTerritories: false,
    },
    relationships: {
      territoryAvailabilities: {
        data: [{ id: 'ta1', type: 'territoryAvailabilities' }],
      },
    },
    ...overrides,
  };
}

/** A territory availability fixture. */
export function territoryAvailabilityFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'territoryAvailabilities',
    id: 'ta1',
    attributes: {
      available: true,
      releaseDate: '2026-01-10',
      preOrderEnabled: false,
      preOrderPublishDate: null,
      contentStatuses: ['AVAILABLE_FOR_SALE'],
    },
    relationships: {
      territory: { data: { id: 'USA', type: 'territories' } },
      appAvailabilityV2: { data: { id: 'av1', type: 'appAvailabilities' } },
    },
    ...overrides,
  };
}

/** An in-app purchase fixture. */
export function inAppPurchaseFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'inAppPurchasesV2',
    id: 'iap1',
    attributes: {
      name: 'Coins 100',
      productId: 'com.example.fixture.coins100',
      inAppPurchaseType: 'CONSUMABLE',
      state: 'READY_TO_SUBMIT',
      reviewNote: null,
      familySharable: false,
      contentHosting: false,
    },
    ...overrides,
  };
}

/** An analytics report fixture. */
export function analyticsReportFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'analyticsReports',
    id: 'rep1',
    attributes: {
      name: 'App Sessions',
      category: 'APP_USAGE',
    },
    relationships: {
      analyticsReportRequest: { data: { id: 'arr1', type: 'analyticsReportRequests' } },
    },
    ...overrides,
  };
}

/** An analytics report request fixture. */
export function analyticsReportRequestFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'analyticsReportRequests',
    id: 'arr1',
    attributes: {
      accessType: 'ONGOING',
      stoppedDueToInactivity: false,
    },
    relationships: {
      reports: { data: [{ id: 'rep1', type: 'analyticsReports' }] },
    },
    ...overrides,
  };
}
