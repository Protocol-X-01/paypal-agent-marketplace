// Run from apps/mobile: node --test tests/chart-description.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const modules = new Map();
function loadSource(file) {
  const absolute = path.resolve(file.endsWith('.ts') ? file : `${file}.ts`);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  const source = fs.readFileSync(absolute, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const localRequire = (name) => name.startsWith('.')
    ? loadSource(path.resolve(path.dirname(absolute), name))
    : require(name);
  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
    module.exports, localRequire, module, absolute, path.dirname(absolute),
  );
  return module.exports;
}

const source = (name) => path.join(__dirname, '..', 'src', 'lib', name);
const { formatChartTime, describeVisibleChart } = loadSource(source('chart-description'));
const { buildChartPath } = loadSource(source('chart-path'));

test('chart time labels include the year and UTC regardless of device timezone', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(formatChartTime(Date.parse('2026-11-01T01:30:00Z')), '1 Nov 2026, 01:30 UTC');
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(formatChartTime(Date.parse('2026-11-01T01:30:00Z')), '1 Nov 2026, 01:30 UTC');
    assert.equal(formatChartTime(Number.NaN), 'Time unavailable');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('screen-reader summary describes the visible zoom interval and endpoints', () => {
  const points = [
    { timestamp: Date.parse('2026-10-31T23:00:00Z'), value: 100 },
    { timestamp: Date.parse('2026-11-01T00:00:00Z'), value: 120 },
    { timestamp: Date.parse('2026-11-01T01:00:00Z'), value: 110 },
    { timestamp: Date.parse('2026-11-01T02:00:00Z'), value: 150 },
  ];
  const zoom = buildChartPath(points.slice(1, 3));
  const text = describeVisibleChart('price', zoom.low, zoom.high, 'GBP', false, zoom.first, zoom.lastPoint);
  assert.match(text, /£110\.00.*£120\.00/);
  assert.match(text, /1 Nov 2026, 00:00 UTC at £120\.00/);
  assert.match(text, /1 Nov 2026, 01:00 UTC at £110\.00/);
  assert.match(text, /-8\.33 percent/);
  assert.doesNotMatch(text, /31 Oct|02:00 UTC/);
});

test('a zero baseline or overflowing change is announced as unavailable', () => {
  const zero = describeVisibleChart('price', 0, 5, 'USD', false, { timestamp: 0, value: 0 }, { timestamp: 60_000, value: 5 });
  assert.match(zero, /Range change not available/);
  assert.doesNotMatch(zero, /Infinity|NaN/);
  const overflow = describeVisibleChart('price', 1e-308, 1e308, 'USD', false, { timestamp: 0, value: 1e-308 }, { timestamp: 60_000, value: 1e308 });
  assert.match(overflow, /Range change not available/);
  assert.doesNotMatch(overflow, /Infinity|NaN/);
});

test('two different values at the same instant do not announce a period change', () => {
  const instant = Date.parse('2026-11-06T10:00:00Z');
  const description = describeVisibleChart('price', 10, 20, 'USD', false, { timestamp: instant, value: 10 }, { timestamp: instant, value: 20 });
  assert.match(description, /Range change not available/);
  assert.doesNotMatch(description, /100\.00 percent/);
});

test('the stablecoin reference is only described for the USD price view', () => {
  const first = { timestamp: 0, value: 0.9999 };
  const last = { timestamp: 60_000, value: 1.0001 };
  assert.match(describeVisibleChart('price', first.value, last.value, 'USD', true, first, last), /\$1\.00 USD peg/);
  assert.doesNotMatch(describeVisibleChart('price', first.value, last.value, 'GBP', true, first, last), /peg/);
  assert.doesNotMatch(describeVisibleChart('volume', first.value, last.value, 'USD', true, first, last), /peg/);
});
