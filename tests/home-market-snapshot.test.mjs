import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadSource(path, modules = {}, globals = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`Unexpected module in synthetic homepage test: ${name}`);
  };
  new Function("exports", "require", "module", ...Object.keys(globals), code)(loaded.exports, require, loaded, ...Object.values(globals));
  return loaded.exports;
}

const formatting = await loadSource("../src/lib/market-format.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
}

async function createHomepage(fetchMock) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const react = {
    createContext(initial) {
      const context = { value: initial };
      context.Provider = { context };
      return context;
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useEffect(effect) { effects.push(effect); },
    useContext(context) { return context.value; },
  };
  const components = await loadSource("../src/app/components/live-markets.tsx", {
    react,
    "react/jsx-runtime": jsx,
    "@/lib/market-format": formatting,
    "../home.module.css": { default: {} },
  }, { fetch: fetchMock });

  function renderProvider() {
    cursor = 0;
    const provider = components.MarketSnapshotProvider({ children: null });
    provider.type.context.value = provider.props.value;
    return provider.props.value;
  }
  return { renderProvider, renderMarket: components.default, effects };
}

const bitcoin = {
  id: "bitcoin", name: "Bitcoin", symbol: "BTC", rank: 1,
  priceUsd: 71234.56, marketCapUsd: 1000000, volume24hUsd: 100000,
  change24hPct: 2, sparkline7d: [10, 11],
};
const chainlink = { ...bitcoin, id: "chainlink", name: "Chainlink", symbol: "LINK", rank: 2, priceUsd: 12.34 };
const paypalUsd = { ...bitcoin, id: "paypal-usd", name: "PayPal USD", symbol: "PYUSD", rank: 3, priceUsd: 1.0001 };

test("one provider effect supplies the same snapshot to hero and market cards", async () => {
  const calls = [];
  const page = await createHomepage(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ retrievedAt: "2026-11-06T06:05:30.123Z", coins: [bitcoin, chainlink, paypalUsd] }) };
  });
  assert.equal(page.renderProvider().status, "loading");
  const cancel = page.effects[0]();
  await flush();
  await flush();
  assert.equal(page.renderProvider().status, "ready");
  const hero = textOf(page.renderMarket({ variant: "hero" }));
  const cards = textOf(page.renderMarket({ variant: "grid" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/market/coins");
  assert.equal(calls[0].options.cache, "no-store");
  assert.match(hero, /\$71,234\.56/);
  assert.match(cards, /\$71,234\.56/);
  assert.match(hero, /\$12\.34/);
  assert.match(cards, /\$12\.34/);
  assert.match(hero, /\$1\.0001/);
  assert.match(cards, /\$1\.0001/);
  assert.match(hero, /Snapshot retrieved 2026-11-06 06:05:30 UTC/);
  assert.match(cards, /Snapshot retrieved 2026-11-06 06:05:30 UTC/);
  cancel();
});

test("an aborted homepage request cannot publish a late response", async () => {
  let resolveRequest;
  const page = await createHomepage(() => new Promise((resolve) => { resolveRequest = resolve; }));
  page.renderProvider();
  const cancel = page.effects[0]();
  cancel();
  resolveRequest({ ok: true, json: async () => ({ retrievedAt: "2026-11-06T06:05:30Z", coins: [bitcoin] }) });
  await flush();
  await flush();
  assert.equal(page.renderProvider().status, "loading");
});

test("a failed shared request leaves both homepage views in their error state", async () => {
  const page = await createHomepage(async () => ({ ok: false }));
  page.renderProvider();
  const cancel = page.effects[0]();
  await flush();
  await flush();
  assert.equal(page.renderProvider().status, "error");
  assert.match(textOf(page.renderMarket({ variant: "hero" })), /temporarily unavailable/i);
  assert.match(textOf(page.renderMarket({ variant: "grid" })), /unavailable/i);
  cancel();
});

test("a partial snapshot without Bitcoin does not leave the hero loading", async () => {
  const page = await createHomepage(async () => ({ ok: true, json: async () => ({ retrievedAt: "2026-11-06T06:05:30Z", coins: [chainlink] }) }));
  page.renderProvider();
  const cancel = page.effects[0]();
  await flush();
  await flush();
  assert.equal(page.renderProvider().status, "ready");
  assert.match(textOf(page.renderMarket({ variant: "hero" })), /Bitcoin is unavailable in this snapshot/);
  assert.match(textOf(page.renderMarket({ variant: "grid" })), /\$12\.34/);
  cancel();
});

test("an empty snapshot does not leave either homepage view loading", async () => {
  const page = await createHomepage(async () => ({ ok: true, json: async () => ({ retrievedAt: "2026-11-06T06:05:30Z", coins: [] }) }));
  page.renderProvider();
  const cancel = page.effects[0]();
  await flush();
  await flush();
  assert.equal(page.renderProvider().status, "ready");
  assert.match(textOf(page.renderMarket({ variant: "hero" })), /Bitcoin is unavailable in this snapshot/);
  assert.match(textOf(page.renderMarket({ variant: "grid" })), /No market prices are available in this snapshot/);
  cancel();
});

test("retrieval labels include the date and handle an invalid timestamp", () => {
  assert.equal(formatting.formatMarketRetrievalTime("2026-11-06T06:05:30Z"), "2026-11-06 06:05:30 UTC");
  assert.equal(formatting.formatMarketRetrievalTime("not a timestamp"), null);
  assert.equal(formatting.formatMarketRetrievalTime(null), null);
});
