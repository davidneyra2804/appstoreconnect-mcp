/**
 * MCP server factory.
 *
 * Registers the read-only tool inventory and dispatches tool calls to the
 * App Store Connect client. Every tool in the registry comes from `TOOLS`
 * in `tools.ts`; the runtime inventory test proves that the registered set is
 * exactly that list and that no write tool is present.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import {
  AppStoreApiException,
  AppStoreConnectClient,
  ToolInputError,
  type ClientOptions,
} from './appstore-client.js';
import type { AppStoreConfig } from './config.js';
import { Logger } from './logger.js';
import { checkAppScope, requiresAppScope, validateToolArguments } from './scope.js';
import { formatProceeds } from './sales-report.js';
import {
  DEFAULT_REVIEW_LIMIT,
  MAX_REVIEW_LIMIT,
  TOOLS,
  type ToolDefinition,
} from './tools.js';

export const SERVER_NAME = 'appstoreconnect-mcp-readonly';

/**
 * Version reported in the MCP handshake.
 *
 * It is read from package.json instead of being written here, so the server
 * always announces the version that was actually published. A hardcoded
 * constant drifts: the package version moves with every release and the
 * server would keep announcing the version of the first one.
 *
 * package.json sits one level above dist/, both in the repository and in the
 * published package, so it is resolved relative to this module.
 */
export const SERVER_VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require('../package.json') as { version?: unknown };
    if (typeof manifest.version === 'string' && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // The manifest is missing or unreadable: fall through to the fallback.
  }
  return '0.0.0-unknown';
}

export interface ServerOptions extends ClientOptions {
  logger?: Logger;
}

/**
 * Build the MCP server with the read-only tool inventory.
 */
export function createMcpServer(
  config: AppStoreConfig,
  options: ServerOptions = {},
): Server {
  const logger = options.logger ?? new Logger();
  const client = new AppStoreConnectClient(config, { ...options, logger });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Listing tools', { count: TOOLS.length });
    return {
      tools: TOOLS.map((tool: ToolDefinition) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    logger.info('Tool call', { tool: name });

    try {
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new ToolInputError(`Unknown tool: ${name}`);
      }

      validateToolArguments(
        name,
        tool.inputSchema.properties,
        args,
        tool.inputSchema.required ?? [],
      );
      validateToolRangeArguments(name, args);

      const result = await dispatch(name, args, client, config, logger);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof ToolInputError) {
        logger.warn('Rejected tool call', { tool: name, reason: error.message });
        return {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        };
      }

      if (error instanceof AppStoreApiException) {
        logger.warn('App Store Connect error', { tool: name, status: error.status });
        return {
          content: [
            {
              type: 'text',
              text: `App Store Connect API error ${error.status}: ${error.detail}`,
            },
          ],
          isError: true,
        };
      }

      logger.error('Tool call failed', { tool: name, error });
      return {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Validate the numeric range of the arguments of a tool call.
 *
 * Range checks run before any request leaves the process, so an invalid
 * argument never produces a network call.
 */
function validateToolRangeArguments(toolName: string, args: Record<string, unknown>): void {
  if (toolName === 'list_customer_reviews') {
    const limit = args.limit;
    if (limit === undefined || limit === null) return;

    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_REVIEW_LIMIT
    ) {
      throw new ToolInputError(
        `Argument "limit" of tool "list_customer_reviews" must be an integer between 1 and ${MAX_REVIEW_LIMIT}.`,
      );
    }

    return;
  }

  if (toolName === 'get_sales_report') {
    const date = args.date;
    if (date === undefined || date === null) return;

    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ToolInputError(
        'Argument "date" of tool "get_sales_report" must be a date in YYYY-MM-DD format.',
      );
    }

    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || formatDate(parsed) !== date) {
      throw new ToolInputError(
        `Argument "date" of tool "get_sales_report" is not a real calendar date: "${date}".`,
      );
    }

    const today = formatDate(new Date());
    if (date > today) {
      throw new ToolInputError(
        `Argument "date" of tool "get_sales_report" is in the future ("${date}"). ` +
          'Apple has no report for a date that has not happened.',
      );
    }
  }
}

/** Format a date as `YYYY-MM-DD` in UTC. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The default report date: yesterday.
 *
 * Apple generates the daily sales report during the following day, so a
 * report for today does not exist yet.
 */
function defaultReportDate(now: Date = new Date()): string {
  return formatDate(new Date(now.getTime() - 86_400_000));
}

/**
 * Resolve the app for an app-scoped call and check it against the configured
 * scope before any further request is made.
 *
 * When no scope is configured, the app record is not fetched at all: there is
 * nothing to check it against, and the extra request would be wasted.
 */
async function resolveScopedApp(
  appId: string,
  client: AppStoreConnectClient,
  config: AppStoreConfig,
): Promise<void> {
  if (!config.bundleId && !config.appId && !config.appStoreSku) {
    return;
  }

  const app = await client.getApp(appId);
  const decision = checkAppScope(appId, app, config);

  if (!decision.allowed) {
    throw new ToolInputError(
      `Access denied: ${decision.reason} The server is restricted to the configured app scope.`,
    );
  }
}

/** Execute a validated tool call and render the result as text. */
async function dispatch(
  name: string,
  args: Record<string, unknown>,
  client: AppStoreConnectClient,
  config: AppStoreConfig,
  logger: Logger,
): Promise<string> {
  if (requiresAppScope(name)) {
    const appId = String(args.appId);
    await resolveScopedApp(appId, client, config);
  }

  switch (name) {
    case 'list_apps': {
      const apps = await client.listApps();
      if (apps.length === 0) return 'No apps are visible to this account.';
      const lines = apps.map(
        (app) =>
          `• ${app.name} (${app.bundleId})\n  App id: ${app.id}\n  App Store id: ${app.sku ?? 'N/A'}\n  State: ${app.appStoreState ?? 'N/A'}\n  Locale: ${app.primaryLocale ?? 'N/A'}`,
      );
      return `${apps.length} app(s):\n\n${lines.join('\n\n')}`;
    }

    case 'get_app': {
      const appId = String(args.appId);
      const app = await client.getApp(appId);
      if (!app) return `App not found: ${appId}`;
      return [
        `Name: ${app.name}`,
        `Bundle id: ${app.bundleId}`,
        `App id: ${app.id}`,
        `App Store id: ${app.sku ?? 'N/A'}`,
        `State: ${app.appStoreState ?? 'N/A'}`,
        `Locale: ${app.primaryLocale ?? 'N/A'}`,
      ].join('\n');
    }

    case 'list_app_store_versions': {
      const appId = String(args.appId);
      const versions = await client.listAppStoreVersions(appId);
      if (versions.length === 0) return `No App Store versions found for app ${appId}.`;
      const lines = versions.map(
        (version) =>
          `• ${version.versionString} (${version.platform ?? 'N/A'})\n  Id: ${version.id}\n  State: ${version.appStoreState ?? 'N/A'}\n  Release type: ${version.releaseType ?? 'N/A'}\n  Created: ${version.createdDate ?? 'N/A'}`,
      );
      return `${versions.length} App Store version(s) for app ${appId}:\n\n${lines.join('\n\n')}`;
    }

    case 'list_builds': {
      const appId = String(args.appId);
      const builds = await client.listBuilds(appId);
      if (builds.length === 0) return `No TestFlight builds found for app ${appId}.`;
      const lines = builds.map(
        (build) =>
          `• ${build.version} (${build.buildNumber ?? 'N/A'})\n  Id: ${build.id}\n  Processing: ${build.processingState ?? 'N/A'}\n  Uploaded: ${build.uploadedDate ?? 'N/A'}\n  Expired: ${build.expired ? 'yes' : 'no'}`,
      );
      return `${builds.length} TestFlight build(s) for app ${appId}:\n\n${lines.join('\n\n')}`;
    }

    case 'list_beta_groups': {
      const appId = String(args.appId);
      const groups = await client.listBetaGroups(appId);
      if (groups.length === 0) return `No beta groups found for app ${appId}.`;
      const lines = groups.map(
        (group) =>
          `• ${group.name}\n  Id: ${group.id}\n  Type: ${group.isInternalGroup ? 'Internal' : 'External'}\n  Public link: ${group.publicLinkEnabled ? (group.publicLink ?? 'enabled') : 'disabled'}\n  Tester limit: ${group.publicLinkLimitEnabled ? (group.publicLinkLimit ?? 'N/A') : 'unlimited'}`,
      );
      return `${groups.length} beta group(s) for app ${appId}:\n\n${lines.join('\n\n')}`;
    }

    case 'list_customer_reviews': {
      const appId = String(args.appId);
      const requested = args.limit === undefined ? DEFAULT_REVIEW_LIMIT : Number(args.limit);
      const reviews = await client.listCustomerReviews(appId, requested);
      if (reviews.length === 0) return `No customer reviews found for app ${appId}.`;
      const lines = reviews.map(
        (review) =>
          `• ${review.rating ?? '?'}/5 ${review.title ?? '(untitled)'}\n  Id: ${review.id}\n  Reviewer: ${review.reviewerNickname ?? 'N/A'}\n  Territory: ${review.territory ?? 'N/A'}\n  Date: ${review.createdDate ?? 'N/A'}${review.body ? `\n  Text: ${review.body.slice(0, 300)}` : ''}`,
      );
      logger.debug('Rendered reviews', { count: reviews.length, limit: requested });
      return `${reviews.length} customer review(s) for app ${appId}:\n\n${lines.join('\n\n')}`;
    }

    case 'get_sales_report': {
      const appId = String(args.appId);
      const date = args.date === undefined ? defaultReportDate() : String(args.date);
      const report = await client.getSalesReport(date);

      if (report.status === 'not_generated') {
        return (
          `The sales report for ${report.date} has not been generated yet. ` +
          'Apple produces the daily sales report during the following day.'
        );
      }

      if (report.status === 'no_sales') {
        return `The sales report for ${report.date} contains no sales.`;
      }

      // The report belongs to the vendor account and lists every app of that
      // account. Only the rows of the app in scope are reported, so a scoped
      // read never discloses the sales of another app.
      const scoped = report.byApp.filter((row) => row.sku === appId);

      if (report.byApp.length > 0 && scoped.length === 0) {
        return (
          `The sales report for ${report.date} contains no sales for app ${appId}. ` +
          `The report lists ${report.byApp.length} app(s) of the vendor account, ` +
          'and none of them is the requested app.'
        );
      }

      const units = scoped.reduce((sum, row) => sum + row.units, 0);
      const proceeds: Record<string, number> = {};

      for (const row of scoped) {
        for (const [currency, amount] of Object.entries(row.proceeds)) {
          proceeds[currency] = (proceeds[currency] ?? 0) + amount;
        }
      }

      const lines = [
        `Date: ${report.date}`,
        `Units: ${units}`,
        `Developer proceeds: ${formatProceeds(proceeds)}`,
        `Rows in report: ${report.rowCount}`,
      ];

      if (report.byApp.length > 1) {
        lines.push(
          `Note: the report covers ${report.byApp.length} apps of the vendor account. ` +
            'The units and the proceeds above are for the requested app only.',
        );
      }

      return lines.join('\n');
    }

    case 'get_app_info_details': {
      const appId = String(args.appId);
      const infos = await client.getAppInfos(appId);
      if (infos.length === 0) return `No App Store info found for app ${appId}.`;

      const blocks = infos.map((info) => {
        const lines = [
          `Info id: ${info.id}`,
          `App Store state: ${info.appStoreState ?? 'N/A'}`,
          `State: ${info.state ?? 'N/A'}`,
          `Age rating: ${info.appStoreAgeRating ?? 'N/A'}`,
          `Category: ${info.primaryCategory ?? 'N/A'}`,
        ];

        const subcategory = info.primarySubcategoryOne;
        if (subcategory) lines.push(`Subcategory: ${subcategory}`);

        const secondary = info.secondaryCategory;
        if (secondary) lines.push(`Secondary category: ${secondary}`);

        const ratings = [
          ['Australia', info.australiaAgeRating],
          ['Brazil', info.brazilAgeRating],
          ['France', info.franceAgeRating],
          ['Korea', info.koreaAgeRating],
        ].filter(([, value]) => value !== null);

        if (ratings.length > 0) {
          lines.push(
            `Territory ratings: ${ratings
              .map(([country, value]) => `${country} ${value}`)
              .join(', ')}`,
          );
        }

        if (info.localizations.length === 0) {
          lines.push('Localizations: none');
        } else {
          lines.push(`Localizations (${info.localizations.length}):`);
          for (const localization of info.localizations) {
            lines.push(
              `  • ${localization.locale ?? 'N/A'}: ${localization.name ?? 'N/A'}` +
                (localization.subtitle ? ` — ${localization.subtitle}` : ''),
            );
          }
        }

        return lines.join('\n');
      });

      return `${infos.length} App Store info(s) for app ${appId}:\n\n${blocks.join('\n\n')}`;
    }

    case 'get_app_pricing': {
      const appId = String(args.appId);
      const pricePoints = await client.getAppPricePoints(appId);
      if (pricePoints.length === 0) {
        return `No price points found for app ${appId}. ` +
          'An app that has never been priced has no price point.';
      }

      const lines = pricePoints.map(
        (point) =>
          `• ${point.territory ?? 'N/A'}${point.territoryCurrency ? ` (${point.territoryCurrency})` : ''}\n` +
          `  Customer price: ${point.customerPrice ?? 'N/A'}\n` +
          `  Developer proceeds: ${point.proceeds ?? 'N/A'}`,
      );

      return `${pricePoints.length} price point(s) for app ${appId}:\n\n${lines.join('\n\n')}`;
    }

    case 'get_app_availability': {
      const appId = String(args.appId);
      const availabilities = await client.getAppAvailability(appId);
      if (availabilities.length === 0) {
        return `No availability found for app ${appId}.`;
      }

      const blocks = availabilities.map((availability) => {
        const lines = [
          `Availability id: ${availability.id}`,
          `Available in new territories: ${availability.availableInNewTerritories ? 'yes' : 'no'}`,
        ];

        if (availability.territories.length === 0) {
          lines.push('Territories: none');
        } else {
          const available = availability.territories.filter((territory) => territory.available);
          lines.push(
            `Territories: ${availability.territories.length} listed, ${available.length} available`,
          );

          for (const territory of availability.territories) {
            const details = [
              territory.available ? 'available' : 'not available',
              territory.releaseDate ? `released ${territory.releaseDate}` : null,
              territory.preOrderEnabled ? 'pre-order' : null,
              territory.contentStatuses.length > 0
                ? territory.contentStatuses.join(', ')
                : null,
            ].filter((value): value is string => value !== null);

            lines.push(`  • ${territory.territory ?? 'N/A'}: ${details.join(', ')}`);
          }
        }

        return lines.join('\n');
      });

      return `Availability for app ${appId}:\n\n${blocks.join('\n\n')}`;
    }

    case 'get_in_app_purchases': {
      const appId = String(args.appId);
      const purchases = await client.getInAppPurchases(appId);
      if (purchases.length === 0) {
        return `No in-app purchases found for app ${appId}.`;
      }

      const lines = purchases.map(
        (purchase) =>
          `• ${purchase.name ?? 'N/A'}\n` +
          `  Id: ${purchase.id}\n` +
          `  Product id: ${purchase.productId ?? 'N/A'}\n` +
          `  Type: ${purchase.inAppPurchaseType ?? 'N/A'}\n` +
          `  State: ${purchase.state ?? 'N/A'}` +
          (purchase.familySharable ? '\n  Family sharable: yes' : ''),
      );

      return `${purchases.length} in-app purchase(s) for app ${appId}:\n\n${lines.join('\n\n')}`;
    }

    case 'get_analytics': {
      const appId = String(args.appId);
      const requests = await client.getAnalyticsReportRequests(appId);
      if (requests.length === 0) {
        return (
          `No analytics report requests found for app ${appId}. ` +
          'Report requests are created in App Store Connect; this server only reads them.'
        );
      }

      const blocks = requests.map((request) => {
        const lines = [
          `Request id: ${request.id}`,
          `Access type: ${request.accessType ?? 'N/A'}`,
          `Stopped due to inactivity: ${request.stoppedDueToInactivity ? 'yes' : 'no'}`,
        ];

        if (request.reports.length === 0) {
          lines.push('Reports: none');
        } else {
          lines.push(`Reports (${request.reports.length}):`);
          for (const report of request.reports) {
            lines.push(`  • ${report.name ?? 'N/A'} [${report.category ?? 'N/A'}]`);
          }
        }

        return lines.join('\n');
      });

      return `${requests.length} analytics report request(s) for app ${appId}:\n\n${blocks.join('\n\n')}`;
    }

    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}
