'use strict';

const decode = require('upstream-decoder').default;

// query-string 7 expects the old decoder's form-style handling of literal plus.
module.exports = function decodeUriComponentCompat(value) {
  return decode(typeof value === 'string' ? value.replace(/\+/g, ' ') : value);
};
