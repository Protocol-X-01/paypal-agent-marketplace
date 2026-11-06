import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/storefront-storage.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { readSavedStorefront } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("preserves legacy, current, and future storefront provenance", () => {
  assert.equal(readSavedStorefront(undefined), null);
  assert.equal(readSavedStorefront(null), null);
  for (const code of ["GB", "US", "CA"]) assert.equal(readSavedStorefront(code), code);
});

test("rejects malformed saved provenance so the existing collection remains recoverable", () => {
  for (const value of ["gb", "GBR", "", 1, {}, ["US"]]) assert.throws(() => readSavedStorefront(value));
});
