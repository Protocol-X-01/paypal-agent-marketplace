import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function("exports", "require", "module", js)(mod.exports, (name) => { if (Object.hasOwn(aliases, name)) return aliases[name]; throw Error(`Unexpected module: ${name}`); }, mod);
  return mod.exports;
}
const storage = await load("../src/lib/customer-session-storage.ts");
const client = await load("../src/lib/customer-session-client.ts", { "./customer-session-storage": storage });
const memory = await load("../src/lib/customer-shopping-draft-memory.ts");
const guest = { authenticated: false, loginAvailable: true };
const account = (name) => ({ authenticated: true, loginAvailable: true, accountType: "personal", dataScope: `v1_${name.repeat(43)}` });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
function fixture() {
  const calls = [];
  const controller = client.createCustomerSessionController({ fetcher: (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })) });
  const drafts = memory.createShoppingDraftMemory(controller.getSnapshot);
  const unsubscribe = controller.subscribe(drafts.observe);
  return { calls, controller, drafts, close() { unsubscribe(); drafts.clear(); controller.dispose(); } };
}
async function verify(fixture, value) {
  const pending = fixture.controller.check();
  fixture.calls.at(-1).resolve(response(value));
  await pending;
  return fixture.controller.getSnapshot().lease;
}

test("guest and same-account checks hide then restore their own draft after verification", async () => {
  for (const identity of [guest, account("A")]) {
    const f = fixture();
    try {
      const prior = await verify(f, identity);
      assert.equal(f.drafts.write(prior, "A private shopping draft"), "retained");
      const checking = f.controller.check({ automatic: true });
      assert.equal(prior.active, false);
      assert.equal(f.controller.getSnapshot().status, "checking");
      assert.equal(f.drafts.read(prior), null);
      assert.equal(f.drafts.write(prior, "late event"), "inactive");
      f.calls.at(-1).resolve(response(identity));
      await checking;
      const current = f.controller.getSnapshot().lease;
      assert.notEqual(current, prior);
      assert.equal(f.drafts.read(current), "A private shopping draft");
    } finally { f.close(); }
  }
});

test("a changed account or guest clears the previous identity's draft", async () => {
  for (const other of [account("B"), guest]) {
    const f = fixture();
    try {
      const prior = await verify(f, account("A"));
      f.drafts.write(prior, "A private draft");
      const replacement = await verify(f, other);
      assert.equal(f.drafts.read(replacement), null);
      assert.equal(f.drafts.write(prior, "late A callback"), "inactive");
      const laterA = await verify(f, account("A"));
      assert.equal(f.drafts.read(laterA), null);
    } finally { f.close(); }
  }
});

test("uncertainty and sign-out clear retained drafts, even if the same identity returns", async () => {
  for (const transition of ["failure", "hold", "logout"]) {
    const f = fixture();
    try {
      const prior = await verify(f, account("A"));
      f.drafts.write(prior, "A private draft");
      if (transition === "failure") {
        const checking = f.controller.check({ automatic: true });
        f.calls.at(-1).resolve(response({ error: "unavailable" }, 503));
        await checking;
      } else if (transition === "hold") f.controller.hold();
      else {
        const loggingOut = f.controller.logout();
        assert.equal(f.controller.getSnapshot().status, "signing-out");
        f.calls.at(-1).reject(Error("fictional logout failure"));
        await loggingOut;
      }
      assert.equal(f.controller.getSnapshot().status, "uncertain");
      assert.equal(f.drafts.write(prior, "late event"), "inactive");
      const restored = await verify(f, account("A"));
      assert.equal(f.drafts.read(restored), null);
    } finally { f.close(); }
  }
});

test("only the exact current lease can update the bounded draft", async () => {
  const f = fixture();
  try {
    const lease = await verify(f, guest);
    const forged = storage.createScopeLease("guest", "other-lease");
    assert.equal(f.drafts.write(forged, "wrong lease"), "inactive");
    assert.equal(f.drafts.write(lease, "x".repeat(memory.MAX_RETAINED_COLLECTION_DRAFT_LENGTH)), "retained");
    assert.equal(f.drafts.write(lease, "y".repeat(memory.MAX_RETAINED_COLLECTION_DRAFT_LENGTH + 1)), "too-long");
    assert.equal(f.drafts.read(lease), null, "Do not restore an older partial draft");
    assert.equal(f.drafts.write(lease, "Fixed"), "retained");
    assert.equal(f.drafts.write(lease, ""), "retained");
    assert.equal(f.drafts.read(lease), null);
  } finally { f.close(); }
});
