// Synthetic data and deliberately chosen failures for the local regression only.
// Postman's simulation starts this fixture as a CommonJS script.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http');

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '', 'http://localhost');
  const currency = url.searchParams.get('vs_currency');
  if (req.method !== 'GET' || req.headers['x-cg-demo-api-key'] !== 'simulation-only') {
    return reply(res, 401, { error: 'Synthetic mock requires its dummy Demo header.' });
  }
  if (url.pathname === '/api/v3/coins/markets') {
    if (currency === 'eur') return reply(res, 200, []);
    if (currency === 'jpy') return reply(res, 500, { error: 'Synthetic provider failure.' });
    if (currency === 'chf') return reply(res, 429, { error: 'Synthetic rate limit.' }, { 'Retry-After': '29' });
    if (!['gbp', 'usd', 'aud'].includes(currency)) return reply(res, 501, { error: 'Synthetic currency not modeled.' });
    const price = currency === 'gbp' ? 12345.67 : currency === 'aud' ? 34567.89 : 23456.78;
    return reply(res, 200, [{
      id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1,
      current_price: price, market_cap: 123456789, total_volume: 12345,
      price_change_percentage_24h: -99,
      price_change_percentage_24h_in_currency: 2.5,
      price_change_percentage_7d_in_currency: 4.5,
      high_24h: price + 100, low_24h: price - 100,
      sparkline_in_7d: { price: [price - 100, price] },
      last_updated: '2026-11-06T00:00:00.000Z',
    }]);
  }
  if (url.pathname === '/api/v3/coins/bitcoin/market_chart') {
    if (currency === 'aud') return reply(res, 429, { error: 'Synthetic rate limit.' }, { 'Retry-After': '37' });
    if (currency === 'jpy') return reply(res, 500, { error: 'Synthetic provider failure.' });
    if (['cad', 'nzd', 'sgd', 'nok'].includes(currency) && url.searchParams.get('days') === '7') {
      const data = {
        prices: [[1730000000000, 12000], [1730003600000, 12500]],
        market_caps: [[1730000000000, 500000], [1730003600000, 510000]],
        total_volumes: [[1730000000000, 5000], [1730003600000, 5100]],
      };
      if (currency === 'cad') data.prices[0][1] = -1;
      if (currency === 'nzd') data.market_caps[0][1] = -1;
      if (currency === 'sgd') data.total_volumes[0][1] = -1;
      if (currency === 'nok') data.prices[0][0] = 1730000000000.5;
      return reply(res, 200, data);
    }
    if (currency !== 'gbp' || url.searchParams.get('days') !== '7') return reply(res, 501, { error: 'Synthetic chart not modeled.' });
    return reply(res, 200, {
      prices: [[1730000000000, 12000], [1730003600000, 12500]],
      market_caps: [[1730000000000, 500000], [1730003600000, 510000]],
      total_volumes: [[1730000000000, 5000], [1730003600000, 5100]],
    });
  }
  return reply(res, 501, { error: 'Synthetic endpoint not modeled.' });
});

server.listen(process.env.PORT);
