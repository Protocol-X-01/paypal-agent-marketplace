// Run from apps/mobile: node --test tests/channel3-image.test.cjs
// Synthetic responses only; no images or user data leave this process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const modules = new Map();
function loadSource(file) {
  const absolute = path.resolve(file.endsWith('.ts') ? file : `${file}.ts`);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  const source = fs.readFileSync(absolute, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = (name) => name.startsWith('.')
    ? loadSource(path.resolve(path.dirname(absolute), name))
    : require(name);
  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
    module.exports, localRequire, module, absolute, path.dirname(absolute),
  );
  return module.exports;
}

const { createChannel3ImageLoader } = loadSource(path.join(__dirname, '..', 'src', 'lib', 'channel3-image'));
const imageUrl = 'https://cdn.trychannel3.com/item.webp';
const signal = () => new AbortController().signal;
const raster = (bytes, extraHeaders = {}) => new Response(bytes, { headers: { 'content-type': 'image/webp', ...extraHeaders } });

test('fetches only the exact image host with safe options and encodes chunk boundaries', async () => {
  for (const length of [1, 2, 3, 4, 5, 8191, 8192, 8193]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 47 + 13) % 256);
    const seen = [];
    const loader = createChannel3ImageLoader(async (url, options) => {
      seen.push({ url, options });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, Math.min(2, length)));
          if (length > 2) controller.enqueue(bytes.slice(2));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'image/webp; charset=binary' } });
    });
    const lease = await loader.load(imageUrl, signal());
    assert.equal(lease.uri, `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, imageUrl);
    assert.equal(seen[0].options.method, 'GET');
    assert.equal(seen[0].options.credentials, 'omit');
    assert.equal(seen[0].options.redirect, 'error');
    assert.equal(seen[0].options.mode, 'cors');
    assert.equal(seen[0].options.referrerPolicy, 'no-referrer');
    lease.release();
  }
});

test('does not request malformed, credentialed, or lookalike image hosts', async () => {
  let calls = 0;
  const loader = createChannel3ImageLoader(async () => { calls += 1; return raster('x'); });
  for (const url of [
    'http://cdn.trychannel3.com/x',
    'https://cdn.trychannel3.com.evil.example/x',
    'https://other.cdn.trychannel3.com/x',
    'https://user:password@cdn.trychannel3.com/x',
    'https://cdn.trychannel3.com:8443/x',
    'https://cdn.trychannel3.com/x\ny',
    null,
  ]) await assert.rejects(loader.load(url, signal()), /Unsupported product image URL/);
  assert.equal(calls, 0);
});

test('rejects redirect, network, status, and non-raster responses', async () => {
  const redirected = raster('x');
  Object.defineProperty(redirected, 'redirected', { value: true });
  const foreign = raster('x');
  Object.defineProperty(foreign, 'url', { value: 'https://retailer.example/track' });
  for (const response of [
    redirected,
    foreign,
    new Response('x', { status: 404, headers: { 'content-type': 'image/png' } }),
    new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    new Response('html', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { headers: { 'content-type': 'image/png' } }),
  ]) {
    const loader = createChannel3ImageLoader(async () => response);
    await assert.rejects(loader.load(imageUrl, signal()));
  }
  const loader = createChannel3ImageLoader(async () => { throw new TypeError('network failed'); });
  await assert.rejects(loader.load(imageUrl, signal()));
});

test('rejects declared and streamed oversize without waiting for cancel to settle', async () => {
  const declared = createChannel3ImageLoader(async () => raster('x', { 'content-length': '11' }), { maxBytes: 10 });
  await assert.rejects(declared.load(imageUrl, signal()), /too large/);
  let cancelCalled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(11)); },
    cancel() { cancelCalled = true; return new Promise(() => {}); },
  });
  const streamed = createChannel3ImageLoader(async () => new Response(body, { headers: { 'content-type': 'image/png' } }), { maxBytes: 10 });
  await assert.rejects(streamed.load(imageUrl, signal()), /too large/);
  assert.equal(cancelCalled, true);
});

test('limits concurrent requests and cancels queued work without fetching it', async () => {
  let active = 0;
  let peak = 0;
  const releaseRequests = [];
  const calls = [];
  const loader = createChannel3ImageLoader(async (url) => {
    calls.push(url);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releaseRequests.push(resolve));
    active -= 1;
    return raster('x');
  }, { maxConcurrent: 2 });
  const a = loader.load(`${imageUrl}?a`, signal());
  const b = loader.load(`${imageUrl}?b`, signal());
  const controller = new AbortController();
  const c = loader.load(`${imageUrl}?c`, controller.signal);
  const canceled = assert.rejects(c, /canceled/);
  const d = loader.load(`${imageUrl}?d`, signal());
  assert.equal(calls.length, 2);
  controller.abort();
  await canceled;
  releaseRequests[0]();
  const leaseA = await a;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  assert.ok(calls[2].endsWith('?d'));
  releaseRequests[1]();
  releaseRequests[2]();
  const [leaseB, leaseD] = await Promise.all([b, d]);
  assert.equal(peak, 2);
  leaseA.release(); leaseB.release(); leaseD.release();
});

test('abort and timeout release a slot even if the transport ignores abort', async () => {
  let calls = 0;
  let firstSignal;
  const loader = createChannel3ImageLoader(async (_url, options) => {
    calls += 1;
    if (calls === 1) { firstSignal = options.signal; return new Promise(() => {}); }
    return raster('next');
  }, { maxConcurrent: 1, timeoutMs: 30 });
  const first = loader.load(imageUrl, signal());
  const second = loader.load(`${imageUrl}?next`, signal());
  await assert.rejects(first, /canceled/);
  const lease = await second;
  assert.equal(firstSignal.aborted, true);
  assert.equal(calls, 2);
  lease.release();
});

test('aborting an in-flight body settles without awaiting stream cancellation', async () => {
  let cancelCalled = false;
  const body = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelCalled = true; return new Promise(() => {}); },
  });
  const loader = createChannel3ImageLoader(async () => new Response(body, { headers: { 'content-type': 'image/png' } }));
  const controller = new AbortController();
  const request = loader.load(imageUrl, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, /canceled/);
  assert.equal(cancelCalled, true);
});

test('retained-image budget is released exactly once', async () => {
  const loader = createChannel3ImageLoader(async () => raster(new Uint8Array(8)), { maxBytes: 10, maxRetainedBytes: 10 });
  const first = await loader.load(imageUrl, signal());
  await assert.rejects(loader.load(`${imageUrl}?two`, signal()), /memory limit/);
  first.release();
  first.release();
  const second = await loader.load(`${imageUrl}?two`, signal());
  await assert.rejects(loader.load(`${imageUrl}?three`, signal()), /memory limit/);
  second.release();
  const third = await loader.load(`${imageUrl}?three`, signal());
  third.release();
});
