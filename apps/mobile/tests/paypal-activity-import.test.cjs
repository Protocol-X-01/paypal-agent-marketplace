// Compare synthetic native parser results with the website's validated contract.
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

const mobile = load(path.join(__dirname, '..', 'src', 'lib', 'paypal-activity-import.ts'));
const web = load(path.join(__dirname, '..', '..', '..', 'src', 'lib', 'paypal-activity-import.ts'), { TextEncoder });
const header = 'Date,Time,TimeZone,Name,From Email Address,Status,Transaction Event Code,Balance Impact,Transaction ID';
const id = (number) => `TEST${String(number).padStart(13, '0')}`;
const row = (date, number, { time = '12:00:00', zone = 'UTC', status = 'Completed', code = 'T0006', impact = 'Credit' } = {}) =>
  `${date},${time},${zone},"Fictional, Person",invented@example.test,${status},${code},${impact},${id(number)}`;
const csv = (...rows) => [header, ...rows].join('\n');
const valid = () => csv(row('23/10/2026', 1), row('30/10/2026', 2, { code: 'T0007' }));
const options = { dateOrder: 'dmy', timeZone: 'utc', windowDays: 7, endExclusive: '2026-11-06', coverageConfirmed: true, nowMs: Date.parse('2026-11-06T15:00:00Z') };
const normalize = (value) => JSON.parse(JSON.stringify(value));
function same(text, overrides = {}) {
  const args = { ...options, ...overrides };
  const expected = normalize(web.summarizePayPalActivity(text, args));
  const actual = normalize(mobile.summarizePayPalActivity(text, args));
  assert.deepEqual(actual, expected);
  assert.doesNotMatch(JSON.stringify(actual), /Fictional|invented@example|TEST0/);
  return actual;
}

test('native limits match the web contract without requiring TextEncoder', () => {
  assert.equal(mobile.PAYPAL_ACTIVITY_MAX_BYTES, web.PAYPAL_ACTIVITY_MAX_BYTES);
  assert.equal(mobile.PAYPAL_ACTIVITY_MAX_ROWS, web.PAYPAL_ACTIVITY_MAX_ROWS);
  const summary = same(csv(
    row('23/10/2026', 1, { time: '00:00:00' }),
    row('29/10/2026', 2, { status: 'Pending' }),
    row('30/10/2026', 3, { zone: 'GMT', code: 'T0007' }),
    row('04/11/2026', 4, { impact: 'Debit' }),
    row('05/11/2026', 5, { code: 'T1107' }),
    row('06/11/2026', 6),
  ));
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.previous.included, 1);
  assert.equal(summary.summary.previous.notCompleted, 1);
  assert.equal(summary.summary.current.included, 1);
  assert.equal(summary.summary.current.notCredit, 1);
  assert.equal(summary.summary.current.otherEvent, 1);
  assert.equal(summary.summary.outsidePeriods, 1);
});

test('formats, UTC boundaries, exclusions, and coverage decisions match', () => {
  assert.equal(same(valid()).ok, true);
  assert.equal(same(csv(row('10/23/2026', 1), row('11/04/2026', 2)), { dateOrder: 'mdy' }).ok, true);
  assert.equal(same(csv(row('07/09/2026', 1), row('07/10/2026', 2)), { windowDays: 30 }).ok, true);
  const noIncludedPrevious = same(csv(row('23/10/2026', 1, { code: 'T1107' }), row('30/10/2026', 2)));
  assert.equal(noIncludedPrevious.summary.changePct, null);
  for (const override of [
    { coverageConfirmed: false }, { dateOrder: '' }, { timeZone: '' }, { windowDays: 14 },
    { endExclusive: '2026-11-07' }, { endExclusive: '2026-02-30' }, { nowMs: Infinity },
  ]) assert.equal(same(valid(), override).ok, false);
  assert.equal(same(csv(row('30/10/2026', 1), row('04/11/2026', 2))).ok, false);
});

test('chosen UK and Pacific zones agree on UTC boundaries and reject clock transitions', () => {
  const summer = { endExclusive: '2026-07-15', nowMs: Date.parse('2026-07-15T15:00:00Z') };
  const cases = [
    ['london', 'BST', '01/07/2026', '01:00:00', '08/07/2026', '01:00:00'],
    ['pacific', 'PDT', '30/06/2026', '17:00:00', '07/07/2026', '17:00:00'],
  ];
  for (const [timeZone, zone, previousDate, previousTime, currentDate, currentTime] of cases) {
    const result = same(csv(row(previousDate, 1, { time: previousTime, zone }), row(currentDate, 2, { time: currentTime, zone })), { ...summer, timeZone });
    assert.equal(result.ok, true);
    assert.equal(result.summary.previous.included, 1);
    assert.equal(result.summary.current.included, 1);
  }
  const london = csv(row('23/10/2026', 1, { zone: 'BST' }), row('30/10/2026', 2, { zone: 'GMT' }));
  for (const [date, time, zone] of [['25/10/2026', '01:30:00', 'BST'], ['29/03/2026', '01:30:00', 'GMT'], ['23/10/2026', '12:00:00', 'GMT']]) {
    assert.equal(same(`${london}\n${row(date, 3, { time, zone })}`, { timeZone: 'london' }).ok, false);
  }
  const pacific = csv(row('23/10/2026', 1, { zone: 'PDT' }), row('30/10/2026', 2, { zone: 'PDT' }));
  for (const [date, time, zone] of [['01/11/2026', '01:30:00', 'PDT'], ['08/03/2026', '02:30:00', 'PST'], ['23/10/2026', '12:00:00', 'PST']]) {
    assert.equal(same(`${pacific}\n${row(date, 3, { time, zone })}`, { timeZone: 'pacific' }).ok, false);
  }
});

test('all selected US report zones match website decisions across summer and winter', () => {
  const seasons = [
    [{ endExclusive: '2026-01-15', nowMs: Date.parse('2026-01-15T15:00:00Z') }, '01/01/2026', '08/01/2026'],
    [{ endExclusive: '2026-07-15', nowMs: Date.parse('2026-07-15T15:00:00Z') }, '01/07/2026', '08/07/2026'],
  ];
  for (const [timeZone, winter, summer] of [
    ['eastern', 'EST', 'EDT'], ['central', 'CST', 'CDT'], ['mountain', 'MST', 'MDT'],
    ['arizona', 'MST', 'MST'], ['pacific', 'PST', 'PDT'], ['alaska', 'AKST', 'AKDT'], ['hawaii', 'HST', 'HST'],
  ]) {
    seasons.forEach(([override, first, second], index) => {
      const zone = index === 0 ? winter : summer;
      const result = same(csv(row(first, 1, { zone }), row(second, 2, { zone })), { ...override, timeZone });
      assert.equal(result.ok, true, `${timeZone} ${zone}`);
      assert.equal(result.summary.previous.included, 1);
      assert.equal(result.summary.current.included, 1);
    });
  }
});

test('native regional reports fail closed when time zone data is unavailable', () => {
  const noZones = load(path.join(__dirname, '..', 'src', 'lib', 'paypal-activity-import.ts'), {
    Intl: { DateTimeFormat() { throw new Error('time zone data unavailable'); } },
  });
  const result = noZones.summarizePayPalActivity(valid(), { ...options, timeZone: 'london' });
  assert.equal(result.ok, false);
  assert.match(result.error, /time zone/i);
  assert.doesNotMatch(JSON.stringify(result), /Fictional|invented@example|TEST0/);
});

test('quoted private fields, BOM, CRLF and malformed inputs match without exposing fields', () => {
  const quoted = valid().replace('"Fictional, Person"', '"Fictional\r\nPerson"').replace(/\n/g, '\r\n');
  assert.equal(same(`\uFEFF${quoted}`).ok, true);
  const invalid = [
    valid().replace('Transaction Event Code', 'Event'),
    `${header},Date\n${row('23/10/2026', 1)},x\n${row('30/10/2026', 2)},x`,
    `${header}\n"unterminated`,
    csv(row('31/02/2026', 1), row('30/10/2026', 2)),
    csv(row('23/10/2026', 1, { time: '24:00:00' }), row('30/10/2026', 2)),
    csv(row('23/10/2026', 1, { zone: 'PST' }), row('30/10/2026', 2)),
    csv(row('23/10/2026', 1, { status: 'Unknown' }), row('30/10/2026', 2)),
    csv(row('23/10/2026', 1, { code: 'T6' }), row('30/10/2026', 2)),
    csv(row('23/10/2026', 1), row('30/10/2026', 1)),
  ];
  for (const input of invalid) assert.equal(same(input).ok, false);
});

test('UTF-8 size decisions agree for multibyte and unpaired surrogate text', () => {
  const limit = mobile.PAYPAL_ACTIVITY_MAX_BYTES;
  for (const suffix of ['é', '😀', '\ud800', '\udc00']) {
    const size = Buffer.byteLength(suffix, 'utf8');
    for (const extra of [0, 1]) {
      const input = 'a'.repeat(limit - size + extra) + suffix;
      const result = same(input);
      assert.equal(result.ok, false);
      assert.equal(result.error.includes('too large'), extra === 1);
    }
  }
});

test('the maximum row count and an additional row match the website', () => {
  const compactHeader = 'Date,Time,TimeZone,Status,Transaction Event Code,Balance Impact,Transaction ID';
  const rows = Array.from({ length: mobile.PAYPAL_ACTIVITY_MAX_ROWS }, (_, index) =>
    `${index === 0 ? '23/10/2026' : '30/10/2026'},00:00:00,UTC,Completed,T0006,Credit,${id(index)}`,
  );
  const input = [compactHeader, ...rows].join('\n');
  assert.ok(Buffer.byteLength(input) < mobile.PAYPAL_ACTIVITY_MAX_BYTES);
  const accepted = same(input);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.summary.rowsInFile, mobile.PAYPAL_ACTIVITY_MAX_ROWS);
  const rejected = same(`${input}\n30/10/2026,00:00:00,UTC,Completed,T0006,Credit,${id(mobile.PAYPAL_ACTIVITY_MAX_ROWS)}`);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /too many rows/i);
});
