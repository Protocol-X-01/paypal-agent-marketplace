/* eslint-disable @typescript-eslint/no-require-imports -- Standalone local simulation. */
// Runs only inside the isolated loopback runner, with an ephemeral test certificate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const root = path.join(__dirname, '..');
const [keyFile, certificateFile] = process.argv.slice(2);
const tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certificateFile) };
const CAP = 2 * 1024 * 1024;
const richProduct = {
  id: 'synthetic-product', title: 'Synthetic headphones £',
  brands: [{ id: 'synthetic-brand', name: 'Example' }],
  images: [{ url: 'https://cdn.example.invalid/item.jpg', is_main_image: true }],
  offers: [{ url: 'https://store.example.invalid/item', domain: 'store.example.invalid', availability: 'InStock', price: { price: 12, currency: 'GBP' } }],
  additional_provider_field: { nested: ['retained', 42] },
};
const largeBody = Buffer.from(JSON.stringify({ products: [richProduct], padding: 'x'.repeat(CAP) }));
const compressedBody = zlib.gzipSync(largeBody);
assert.ok(largeBody.length > CAP);
assert.ok(compressedBody.length < CAP);

function load(relative, aliases = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', js)(loaded.exports, (name) => Object.hasOwn(aliases, name) ? aliases[name] : require(name), loaded);
  return loaded.exports;
}

const storefront = load('src/lib/channel3-storefront.ts');
const priceRange = load('src/lib/marketplace-price-range.ts');
const safety = load('src/lib/marketplace-safety.ts');
const budgetError = class Channel3BudgetExceededError extends Error { constructor(retryAfterSeconds) { super('budget exhausted'); this.retryAfterSeconds = retryAfterSeconds; } };
const budget = { Channel3BudgetExceededError: budgetError, reserveChannel3ProviderRequest: async () => {} };
const channel3 = load('src/lib/channel3.ts', { 'server-only': {}, '@/lib/channel3-storefront': storefront, '@/lib/marketplace-safety': safety, '@/lib/channel3-request-budget': budget });
const cors = load('src/lib/mobile-web-cors.ts', { 'server-only': {} });
const catalog = load('src/lib/channel3-catalog.ts');
const aliases = {
  '@/lib/channel3': channel3,
  '@/lib/channel3-storefront': storefront,
  '@/lib/marketplace-price-range': priceRange,
  '@/lib/channel3-catalog': catalog,
  '@/lib/mobile-web-cors': cors,
  '@/lib/channel3-rate-limit': { takeChannel3RateLimit: () => true },
  '@/lib/request-limits': { acquireClientSlot: () => () => {} },
};
const search = load('src/app/api/marketplace/search/route.ts', aliases);
const browse = load('src/app/api/marketplace/catalog/route.ts', aliases);

let scenario = '';
let calls = [];
let redirectHits = 0;
let declaredClosed = 0;
const server = https.createServer(tls, (req, res) => {
  if (req.url === '/redirect-target') { redirectHits += 1; res.writeHead(200); res.end('{}'); return; }
  const chosen = scenario;
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end(); return; }
    calls.push({ chosen, method: req.method, path: req.url, country: body.config?.country, currency: body.config?.currency });
    if (req.method !== 'POST' || !['/v1/search', '/v1/browse'].includes(req.url) || req.headers['x-api-key'] !== 'simulation-only') {
      res.writeHead(501); res.end(); return;
    }
    if (chosen === 'declared') {
      res.on('close', () => { if (!res.writableEnded) declaredClosed += 1; });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(CAP + 1) });
      res.flushHeaders();
      return;
    }
    if (chosen === 'chunked') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      res.end(largeBody); return;
    }
    if (chosen === 'compressed') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': String(compressedBody.length) });
      res.end(compressedBody); return;
    }
    if (chosen === 'invalid-utf8') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(Buffer.concat([Buffer.from('{"products":[{"id":"synthetic","title":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}]}')]));
      return;
    }
    if (chosen === 'malformed-json') { res.writeHead(200); res.end('{"products":'); return; }
    if (chosen === 'stall') { res.writeHead(200); res.write('{"products":'); return; }
    if (chosen === 'redirect') { res.writeHead(307, { Location: '/redirect-target' }); res.end(); return; }
    if (chosen === 'rich') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ products: [richProduct], next_page_token: 'synthetic-next' })); return; }
    res.writeHead(501); res.end();
  });
});

function post(country) {
  return search.POST(new NextRequest('http://localhost:3000/api/marketplace/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'headphones', storefront: country }),
  }));
}
function get(country) { return browse.GET(new NextRequest(`http://localhost:3000/api/marketplace/catalog?section=audio&storefront=${country}`)); }

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.CHANNEL3_API_KEY = 'simulation-only';
  process.env.CHANNEL3_BASE_URL = `https://127.0.0.1:${server.address().port}`;
  process.env.CHANNEL3_COLLECTION_ID = 'fixture-collection';
  try {
    for (const [country, currency] of [['GB', 'GBP'], ['US', 'USD']]) {
      for (const request of [post, get]) {
        scenario = 'rich';
        const response = await request(country);
        const result = await response.json();
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(result.storefront, country);
        assert.equal(result.currency, currency);
        assert.deepEqual(result.products, [richProduct]);
      }
    }
    console.log('PASS GB and US HTTPS search and browse preserved full synthetic product fields');

    for (const name of ['declared', 'chunked', 'compressed', 'invalid-utf8', 'malformed-json', 'redirect']) {
      for (const request of [post, get]) {
        scenario = name;
        const started = Date.now();
        const response = await request('GB');
        assert.equal(response.status, 503, name);
        assert.equal(response.headers.get('cache-control'), 'no-store', name);
        assert.deepEqual(Object.keys(await response.json()), ['error'], name);
        if (name === 'declared') assert.ok(Date.now() - started < 3000, 'declared size should fail before the body arrives');
      }
      console.log(`PASS HTTPS ${name} responses were rejected by search and browse`);
    }
    scenario = 'stall';
    const started = Date.now();
    const stalled = await post('US');
    const elapsed = Date.now() - started;
    assert.equal(stalled.status, 504);
    assert.deepEqual(await stalled.json(), { error: 'Product search took too long. Please try again.' });
    assert.ok(elapsed >= 11_000 && elapsed < 16_000, `unexpected deadline: ${elapsed} ms`);
    console.log(`PASS HTTPS stalled search returned a safe 504 after the real twelve-second deadline (${elapsed} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(declaredClosed, 2, 'both declared-oversize streams should be cancelled');
    assert.equal(redirectHits, 0, 'redirect target must not receive credentials');
    assert.equal(calls.length, 17, 'each scenario must reach the stand-in exactly once');
    assert.ok(calls.every((call) => call.method === 'POST' && ['GB', 'US'].includes(call.country) && ['GBP', 'USD'].includes(call.currency)));
    console.log('PASS declared streams closed, redirect target received no request, and 17 calls reached the HTTPS stand-in');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => { console.error('FAIL HTTPS boundary simulation:', error.message); process.exitCode = 1; });
