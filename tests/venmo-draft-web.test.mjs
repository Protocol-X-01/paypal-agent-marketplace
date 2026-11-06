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
    throw new Error(`Unexpected module in synthetic draft test: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}

const validation = await load("../src/lib/venmo-draft.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
function nodes(value) {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  return typeof value === "object" ? text(value.props?.children) : String(value);
}

async function createDraft() {
  const slots = [];
  const pendingEffects = [];
  const focusLog = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        const state = { dependencies, cleanup: previous?.cleanup };
        slots[index] = state;
        pendingEffects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  const Component = (await load("../src/app/components/venmo-draft.tsx", {
    react: hooks,
    "react/jsx-runtime": jsx,
    "@/lib/venmo-draft": validation,
    "./venmo-draft.module.css": { __esModule: true, default: {} },
  })).default;
  function render() {
    cursor = 0;
    pendingEffects.length = 0;
    const tree = Component();
    for (const node of nodes(tree)) {
      if (node.props?.ref) node.props.ref.current = { focus: () => focusLog.push(node.props.name ?? "review") };
    }
    for (const effect of pendingEffects) effect();
    return tree;
  }
  function input(name, value) {
    const field = nodes(render()).find((node) => node.type === "input" && node.props.name === name);
    assert.ok(field, `Expected ${name} input`);
    field.props.onChange({ target: { value } });
  }
  function submit() {
    const form = nodes(render()).find((node) => node.type === "form");
    assert.ok(form, "Expected draft form");
    form.props.onSubmit({ preventDefault() {} });
    return render();
  }
  function button(label) {
    const result = nodes(render()).find((node) => node.type === "button" && text(node.props.children) === label);
    assert.ok(result, `Expected ${label} button`);
    return result;
  }
  function unmount() {
    for (const state of slots) {
      if (Array.isArray(state?.dependencies) && typeof state.cleanup === "function") state.cleanup();
    }
    slots.length = 0;
  }
  return { render, input, submit, button, focusLog, unmount };
}

test("web draft accepts only unambiguous recipient text", () => {
  for (const value of ["", "@", "@@example", " example", "example ", "example\nother", "example@email.test", "x".repeat(41)]) {
    assert.equal(validation.checkDraftRecipient(value).ok, false, value);
  }
  assert.deepEqual(validation.checkDraftRecipient("@example.name_1-2"), { ok: true, display: "@example.name_1-2" });
  assert.equal(validation.followsPublishedUsernameGuidance("@example-name_1"), true);
  for (const value of ["@abcd", "@example.name", `@${"x".repeat(31)}`]) assert.equal(validation.followsPublishedUsernameGuidance(value), false, value);
});

test("web draft preserves entered cents without floating-point rounding", () => {
  for (const [input, display] of [["1", "$1.00"], [",5", "$0.50"], ["00012.3", "$12.30"], ["9999999999999999.99", "$9,999,999,999,999,999.99"]]) {
    assert.deepEqual(validation.checkDraftAmount(input), { ok: true, display }, input);
  }
  for (const value of ["", "0", "0.00", ".", "1.", "1e3", "-1", "1.234", "1,234.56", "9".repeat(33)]) {
    assert.equal(validation.checkDraftAmount(value).ok, false, value);
  }
});

test("the review screen requires both valid fields and identifies the problem", async () => {
  const draft = await createDraft();
  draft.input("recipient", "@");
  draft.input("amount", "1.234");
  const tree = draft.submit();
  assert.ok(nodes(tree).some((node) => node.type === "form"));
  assert.match(text(tree), /Check the highlighted fields/);
  assert.equal(nodes(tree).find((node) => node.type === "input" && node.props.name === "recipient").props["aria-invalid"], true);
  assert.equal(nodes(tree).find((node) => node.type === "input" && node.props.name === "amount").props["aria-invalid"], true);
  assert.ok(!nodes(tree).some((node) => node.type === "button" && text(node.props.children) === "Copy draft details"));
});

test("review and copied draft use the exact validated username and amount", async () => {
  const draft = await createDraft();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied = "";
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value) => { copied = value; } } } });
  try {
    draft.input("recipient", "@fictional.user");
    draft.input("amount", "9999999999999999.99");
    const review = draft.submit();
    assert.match(text(review), /@fictional\.user/);
    assert.match(text(review), /\$9,999,999,999,999,999\.99/);
    assert.match(text(review), /differs from Venmo’s current published format/);
    await draft.button("Copy draft details").props.onClick();
    assert.match(copied, /Recipient: @fictional\.user/);
    assert.match(copied, /Amount: \$9,999,999,999,999,999\.99/);
    assert.match(copied, /Draft only/);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("an unfinished copy allows editing but cannot overwrite a newer copy", async () => {
  const draft = await createDraft();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let completeCopy;
  const writes = [];
  const write = new Promise((resolve) => { completeCopy = resolve; });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: (value) => { writes.push(value); return writes.length === 1 ? write : Promise.resolve(); } } } });
  try {
    draft.input("recipient", "@fictional_user");
    draft.input("amount", "12.34");
    draft.submit();
    const handler = draft.button("Copy draft details").props.onClick;
    const firstCopy = handler();
    assert.equal(draft.button("Copying…").props.disabled, true);
    assert.equal(draft.button("Edit draft").props.disabled, undefined);
    assert.equal(draft.button("Clear draft").props.disabled, undefined);
    await handler();
    assert.equal(writes.length, 1);
    assert.match(text(draft.render()), /Another draft copy is in progress/);
    draft.button("Edit draft").props.onClick();
    assert.match(text(draft.render()), /earlier copy is still in progress/);
    assert.equal(draft.focusLog.at(-1), "recipient");
    draft.input("amount", "15.67");
    draft.submit();
    completeCopy();
    await firstCopy;
    assert.match(text(draft.render()), /earlier copy attempt finished/);
    await draft.button("Copy draft details").props.onClick();
    assert.equal(writes.length, 2);
    assert.match(writes[0], /Amount: \$12\.34/);
    assert.match(writes[1], /Amount: \$15\.67/);
  } finally {
    completeCopy?.();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("clearing a reviewed draft returns focus to the emptied recipient field", async () => {
  const draft = await createDraft();
  draft.input("recipient", "@fictional_user");
  draft.input("amount", "1.00");
  draft.submit();
  draft.button("Clear draft").props.onClick();
  const tree = draft.render();
  assert.equal(draft.focusLog.at(-1), "recipient");
  assert.equal(nodes(tree).find((node) => node.type === "input" && node.props.name === "recipient").props.value, "");
  assert.equal(nodes(tree).find((node) => node.type === "input" && node.props.name === "amount").props.value, "");
  assert.match(text(tree), /Draft cleared/);
});

test("a pending copy remains guarded after leaving and reopening the draft", async () => {
  const draft = await createDraft();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const writes = [];
  let completeCopy;
  const write = new Promise((resolve) => { completeCopy = resolve; });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: (value) => { writes.push(value); return writes.length === 1 ? write : Promise.resolve(); } } } });
  try {
    draft.input("recipient", "@first_user");
    draft.input("amount", "1.00");
    draft.submit();
    const earlierCopy = draft.button("Copy draft details").props.onClick();
    draft.unmount();
    draft.input("recipient", "@second_user");
    draft.input("amount", "2.00");
    draft.submit();
    await draft.button("Copy draft details").props.onClick();
    assert.equal(writes.length, 1);
    assert.match(text(draft.render()), /Another draft copy is in progress/);
    completeCopy();
    await earlierCopy;
    await draft.button("Copy draft details").props.onClick();
    assert.equal(writes.length, 2);
    assert.match(writes[1], /Recipient: @second_user/);
    assert.match(writes[1], /Amount: \$2\.00/);
  } finally {
    completeCopy?.();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});
