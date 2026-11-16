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
