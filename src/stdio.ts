#!/usr/bin/env node
/**
 * STDIO entrypoint for local MCP clients (Claude Desktop, Claude Code, Cursor, ...).
 *
 * The MCP protocol owns stdout: only JSON-RPC frames are written there.
 * Every diagnostic, log line and warning goes to stderr.
 *
 * The stdout redirect is installed before any other module is imported, so a
 * dependency that logs on import cannot corrupt the protocol stream.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { Logger } from './logger.js';
import { createMcpServer } from './server.js';

/**
 * Redirect the console write methods to stderr.
 *
 * `console.log`, `console.info` and `console.debug` all target stdout by
 * default, which would inject non-protocol text into the JSON-RPC stream.
 */
function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
}

redirectConsoleToStderr();

const logger = new Logger();

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // The failure is reported on stderr; stdout stays empty so the client
      // sees a clean stream, not a half-written protocol frame.
      logger.error('Configuration error', { message: error.message });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  logger.info('Starting read-only App Store Connect MCP server', {
    keyId: config.keyId,
    issuerId: config.issuerId,
    bundleScoped: Boolean(config.bundleId),
    appIdScoped: Boolean(config.appId),
    appStoreSkuScoped: Boolean(config.appStoreSku),
  });

  const server = createMcpServer(config, { logger });
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info('Server connected over stdio');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    try {
      await server.close();
    } catch {
      // Closing must never keep the process alive.
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Fatal error', { error });
  process.exit(1);
});
