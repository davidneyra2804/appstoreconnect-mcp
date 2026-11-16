/**
 * The read-only tool inventory.
 *
 * This module is the single source of truth for what the server exposes.
 * Every entry here is a read. No write tool is defined, and the runtime
 * inventory test asserts that the registered set matches this list exactly.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

/**
 * Verb prefixes that indicate a mutating operation. The inventory test
 * fails if any registered tool name uses one of them.
 */
export const WRITE_VERB_PREFIXES = [
  'create',
  'update',
  'delete',
  'remove',
  'add',
  'set',
  'put',
  'post',
  'patch',
  'write',
  'modify',
  'upload',
  'submit',
  'cancel',
  'revoke',
  'rotate',
];

/** Tools that require an `appId` argument. */
export const APP_SCOPED_TOOLS = new Set([
  'get_app',
  'list_app_store_versions',
  'list_builds',
  'list_beta_groups',
  'list_customer_reviews',
]);

/** Maximum number of reviews a single call may return. */
export const MAX_REVIEW_LIMIT = 200;

/** Default number of reviews returned when the caller does not specify one. */
export const DEFAULT_REVIEW_LIMIT = 50;

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_apps',
    description:
      'List the apps visible to the configured App Store Connect account. Read-only. ' +
      'Returns app id, name, bundle id, SKU and App Store state.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_app',
    description:
      'Read one app by its App Store Connect app id. Read-only. ' +
      'Returns the same fields as list_apps for a single app.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The App Store Connect app id (the numeric id in /v1/apps).',
          minLength: 1,
        },
      },
      required: ['appId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_app_store_versions',
    description:
      'List the App Store versions of an app, newest first. Read-only. ' +
      'Returns version string, platform, state, release type and dates.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The App Store Connect app id.',
          minLength: 1,
        },
      },
      required: ['appId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_builds',
    description:
      'List the TestFlight builds of an app, newest upload first. Read-only. ' +
      'Returns version, build number, processing state and upload date.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The App Store Connect app id.',
          minLength: 1,
        },
      },
      required: ['appId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_beta_groups',
    description:
      'List the TestFlight beta groups of an app. Read-only. ' +
      'Returns group name, internal/external flag and public link settings.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The App Store Connect app id.',
          minLength: 1,
        },
      },
      required: ['appId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_customer_reviews',
    description:
      'List the customer reviews of an app, newest first. Read-only. ' +
      'Returns rating, reviewer nickname, territory and review text.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The App Store Connect app id.',
          minLength: 1,
        },
        limit: {
          type: 'number',
          description: `Maximum number of reviews to return (default ${DEFAULT_REVIEW_LIMIT}, maximum ${MAX_REVIEW_LIMIT}).`,
          minimum: 1,
          maximum: MAX_REVIEW_LIMIT,
        },
      },
      required: ['appId'],
      additionalProperties: false,
    },
  },
];

/** The set of tool names this server exposes. */
export const TOOL_NAMES: string[] = TOOLS.map((tool) => tool.name);

/**
 * True when the name looks like a mutating operation.
 *
 * The check is deliberately name-based: a tool that writes is excluded by
 * construction, so a write capability can never enter the inventory.
 */
export function isWriteToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return WRITE_VERB_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
