import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected module in percentage test: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}

const webPercentage = await load("../src/lib/business-percentage.ts");
const nativePercentage = await load("../apps/mobile/src/lib/business-percentage.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  return typeof value === "object" ? text(value.props?.children) : String(value);
}
function hooks(overrides) {
  let index = 0;
  return {
    useState(initial) { const value = Object.hasOwn(overrides, index) ? overrides[index] : initial; index += 1; return [value, () => {}]; },
    useRef(initial) { return { current: initial }; },
    useEffect() {},
    useCallback(callback) { return callback; },
  };
}
function summary(changePct) {
  return { changePct, rowsInFile: 4001, outsidePeriods: 0, previous: {}, current: {} };
}

test("percentage formatting preserves tiny changes, true zero and unavailable values on both platforms", () => {
  for (const api of [webPercentage, nativePercentage]) {
    assert.equal(api.formatBusinessPercentage(0.0001, true), "Increase under 0.1%");
    assert.equal(api.formatBusinessPercentage(-0.0001, true), "Decrease under 0.1%");
    assert.equal(api.formatBusinessPercentage(0.0001), "Under 0.1%");
    assert.equal(api.formatBusinessPercentage(0, true), "0.0%");
    assert.equal(api.formatBusinessPercentage(-0, true), "0.0%");
    assert.equal(api.formatBusinessPercentage(null, true), "Unavailable");
    assert.equal(api.formatBusinessPercentage(Infinity), "Unavailable");
    assert.equal(api.formatBusinessPercentage(0.1, true), "+0.1%");
    assert.equal(api.formatBusinessPercentage(-0.1, true), "-0.1%");
  }
});

test("both PayPal Activity previews label tiny changes as included report rows", async () => {
  for (const [value, expected] of [[0.01, "Increase under 0.1%"], [-0.01, "Decrease under 0.1%"], [0, "0.0%"], [null, "Unavailable — previous included count is zero"]]) {
    const web = (await load("../src/app/components/paypal-activity-panel.tsx", {
      react: hooks({ 5: summary(value) }),
      "react/jsx-runtime": jsx,
      "@/lib/paypal-activity-import": { PAYPAL_ACTIVITY_MAX_BYTES: 4194304 },
      "@/lib/business-percentage": webPercentage,
      "./paypal-activity-panel.module.css": { __esModule: true, default: {} },
    })).default({ onReportChange() {} });

    const native = (await load("../apps/mobile/src/components/paypal-activity-panel.tsx", {
      react: hooks({ 0: true, 6: summary(value) }),
      "react/jsx-runtime": jsx,
      "react-native": { AppState: {}, Keyboard: {}, Platform: { OS: "android" }, Pressable: "Pressable", StyleSheet: { create: (styles) => styles }, Switch: "Switch", Text: "Text", TextInput: "TextInput", View: "View" },
      "expo-clipboard": {},
      "expo-router": { useFocusEffect() {} },
      "@/components/native-button": { NativeButton: "NativeButton" },
      "@/lib/business-percentage": nativePercentage,
      "@/lib/paypal-activity-clipboard": { canReadActivityClipboard: () => false, usableEndDate: () => false },
      "@/lib/report-lifecycle": { watchReportLifecycle() {} },
    })).PayPalActivityPanel();
    for (const tree of [web, native]) {
      assert.ok(text(tree).includes(`Included row change: ${expected}`));
      assert.match(text(tree), /not unique customers/i);
    }
  }
});
