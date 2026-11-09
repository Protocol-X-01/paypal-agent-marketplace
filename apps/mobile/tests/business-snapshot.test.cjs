// Run from apps/mobile: node --test tests/business-snapshot.test.cjs
// Compare the native parser with the website contract without device or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, globals = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, ...globals }, { filename: file });
  return module.exports;
}

const mobileFile = path.join(__dirname, '..', 'src', 'lib', 'business-snapshot.ts');
const webFile = path.join(__dirname, '..', '..', '..', 'src', 'lib', 'business-snapshot.ts');
const mobile = load(mobileFile, { Intl }); // Intentionally no TextEncoder.
const fallback = load(mobileFile, { Intl: { NumberFormat: Intl.NumberFormat } });
const brokenIntl = load(mobileFile, { Intl: { supportedValuesOf: () => { throw new RangeError('unsupported'); } } });
const web = load(webFile, { Intl, TextEncoder });
const normalize = (value) => JSON.parse(JSON.stringify(value));

const headers = [...web.BUSINESS_SNAPSHOT_HEADERS];
function rows() {
  return [
    { window_days: '7', period: 'previous', start_date: '2026-10-23', end_exclusive: '2026-10-30', channel: 'online', currency: 'GBP', transactions: '100', gross_minor: '100000', refund_minor: '2000', source_updated_at: '2026-11-06T00:00:00Z' },
    { window_days: '7', period: 'current', start_date: '2026-10-30', end_exclusive: '2026-11-06', channel: 'online', currency: 'GBP', transactions: '120', gross_minor: '120000', refund_minor: '3000', source_updated_at: '2026-11-06T00:00:00Z' },
  ];
}
function csv(items = rows(), columns = headers) {
  return [columns.join(','), ...items.map((row) => columns.map((column) => row[column] ?? '').join(','))].join('\n');
}
function sameDecision(text) {
  const expected = web.parseBusinessSnapshot(text);
  for (const parser of [mobile, fallback]) {
    const actual = parser.parseBusinessSnapshot(text);
    assert.equal(actual.ok, expected.ok);
    if (expected.ok) assert.deepEqual(normalize(actual.snapshot), normalize(expected.snapshot));
    else assert.equal(typeof actual.error, 'string');
  }
}

test('native and website exports use the same fields and bounds', () => {
  assert.deepEqual(normalize(mobile.BUSINESS_SNAPSHOT_HEADERS), normalize(web.BUSINESS_SNAPSHOT_HEADERS));
  assert.deepEqual(normalize(mobile.BUSINESS_SNAPSHOT_CHANNELS), normalize(web.BUSINESS_SNAPSHOT_CHANNELS));
  assert.equal(mobile.BUSINESS_SNAPSHOT_MAX_BYTES, web.BUSINESS_SNAPSHOT_MAX_BYTES);
  assert.equal(mobile.BUSINESS_SNAPSHOT_MAX_TRANSACTIONS_PER_ROW, web.BUSINESS_SNAPSHOT_MAX_TRANSACTIONS_PER_ROW);
  assert.equal(mobile.BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW, web.BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW);
});

test('valid aggregate snapshots and zero-denominator cases match the website', () => {
  sameDecision(csv());
  const zero = rows();
  zero[0].transactions = '0';
  zero[1].gross_minor = '0';
  sameDecision(csv(zero));
  const refunds = rows();
  refunds[1].gross_minor = '100';
  refunds[1].refund_minor = '300';
  sameDecision(csv(refunds));
  const reordered = [...headers].reverse();
  sameDecision('\uFEFF' + csv(rows(), reordered).replace(/\n/g, '\r\n') + '\r\n');
});

test('rejects identifying columns, malformed CSV, bad dates, missing pairs, and unsafe values', () => {
  const extra = rows().map((row) => ({ ...row, customer_email: 'person@example.invalid' }));
  const invalid = [
    csv(extra, [...headers, 'customer_email']),
    csv().replace('previous', '"previous'),
    csv(rows().slice(0, 1)),
    csv().replace('2026-10-23', '2026-02-30'),
    csv().replace('2026-11-06T00:00:00Z', '2026-11-05T23:59:59Z'),
    csv().replace('GBP', 'ZZZ'),
    csv().replace('100000', '-1'),
    csv().replace('100000', '1000000000001'),
  ];
  for (const text of invalid) {
    sameDecision(text);
    const result = fallback.parseBusinessSnapshot(text);
    assert.equal(result.ok, false);
    assert.equal(result.error.includes('person@example.invalid'), false);
  }
});

test('UTF-8 byte limits hold without TextEncoder, including surrogate edge cases', () => {
  const limit = mobile.BUSINESS_SNAPSHOT_MAX_BYTES;
  for (const suffix of ['😀', '\ud800', '\udc00', 'é']) {
    for (const extra of [0, 1]) {
      const bytes = Buffer.byteLength(suffix, 'utf8');
      const text = 'a'.repeat(limit - bytes + extra) + suffix;
      const result = fallback.parseBusinessSnapshot(text);
      assert.equal(result.ok, false);
      assert.equal(result.error.includes('too large'), extra === 1);
      sameDecision(text);
    }
  }
});

test('native and website use the same pinned ISO currency units without runtime currency lists', () => {
  assert.equal(mobile.BUSINESS_SNAPSHOT_ISO_PUBLISHED, '2026-09-17');
  assert.equal(mobile.BUSINESS_SNAPSHOT_ISO_PUBLISHED, web.BUSINESS_SNAPSHOT_ISO_PUBLISHED);
  assert.deepEqual(normalize(mobile.BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS), normalize(web.BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS));
  assert.equal(Object.keys(mobile.BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS).length, 165);
  for (const currency of Object.keys(mobile.BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS)) {
    const input = rows().map((row) => ({ ...row, currency }));
    sameDecision(csv(input));
    assert.equal(fallback.parseBusinessSnapshot(csv(input)).ok, true, currency);
  }
  for (const currency of ['XDR', 'XSU', 'XXX', 'BGN', 'ZZZ', 'usd', 'GB', 'GBP ']) {
    const input = rows().map((row) => ({ ...row, currency }));
    sameDecision(csv(input));
    assert.equal(fallback.parseBusinessSnapshot(csv(input)).ok, false, currency);
  }
  assert.equal(brokenIntl.parseBusinessSnapshot(csv()).ok, true);
});

test('currency formatting retains ISO minor units and matches the website', () => {
  const currencies = { GBP: 2, USD: 2, COP: 2, HUF: 2, IDR: 2, JPY: 0, BHD: 3, CLF: 4 };
  for (const [currency, digits] of Object.entries(currencies)) {
    assert.equal(mobile.businessCurrencyMinorDigits(currency), digits, currency);
    for (const value of [0, 1, 1250, 2_999_999_999_997, 3_000_000_000_000]) {
      const formatter = new Intl.NumberFormat('en-GB', {
        style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
      });
      assert.equal(mobile.formatBusinessMinorAmount(value, currency), formatter.format(value / 10 ** digits), currency);
      assert.equal(mobile.formatBusinessMinorAmount(value, currency), web.formatBusinessMinorAmount(value, currency), currency);
    }
  }
});

test('incomplete native Intl implementations fall back to exact ISO-scaled text', () => {
  const absentIntl = load(mobileFile, { Intl: {} });
  for (const [currency, expected] of Object.entries({ COP: 'COP 12.50', JPY: 'JPY 1,250', BHD: 'BHD 1.250', CLF: 'CLF 0.1250' })) {
    assert.equal(absentIntl.formatBusinessMinorAmount(1250, currency), expected);
  }
  assert.equal(absentIntl.formatBusinessMinorAmount(2_999_999_999_997, 'COP'), 'COP 29,999,999,999.97');
  const wrongDigits = load(mobileFile, { Intl: { NumberFormat: function () {
    return { resolvedOptions: () => ({ minimumFractionDigits: 2, maximumFractionDigits: 2 }), format: () => 'incorrect' };
  } } });
  assert.equal(wrongDigits.formatBusinessMinorAmount(1250, 'JPY'), 'JPY 1,250');
  const ignoresPrecision = load(mobileFile, { Intl: { NumberFormat: function (_locale, options) {
    return { resolvedOptions: () => ({ minimumFractionDigits: options.minimumFractionDigits, maximumFractionDigits: options.maximumFractionDigits }), format: () => 'incorrect' };
  } } });
  assert.equal(ignoresPrecision.formatBusinessMinorAmount(1250, 'COP'), 'COP 12.50');
  assert.equal(absentIntl.formatBusinessMinorAmount(1250, 'XDR'), 'Unavailable');
});
