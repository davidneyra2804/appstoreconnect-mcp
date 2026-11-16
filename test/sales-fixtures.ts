/**
 * Synthetic sales report fixtures.
 *
 * The fixtures reproduce the column layout of Apple's daily sales report
 * without containing a single byte of real account data. Every file here is
 * a deterministic string or a gzipped string, so the suite never touches the
 * network and never needs a credential.
 */

import { gzipSync } from 'node:zlib';

/**
 * The header of Apple's daily sales report.
 *
 * The column order is part of the contract: the parser reads the header by
 * name, but the fixtures keep the real order so a regression in the reader
 * shows up here.
 */
export const SALES_REPORT_HEADER = [
  'Provider',
  'Provider Country',
  'Fiscal Year',
  'Fiscal Period',
  'Report Date',
  'Report Type',
  'Report Subtype',
  'Title',
  'SKU',
  'Developer',
  'Units',
  'Developer Proceeds',
  'Begin Date',
  'End Date',
  'Currency of Proceeds',
  'Country Code',
].join('\t');

/** One row of the sales report, with named fields. */
export interface SalesRow {
  title: string;
  sku: string;
  units: number | string;
  /** Developer proceeds per unit, as Apple states them. */
  proceedsPerUnit: number | string;
  currency: string;
  countryCode?: string;
}

/** Render rows as a TSV document with the Apple column layout. */
export function renderSalesTsv(rows: SalesRow[], header: string = SALES_REPORT_HEADER): string {
  const lines = [header];

  for (const row of rows) {
    const cells: Record<string, string> = {
      Provider: 'Apple Distribution International Ltd.',
      'Provider Country': 'IRL',
      'Fiscal Year': '2026',
      'Fiscal Period': '10',
      'Report Date': '2026-10-30',
      'Report Type': 'SALES',
      'Report Subtype': 'SUMMARY',
      Title: row.title,
      SKU: row.sku,
      Developer: 'Example Developer',
      Units: String(row.units),
      'Developer Proceeds': String(row.proceedsPerUnit),
      'Begin Date': '2026-10-30',
      'End Date': '2026-10-30',
      'Currency of Proceeds': row.currency,
      'Country Code': row.countryCode ?? 'USA',
    };

    lines.push(
      header
        .split('\t')
        .map((column) => cells[column] ?? '')
        .join('\t'),
    );
  }

  return `${lines.join('\n')}\n`;
}

/** Render rows as a gzipped TSV, the way Apple serves the report. */
export function renderSalesGzip(rows: SalesRow[], header?: string): Buffer {
  return gzipSync(Buffer.from(renderSalesTsv(rows, header), 'utf8'));
}

/**
 * A report with a single app sold in a single currency.
 */
export const SINGLE_APP_ROWS: SalesRow[] = [
  {
    title: 'Fixture App',
    sku: '1234567890',
    units: 10,
    proceedsPerUnit: '0.70',
    currency: 'USD',
  },
];

/**
 * A report with several apps, several currencies and a multi-unit row.
 *
 * The EUR and USD rows must never be summed together: they are different
 * amounts of different money.
 */
export const MIXED_CURRENCY_ROWS: SalesRow[] = [
  {
    title: 'Fixture App',
    sku: '1234567890',
    units: 3,
    proceedsPerUnit: '0.70',
    currency: 'USD',
    countryCode: 'USA',
  },
  {
    title: 'Fixture App',
    sku: '1234567890',
    units: 2,
    proceedsPerUnit: '0.65',
    currency: 'EUR',
    countryCode: 'DEU',
  },
  {
    title: 'Other App',
    sku: '5555555555',
    units: 7,
    proceedsPerUnit: '0.50',
    currency: 'USD',
    countryCode: 'USA',
  },
  {
    title: 'Other App',
    sku: '5555555555',
    units: 1,
    proceedsPerUnit: '0.45',
    currency: 'GBP',
    countryCode: 'GBR',
  },
];

/**
 * A report whose rows carry no currency and no proceeds.
 *
 * This is what a day without sales looks like: the report exists and the
 * rows are empty of money.
 */
export const NO_SALES_ROWS: SalesRow[] = [
  {
    title: 'Fixture App',
    sku: '1234567890',
    units: 0,
    proceedsPerUnit: '0.00',
    currency: 'USD',
  },
];
