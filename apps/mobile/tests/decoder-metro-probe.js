'use strict';
const decode = require('decode-uri-component');
const query = require('query-string');
const { getStateFromPath } = require('expo-router/build/react-navigation/core/getStateFromPath');
const { getPathFromState } = require('expo-router/build/react-navigation/core/getPathFromState');
const check = (value, expected, name) => {
  if (value !== expected) throw new Error(name + ': ' + JSON.stringify(value));
};
check(typeof decode, 'function', 'callable decoder');
check(decode('%E2%82%AC%20%F0%9F%8C%8D'), '€ 🌍', 'unicode decoder');
check(decode('%C0%zz'), '%C0%zz', 'malformed decoder');
check(decode('a+b'), 'a b', 'legacy plus');
check(decode('%41%25%32%46%F1'), 'A%2F%F1', 'single-pass malformed decoder');
check(query.parse('q=BTC%20%26%20ETH').q, 'BTC & ETH', 'query parser');
const config = { screens: { Asset: 'market/:id' } };
const state = getStateFromPath('/market/btc?note=%C2%A3%20%2F%20%C2%A5', config);
check(state.routes[0].params.note, '£ / ¥', 'route parser');
check(getPathFromState(state, config), '/market/btc?note=%C2%A3%20%2F%20%C2%A5', 'route serializer');
console.log('PASS: Metro module interop, decoder, query parsing and route serialization');
