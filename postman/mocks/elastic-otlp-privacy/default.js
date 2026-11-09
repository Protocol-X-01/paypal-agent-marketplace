// Local-only synthetic OTLP receiver. It never logs or stores a request body.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('node:http');

const PRIVATE_MARKER = Buffer.from('synthetic_private_marker_9f12');
const MAX_BYTES = 1024 * 1024;
const emptyStats = () => ({ received: 0, validated: 0, rejected: 0, accepted: 0, badRequest: 0, unavailable: 0, redirected: 0, redirectTarget: 0, ambientGeneral: 0, ambientTraces: 0, lastFailure: null });
const stats = { vercel: emptyStats(), official: emptyStats(), wrapped: emptyStats() };
// google.rpc.Status { message: <fictional marker> }; field 2 is a short string.
const ERROR_STATUS = Buffer.concat([Buffer.from([0x12, PRIVATE_MARKER.length]), PRIVATE_MARKER]);

// Decode the subset of protobuf wire types used by OTLP. Bounds are checked
// before reading and request bodies are capped; this is a test fixture only.
function fields(buffer) {
  const result = [];
  let offset = 0;
  function varint() {
    let value = 0n;
    for (let n = 0; n < 10; n += 1) {
      if (offset >= buffer.length) throw new Error('truncated varint');
      const byte = buffer[offset++];
      value |= BigInt(byte & 0x7f) << BigInt(7 * n);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('invalid varint');
  }
  function bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset) throw new Error('truncated field');
    const value = buffer.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  while (offset < buffer.length) {
    const tag = varint();
    const id = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!id) throw new Error('invalid field');
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1) value = bytes(8);
    else if (wire === 2) value = bytes(Number(varint()));
    else if (wire === 5) value = bytes(4);
    else throw new Error('unsupported wire type');
    result.push({ id, wire, value });
  }
  return result;
}

function all(message, id) { return fields(message).filter((field) => field.id === id); }
function one(message, id, wire = 2) {
  const items = all(message, id);
  if (items.length !== 1 || items[0].wire !== wire) throw new Error('missing or repeated field');
  return items[0].value;
}
function text(message, id) { return one(message, id).toString('utf8'); }
function attributes(message, id) {
  const result = {};
  for (const item of all(message, id)) {
    if (item.wire !== 2) throw new Error('invalid attribute');
    const key = text(item.value, 1);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error('duplicate attribute');
    const value = one(item.value, 2);
    const values = fields(value);
    if (values.length !== 1) throw new Error('unsupported attribute value');
    if (values[0].id === 1 && values[0].wire === 2) result[key] = values[0].value.toString('utf8');
    else if (values[0].id === 2 && values[0].wire === 0) result[key] = values[0].value !== 0n;
    else if (values[0].id === 3 && values[0].wire === 0) result[key] = Number(values[0].value);
    else throw new Error('unsupported attribute type');
  }
  return result;
}
function same(actual, expected) {
  return JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort());
}

function validTrace(body) {
  if (!body.length) return 'empty protobuf';
  if (body.includes(PRIVATE_MARKER)) return 'private marker on wire';
  try {
    const resourceSpans = one(body, 1);
    const resource = one(resourceSpans, 1);
    if (!same(attributes(resource, 1), {
      'service.name': 'paypal-markets-companion',
      'deployment.environment.name': 'production',
    })) return 'unexpected resource attributes';
    const scopeSpans = one(resourceSpans, 2);
    const scope = one(scopeSpans, 1);
    if (text(scope, 1) !== 'paypal-markets.filtered') return 'unexpected instrumentation scope';
    const span = one(scopeSpans, 2);
    if (text(span, 5) !== 'GET /api/marketplace/catalog') return 'unexpected span name';
    if (!same(attributes(span, 9), {
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'http.route': '/api/marketplace/catalog',
      'next.span_type': 'BaseServer.handleRequest',
    })) return 'unexpected span attributes';
    if (all(span, 3).length || all(span, 11).length || all(span, 13).length) return 'trace state, events or links present';
    const status = one(span, 15);
    if (all(status, 2).length || one(status, 3, 0) !== 2n) return 'unexpected status';
    return null;
  } catch {
    return 'invalid protobuf structure';
  }
}

const server = http.createServer((req, res) => {
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.method === 'GET' && req.url === '/__elastic__/stats') return json(200, stats);
  if (req.method !== 'POST' || !['/v1/traces', '/bad-request/v1/traces', '/unavailable/v1/traces', '/redirect/v1/traces', '/redirect-target/v1/traces'].includes(req.url)) return json(501, { error: 'Synthetic endpoint not modeled.' });
  const group = req.headers['x-simulation-exporter'];
  if (!Object.prototype.hasOwnProperty.call(stats, group)) return json(422, { error: 'Synthetic exporter label required.' });
  const current = stats[group];
  current.received += 1;
  if (req.headers['x-simulation-ambient-general'] === PRIVATE_MARKER.toString()) current.ambientGeneral += 1;
  if (req.headers['x-simulation-ambient-traces'] === PRIVATE_MARKER.toString()) current.ambientTraces += 1;
  let length = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    length += chunk.length;
    if (length <= MAX_BYTES) chunks.push(chunk);
  });
  req.on('end', () => {
    const failure = length > MAX_BYTES ? 'payload too large'
      : req.headers['content-type'] !== 'application/x-protobuf' ? 'unexpected content type'
        : req.headers.authorization !== 'ApiKey simulation-only' ? 'unexpected synthetic authorization'
          : validTrace(Buffer.concat(chunks));
    if (failure) {
      current.rejected += 1;
      current.lastFailure = failure;
      return json(422, { error: 'Synthetic trace failed the fixture checks.' });
    }
    current.validated += 1;
    if (req.url === '/bad-request/v1/traces') {
      current.badRequest += 1;
      res.writeHead(400, { 'content-type': 'application/x-protobuf' });
      return res.end(ERROR_STATUS);
    }
    if (req.url === '/unavailable/v1/traces') {
      current.unavailable += 1;
      res.writeHead(503, { 'content-type': 'application/x-protobuf' });
      return res.end(ERROR_STATUS);
    }
    if (req.url === '/redirect/v1/traces') {
      current.redirected += 1;
      res.writeHead(307, { 'content-type': 'application/x-protobuf', location: '/elastic/redirect-target/v1/traces' });
      return res.end(ERROR_STATUS);
    }
    if (req.url === '/redirect-target/v1/traces') current.redirectTarget += 1;
    current.accepted += 1;
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    return res.end(Buffer.alloc(0)); // Empty ExportTraceServiceResponse protobuf.
  });
});

server.listen(process.env.PORT);
