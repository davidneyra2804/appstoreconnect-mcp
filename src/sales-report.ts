/**
 * Sales report parsing.
 *
 * Apple's daily sales report is not JSON. It is a gzipped TSV file whose
 * columns are named, and whose rows mix several currencies. This module owns
 * the pure part of the work: turning the decompressed bytes into a summary
 * that keeps every currency separate.
 *
 * Everything here is deterministic and free of I/O, so the suite can drive it
 * with synthetic fixtures and no network.
 */

import { gunzipSync } from 'node:zlib';

/**
 * The column names this parser understands.
 *
 * Apple has changed the exact wording of these headers over time, so each
 * logical field accepts a small set of spellings. A field that cannot be
 * located is reported as missing instead of silently read as zero.
 */
export const SALES_COLUMN_ALIASES = {
  units: ['Units', 'Quantity', 'Units Sold'],
  developerProceeds: ['Developer Proceeds', 'Proceeds'],
  currency: ['Currency of Proceeds', 'Currency', 'Currency Code'],
  title: ['Title', 'App Name', 'App Title'],
  sku: ['SKU', 'Apple Identifier', 'App Store ID'],
  provider: ['Provider', 'Partner'],
  country: ['Country Code', 'Country', 'Region'],
} as const;

export type SalesField = keyof typeof SALES_COLUMN_ALIASES;

/** The distinct outcomes of asking for a report of a given date. */
export type SalesReportStatus =
  /** Apple returned the report. It may still contain zero sales. */
  | 'available'
  /** Apple has not generated the report for that date yet. */
  | 'not_generated'
  /** The report exists but contains no sales at all. */
  | 'no_sales';

export interface SalesAppRow {
  title: string;
  sku: string;
  units: number;
  /**
   * Developer proceeds of this app, per currency.
   *
   * The account summary and this map always agree: they are built from the
   * same rows, so a caller can attribute proceeds to one app without
   * guessing.
   */
  proceeds: Record<string, number>;
}

export interface SalesReportSummary {
  status: SalesReportStatus;
  /** The report date, as `YYYY-MM-DD`. */
  date: string;
  /** Total units across every row of the report. */
  units: number;
  /**
   * Developer proceeds per currency.
   *
   * Amounts are never summed across currencies: one key per currency code.
   */
  proceeds: Record<string, number>;
  /** Rows grouped by app, heaviest first. */
  byApp: SalesAppRow[];
  /** The columns this parser could not locate in the header. */
  missingColumns: SalesField[];
  /** The number of data rows that were read. */
  rowCount: number;
}

/** Thrown when the report body cannot be decoded as a sales report. */
export class SalesReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SalesReportParseError';
  }
}

/**
 * Decompress a gzipped report body.
 *
 * Apple serves the report as `application/a-gzip`. Some accounts receive an
 * uncompressed body, so an already-plain payload is accepted as-is instead of
 * failing the read.
 */
export function decompressReport(body: Uint8Array | Buffer): Buffer {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);

  // gzip magic number: 0x1f 0x8b
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return gunzipSync(buffer);
    } catch (error) {
      throw new SalesReportParseError(
        `The sales report could not be decompressed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return buffer;
}

/**
 * Split a TSV document into its header row and its data rows.
 *
 * Apple terminates the file with a newline, which would otherwise produce a
 * trailing empty row.
 */
export function splitTsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new SalesReportParseError('The sales report is empty.');
  }

  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((line) => line.split('\t'));

  return { header, rows };
}

/**
 * Locate a logical field in the header.
 *
 * The match is exact first, then case-insensitive, so a header that differs
 * only in casing is still recognised.
 */
export function findColumn(header: string[], field: SalesField): number {
  const aliases = SALES_COLUMN_ALIASES[field] as readonly string[];

  for (const alias of aliases) {
    const exact = header.indexOf(alias);
    if (exact !== -1) return exact;
  }

  const lowered = header.map((name) => name.trim().toLowerCase());
  for (const alias of aliases) {
    const index = lowered.indexOf(alias.trim().toLowerCase());
    if (index !== -1) return index;
  }

  return -1;
}

/**
 * Resolve every logical field against a header.
 *
 * The result maps each field to its column index, or to `-1` when the column
 * is absent.
 */
export function resolveColumns(header: string[]): Record<SalesField, number> {
  const resolved = {} as Record<SalesField, number>;

  for (const field of Object.keys(SALES_COLUMN_ALIASES) as SalesField[]) {
    resolved[field] = findColumn(header, field);
  }

  return resolved;
}

/**
 * Read a numeric cell.
 *
 * Apple writes plain decimals with a dot. A value that carries a comma and a
 * dot is read as a thousands-separated number, and a value that carries only
 * a comma is read as a decimal comma, so a European-formatted amount is not
 * silently read as a hundred times larger.
 */
function readNumber(value: string | undefined): number {
  if (value === undefined) return 0;
  const cleaned = value.trim();
  if (cleaned === '') return 0;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  let normalized: string;
  if (hasDot && hasComma) {
    // The last separator is the decimal one; the others group thousands.
    const decimalSeparator = cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',';
    const groupingSeparator = decimalSeparator === '.' ? ',' : '.';
    normalized = cleaned.split(groupingSeparator).join('').replace(decimalSeparator, '.');
  } else if (hasComma) {
    // A lone comma is a decimal comma, not a grouping separator.
    normalized = cleaned.replace(',', '.');
  } else {
    normalized = cleaned;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Round a monetary amount to cents.
 *
 * The proceeds are products of two decimal numbers, so a naive sum drifts:
 * 3 units at 0.70 is 2.0999999999999996 in binary floating point. Money is
 * rounded at every step so the reported amount is the amount Apple would
 * state.
 */
export function roundCurrency(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * Parse a decompressed sales report into a summary.
 *
 * The report mixes currencies, so proceeds are accumulated per currency code
 * and never reduced to a single number.
 */
export function parseSalesReport(text: string, date: string): SalesReportSummary {
  const { header, rows } = splitTsv(text);
  const columns = resolveColumns(header);

  const missingColumns = (Object.keys(columns) as SalesField[]).filter(
    (field) => columns[field] === -1,
  );

  const summary: SalesReportSummary = {
    status: 'available',
    date,
    units: 0,
    proceeds: {},
    byApp: [],
    missingColumns,
    rowCount: rows.length,
  };

  if (columns.units === -1) {
    throw new SalesReportParseError(
      'The sales report has no "Units" column, so its rows cannot be read.',
    );
  }

  const byApp = new Map<string, SalesAppRow>();

  for (const row of rows) {
    const units = readNumber(row[columns.units]);
    summary.units += units;

    // Developer Proceeds is stated per unit in the report, so the row amount
    // is the per-unit figure multiplied by the units of that row.
    const currency =
      columns.currency === -1 ? 'UNKNOWN' : (row[columns.currency] ?? '').trim() || 'UNKNOWN';
    const perUnit = columns.developerProceeds === -1 ? 0 : readNumber(row[columns.developerProceeds]);
    const amount = roundCurrency(perUnit * units);

    if (amount !== 0) {
      summary.proceeds[currency] = roundCurrency((summary.proceeds[currency] ?? 0) + amount);
    }

    const sku = columns.sku === -1 ? '' : (row[columns.sku] ?? '').trim();
    const title = columns.title === -1 ? '' : (row[columns.title] ?? '').trim();
    const key = sku || title;

    if (key !== '') {
      const existing = byApp.get(key) ?? { title, sku, units: 0, proceeds: {} };
      existing.units += units;
      if (existing.title === '' && title !== '') existing.title = title;
      if (amount !== 0) {
        existing.proceeds[currency] = roundCurrency((existing.proceeds[currency] ?? 0) + amount);
      }
      byApp.set(key, existing);
    }
  }

  summary.byApp = [...byApp.values()].sort((a, b) => b.units - a.units);

  if (summary.rowCount === 0 || (summary.units === 0 && Object.keys(summary.proceeds).length === 0)) {
    summary.status = 'no_sales';
  }

  return summary;
}

/**
 * Parse a gzipped sales report body.
 */
export function parseSalesReportGzipped(
  body: Uint8Array | Buffer,
  date: string,
): SalesReportSummary {
  return parseSalesReport(decompressReport(body).toString('utf8'), date);
}

/**
 * Decide whether a 404 from Apple means "no sales that day" or "the report
 * has not been generated yet".
 *
 * Apple answers both cases with a 404 and only the error detail tells them
 * apart: a date whose report is still being produced is reported as "not
 * available yet".
 */
export function classifyNotFound(detail: string): 'not_generated' | 'no_sales' {
  const normalized = detail.toLowerCase();

  if (
    normalized.includes('not available yet') ||
    normalized.includes('not yet available') ||
    normalized.includes('not generated') ||
    normalized.includes('has not been generated')
  ) {
    return 'not_generated';
  }

  return 'no_sales';
}

/**
 * Format the proceeds map for display, one currency per line.
 */
export function formatProceeds(proceeds: Record<string, number>): string {
  const entries = Object.entries(proceeds);
  if (entries.length === 0) return 'none';

  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`)
    .join(', ');
}
