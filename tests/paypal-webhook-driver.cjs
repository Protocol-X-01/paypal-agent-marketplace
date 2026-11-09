/* eslint-disable @typescript-eslint/no-require-imports -- Standalone local simulation. */
// Load the actual receiver and PayPal adapter. Only the adapter's two remote
// base URLs are replaced, in memory, with the isolated mock's loopback URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const ts = require('typescript');

const mockPort = Number(process.argv[2]);
assert(Number.isInteger(mockPort) && mockPort > 0 && mockPort < 65536);
assert.equal(process.env.PAYPAL_ENV, 'sandbox');
assert.equal(process.env.PAYPAL_CLIENT_ID, 'fixture-client');
assert.equal(process.env.PAYPAL_CLIENT_SECRET, 'fixture-credential');
assert.equal(process.env.PAYPAL_WEBHOOK_ID, 'FIXTUREWEBHOOK');
const mockBase = `http://127.0.0.1:${mockPort}/paypal`;

function load(relative, aliases = {}, replacements = []) {
  let source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, `Fixture source mapping changed: ${relative}`);
    source = source.replace(before, after);
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', compiled)(
    loaded.exports,
    (name) => Object.hasOwn(aliases, name) ? aliases[name] : require(name),
    loaded,
  );
  return loaded.exports;
}

const paypal = load('src/lib/paypal.ts', { 'server-only': {} }, [
  ['https://api-m.paypal.com', mockBase],
  ['https://api-m.sandbox.paypal.com', mockBase],
]);
const { POST } = load('src/app/api/webhooks/paypal/route.ts', {
  '@/lib/paypal': paypal,
  '@/lib/request-limits': { acquireClientSlot: () => () => {} },
});

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/webhooks/paypal') {
    req.resume();
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const part of value) headers.append(name, part);
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request('http://127.0.0.1/api/webhooks/paypal', {
      method: 'POST', headers, body: Readable.toWeb(req), duplex: 'half',
    });
    const response = await POST(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  assert(address && typeof address === 'object');
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`);
});

function stop() {
  server.closeAllConnections();
  server.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
