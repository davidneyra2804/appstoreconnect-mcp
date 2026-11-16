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

      validateToolArguments(name, tool.inputSchema.properties, args);
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
  if (toolName !== 'list_customer_reviews') return;

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

    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}
