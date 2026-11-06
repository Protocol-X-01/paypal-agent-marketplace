import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

// Exercise the actual route in isolation; no network or real credentials.
const source = await readFile(new URL("../src/app/api/webhooks/paypal/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const cjsModule = { exports: {} };
const nodeRequire = createRequire(import.meta.url);
let providerCalls = 0;
const require = (name) => name === "@/lib/paypal"
  ? { verifyWebhook: async () => { providerCalls += 1; return { verification_status: "SUCCESS" }; } }
  : nodeRequire(name);
new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
const { POST } = cjsModule.exports;

const headers = {
  "content-type": "application/json",
  "paypal-transmission-id": "test-transmission",
  "paypal-transmission-time": "2026-11-06T00:00:00Z",
  "paypal-cert-url": "https://api-m.paypal.com/v1/notifications/certs/TEST-CERT",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "test-signature",
};

test("oversized streams release verification slots even if cancellation never settles", async () => {
  const envNames = ["PAYPAL_WEBHOOK_ID", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"];
  const previous = envNames.map((name) => process.env[name]);
  const cancellations = [];
  let deadline;
  try {
    for (const name of envNames) process.env[name] = "SYNTHETIC";
    providerCalls = 0;
    const requests = Array.from({ length: 8 }, () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
        cancel() { return gate; },
      });
      cancellations.push(() => release());
      return new Request("http://localhost/api/webhooks/paypal", { method: "POST", headers, body, duplex: "half" });
    });

    const outcome = await Promise.race([
      Promise.all(requests.map((request) => POST(request))),
      new Promise((resolve) => { deadline = setTimeout(() => resolve(null), 1000); }),
    ]);
    assert.notEqual(outcome, null, "rejection must not wait for the stream's cancellation promise");
    assert.deepEqual(outcome.map((response) => response.status), Array(8).fill(413));
    assert.equal(globalThis.__paypalWebhookVerificationsInFlight, 0);

    const malformed = await POST(new Request("http://localhost/api/webhooks/paypal", { method: "POST", headers, body: "{" }));
    assert.equal(malformed.status, 400, "later requests can acquire a released slot");
    assert.equal(providerCalls, 0, "neither rejected body reaches signature verification");
  } finally {
    clearTimeout(deadline);
    for (const release of cancellations) release();
    envNames.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});
