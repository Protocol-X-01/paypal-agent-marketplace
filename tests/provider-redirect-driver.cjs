/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS fixture. */
// Called only inside the isolated simulation runner; no real keys are loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const ts = require('typescript');

const [mockPort, upstreamPort, destinationPort, tlsDirectory] = process.argv.slice(2);
const upstream = `https://127.0.0.1:${Number(upstreamPort)}/upstream`;
const tls = { key: fs.readFileSync(path.join(tlsDirectory, 'key.pem')), cert: fs.readFileSync(path.join(tlsDirectory, 'cert.pem')) };
let destinationHits = 0;
const destination = https.createServer(tls, (req, res) => {
  destinationHits += 1;
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
const proxy = https.createServer(tls, (req, res) => {
  const forwarded = http.request({ host: '127.0.0.1', port: Number(mockPort), path: req.url, method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  forwarded.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(forwarded);
});

function load(relative, aliases = {}, replacements = []) {
  let source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, `fixture source mapping changed: ${relative}`);
    source = source.replace(before, after);
  }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', compiled)(loaded.exports, (name) => Object.hasOwn(aliases, name) ? aliases[name] : require(name), loaded);
  return loaded.exports;
}

async function run() {
  await Promise.all([
    new Promise((resolve) => proxy.listen(Number(upstreamPort), '127.0.0.1', resolve)),
    new Promise((resolve) => destination.listen(Number(destinationPort), '127.0.0.1', resolve)),
  ]);
  process.env.CHANNEL3_BASE_URL = `${upstream}/c3`;
  process.env.CHANNEL3_API_KEY = 'synthetic-c3-key';
  process.env.CHANNEL3_COLLECTION_ID = 'fixture-collection';
  process.env.COINGECKO_DEMO_API_KEY = 'synthetic-gecko-key';
  process.env.PAYPAL_CLIENT_SECRET = 'synthetic-secret';
  const storefront = load('src/lib/channel3-storefront.ts');
  const safety = load('src/lib/marketplace-safety.ts');
  const channel3 = load('src/lib/channel3.ts', { 'server-only': {}, '@/lib/channel3-storefront': storefront, '@/lib/marketplace-safety': safety });
  const assets = load('src/lib/market-assets.ts');
  const market = load('src/lib/market-data.ts', { 'server-only': {}, 'next/cache': { cacheLife() {} }, './market-assets': assets }, [
    ['https://api.coingecko.com/api/v3', `${upstream}/gecko`],
  ]);
  const paypal = () => load('src/lib/paypal.ts', { 'server-only': {} }, [
    ['https://api-m.paypal.com', `${upstream}/paypal`],
    ['https://api-m.sandbox.paypal.com', `${upstream}/paypal`],
  ]);
  const locale = { country: 'GB', currency: 'GBP', language: 'en' };
  const headers = { transmission_id: 'synthetic-id', transmission_time: '2026-11-06T00:00:00Z', cert_url: 'https://example.invalid', auth_algo: 'SHA256withRSA', transmission_sig: 'synthetic-signature', webhook_id: 'synthetic-webhook' };
  const event = (scenario) => Buffer.from(JSON.stringify({ scenario, private: 'synthetic-event-marker' }));

  try {
    assert.equal((await channel3.search({ query: 'success', locale })).products[0].id, 'synthetic-product');
    assert.equal((await channel3.browseCategory('success', 8, locale)).products[0].id, 'synthetic-product');
    assert.equal((await market.getMarketQuotes('USD')).coins[0].price, 100);
    assert.equal((await market.getMarketChart('bitcoin', 7, 'USD')).prices.length, 2);
    process.env.PAYPAL_CLIENT_ID = 'success';
    assert.equal(await paypal().accessToken(AbortSignal.timeout(3000)), 'synthetic-token');
    assert.equal((await paypal().verifyWebhook(headers, event('success'))).verification_status, 'SUCCESS');
    console.log('PASS all six provider operations accepted synthetic HTTP 200 responses');

    for (const [scenario, currency] of [['same', 'EUR'], ['cross', 'GBP']]) {
      await assert.rejects(channel3.search({ query: scenario, locale }));
      await assert.rejects(channel3.browseCategory(scenario, 8, locale));
      await assert.rejects(market.getMarketQuotes(currency), (error) => error.kind === 'unavailable');
      await assert.rejects(market.getMarketChart('bitcoin', 7, currency), (error) => error.kind === 'unavailable');
      process.env.PAYPAL_CLIENT_ID = scenario;
      await assert.rejects(paypal().accessToken(AbortSignal.timeout(3000)));
      process.env.PAYPAL_CLIENT_ID = 'success';
      await assert.rejects(paypal().verifyWebhook(headers, event(scenario)));
      console.log(`PASS all six provider operations rejected the synthetic ${scenario}-origin HTTP 307`);
    }
    assert.equal(destinationHits, 0, 'the cross-origin destination received a request');
    console.log('PASS cross-origin destination received no request or synthetic credentials');
  } finally {
    proxy.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([new Promise((resolve) => proxy.close(resolve)), new Promise((resolve) => destination.close(resolve))]);
  }
}

run().catch((error) => {
  console.error('FAIL isolated provider redirect regression:', error);
  process.exitCode = 1;
});
