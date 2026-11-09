'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const decode = require('decode-uri-component');
const queryString = require('query-string');
const { getStateFromPath } = require('expo-router/build/react-navigation/core/getStateFromPath');
const { getPathFromState } = require('expo-router/build/react-navigation/core/getPathFromState');

const config = { screens: { Asset: 'market/:id' } };

test('adapter exposes a callable patched decoder with ordinary and malformed input', () => {
  assert.equal(typeof decode, 'function');
  assert.equal(decode('hello%20world'), 'hello world');
  assert.equal(decode('%E2%82%AC%20%F0%9F%8C%8D'), '€ 🌍');
  assert.equal(decode('abc%zz'), 'abc%zz');
  assert.equal(decode('a+b'), 'a b');
  assert.equal(decode('%2B'), '+');
  assert.equal(decode('%C3%28'), '%C3(');
  assert.equal(decode('%E0%A4%A'), '%E0%A4%A');
  // Unlike the vulnerable decoder, do not rescan and decode newly emitted '%' bytes.
  assert.equal(decode('%41%25%32%46%F1'), 'A%2F%F1');
  assert.equal(decode('%C2'), '\uFFFD');
  assert.equal(decode('%FE%FF'), '\uFFFD\uFFFD');
  assert.throws(() => decode(null), TypeError);
});

test('query-string preserves its CommonJS methods and serializes URL characters', () => {
  assert.equal(typeof queryString.parse, 'function');
  assert.equal(typeof queryString.stringify, 'function');
  assert.deepEqual({ ...queryString.parse('q=BTC%20%26%20ETH&tag=one&tag=two&empty=&flag') }, {
    q: 'BTC & ETH', tag: ['one', 'two'], empty: '', flag: null,
  });
  assert.equal(queryString.stringify({ note: '£ / ¥', symbol: 'BTC & ETH' }),
    'note=%C2%A3%20%2F%20%C2%A5&symbol=BTC%20%26%20ETH');
});

test('Expo Router generic path parser and serializer preserve SDK 57 URL behavior', () => {
  const samples = [
    ['/market/btc?symbol=BTC%20%26%20ETH&note=%C2%A3%20%2F%20%C2%A5',
      { id: 'btc', note: '£ / ¥', symbol: 'BTC & ETH' },
      '/market/btc?note=%C2%A3%20%2F%20%C2%A5&symbol=BTC%20%26%20ETH'],
    ['/market/eth?tag=one&tag=two&empty=&flag',
      { id: 'eth', empty: '', flag: null, tag: ['one', 'two'] },
      '/market/eth?empty=&flag=null&tag=one%2Ctwo'],
    ['/market/pyusd?special=%2A%7E%2B%20%2F',
      { id: 'pyusd', special: '*~+ /' }, '/market/pyusd?special=%2A~%2B%20%2F'],
    ['/market/chainlink?tag=caf%C3%A9&emoji=%F0%9F%8C%8D',
      { id: 'chainlink', emoji: '🌍', tag: 'café' },
      '/market/chainlink?emoji=%F0%9F%8C%8D&tag=caf%C3%A9'],
  ];
  for (const [input, params, output] of samples) {
    const state = getStateFromPath(input, config);
    assert.deepEqual({ ...state.routes[0].params }, params);
    assert.equal(getPathFromState(state, config), output);
  }
});

test('both malformed-input advisory shapes complete within an isolated time limit', () => {
  const probe = `
    const assert = require('node:assert/strict');
    const decode = require('decode-uri-component');
    const parse = require('query-string').parse;
    const repeated = '%C0'.repeat(12000) + '%zz';
    let distinct = '';
    for (let i = 0; i < 32000; i++) {
      distinct += '%' + Math.floor(i / 256).toString(16).padStart(2, '0') + '%' + (i % 256).toString(16).padStart(2, '0') + 'x';
    }
    distinct += '%zz';
    assert.ok(decode(repeated).endsWith('%zz'));
    assert.ok(decode(distinct).endsWith('%zz'));
    assert.ok(parse('q=' + distinct).q.endsWith('%zz'));
  `;
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: process.cwd(), timeout: 5000, encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
