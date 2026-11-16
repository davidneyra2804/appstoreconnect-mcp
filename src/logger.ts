/**
 * Diagnostics logger.
 *
 * stdout carries the MCP protocol and nothing else, so every diagnostic in
 * this server goes to stderr. Secret values are redacted before they reach a
 * log line.
 */

import { isSecretKey, redactSecret } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for the formatted line. Defaults to stderr. */
  sink?: (line: string) => void;
}

/**
 * Format a value for a log line, redacting secrets.
 *
 * Objects are summarised key by key: any key that looks like a secret has its
 * value replaced by a fingerprint, and long strings are truncated so that a
 * private key pasted into an error message cannot leak in full.
 */
export function formatForLog(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') {
    return truncate(redactText(value));
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Error) {
    return `${value.name}: ${truncate(redactText(value.message))}`;
  }

  if (depth >= 3) return '[deep]';

  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map((item) => formatForLog(item, depth + 1));
    if (value.length > 10) items.push(`…(+${value.length - 10})`);
    return `[${items.join(', ')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, val]) => {
      if (isSecretKey(key)) {
        return `${key}=${typeof val === 'string' ? redactSecret(val) : '<redacted>'}`;
      }
      return `${key}=${formatForLog(val, depth + 1)}`;
    });
    return `{${entries.join(', ')}}`;
  }

  return truncate(String(value));
}

const MAX_LOG_STRING = 512;

/**
 * Patterns for secret material that can appear inside free text, such as an
 * error message that echoes a request body or a key.
 *
 * A PEM block is replaced as a whole. The remaining patterns cover the
 * common single-line forms.
 */
const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  {
    // A full PEM private key block, including the base64 body.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '<redacted pem-block>',
  },
  {
    // A PEM block that was never closed.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g,
    replacement: '<redacted pem-block>',
  },
  {
    // An auth scheme and its credential, e.g. "Bearer eyJ..." or
    // "Basic dXNlcjpwYXNz". This runs before the generic key/value rule so
    // that the whole credential is replaced, not just the scheme word.
    pattern: /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: '$1 <redacted>',
  },
  {
    // A JSON:API-style "privateKey": "..." pair.
    //
    // The value is consumed up to a delimiter. A value that starts with an
    // auth scheme word is left to the rule above, because replacing only the
    // word would leave the credential itself exposed.
    pattern:
      /("?(?:private_?key|token|secret|password|authorization)"?\s*[:=]\s*"?)(?!(?:Bearer|Basic|Digest|Token)\b)[^"',\s}]+/gi,
    replacement: '$1<redacted>',
  },
];

/**
 * Remove secret material from a free-text string.
 *
 * Applied to every string that reaches a log line, so a secret that is
 * embedded in an error message cannot leak.
 */
export function redactText(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function truncate(value: string): string {
  if (value.length <= MAX_LOG_STRING) return value;
  return `${value.slice(0, MAX_LOG_STRING)}…(+${value.length - MAX_LOG_STRING} chars)`;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
  }

  debug(message: string, context?: unknown): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: unknown): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: unknown): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: unknown): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const suffix = context === undefined ? '' : ` ${formatForLog(context)}`;
    this.sink(`[${level}] ${message}${suffix}`);
  }
}

export const logger = new Logger();
