// The clipboard reader is injected; these tests never access a real clipboard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, aliases = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (name) => {
    if (!Object.hasOwn(aliases, name)) throw new Error('Unexpected module import');
    return aliases[name];
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: requireMock }, { filename: file });
  return module.exports;
}

const parser = load(path.join(__dirname, '..', 'src', 'lib', 'paypal-activity-import.ts'));
const { readActivityClipboard, canReadActivityClipboard } = load(
  path.join(__dirname, '..', 'src', 'lib', 'paypal-activity-clipboard.ts'),
  { './paypal-activity-import': parser },
);
const { watchReportLifecycle } = load(path.join(__dirname, '..', 'src', 'lib', 'report-lifecycle.ts'));
const time = Date.parse('2026-11-06T12:00:00Z');
const now = () => time;
const choices = { native: true, dateOrder: 'dmy', timeZone: 'utc', windowDays: 7, endExclusive: '2026-11-06', privacyConfirmed: true, coverageConfirmed: true };
const csv = [
  'Date,Time,TimeZone,Name,From Email Address,Status,Transaction Event Code,Balance Impact,Transaction ID',
  '23/10/2026,12:00:00,UTC,Fictional,invented@example.test,Completed,T0006,Credit,TEST0000000000001',
  '30/10/2026,12:00:00,GMT,Fictional,invented@example.test,Completed,T0007,Credit,TEST0000000000002',
].join('\n');
const clean = (value) => JSON.parse(JSON.stringify(value));

test('no clipboard read occurs before both confirmations and valid settings', async () => {
  let reads = 0;
  const read = async () => { reads += 1; return csv; };
  for (const override of [
    { native: false }, { privacyConfirmed: false }, { coverageConfirmed: false },
    { dateOrder: '' }, { dateOrder: 'bad' }, { timeZone: '' }, { timeZone: 'bad' }, { windowDays: 0 },
    { endExclusive: '2026-02-30' }, { endExclusive: '2026-11-07' },
  ]) {
    const input = { ...choices, ...override };
    assert.equal(canReadActivityClipboard(input, '2026-11-06'), false);
    assert.equal((await readActivityClipboard(input, read, () => true, now)).kind, 'error');
  }
  assert.equal(reads, 0);
  assert.equal((await readActivityClipboard(choices, read, () => false, now)).kind, 'cancelled');
  assert.equal(reads, 0);
});

test('a confirmed synthetic read returns counts only', async () => {
  let reads = 0;
  const result = clean(await readActivityClipboard(choices, async () => { reads += 1; return csv; }, () => true, now));
  assert.equal(reads, 1);
  assert.equal(result.kind, 'success');
  assert.equal(result.summary.previous.included, 1);
  assert.equal(result.summary.current.included, 1);
  assert.doesNotMatch(JSON.stringify(result), /Fictional|invented@example|TEST0/);
});

test('a read completing after cancellation does not produce a preview', async () => {
  let active = true;
  let resolve;
  const pending = readActivityClipboard(choices, () => new Promise((done) => { resolve = done; }), () => active, now);
  active = false;
  resolve(csv);
  assert.deepEqual(clean(await pending), { kind: 'cancelled' });
});

test('a background notification clears the report and invalidates an unfinished read', async () => {
  let change;
  let removed = false;
  let revision = 0;
  let report = { included: 2 };
  let refreshes = 0;
  const unsubscribe = watchReportLifecycle(
    (listener) => { change = listener; return { remove() { removed = true; } }; },
    () => { report = null; revision += 1; },
    () => { refreshes += 1; },
  );
  let resolve;
  const current = revision;
  const pending = readActivityClipboard(choices, () => new Promise((done) => { resolve = done; }), () => current === revision, now);
  change('inactive'); // iOS may be temporarily inactive for a system dialog.
  assert.deepEqual(report, { included: 2 });
  change('background');
  assert.equal(report, null);
  resolve(csv);
  assert.deepEqual(clean(await pending), { kind: 'cancelled' });
  change('active');
  assert.equal(refreshes, 1);
  unsubscribe();
  change('active');
  assert.equal(refreshes, 1);
  assert.equal(removed, true);
});

test('empty, malformed, and failed clipboard reads return fixed messages without contents', async () => {
  const empty = clean(await readActivityClipboard(choices, async () => '', () => true, now));
  assert.match(empty.message, /empty or access was denied/i);
  const malformed = clean(await readActivityClipboard(choices, async () => `${csv}\nFictional secret`, () => true, now));
  const failed = clean(await readActivityClipboard(choices, async () => { throw new Error('Fictional secret'); }, () => true, now));
  assert.equal(malformed.kind, 'error');
  assert.equal(failed.kind, 'error');
  assert.doesNotMatch(JSON.stringify([malformed, failed]), /Fictional|invented@example|TEST0/);
});

test('a clock change while waiting revalidates period completion', async () => {
  let clockReads = 0;
  const changingClock = () => clockReads++ === 0 ? time : Date.parse('2026-11-05T23:00:00Z');
  const result = clean(await readActivityClipboard(choices, async () => csv, () => true, changingClock));
  assert.equal(result.kind, 'error');
  assert.match(result.message, /complete periods/i);
});
