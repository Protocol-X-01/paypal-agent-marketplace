/* eslint-disable @typescript-eslint/no-require-imports -- Local Postman fixture. */
const http = require('node:http');

// Synthetic behavior exercises the caller; it does not establish how PayPal
// behaves for these cases or simulate merchant authorization.
const calls = [];
let redirectDestinationHits = 0;
const server = http.createServer((req, res) => {
  const reply = (status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/_fixture/stats') return reply(200, { calls, redirectDestinationHits });
  if (url.pathname === '/_fixture/redirect-target') {
    redirectDestinationHits += 1;
    return reply(200, {});
  }
  if (req.method !== 'GET' || url.pathname !== '/v1/reporting/transactions') return reply(501, { error: 'Not modeled.' });
  const start = url.searchParams.get('start_date');
  const end = url.searchParams.get('end_date');
  const startTime = Date.parse(start ?? '');
  const expectedEnd = Number.isFinite(startTime) ? new Date(startTime + 7 * 86_400_000).toISOString().replace('.000Z', 'Z') : null;
  if (req.headers.authorization !== 'Bearer synthetic-reporting-token' ||
      end !== expectedEnd || url.searchParams.get('fields') !== 'transaction_info' ||
      url.searchParams.get('balance_affecting_records_only') !== 'Y' ||
      url.searchParams.get('page') !== '1' || url.searchParams.get('page_size') !== '100' ||
      [...url.searchParams.keys()].length !== 6) {
    return reply(400, { error: 'Synthetic request did not match the tested subset.' });
  }
  calls.push(start);
  if (start === '2026-01-01T00:00:00Z') return reply(200, {
    account_number: 'SYNTHETIC_PRIVATE_ACCOUNT',
    transaction_details: [
      { transaction_info: { transaction_id: 'SYNTHETIC_DUPLICATE', transaction_event_code: 'T0006', transaction_status: 'S', transaction_note: 'SYNTHETIC_PRIVATE_NOTE' } },
      { transaction_info: { transaction_id: 'SYNTHETIC_DUPLICATE', transaction_event_code: 'T1107', transaction_status: 'S' } },
    ],
    page: 1, total_items: 2, total_pages: 1,
  });
  if (start === '2026-02-01T00:00:00Z') return reply(403, { message: 'SYNTHETIC_PRIVATE_ERROR' });
  if (start === '2026-03-01T00:00:00Z') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{invalid');
  }
  if (start === '2026-04-01T00:00:00Z') return reply(200, { transaction_details: [], note: 'x'.repeat(270_000) });
  if (start === '2026-05-01T00:00:00Z') return setTimeout(() => reply(200, { transaction_details: [] }), 6_500);
  if (start === '2026-06-01T00:00:00Z') {
    res.writeHead(307, { location: '/paypal/_fixture/redirect-target' });
    return res.end();
  }
  if (start === '2026-07-01T00:00:00Z') return reply(200, { message: 'missing list' });
  return reply(501, { error: 'Scenario not modeled.' });
});

server.listen(process.env.PORT);
