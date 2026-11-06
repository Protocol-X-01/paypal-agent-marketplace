import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function configuredHeaders(mode, path = "/") {
  const cjsModule = { exports: {} };
  const noImports = () => { throw new Error("Unexpected runtime import in Next configuration"); };
  new Function("exports", "require", "module", "process", compiled)(cjsModule.exports, noImports, cjsModule, { env: { NODE_ENV: mode } });
  const rules = await cjsModule.exports.default.headers();
  assert.ok(rules.some((rule) => rule.source === "/:path*"), "Expected the security policy on all application paths");
  const matching = rules.filter((rule) => rule.source === "/:path*" || rule.source === path ||
    (rule.source === "/api/auth/:path*" && path.startsWith("/api/auth/")));
  return new Map(matching.flatMap((rule) => rule.headers.map((header) => [header.key.toLowerCase(), header.value])));
}

function directives(headers) {
  return new Map(headers.get("content-security-policy").split(";").map((item) => {
    const [name, ...values] = item.trim().split(/\s+/);
    return [name, values];
  }));
}

test("security headers constrain embedding, form destinations and base URLs", async () => {
  for (const mode of ["development", "production"]) {
    const headers = await configuredHeaders(mode);
    const policy = directives(headers);
    assert.deepEqual(policy.get("base-uri"), ["'self'"]);
    assert.deepEqual(policy.get("form-action"), ["'self'"]);
    assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
    assert.deepEqual(policy.get("object-src"), ["'none'"]);
    assert.equal(headers.get("x-frame-options"), "DENY");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
  }
});

test("only sign-in surfaces allow exact PayPal form destinations", async () => {
  for (const path of ["/dashboard", "/api/auth/paypal/start"]) {
    const policy = directives(await configuredHeaders("production", path));
    assert.deepEqual(policy.get("form-action"), ["'self'", "https://www.paypal.com", "https://www.sandbox.paypal.com"]);
    for (const name of ["base-uri", "frame-ancestors", "object-src"]) {
      assert.deepEqual(policy.get(name), directives(await configuredHeaders("production")).get(name));
    }
  }
  assert.deepEqual(directives(await configuredHeaders("production", "/api/auth/paypal/callback")).get("form-action"), ["'self'"]);
});

test("only auth endpoints override referrer policy", async () => {
  for (const path of ["/api/auth/paypal/start", "/api/auth/paypal/callback", "/api/auth/session", "/api/auth/logout"]) {
    assert.equal((await configuredHeaders("production", path)).get("referrer-policy"), "no-referrer");
  }
  assert.equal((await configuredHeaders("production", "/dashboard")).get("referrer-policy"), "strict-origin-when-cross-origin");
});

test("HSTS is sent only for the production configuration", async () => {
  assert.equal((await configuredHeaders("development")).has("strict-transport-security"), false);
  assert.equal((await configuredHeaders("production")).get("strict-transport-security"), "max-age=31536000");
});
