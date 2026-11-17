/**
 * Read-only App Store Connect API client.
 *
 * The client can only issue HTTP GET requests. There is no code path that
 * performs a POST, PATCH, PUT or DELETE against the App Store Connect API.
 */

import jwt from 'jsonwebtoken';
import type { AppStoreConfig } from './config.js';
import { Logger } from './logger.js';
import {
  classifyNotFound,
  parseSalesReportGzipped,
  type SalesReportSummary,
} from './sales-report.js';

export const DEFAULT_BASE_URL = 'https://api.appstoreconnect.apple.com';

/** A JSON:API error as returned by Apple. */
export interface AppStoreApiError {
  status: number;
  title: string;
  detail: string;
  code?: string;
}

/** Thrown when the App Store Connect API answers with a non-2xx status. */
export class AppStoreApiException extends Error {
  readonly status: number;
  readonly detail: string;
  readonly code?: string;

  constructor(error: AppStoreApiError) {
    super(`App Store Connect API error ${error.status}: ${error.detail || error.title}`);
    this.name = 'AppStoreApiException';
    this.status = error.status;
    this.detail = error.detail || error.title;
    this.code = error.code;
  }
}

/** Thrown when a tool is called with arguments that fail validation. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * Injectable fetch implementation, so tests can drive the client with
 * fixtures instead of real network calls.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  logger?: Logger;
  /** Lifetime of the signed JWT, in seconds. Apple accepts up to 20 minutes. */
  tokenTtlSeconds?: number;
  /** Maximum number of pages followed by a paginated endpoint. */
  maxPages?: number;
}

export interface AppSummary {
  id: string;
  name: string;
  bundleId: string;
  sku: string | null;
  appStoreState: string | null;
  primaryLocale: string | null;
}

export interface AppStoreVersionSummary {
  id: string;
  versionString: string;
  platform: string | null;
  appStoreState: string | null;
  releaseType: string | null;
  copyright: string | null;
  earliestReleaseDate: string | null;
  createdDate: string | null;
}

export interface BuildSummary {
  id: string;
  version: string;
  buildNumber: string | null;
  processingState: string | null;
  uploadedDate: string | null;
  expired: boolean;
}

export interface BetaGroupSummary {
  id: string;
  name: string;
  isInternalGroup: boolean;
  publicLinkEnabled: boolean;
  publicLink: string | null;
  publicLinkLimitEnabled: boolean;
  publicLinkLimit: number | null;
  createdDate: string | null;
}

export interface ReviewSummary {
  id: string;
  title: string | null;
  rating: number | null;
  reviewerNickname: string | null;
  territory: string | null;
  createdDate: string | null;
  body: string | null;
}

/**
 * The App Store age rating of an app.
 *
 * `appStoreAgeRating` is the rating as Apple publishes it ("4+", "12+").
 * The country-specific ratings are kept apart because they change per
 * territory and a single rating does not describe the whole world.
 */
export interface AppInfoSummary {
  id: string;
  appStoreState: string | null;
  state: string | null;
  appStoreAgeRating: string | null;
  australiaAgeRating: string | null;
  brazilAgeRating: string | null;
  brazilAgeRatingV2: string | null;
  franceAgeRating: string | null;
  koreaAgeRating: string | null;
  primaryCategory: string | null;
  primarySubcategoryOne: string | null;
  primarySubcategoryTwo: string | null;
  secondaryCategory: string | null;
  secondarySubcategoryOne: string | null;
  secondarySubcategoryTwo: string | null;
  localizations: AppInfoLocalizationSummary[];
}

/** A localised name, subtitle and privacy policy of an app info. */
export interface AppInfoLocalizationSummary {
  id: string;
  locale: string | null;
  name: string | null;
  subtitle: string | null;
  privacyPolicyUrl: string | null;
  privacyPolicyText: string | null;
  privacyChoicesUrl: string | null;
}

/** One price point of the app, in one territory. */
export interface AppPricePointSummary {
  id: string;
  customerPrice: string | null;
  proceeds: string | null;
  territory: string | null;
  territoryCurrency: string | null;
}

/** The availability of the app in one territory. */
export interface TerritoryAvailabilitySummary {
  territory: string | null;
  territoryCurrency: string | null;
  available: boolean;
  releaseDate: string | null;
  preOrderEnabled: boolean;
  preOrderPublishDate: string | null;
  contentStatuses: string[];
}

/** The availability record of the app as a whole. */
export interface AppAvailabilitySummary {
  id: string;
  availableInNewTerritories: boolean;
  territories: TerritoryAvailabilitySummary[];
}

/** One in-app purchase or one auto-renewable subscription of the app. */
export interface InAppPurchaseSummary {
  id: string;
  name: string | null;
  productId: string | null;
  inAppPurchaseType: string | null;
  state: string | null;
  reviewNote: string | null;
  familySharable: boolean;
  contentHosting: boolean;
}

/** One analytics report attached to a report request. */
export interface AnalyticsReportSummary {
  id: string;
  name: string | null;
  category: string | null;
}

/** One analytics report request of the app. */
export interface AnalyticsReportRequestSummary {
  id: string;
  accessType: string | null;
  stoppedDueToInactivity: boolean;
  reports: AnalyticsReportSummary[];
}

/** JSON:API document shape returned by Apple. */
interface JsonApiDocument {
  data?: unknown[];
  included?: unknown[];
  links?: { next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export class AppStoreConnectClient {
  private readonly config: AppStoreConfig;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly tokenTtlSeconds: number;
  private readonly maxPages: number;

  constructor(config: AppStoreConfig, options: ClientOptions = {}) {
    this.config = config;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.logger = options.logger ?? new Logger();
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 20 * 60;
    this.maxPages = options.maxPages ?? 10;
  }

  /**
   * Sign the ES256 JWT that Apple expects in the Authorization header.
   * The private key never leaves this function.
   */
  buildToken(now: number = Date.now()): string {
    const issuedAt = Math.floor(now / 1000);
    const payload = {
      iss: this.config.issuerId,
      iat: issuedAt,
      exp: issuedAt + this.tokenTtlSeconds,
      aud: 'appstoreconnect-v1',
    };

    return jwt.sign(payload, this.config.privateKey, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: this.config.keyId, typ: 'JWT' },
    });
  }

  /**
   * Perform a GET request against the App Store Connect API.
   *
   * This is the only request method in this client. There is deliberately no
   * sibling that accepts a non-GET verb.
   */
  private async get(path: string): Promise<JsonApiDocument> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const token = this.buildToken();

    this.logger.debug('GET request', { url });

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const error = await parseErrorResponse(response);
      this.logger.warn('API request failed', { url, status: error.status, code: error.code });
      throw new AppStoreApiException(error);
    }

    return (await response.json()) as JsonApiDocument;
  }

  /**
   * Follow `links.next` until the page budget is exhausted.
   */
  private async getAllPages(path: string): Promise<{ data: unknown[]; included: unknown[] }> {
    const data: unknown[] = [];
    const included: unknown[] = [];
    let next: string | undefined = path;
    let pages = 0;

    while (next && pages < this.maxPages) {
      const doc: JsonApiDocument = await this.get(next);
      if (Array.isArray(doc.data)) data.push(...doc.data);
      if (Array.isArray(doc.included)) included.push(...doc.included);
      next = doc.links?.next;
      pages += 1;
    }

    if (next) {
      this.logger.warn('Page budget reached, result truncated', { maxPages: this.maxPages });
    }

    return { data, included };
  }

  /**
   * Perform a GET request that expects a non-JSON body.
   *
   * The sales report is served as a gzipped TSV, so it cannot go through the
   * JSON reader. The request is still a GET, and the verb discipline of this
   * client is unchanged.
   */
  private async getBinary(path: string, accept: string): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const token = this.buildToken();

    this.logger.debug('GET request (binary)', { url });

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
      },
    });

    return response;
  }

  /**
   * Read the daily sales report for a date.
   *
   * The report belongs to the vendor account, not to a single app, so this
   * call is not app-scoped. The caller is responsible for the scope check.
   *
   * The vendor number is a property of the account, not of the issuer: it is
   * the number shown in App Store Connect under Payments and Financial
   * Reports. It is required, because Apple rejects the request without it.
   */
  async getSalesReport(date: string): Promise<SalesReportSummary> {
    const vendorNumber = this.config.vendorNumber?.trim();
    if (!vendorNumber) {
      throw new ToolInputError(
        'APPLE_VENDOR_NUMBER is not set. It is the vendor number shown in App Store Connect ' +
          'under Payments and Financial Reports, and Apple rejects the sales report request without it.',
      );
    }

    const query = new URLSearchParams({
      'filter[frequency]': 'DAILY',
      'filter[reportType]': 'SALES',
      'filter[reportSubType]': 'SUMMARY',
      'filter[vendorNumber]': vendorNumber,
      'filter[reportDate]': date,
    });

    const response = await this.getBinary(`/v1/salesReports?${query.toString()}`, 'application/a-gzip');

    if (response.status === 404) {
      // Apple answers 404 both for a day without sales and for a report that
      // has not been produced yet. Only the detail tells them apart.
      let detail = '';
      try {
        const body = (await response.json()) as { errors?: { detail?: string }[] };
        detail = body.errors?.[0]?.detail ?? '';
      } catch {
        detail = '';
      }

      const status = classifyNotFound(detail);
      this.logger.info('Sales report not available', { date, status });

      return {
        status,
        date,
        units: 0,
        proceeds: {},
        byApp: [],
        missingColumns: [],
        rowCount: 0,
      };
    }

    if (!response.ok) {
      const error = await parseErrorResponse(response);
      this.logger.warn('Sales report request failed', { date, status: error.status });
      throw new AppStoreApiException(error);
    }

    const body = Buffer.from(await response.arrayBuffer());
    return parseSalesReportGzipped(body, date);
  }

  /** List the apps visible to the configured account. */
  async listApps(): Promise<AppSummary[]> {
    const { data } = await this.getAllPages('/v1/apps?limit=200');
    return data.map(toAppSummary);
  }

  /** Read one app by its App Store Connect identifier. */
  async getApp(appId: string): Promise<AppSummary | null> {
    const doc = await this.get(`/v1/apps/${encodeURIComponent(appId)}`);
    const raw = (doc as { data?: unknown }).data;
    return raw ? toAppSummary(raw) : null;
  }

  /** List the App Store versions of an app, newest first by creation date. */
  async listAppStoreVersions(appId: string): Promise<AppStoreVersionSummary[]> {
    const { data } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?limit=200`,
    );
    return data
      .map(toVersionSummary)
      .sort((a, b) => (b.createdDate ?? '').localeCompare(a.createdDate ?? ''));
  }

  /** List the TestFlight builds of an app. */
  async listBuilds(appId: string): Promise<BuildSummary[]> {
    const { data } = await this.getAllPages(`/v1/apps/${encodeURIComponent(appId)}/builds?limit=200`);
    return data
      .map(toBuildSummary)
      .sort((a, b) => (b.uploadedDate ?? '').localeCompare(a.uploadedDate ?? ''));
  }

  /** List the TestFlight beta groups of an app. */
  async listBetaGroups(appId: string): Promise<BetaGroupSummary[]> {
    const { data } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/betaGroups?limit=200`,
    );
    return data.map(toBetaGroupSummary);
  }

  /** List the customer reviews of an app, newest first. */
  async listCustomerReviews(appId: string, limit: number): Promise<ReviewSummary[]> {
    const { data } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/customerReviews?limit=200`,
    );
    return data
      .map(toReviewSummary)
      .sort((a, b) => (b.createdDate ?? '').localeCompare(a.createdDate ?? ''))
      .slice(0, limit);
  }

  /**
   * Read the App Store info of an app.
   *
   * `GET /v1/apps/{id}/appInfos`. An app has one app info per App Store
   * version: the one that is live and the one that takes effect with the next
   * version. The localizations are requested inline so that the name and the
   * subtitle of every locale arrive in the same call.
   */
  async getAppInfos(appId: string): Promise<AppInfoSummary[]> {
    const { data, included } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/appInfos?include=appInfoLocalizations&limit=200`,
    );

    const localizationsByParent = groupByParent(included, 'appInfoLocalizations', 'appInfo');
    const categoriesById = indexById(included, 'appCategories');

    return data.map((raw) =>
      toAppInfoSummary(raw, localizationsByParent, categoriesById),
    );
  }

  /**
   * Read the price points of an app.
   *
   * `GET /v1/apps/{id}/appPricePoints`. A price point is the price of the
   * app in one territory, so the list holds one entry per territory.
   *
   * The territory is requested inline to show the territory code and its
   * currency next to the price, instead of a bare price with no context.
   */
  async getAppPricePoints(appId: string): Promise<AppPricePointSummary[]> {
    const { data, included } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/appPricePoints?include=territory&limit=200`,
    );

    const territoriesById = indexById(included, 'territories');

    return data.map((raw) => toAppPricePointSummary(raw, territoriesById));
  }

  /**
   * Read the availability of an app.
   *
   * `GET /v1/apps/{id}/appAvailabilityV2`. The availability record of the app
   * carries one territory availability per territory, and they are requested
   * inline so that a single call answers the whole question.
   */
  async getAppAvailability(appId: string): Promise<AppAvailabilitySummary[]> {
    const { data, included } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/appAvailabilityV2` +
        `?include=territoryAvailabilities&limit[territoryAvailabilities]=200`,
    );

    const territoriesById = indexById(included, 'territories');
    const availabilitiesByParent = groupByParent(
      included,
      'territoryAvailabilities',
      'appAvailabilityV2',
    );

    return data.map((raw) =>
      toAppAvailabilitySummary(raw, availabilitiesByParent, territoriesById),
    );
  }

  /**
   * Read the in-app purchases of an app.
   *
   * `GET /v1/apps/{id}/inAppPurchasesV2`. This is the current (v2) endpoint:
   * it covers consumables, non-consumables, non-renewing subscriptions and
   * auto-renewable subscriptions. The legacy `/v1/apps/{id}/inAppPurchases`
   * endpoint only covers the first three, so the v2 one is used instead.
   */
  async getInAppPurchases(appId: string): Promise<InAppPurchaseSummary[]> {
    const { data } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?limit=200`,
    );
    return data.map(toInAppPurchaseSummary);
  }

  /**
   * Read the analytics report requests of an app.
   *
   * `GET /v1/apps/{id}/analyticsReportRequests`.
   *
   * Only the requests that already exist are read. Creating a new report
   * request is a write (`POST /v1/analyticsReportRequests`) and is therefore
   * out of the scope of this read-only server: the tool lists the report
   * requests the account already holds, with the reports each one produced.
   */
  async getAnalyticsReportRequests(appId: string): Promise<AnalyticsReportRequestSummary[]> {
    const { data, included } = await this.getAllPages(
      `/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests` +
        '?include=reports&limit[reports]=200&limit=200',
    );

    const reportsByParent = groupByParent(included, 'analyticsReports', 'analyticsReportRequest');

    return data.map((raw) => toAnalyticsReportRequestSummary(raw, reportsByParent));
  }
}

/**
 * Index the included resources of one type by their id.
 */
function indexById(included: unknown[], type: string): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const item of included) {
    if (typeOf(item) !== type) continue;
    const id = idOf(item);
    if (id) index.set(id, item as Record<string, unknown>);
  }
  return index;
}

/**
 * Group the included resources of one type by the id of their parent.
 *
 * An included resource carries the id of its parent in `relationships`, under
 * the name of that relationship. The name is given by the caller because the
 * same resource type can hang from more than one parent, and picking the
 * first relationship blindly would group by the wrong parent.
 */
function groupByParent(
  included: unknown[],
  type: string,
  parentRelationship: string,
): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const item of included) {
    if (typeOf(item) !== type) continue;
    const parentId = relationshipIdOf(item, parentRelationship);
    if (!parentId) continue;
    const bucket = groups.get(parentId);
    if (bucket) {
      bucket.push(item as Record<string, unknown>);
    } else {
      groups.set(parentId, [item as Record<string, unknown>]);
    }
  }
  return groups;
}

/** The `type` of a JSON:API resource. */
function typeOf(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' ? type : '';
}


function attributesOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const attributes = (raw as { attributes?: unknown }).attributes;
  return attributes && typeof attributes === 'object' ? (attributes as Record<string, unknown>) : {};
}

function idOf(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const id = (raw as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

export function toAppSummary(raw: unknown): AppSummary {
  const a = attributesOf(raw);
  return {
    id: idOf(raw),
    name: str(a.name) ?? '',
    bundleId: str(a.bundleId) ?? '',
    sku: str(a.sku),
    appStoreState: str(a.appStoreState),
    primaryLocale: str(a.primaryLocale),
  };
}

export function toVersionSummary(raw: unknown): AppStoreVersionSummary {
  const a = attributesOf(raw);
  return {
    id: idOf(raw),
    versionString: str(a.versionString) ?? '',
    platform: str(a.platform),
    appStoreState: str(a.appStoreState),
    releaseType: str(a.releaseType),
    copyright: str(a.copyright),
    earliestReleaseDate: str(a.earliestReleaseDate),
    createdDate: str(a.createdDate),
  };
}

export function toBuildSummary(raw: unknown): BuildSummary {
  const a = attributesOf(raw);
  return {
    id: idOf(raw),
    version: str(a.version) ?? '',
    buildNumber: str(a.buildNumber),
    processingState: str(a.processingState),
    uploadedDate: str(a.uploadedDate),
    expired: bool(a.expired),
  };
}

export function toBetaGroupSummary(raw: unknown): BetaGroupSummary {
  const a = attributesOf(raw);
  return {
    id: idOf(raw),
    name: str(a.name) ?? '',
    isInternalGroup: bool(a.isInternalGroup),
    publicLinkEnabled: bool(a.publicLinkEnabled),
    publicLink: str(a.publicLink),
    publicLinkLimitEnabled: bool(a.publicLinkLimitEnabled),
    publicLinkLimit: num(a.publicLinkLimit),
    createdDate: str(a.createdDate),
  };
}

export function toReviewSummary(raw: unknown): ReviewSummary {
  const a = attributesOf(raw);
  return {
    id: idOf(raw),
    title: str(a.title),
    rating: num(a.rating),
    reviewerNickname: str(a.reviewerNickname),
    territory: str(a.territory),
    createdDate: str(a.createdDate),
    body: str(a.body),
  };
}

/**
 * The id of the resource a relationship points to.
 *
 * A relationship without a linked resource holds `data: null`, so the id is
 * empty rather than a placeholder. A to-many relationship holds a list, and
 * its first id is used.
 */
function relationshipIdOf(raw: unknown, name: string): string {
  if (!raw || typeof raw !== 'object') return '';
  const relationships = (raw as { relationships?: unknown }).relationships;
  if (!relationships || typeof relationships !== 'object') return '';

  const relationship = (relationships as Record<string, unknown>)[name];
  if (!relationship || typeof relationship !== 'object') return '';

  const data = (relationship as { data?: unknown }).data;

  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
    return '';
  }

  if (!data || typeof data !== 'object') return '';

  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

/**
 * Read the name of a linked category.
 *
 * The category is a related resource: it arrives in the `included` array of
 * the same response. When it was not included, the id is returned instead,
 * because an id still identifies the category even when its name is unknown.
 */
function linkedName(
  index: Map<string, Record<string, unknown>>,
  id: string,
): string | null {
  if (!id) return null;

  const linked = index.get(id);
  if (!linked) return id;

  const attributes = attributesOf(linked);
  return str(attributes.name) ?? str(attributes.platforms) ?? id;
}

export function toAppInfoSummary(
  raw: unknown,
  localizationsByParent: Map<string, Record<string, unknown>[]>,
  categoriesById: Map<string, Record<string, unknown>>,
): AppInfoSummary {
  const a = attributesOf(raw);
  const id = idOf(raw);

  const localizations = (localizationsByParent.get(id) ?? []).map((item) => {
    const la = attributesOf(item);
    return {
      id: idOf(item),
      locale: str(la.locale),
      name: str(la.name),
      subtitle: str(la.subtitle),
      privacyPolicyUrl: str(la.privacyPolicyUrl),
      privacyPolicyText: str(la.privacyPolicyText),
      privacyChoicesUrl: str(la.privacyChoicesUrl),
    } satisfies AppInfoLocalizationSummary;
  });

  return {
    id,
    appStoreState: str(a.appStoreState),
    state: str(a.state),
    appStoreAgeRating: str(a.appStoreAgeRating),
    australiaAgeRating: str(a.australiaAgeRating),
    brazilAgeRating: str(a.brazilAgeRating),
    brazilAgeRatingV2: str(a.brazilAgeRatingV2),
    franceAgeRating: str(a.franceAgeRating),
    koreaAgeRating: str(a.koreaAgeRating),
    primaryCategory: linkedName(categoriesById, relationshipIdOf(raw, 'primaryCategory')),
    primarySubcategoryOne: linkedName(
      categoriesById,
      relationshipIdOf(raw, 'primarySubcategoryOne'),
    ),
    primarySubcategoryTwo: linkedName(
      categoriesById,
      relationshipIdOf(raw, 'primarySubcategoryTwo'),
    ),
    secondaryCategory: linkedName(
      categoriesById,
      relationshipIdOf(raw, 'secondaryCategory'),
    ),
    secondarySubcategoryOne: linkedName(
      categoriesById,
      relationshipIdOf(raw, 'secondarySubcategoryOne'),
    ),
    secondarySubcategoryTwo: linkedName(
      categoriesById,
      relationshipIdOf(raw, 'secondarySubcategoryTwo'),
    ),
    localizations,
  };
}

export function toAppPricePointSummary(
  raw: unknown,
  territoriesById: Map<string, Record<string, unknown>>,
): AppPricePointSummary {
  const a = attributesOf(raw);
  const territoryId = relationshipIdOf(raw, 'territory');
  const territory = territoriesById.get(territoryId);
  const territoryAttributes = territory ? attributesOf(territory) : {};

  return {
    id: idOf(raw),
    customerPrice: str(a.customerPrice),
    proceeds: str(a.proceeds),
    territory: territoryId || null,
    territoryCurrency: str(territoryAttributes.currency),
  };
}

export function toAppAvailabilitySummary(
  raw: unknown,
  availabilitiesByParent: Map<string, Record<string, unknown>[]>,
  territoriesById: Map<string, Record<string, unknown>>,
): AppAvailabilitySummary {
  const a = attributesOf(raw);
  const id = idOf(raw);

  const territories = (availabilitiesByParent.get(id) ?? []).map((item) => {
    const ta = attributesOf(item);
    const territoryId = relationshipIdOf(item, 'territory');
    const territory = territoriesById.get(territoryId);
    const territoryAttributes = territory ? attributesOf(territory) : {};

    const contentStatuses = ta.contentStatuses;
    return {
      territory: territoryId || null,
      territoryCurrency: str(territoryAttributes.currency),
      available: bool(ta.available),
      releaseDate: str(ta.releaseDate),
      preOrderEnabled: bool(ta.preOrderEnabled),
      preOrderPublishDate: str(ta.preOrderPublishDate),
      contentStatuses: Array.isArray(contentStatuses)
        ? contentStatuses.filter((value): value is string => typeof value === 'string')
        : [],
    } satisfies TerritoryAvailabilitySummary;
  });

  return {
    id,
    availableInNewTerritories: bool(a.availableInNewTerritories),
    territories,
  };
}

export function toInAppPurchaseSummary(raw: unknown): InAppPurchaseSummary {
  const a = attributesOf(raw);
  return {
    id: idOf(raw),
    name: str(a.name),
    productId: str(a.productId),
    inAppPurchaseType: str(a.inAppPurchaseType),
    state: str(a.state),
    reviewNote: str(a.reviewNote),
    familySharable: bool(a.familySharable),
    contentHosting: bool(a.contentHosting),
  };
}

export function toAnalyticsReportRequestSummary(
  raw: unknown,
  reportsByParent: Map<string, Record<string, unknown>[]>,
): AnalyticsReportRequestSummary {
  const a = attributesOf(raw);
  const id = idOf(raw);

  const reports = (reportsByParent.get(id) ?? []).map((item) => {
    const ra = attributesOf(item);
    return {
      id: idOf(item),
      name: str(ra.name),
      category: str(ra.category),
    } satisfies AnalyticsReportSummary;
  });

  return {
    id,
    accessType: str(a.accessType),
    stoppedDueToInactivity: bool(a.stoppedDueToInactivity),
    reports,
  };
}

/**
 * Turn an error response into a structured error.
 * The body is truncated: an error page can echo request headers.
 */
async function parseErrorResponse(response: Response): Promise<AppStoreApiError> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }

  try {
    const parsed = JSON.parse(raw) as {
      errors?: { status?: string; title?: string; detail?: string; code?: string }[];
    };
    const first = parsed.errors?.[0];
    if (first) {
      return {
        status: Number(first.status ?? response.status),
        title: first.title ?? response.statusText,
        detail: first.detail ?? '',
        code: first.code,
      };
    }
  } catch {
    // Not a JSON error body; fall through to the generic form.
  }

  return {
    status: response.status,
    title: response.statusText || 'Request failed',
    detail: raw.slice(0, 300),
  };
}
