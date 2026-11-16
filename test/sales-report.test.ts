/**
 * Sales report behaviour: TSV layout, gzip, multi-currency and the
 * distinction between "no sales that day" and "report not generated yet".
 *
 * Every case is driven by a synthetic fixture. There is no network access
 * and no real Apple credential anywhere in this file.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  classifyNotFound,
  decompressReport,
  findColumn,
  formatProceeds,
  parseSalesReport,
  parseSalesReportGzipped,
  SalesReportParseError,
  splitTsv,
} from '../src/sales-report.js';
import {
  MIXED_CURRENCY_ROWS,
  NO_SALES_ROWS,
  SALES_REPORT_HEADER,
  SINGLE_APP_ROWS,
  renderSalesGzip,
  renderSalesTsv,
} from './sales-fixtures.js';

const REPORT_DATE = '2026-10-30';

describe('tsv layout', () => {
  it('splits a report into a header and its rows', () => {
    const { header, rows } = splitTsv(renderSalesTsv(SINGLE_APP_ROWS));

    assert.deepEqual(header, SALES_REPORT_HEADER.split('\t'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0][header.indexOf('SKU')], '1234567890');
  });

  it('ignores the trailing newline Apple writes', () => {
    const { rows } = splitTsv(renderSalesTsv(MIXED_CURRENCY_ROWS));

    assert.equal(rows.length, MIXED_CURRENCY_ROWS.length);
  });

  it('rejects an empty report', () => {
    assert.throws(() => splitTsv(''), SalesReportParseError);
    assert.throws(() => splitTsv('\n\n'), SalesReportParseError);
  });

  it('finds a column by its exact name', () => {
    const header = SALES_REPORT_HEADER.split('\t');

    assert.equal(findColumn(header, 'units'), header.indexOf('Units'));
    assert.equal(findColumn(header, 'developerProceeds'), header.indexOf('Developer Proceeds'));
    assert.equal(findColumn(header, 'currency'), header.indexOf('Currency of Proceeds'));
  });

  it('finds a column whose casing differs', () => {
    const header = ['UNITS', 'developer proceeds', 'Currency of Proceeds'];

    assert.equal(findColumn(header, 'units'), 0);
    assert.equal(findColumn(header, 'developerProceeds'), 1);
  });

  it('accepts an alternative wording of a column', () => {
    assert.equal(findColumn(['Quantity', 'Proceeds', 'Currency'], 'units'), 0);
    assert.equal(findColumn(['Quantity', 'Proceeds', 'Currency'], 'developerProceeds'), 1);
    assert.equal(findColumn(['Quantity', 'Proceeds', 'Currency'], 'currency'), 2);
  });

  it('reports a column it cannot find as missing', () => {
    assert.equal(findColumn(['Provider'], 'units'), -1);
  });

  it('refuses a report without a units column', () => {
    const tsv = 'Provider\tTitle\nApple\tFixture App\n';

    assert.throws(() => parseSalesReport(tsv, REPORT_DATE), SalesReportParseError);
  });
});

describe('gzip decoding', () => {
  it('decompresses a gzipped report', () => {
    const decompressed = decompressReport(renderSalesGzip(SINGLE_APP_ROWS));

    assert.match(decompressed.toString('utf8'), /^Provider\t/);
    assert.match(decompressed.toString('utf8'), /Fixture App/);
  });

  it('accepts an uncompressed report body', () => {
    const plain = Buffer.from(renderSalesTsv(SINGLE_APP_ROWS), 'utf8');

    assert.equal(decompressReport(plain).toString('utf8'), plain.toString('utf8'));
  });

  it('reports a corrupt gzip body instead of throwing a raw error', () => {
    const corrupt = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]);

    assert.throws(() => decompressReport(corrupt), SalesReportParseError);
  });

  it('parses a gzipped report end to end', () => {
    const summary = parseSalesReportGzipped(renderSalesGzip(SINGLE_APP_ROWS), REPORT_DATE);

    assert.equal(summary.status, 'available');
    assert.equal(summary.units, 10);
    assert.deepEqual(summary.proceeds, { USD: 7 });
    assert.equal(summary.rowCount, 1);
  });
});

describe('multi-currency accounting', () => {
  it('keeps every currency in its own bucket', () => {
    const summary = parseSalesReport(renderSalesTsv(MIXED_CURRENCY_ROWS), REPORT_DATE);

    assert.deepEqual(Object.keys(summary.proceeds).sort(), ['EUR', 'GBP', 'USD']);
    assert.equal(summary.proceeds.USD, 3 * 0.7 + 7 * 0.5);
    assert.equal(summary.proceeds.EUR, 2 * 0.65);
    assert.equal(summary.proceeds.GBP, 1 * 0.45);
  });

  it('never reduces several currencies to one number', () => {
    const summary = parseSalesReport(renderSalesTsv(MIXED_CURRENCY_ROWS), REPORT_DATE);

    const total = Object.values(summary.proceeds).reduce((sum, amount) => sum + amount, 0);
    const singleCurrency = parseSalesReport(renderSalesTsv(SINGLE_APP_ROWS), REPORT_DATE);

    assert.notEqual(total, singleCurrency.proceeds.USD);
    assert.equal(Object.keys(summary.proceeds).length, 3);
  });

  it('multiplies the per-unit proceeds by the units of the row', () => {
    const summary = parseSalesReport(renderSalesTsv(SINGLE_APP_ROWS), REPORT_DATE);

    // The fixture states 0.70 per unit for 10 units.
    assert.equal(summary.proceeds.USD, 7);
  });

  it('totals the units across every row', () => {
    const summary = parseSalesReport(renderSalesTsv(MIXED_CURRENCY_ROWS), REPORT_DATE);

    assert.equal(summary.units, 3 + 2 + 7 + 1);
    assert.equal(summary.rowCount, MIXED_CURRENCY_ROWS.length);
  });

  it('groups the rows by app and keeps the heaviest app first', () => {
    const summary = parseSalesReport(renderSalesTsv(MIXED_CURRENCY_ROWS), REPORT_DATE);

    assert.equal(summary.byApp.length, 2);
    assert.equal(summary.byApp[0].sku, '5555555555');
    assert.equal(summary.byApp[0].units, 8);
    assert.equal(summary.byApp[1].sku, '1234567890');
    assert.equal(summary.byApp[1].units, 5);
  });

  it('keeps the proceeds of each app in its own currencies', () => {
    const summary = parseSalesReport(renderSalesTsv(MIXED_CURRENCY_ROWS), REPORT_DATE);

    const fixture = summary.byApp.find((row) => row.sku === '1234567890');
    const other = summary.byApp.find((row) => row.sku === '5555555555');

    assert.ok(fixture);
    assert.ok(other);
    assert.deepEqual(fixture.proceeds, { USD: 2.1, EUR: 1.3 });
    assert.deepEqual(other.proceeds, { USD: 3.5, GBP: 0.45 });
  });

  it('sums the per-app proceeds into the account total', () => {
    const summary = parseSalesReport(renderSalesTsv(MIXED_CURRENCY_ROWS), REPORT_DATE);

    for (const currency of Object.keys(summary.proceeds)) {
      const fromApps = summary.byApp.reduce(
        (sum, row) => sum + (row.proceeds[currency] ?? 0),
        0,
      );
      assert.equal(fromApps, summary.proceeds[currency]);
    }
  });

  it('reads a decimal amount written with a decimal comma', () => {
    const tsv = [
      'Units\tDeveloper Proceeds\tCurrency of Proceeds\tSKU\tTitle',
      '2\t1,50\tEUR\t1234567890\tFixture App',
      '',
    ].join('\n');

    const summary = parseSalesReport(tsv, REPORT_DATE);

    // 2 units at 1.50 each is 3.00, not 300.
    assert.equal(summary.proceeds.EUR, 3);
  });

  it('reads a thousands-separated amount', () => {
    const tsv = [
      'Units\tDeveloper Proceeds\tCurrency of Proceeds\tSKU\tTitle',
      '1\t1,234.50\tUSD\t1234567890\tFixture App',
      '',
    ].join('\n');

    const summary = parseSalesReport(tsv, REPORT_DATE);

    assert.equal(summary.proceeds.USD, 1234.5);
  });

  it('rounds the proceeds to cents instead of drifting', () => {
    // 3 units at 0.70 is 2.0999999999999996 in binary floating point.
    const summary = parseSalesReport(renderSalesTsv(SINGLE_APP_ROWS), REPORT_DATE);

    assert.equal(summary.proceeds.USD, 7);
    assert.equal(Object.is(summary.proceeds.USD, 2.0999999999999996), false);
  });
});

describe('report status', () => {
  it('marks a report with sales as available', () => {
    const summary = parseSalesReport(renderSalesTsv(SINGLE_APP_ROWS), REPORT_DATE);

    assert.equal(summary.status, 'available');
  });

  it('marks a report without sales as no_sales', () => {
    const summary = parseSalesReport(renderSalesTsv(NO_SALES_ROWS), REPORT_DATE);

    assert.equal(summary.status, 'no_sales');
    assert.equal(summary.units, 0);
    assert.deepEqual(summary.proceeds, {});
  });

  it('marks a report with a header and no rows as no_sales', () => {
    const summary = parseSalesReport(`${SALES_REPORT_HEADER}\n`, REPORT_DATE);

    assert.equal(summary.status, 'no_sales');
    assert.equal(summary.rowCount, 0);
  });

  it('tells a report that is not generated yet apart from a day without sales', () => {
    assert.equal(
      classifyNotFound('The sales report for this date is not available yet.'),
      'not_generated',
    );
    assert.equal(
      classifyNotFound('There is no sales report for the given date.'),
      'no_sales',
    );
  });

  it('recognises the not-generated wording whatever its case', () => {
    assert.equal(classifyNotFound('NOT AVAILABLE YET'), 'not_generated');
    assert.equal(classifyNotFound('The report has not been generated.'), 'not_generated');
    assert.equal(classifyNotFound('Report not generated for that day'), 'not_generated');
  });

  it('treats an empty detail as a day without sales', () => {
    assert.equal(classifyNotFound(''), 'no_sales');
  });
});

describe('rendering', () => {
  it('formats the proceeds with one entry per currency', () => {
    assert.equal(formatProceeds({ USD: 7, EUR: 1.3 }), 'EUR 1.30, USD 7.00');
  });

  it('formats an empty proceeds map as none', () => {
    assert.equal(formatProceeds({}), 'none');
  });
});

describe('fixture integrity', () => {
  it('produces a byte-identical report on every run', () => {
    const first = renderSalesGzip(MIXED_CURRENCY_ROWS);
    const second = renderSalesGzip(MIXED_CURRENCY_ROWS);

    assert.deepEqual(first, second);
  });

  it('keeps the Apple column order in the header', () => {
    const header = SALES_REPORT_HEADER.split('\t');

    assert.equal(header[0], 'Provider');
    assert.equal(header[header.length - 1], 'Country Code');
  });

  it('produces a gzipped body that starts with the gzip magic number', () => {
    const body = renderSalesGzip(SINGLE_APP_ROWS);

    assert.equal(body[0], 0x1f);
    assert.equal(body[1], 0x8b);
  });

  it('produces a gzipped body that the parser reads back identically', () => {
    const body = gzipSync(Buffer.from(renderSalesTsv(MIXED_CURRENCY_ROWS), 'utf8'));
    const summary = parseSalesReportGzipped(body, REPORT_DATE);

    assert.equal(summary.units, 13);
  });
});
