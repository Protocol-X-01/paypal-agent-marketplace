import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/marketplace-safety.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { fetchMarketplaceImage, MAX_MARKETPLACE_IMAGE_BYTES } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

async function withFetch(mock, action) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test("fetches an allowed raster image without credentials, referrer or redirects", async () => {
  let options;
  const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  await withFetch(async (url, init) => {
    assert.equal(url, "https://cdn.trychannel3.com/item.png");
    options = init;
    return new Response(data, { headers: { "content-type": "image/png; charset=binary" } });
  }, async () => {
    const blob = await fetchMarketplaceImage("https://cdn.trychannel3.com/item.png", new AbortController().signal);
    assert.equal(blob.type, "image/png");
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data);
  });
  assert.equal(options.mode, "cors");
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(options.referrerPolicy, "no-referrer");
});

test("does not request untrusted URLs and rejects redirects, CORS failures and non-raster types", async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; throw new TypeError("CORS or redirect rejected"); }, async () => {
    await assert.rejects(fetchMarketplaceImage("https://cdn.trychannel3.com.evil.example/a", new AbortController().signal));
    assert.equal(calls, 0);
    await assert.rejects(fetchMarketplaceImage("https://cdn.trychannel3.com/a", new AbortController().signal));
  });
  await withFetch(async () => Response.redirect("https://other.example/image", 302), async () => {
    await assert.rejects(fetchMarketplaceImage("https://cdn.trychannel3.com/a", new AbortController().signal));
  });
  for (const type of ["image/svg+xml", "text/html", "application/octet-stream", ""]) {
    await withFetch(async () => new Response("example", { headers: { "content-type": type } }), async () => {
      await assert.rejects(fetchMarketplaceImage("https://cdn.trychannel3.com/a", new AbortController().signal));
    });
  }
});

test("rejects declared and streamed oversized images without waiting for cancellation", async () => {
  await withFetch(async () => new Response("small", { headers: { "content-type": "image/png", "content-length": String(MAX_MARKETPLACE_IMAGE_BYTES + 1) } }), async () => {
    await assert.rejects(fetchMarketplaceImage("https://cdn.trychannel3.com/a", new AbortController().signal));
  });
  let canceled = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_MARKETPLACE_IMAGE_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { canceled = true; return gate; },
  });
  try {
    await withFetch(async () => new Response(body, { headers: { "content-type": "image/webp" } }), async () => {
      await assert.rejects(fetchMarketplaceImage("https://cdn.trychannel3.com/a", new AbortController().signal));
    });
    assert.equal(canceled, true);
  } finally { release(); }
});

test("an aborted image request settles even if a fetch implementation ignores the signal", async () => {
  const controller = new AbortController();
  await withFetch(() => new Promise(() => {}), async () => {
    const pending = fetchMarketplaceImage("https://cdn.trychannel3.com/a", controller.signal);
    controller.abort();
    await assert.rejects(pending);
  });
});
