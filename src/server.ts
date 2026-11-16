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
export const SERVER_VERSION = '0.1.0';

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

    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}
