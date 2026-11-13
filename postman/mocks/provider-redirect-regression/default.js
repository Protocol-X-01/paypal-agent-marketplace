// Synthetic loopback-only provider stand-in. Never records bodies or headers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('node:http');

// The isolated runner replaces these two placeholders in its temporary copy.
const sameOriginTarget = '__SYNTHETIC_ORIGIN__/upstream/same-target';
const crossOriginTarget = '__SYNTHETIC_DESTINATION__/destination';
const groups = ['c3search', 'c3browse', 'quotes', 'chart', 'token', 'verify'];
const stats = Object.fromEntries(groups.map((name) => [name, { success: 0, same: 0, cross: 0 }]));
stats.sameTarget = 0;
stats.invalid = 0;

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const credentials = (name) => `Basic ${Buffer.from(`${name}:synthetic-secret`).toString('base64')}`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/stats') return send(res, 200, stats);
  if (url.pathname === '/same-target') {
    stats.sameTarget += 1;
    return send(res, 200, { products: [] });
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let group, scenario;
    if (req.method === 'POST' && ['/c3/v1/search', '/c3/v1/browse'].includes(url.pathname)) {
      if (req.headers['x-api-key'] !== 'synthetic-c3-key') { stats.invalid += 1; return send(res, 401, {}); }
      let input;
      try { input = JSON.parse(body); } catch { stats.invalid += 1; return send(res, 400, {}); }
      group = url.pathname.endsWith('/search') ? 'c3search' : 'c3browse';
      scenario = group === 'c3search' ? input.query : input.filters?.category_ids?.[0];
    } else if (req.method === 'GET' && ['/gecko/coins/markets', '/gecko/coins/bitcoin/market_chart'].includes(url.pathname)) {
      if (req.headers['x-cg-demo-api-key'] !== 'synthetic-gecko-key') { stats.invalid += 1; return send(res, 401, {}); }
      group = url.pathname.endsWith('/markets') ? 'quotes' : 'chart';
      scenario = { usd: 'success', gbp: 'cross', eur: 'same' }[url.searchParams.get('vs_currency')];
    } else if (req.method === 'POST' && url.pathname === '/paypal/v1/oauth2/token') {
      group = 'token';
      scenario = ['success', 'cross', 'same'].find((name) => req.headers.authorization === credentials(name));
    } else if (req.method === 'POST' && url.pathname === '/paypal/v1/notifications/verify-webhook-signature') {
      if (req.headers.authorization !== 'Bearer synthetic-token') { stats.invalid += 1; return send(res, 401, {}); }
      let input;
      try { input = JSON.parse(body); } catch { stats.invalid += 1; return send(res, 400, {}); }
      group = 'verify';
      scenario = input.webhook_event?.scenario;
    }
    if (!group || !['success', 'same', 'cross'].includes(scenario)) { stats.invalid += 1; return send(res, 501, {}); }
    stats[group][scenario] += 1;
    if (scenario !== 'success') {
      res.writeHead(307, { location: scenario === 'same' ? sameOriginTarget : crossOriginTarget });
      return res.end();
    }
    if (group === 'c3search' || group === 'c3browse') return send(res, 200, { products: [{ id: 'synthetic-product', title: 'Synthetic product', offers: [] }] });
    if (group === 'quotes') return send(res, 200, [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100, market_cap: 100, total_volume: 10, high_24h: 110, low_24h: 90 }]);
    if (group === 'chart') return send(res, 200, { prices: [[1000, 100], [2000, 101]], market_caps: [[1000, 1000]], total_volumes: [[1000, 10]] });
    if (group === 'token') return send(res, 200, { access_token: 'synthetic-token', expires_in: 3600 });
    return send(res, 200, { verification_status: 'SUCCESS' });
  });
}).listen(process.env.PORT);
