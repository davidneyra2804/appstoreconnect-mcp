/**
 * Scope enforcement.
 *
 * When the server is configured with `APPLE_BUNDLE_ID` or `APPLE_APP_STORE_ID`,
 * every app-scoped tool is restricted to the account that owns that app. The
 * check happens before any request leaves the process, so a tool call for an
 * app outside the configured scope never reaches the API.
 */

import { ToolInputError } from './appstore-client.js';
import type { AppStoreConfig } from './config.js';
import { APP_SCOPED_TOOLS } from './tools.js';

export interface ScopeDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether an app id may be read under the configured scope.
 *
 * The scope is account-level: the configured bundle id or App Store id
 * identifies one app of the account, so the allowed set is resolved by
 * comparing the app's own identifiers against the scope.
 */
export function checkAppScope(
  appId: string,
  app: { bundleId: string; sku: string | null } | null,
  config: AppStoreConfig,
): ScopeDecision {
  const { bundleId, appStoreId } = config;

  if (!bundleId && !appStoreId) {
    return { allowed: true };
  }

  if (!app) {
    return {
      allowed: false,
      reason:
        'The app could not be resolved, so it cannot be checked against the configured scope.',
    };
  }

  if (bundleId && app.bundleId !== bundleId) {
    return {
      allowed: false,
      reason: `App ${appId} has bundle id "${app.bundleId}", which is outside the configured scope.`,
    };
  }

  if (appStoreId && app.sku !== appStoreId) {
    return {
      allowed: false,
      reason: `App ${appId} has App Store id "${app.sku}", which is outside the configured scope.`,
    };
  }

  return { allowed: true };
}

/**
 * Validate the arguments of a tool call before it reaches the client.
 *
 * Only the properties declared by the tool schema are accepted; an unknown
 * property is an error rather than a silently ignored argument.
 */
export function validateToolArguments(
  toolName: string,
  schemaProperties: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  const known = new Set(Object.keys(schemaProperties));

  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      throw new ToolInputError(
        `Unknown argument "${key}" for tool "${toolName}". Accepted arguments: ${[...known].join(', ') || '(none)'}.`,
      );
    }
  }

  for (const [key, definition] of Object.entries(schemaProperties)) {
    const spec = definition as { type?: string; required?: boolean };
    const value = args[key];

    if (value === undefined || value === null) continue;

    if (spec.type === 'string' && typeof value !== 'string') {
      throw new ToolInputError(`Argument "${key}" of tool "${toolName}" must be a string.`);
    }

    if (spec.type === 'number' && typeof value !== 'number') {
      throw new ToolInputError(`Argument "${key}" of tool "${toolName}" must be a number.`);
    }
  }
}

/**
 * True when the tool operates on a single app and therefore needs the scope
 * check.
 */
export function requiresAppScope(toolName: string): boolean {
  return APP_SCOPED_TOOLS.has(toolName);
}
