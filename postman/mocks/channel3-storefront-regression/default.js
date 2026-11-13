// Synthetic, local-only provider fixture. Postman starts it as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('node:http');

const server = http.createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || !['/v1/search', '/v1/browse'].includes(req.url)) return reply(501, { error: 'Synthetic endpoint not modeled.' });
  if (req.headers['x-api-key'] !== 'simulation-only') return reply(401, { error: 'Synthetic key required.' });
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return reply(400, { error: 'Invalid synthetic request.' }); }
    const { country, currency, language } = body.config || {};
    const modeled = (country === 'GB' && currency === 'GBP' && language === 'en')
      || (country === 'US' && currency === 'USD' && language === 'en')
      || (country === 'DE' && currency === 'GBP' && language === 'de');
    if (req.url === '/v1/search' && body.query === 'Please help me find comfortable over-ear headphones from Best Buy for travel under $150') {
      if (country !== 'US' || currency !== 'USD' || language !== 'en' || body.config?.mode !== 'agentic'
          || body.config?.collection_id !== 'fixture-collection' || body.limit !== 6
          || body.filters?.price?.max_price !== 150 || body.filters?.website_ids?.[0] !== 'p1PB') {
        return reply(501, { error: 'Synthetic assisted search is not modeled for this configuration.' });
      }
      return reply(200, { products: [{ id: 'fixture-agentic', title: 'Synthetic headphones', offers: [{
        domain: 'bestbuy.com', url: 'https://bestbuy.com/synthetic-item', availability: 'InStock', condition: 'new',
        price: { price: 99, currency: 'USD' },
      }, {
        domain: 'bestbuy.com', url: 'https://other.example/mismatched-item', availability: 'InStock', condition: 'new',
        price: { price: 99, currency: 'USD' },
      }] }], next_page_token: null });
    }
    if (req.url === '/v1/search' && body.query === 'paged headphones') {
      if (country !== 'GB' || currency !== 'GBP' || language !== 'en' || body.config?.collection_id !== 'fixture-collection' || body.limit !== 1) {
        return reply(501, { error: 'Synthetic paged search is not modeled for this configuration.' });
      }
      if (body.page_token === undefined) return reply(200, { products: [{ id: 'fixture-first', title: 'Another product', offers: [] }], next_page_token: 'fixture-page-two' });
      if (body.page_token === 'fixture-page-two') return reply(200, { products: [{ id: 'fixture-target', title: 'Saved product', offers: [] }], next_page_token: null });
      return reply(501, { error: 'Synthetic continuation is not modeled.' });
    }
    if (!modeled || (req.url === '/v1/search' && body.query !== 'headphones')
      || (req.url === '/v1/browse' && body.filters?.category_ids?.[0] !== 'headphones')) {
      return reply(501, { error: 'Synthetic request not modeled.' });
    }
    return reply(200, {
      products: [{ id: `fixture-${country}-${currency}-${language}`, title: 'Synthetic headphones', offers: [] }],
      next_page_token: null,
    });
  });
});

server.listen(process.env.PORT);
