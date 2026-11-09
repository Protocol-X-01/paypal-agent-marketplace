// Synthetic React hook and native-component harness: no device, real storage, or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

function loadSource(relativePath, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, id)) return dependencies[id];
    if (id.startsWith('@/lib/')) return loadMobileAlias(id);
    throw new Error(`Unexpected module in synthetic test: ${id}`);
  };
  new Function('exports', 'require', 'module', ...Object.keys(globals), compiled)(loaded.exports, localRequire, loaded, ...Object.values(globals));
  return loaded.exports;
}

const holding = loadSource('src/lib/holding-input.ts');
const persistence = loadSource('src/lib/portfolio-persistence.ts');
const actualCurrency = loadSource('src/lib/currency.ts');
const { formatProviderUpdate } = loadSource('src/lib/market.ts', { './currency': actualCurrency });
const assets = [
  { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', color: '#111111', monogram: 'B' },
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', color: '#222222', monogram: 'E' },
];
const market = { ASSETS: assets, formatProviderUpdate, formatTimestamp: (value) => value, formatUsd: (value) => `$${value}` };
const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment: 'Fragment',
};

function createHookRuntime() {
  const slots = [];
  let next = 0;
  let dirty = true;
  let pendingEffects = [];
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const hooks = {
    createContext: () => ({ Provider: 'ContextProvider' }),
    useState(initial) {
      const index = next++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => {
        const updated = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(updated, slots[index].value)) { slots[index].value = updated; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = next++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(fn, deps) {
      const index = next++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: fn(), deps };
      return slots[index].value;
    },
    useCallback(fn, deps) {
      const index = next++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: fn, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = next++;
      const prior = slots[index];
      if (!prior || !sameDeps(prior.deps, deps)) {
        const slot = { deps, cleanup: prior?.cleanup };
        slots[index] = slot;
        pendingEffects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
      }
    },
    useContext: () => { throw new Error('Unexpected useContext in provider harness'); },
  };
  return {
    hooks,
    render(component) {
      next = 0;
      dirty = false;
      pendingEffects = [];
      const tree = component({ children: null });
      for (const effect of pendingEffects) effect();
      return tree.props.value;
    },
    isDirty: () => dirty,
  };
}

async function createHarness(savedHoldings = { bitcoin: '2', ethereum: '3' }, prices = { bitcoin: 100, ethereum: 10 }, options = {}) {
  const legacyKey = 'paypal-markets.mobile.manual-holdings.v1';
  const storage = new Map([[legacyKey, options.rawHoldings ?? JSON.stringify(savedHoldings)]]);
  const writes = [];
  let failWrite = false;
  let failVerification = false;
  let failNextRead = false;
  let pausedWrite = null;
  const AsyncStorage = {
    async getItem(key) {
      if (key === legacyKey && failNextRead) { failNextRead = false; throw new Error('synthetic read failure'); }
      return storage.get(key) ?? null;
    },
    async setItem(key, value) {
      writes.push({ key, value });
      if (key === legacyKey && pausedWrite) { const pending = pausedWrite; pausedWrite = null; await pending.promise; }
      if (key === legacyKey && failWrite) { failWrite = false; throw new Error('synthetic write failure'); }
      storage.set(key, value);
      if (key === legacyKey && failVerification) { failVerification = false; failNextRead = true; }
    },
    async removeItem(key) { storage.delete(key); },
  };
  const resource = {
    loadPreferenceWithTimeout: (read, success, fail) => { void read().then(success, fail); return () => {}; },
    loadMarketResource: () => () => {},
    marketDataToPersist: () => null,
    createLatestCacheWriter: () => () => {},
  };
  const runtime = createHookRuntime();
  const { DataProvider } = loadSource('src/lib/data-context.tsx', {
    react: runtime.hooks,
    'react/jsx-runtime': jsxRuntime,
    'react-native': { Platform: { OS: 'web' } },
    '@react-native-async-storage/async-storage': { __esModule: true, default: AsyncStorage },
    'expo-secure-store': {},
    './currency': { DEFAULT_DISPLAY_CURRENCY: 'USD', isDisplayCurrency: (value) => value === 'USD' },
    './holding-input': holding,
    './market': market,
    './market-resource': resource,
    './portfolio-persistence': persistence,
    './customer-storage-scope': loadSource('src/lib/customer-storage-scope.ts'),
  });
  let context = runtime.render(DataProvider);
  async function settle() {
    for (let i = 0; i < 16; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (runtime.isDirty()) context = runtime.render(DataProvider);
    }
  }
  await settle();
  if (options.rawHoldings === undefined) assert.equal(context.portfolioReady, true);

  const portfolioValue = loadSource('src/lib/portfolio-value.ts', { './market': market, './holding-input': holding });
  // The screen stub supplies Venmo hooks only to render the portfolio; these
  // tests exercise holding interactions, not the Venmo hook lifecycle.
  let screenStateCursor = 0;
  let responsiveLayout = { wideCanvas: false, pairedPanels: false, shopGrid: false };
  const screenReact = {
    useEffect: () => {}, useMemo: (fn) => fn(), useRef: (initial) => ({ current: initial }),
    useState(initial) {
      const index = screenStateCursor++;
      const state = options.screenStates ?? {};
      return [Object.hasOwn(state, index) ? state[index] : initial, () => {}];
    },
  };
  const native = {
    Alert: options.alert ?? {}, Platform: { OS: options.screenPlatform ?? 'web' }, StyleSheet: { create: (styles) => Object.fromEntries(Object.entries(styles).map(([name, style]) => [name, { ...style, _name: name }])) },
    KeyboardAvoidingView: 'KeyboardAvoidingView', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
  };
  const guestFence = loadSource('src/lib/customer-storage-scope.ts').createCustomerStorageFence({ kind: 'guest' });
  const contactStorage = new Map();
  const contacts = loadSource('src/lib/venmo-contacts.ts', {
    'expo-secure-store': {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
      isAvailableAsync: async () => true,
      getItemAsync: async key => contactStorage.get(key) ?? null,
      setItemAsync: async (key, value) => { contactStorage.set(key, value); },
      deleteItemAsync: async key => { contactStorage.delete(key); },
    },
  });
  // Render the real private content; boundary visibility is tested separately.
  const { PortfolioContent } = loadSource('src/app/portfolio.tsx', {
    react: screenReact,
    'react/jsx-runtime': jsxRuntime,
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-clipboard': {},
    '@/components/customer-private-boundary': { CustomerPrivateBoundary: 'CustomerPrivateBoundary' },
    '@/lib/customer-session-context': { useCustomerSession: () => ({ status: 'guest', identity: null, revision: 0, storageFence: guestFence }) },
    '@/components/market-header': { MarketHeader: 'MarketHeader' },
    '@/components/native-button': { NativeButton: 'NativeButton' },
    '@/components/portfolio-allocation': { PortfolioAllocation: 'PortfolioAllocation' },
    '@/lib/currency': { formatCurrency: options.realCurrency ? actualCurrency.formatCurrency : (amount) => `$${amount}` },
    '@/lib/data-context': { useData: () => ({ ...context, overview: { data: { retrievedAt: '2026-11-06T10:00:00Z', coins: [{ id: 'bitcoin', price: prices.bitcoin, lastUpdated: options.updates?.bitcoin ?? null }, { id: 'ethereum', price: prices.ethereum, lastUpdated: options.updates?.ethereum ?? null }] }, loading: false, stale: false, error: null } }) },
    '@/lib/holding-input': holding,
    '@/lib/market': market,
    '@/lib/portfolio-value': portfolioValue,
    '@/lib/responsive-layout': { useResponsiveLayout: () => responsiveLayout },
    '@/lib/venmo-draft-amount': loadSource('src/lib/venmo-draft-amount.ts'),
    '@/lib/venmo-contacts': contacts,
  }, { window: options.window });
  const treeNodes = (node) => {
    if (Array.isArray(node)) return node.flatMap(treeNodes);
    if (!node || typeof node !== 'object') return [];
    return [node, ...treeNodes(node.props?.children)];
  };
  function screen() {
    screenStateCursor = 0;
    const nodes = treeNodes(PortfolioContent());
    return {
      input: (name) => nodes.find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === `${name} holding quantity`),
      summary: () => nodes.find((node) => node.props?.style?._name === 'summaryValue'),
      rowValues: () => nodes.filter((node) => node.props?.style?._name === 'holdingValue').map((node) => node.props.children),
      rowValueLabels: () => nodes.filter((node) => node.props?.style?._name === 'holdingValue').map((node) => node.props.accessibilityLabel),
      priceRows: () => nodes.filter((node) => node.props?.style?._name === 'holdingSymbol'),
      providerUpdates: () => nodes.filter((node) => node.props?.style?._name === 'holdingQuoteUpdate').map((node) => node.props.children.join('')),
      allocation: () => nodes.find((node) => node.type === 'PortfolioAllocation')?.props,
      paired: () => nodes.some((node) => node.type === 'View' && node.props?.style?._name === 'summaryPanels'),
      text: () => nodes.filter((node) => node.type === 'Text').flatMap((node) => Array.isArray(node.props.children) ? node.props.children : [node.props.children]).filter((item) => typeof item === 'string').join(' '),
      save: () => nodes.find((node) => node.type === 'NativeButton' && node.props.label === 'Save valid quantities'),
      retry: () => nodes.find((node) => node.type === 'NativeButton' && node.props.label === 'Retry saving quantities'),
      copyDraft: () => nodes.find((node) => node.type === 'NativeButton' && node.props.label === 'Copy draft text'),
      forgetUnreadable: () => nodes.find((node) => node.type === 'NativeButton' && node.props.label === 'Forget unreadable quantities'),
    };
  }
  return {
    settle, screen, current: () => context,
    setLayout: (value) => { responsiveLayout = value; },
    saved: () => JSON.parse(storage.get(legacyKey)),
    rawSaved: () => storage.get(legacyKey) ?? null,
    revokeScreenScope: () => guestFence.invalidate(),
    holdingWrites: () => writes.filter((write) => write.key === legacyKey),
    failNextWrite: () => { failWrite = true; },
    failNextVerification: () => { failVerification = true; },
    changeStored: (value) => { storage.set(legacyKey, JSON.stringify(value)); },
    pauseNextWrite: () => {
      let reject;
      const promise = new Promise((resolve, rejectPromise) => { reject = rejectPromise; });
      pausedWrite = { promise };
      return () => reject(new Error('synthetic delayed write failure'));
    },
  };
}

test('allocation uses the complete estimate and withholds a missing-price portfolio', async () => {
  const complete = await createHarness();
  assert.equal(complete.screen().allocation().total, 230);
  assert.deepEqual(complete.screen().allocation().positions.map(({ id, value }) => [id, value]), [['bitcoin', 200], ['ethereum', 30]]);
  const missing = await createHarness({ bitcoin: '2', ethereum: '3' }, { bitcoin: 100, ethereum: null });
  assert.equal(missing.screen().allocation().total, null);
  assert.match(missing.screen().allocation().unavailableMessage, /prices are needed for 1 holding/i);
});

test('web recovery keeps unreadable data on decline or when confirmation is unavailable', async () => {
  const corrupt = '{fictional-unreadable-data';
  const prompts = [];
  const declined = await createHarness({}, {}, { rawHoldings: corrupt, window: { confirm: (message) => { prompts.push(message); return false; } } });
  assert.equal(declined.current().portfolioStatus, 'corrupt');
  declined.screen().forgetUnreadable().props.onPress();
  await declined.settle();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Forget saved quantities/);
  assert.equal(declined.rawSaved(), corrupt);
  assert.equal(declined.current().portfolioStatus, 'corrupt');

  const unavailable = await createHarness({}, {}, { rawHoldings: corrupt });
  unavailable.screen().forgetUnreadable().props.onPress();
  await unavailable.settle();
  assert.equal(unavailable.rawSaved(), corrupt);
  assert.equal(unavailable.current().portfolioStatus, 'corrupt');
});

test('web recovery deletes unreadable data only after confirmation in the current scope', async () => {
  const corrupt = '{fictional-unreadable-data';
  const app = await createHarness({}, {}, { rawHoldings: corrupt, window: { confirm: () => true } });
  assert.equal(app.rawSaved(), corrupt);
  app.screen().forgetUnreadable().props.onPress();
  await app.settle();
  assert.equal(app.rawSaved(), null);
  assert.equal(app.current().portfolioStatus, 'saved-web');
  assert.equal(app.current().portfolioReady, true);

  let stale;
  stale = await createHarness({}, {}, { rawHoldings: corrupt, window: { confirm: () => { stale.revokeScreenScope(); return true; } } });
  stale.screen().forgetUnreadable().props.onPress();
  await stale.settle();
  assert.equal(stale.rawSaved(), corrupt);
  assert.equal(stale.current().portfolioStatus, 'corrupt');
});

test('native recovery waits for destructive confirmation and rejects a stale callback', async () => {
  const corrupt = '{fictional-unreadable-data';
  let buttons;
  const alert = { alert: (_title, _message, choices) => { buttons = choices; } };
  const app = await createHarness({}, {}, { rawHoldings: corrupt, screenPlatform: 'android', alert });
  app.screen().forgetUnreadable().props.onPress();
  assert.ok(buttons.some((button) => button.style === 'cancel'));
  assert.equal(app.rawSaved(), corrupt);
  buttons.find((button) => button.style === 'destructive').onPress();
  await app.settle();
  assert.equal(app.rawSaved(), null);

  const stale = await createHarness({}, {}, { rawHoldings: corrupt, screenPlatform: 'ios', alert });
  stale.screen().forgetUnreadable().props.onPress();
  stale.revokeScreenScope();
  buttons.find((button) => button.style === 'destructive').onPress();
  await stale.settle();
  assert.equal(stale.rawSaved(), corrupt);
});

test('tablet reflow keeps an in-progress holding draft without writing it', async () => {
  const app = await createHarness();
  app.screen().input('Bitcoin').props.onChangeText('2.');
  await app.settle();
  assert.equal(app.screen().paired(), false);
  app.setLayout({ wideCanvas: true, pairedPanels: true, shopGrid: true });
  const view = app.screen();
  assert.equal(view.paired(), true);
  assert.equal(view.input('Bitcoin').props.value, '2.');
  assert.deepEqual(app.saved(), { bitcoin: '2', ethereum: '3' });
  assert.equal(app.holdingWrites().length, 0);
});

test('unsupported pasted notation and excess precision stay visible without changing storage or the estimate', async () => {
  const app = await createHarness();
  for (const [raw, notice] of [['1e-8', 'Scientific notation'], ['0.00000000001', '10 decimal places'], ['9'.repeat(600), '32 characters']]) {
    let view = app.screen();
    assert.equal(view.input('Bitcoin').props.maxLength, undefined, 'pasted input is not truncated before validation');
    view.input('Bitcoin').props.onChangeText(raw);
    await app.settle();
    view = app.screen();
    assert.equal(view.input('Bitcoin').props.value, raw);
    assert.match(view.text(), new RegExp(notice));
    assert.equal(view.summary().props.children, '—');
    assert.equal(view.summary().props.accessibilityLabel, 'Portfolio estimate unavailable');
    view.input('Bitcoin').props.onBlur();
    await app.settle();
    assert.equal(app.screen().input('Bitcoin').props.value, raw, 'leaving the field preserves the invalid draft');
    assert.deepEqual(app.saved(), { bitcoin: '2', ethereum: '3' });
    assert.equal(app.holdingWrites().length, 0);
  }
});

test('complete decimals preview immediately and save unchanged on blur or explicit save', async () => {
  const app = await createHarness();
  app.screen().input('Bitcoin').props.onChangeText('0.1');
  await app.settle();
  let view = app.screen();
  assert.equal(view.input('Bitcoin').props.value, '0.1');
  assert.equal(view.summary().props.children, '$40');
  assert.equal(app.saved().bitcoin, '2', 'editing alone has not committed');
  view.input('Bitcoin').props.onBlur();
  await app.settle();
  assert.equal(app.saved().bitcoin, '0.1');
  assert.equal(app.current().portfolioStatus, 'saved-web');
  view = app.screen();
  view.input('Ethereum').props.onChangeText('0,25');
  await app.settle();
  view = app.screen();
  assert.equal(view.input('Ethereum').props.value, '0,25');
  assert.equal(view.summary().props.children, '$12.5');
  view.save().props.onPress();
  await app.settle();
  assert.deepEqual(app.saved(), { bitcoin: '0.1', ethereum: '0.25' });
});

test('an incomplete draft survives navigation and save-valid leaves the prior saved value intact', async () => {
  const app = await createHarness();
  app.screen().input('Bitcoin').props.onChangeText('0.');
  await app.settle();
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  // A new screen render models leaving the tab and returning while the provider stays mounted.
  let view = app.screen();
  assert.equal(view.input('Bitcoin').props.value, '0.');
  assert.equal(view.summary().props.children, '—');
  assert.match(view.text(), /Finish this quantity before saving/);
  view.input('Ethereum').props.onChangeText('4.5');
  await app.settle();
  view = app.screen();
  view.save().props.onPress();
  await app.settle();
  assert.equal(app.screen().input('Bitcoin').props.value, '0.');
  assert.equal(app.screen().summary().props.children, '—');
  assert.deepEqual(app.saved(), { bitcoin: '2', ethereum: '4.5' });
});

test('empty clears only on commit and legacy incomplete values remain unmodified', async () => {
  const app = await createHarness({ bitcoin: '1.', ethereum: '3' });
  assert.equal(app.screen().summary().props.children, '—');
  assert.equal(app.screen().input('Bitcoin').props.value, '1.');
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  assert.equal(app.saved().bitcoin, '1.');
  app.screen().input('Bitcoin').props.onChangeText('');
  await app.settle();
  assert.equal(app.saved().bitcoin, '1.');
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  assert.deepEqual(app.saved(), { ethereum: '3' });
});

test('classification never converts malformed drafts into a different amount', () => {
  for (const value of ['-1', '1 2', '1.2.3', '1,2,3', '1e-8', '1_000']) {
    assert.equal(holding.parseHoldingInput(value).kind, 'invalid', value);
  }
  for (const value of ['.', ',', '0.', '0,']) assert.equal(holding.parseHoldingInput(value).kind, 'incomplete', value);
  assert.deepEqual(holding.parseHoldingInput('.5'), { kind: 'valid', value: '.5' });
  assert.deepEqual(holding.parseHoldingInput('0,5'), { kind: 'valid', value: '0.5' });
});

test('valuation bounds preserve quantity text and apply equally to the row and total', async () => {
  for (const [value, expected] of [
    ['.0000000001', 0.0000000001],
    ['00000000000000000000000000000001', 1],
    ['999999999999.999', 999999999999.999],
    ['1000000000000', 1000000000000],
    ['999999999999.9999', null],
    ['1000000000001', null],
    ['1000000000000.0000000001', null],
    ['99999999999999999999999999999999', null],
  ]) assert.equal(holding.holdingQuantityForEstimate(value), expected, value);

  const large = '99999999999999999999999999999999';
  const app = await createHarness({ bitcoin: large, ethereum: '3' });
  let view = app.screen();
  assert.equal(view.input('Bitcoin').props.value, large);
  assert.equal(view.summary().props.children, '—');
  assert.deepEqual(view.rowValues(), ['$30']);
  assert.match(view.text(), /up to 1 trillion and 15 significant digits/);
  view.input('Bitcoin').props.onChangeText('1000000000000.0000000001');
  await app.settle();
  view = app.screen();
  view.input('Bitcoin').props.onBlur();
  await app.settle();
  assert.equal(app.saved().bitcoin, '1000000000000.0000000001');
  assert.equal(app.screen().summary().props.children, '—');
  assert.deepEqual(app.screen().rowValues(), ['$30']);
});

test('large individual or combined monetary values are withheld before precision becomes misleading', async () => {
  const bound = await createHarness({ bitcoin: '1000000000000' }, { bitcoin: 1, ethereum: 1 });
  assert.equal(bound.screen().summary().props.children, '$1000000000000');
  assert.deepEqual(bound.screen().rowValues(), ['$1000000000000']);

  const product = await createHarness({ bitcoin: '999999999999.999', ethereum: '3' }, { bitcoin: 123456.78901234, ethereum: 1 });
  assert.equal(product.screen().summary().props.children, '—');
  assert.deepEqual(product.screen().rowValues(), ['$3']);
  assert.match(product.screen().text(), /up to 1 trillion USD in value/);
  assert.equal(product.saved().bitcoin, '999999999999.999');

  const aggregate = await createHarness({ bitcoin: '600000000000', ethereum: '500000000000' }, { bitcoin: 1, ethereum: 1 });
  assert.equal(aggregate.screen().summary().props.children, '—');
  assert.deepEqual(aggregate.screen().rowValues(), ['$600000000000', '$500000000000']);
});

test('tiny positive values are not displayed as zero, while true zero stays zero', async () => {
  const tiny = await createHarness({ bitcoin: '0.0000000001' }, { bitcoin: 1, ethereum: 1 }, { realCurrency: true });
  assert.equal(tiny.screen().summary().props.children, '< $0.00000001');
  assert.equal(tiny.screen().summary().props.accessibilityLabel, 'Less than $0.00000001');
  assert.deepEqual(tiny.screen().rowValues(), ['< $0.00000001']);
  assert.deepEqual(tiny.screen().rowValueLabels(), ['Less than $0.00000001']);

  const tinyPrice = await createHarness({ bitcoin: '1' }, { bitcoin: 0.0000000001, ethereum: 1 }, { realCurrency: true });
  assert.equal(tinyPrice.screen().priceRows()[0].props.children.join(''), 'BTC · < $0.00000001');
  assert.equal(tinyPrice.screen().priceRows()[0].props.accessibilityLabel, 'Bitcoin reference price: Less than $0.00000001');

  const threshold = await createHarness({ bitcoin: '0.00000001' }, { bitcoin: 1, ethereum: 1 }, { realCurrency: true });
  assert.equal(threshold.screen().summary().props.children, '$0.00000001');
  const zero = await createHarness({ bitcoin: '1' }, { bitcoin: 0, ethereum: 1 }, { realCurrency: true });
  assert.equal(zero.screen().summary().props.children, '$0.00');
  assert.deepEqual(zero.screen().rowValues(), ['$0.00']);
});

test('each entered holding identifies the provider update time, separately from retrieval', async () => {
  const app = await createHarness(
    { bitcoin: '2', ethereum: '3' },
    { bitcoin: 100, ethereum: 10 },
    { updates: { bitcoin: '2026-11-05T22:11:04Z' } },
  );
  assert.deepEqual(app.screen().providerUpdates(), [
    'Provider update: 2026-11-05 22:11:04.000 UTC',
    'Provider update: Time unavailable',
  ]);
  assert.match(app.screen().text(), /Prices retrieved 2026-11-06T10:00:00Z/);
  app.screen().input('Ethereum').props.onChangeText('0');
  await app.settle();
  assert.equal(app.screen().providerUpdates().length, 1);
});

test('Venmo username guidance is visible without blocking legacy saved or draft handles', async () => {
  const savedContact = { id: 'contact-legacy', displayName: 'Fictional', handle: 'old.name' };
  const app = await createHarness({}, { bitcoin: 1, ethereum: 1 }, {
    screenStates: { 1: '@old.name', 8: [savedContact], 9: 'ready' },
  });
  const view = app.screen();
  assert.match(view.text(), /Check this username in Venmo/);
  assert.equal((view.text().match(/Venmo says usernames are 5–30 characters/g) ?? []).length, 1);
  assert.equal(view.copyDraft().props.disabled, false);

  const good = await createHarness({}, { bitcoin: 1, ethereum: 1 }, {
    screenStates: { 1: '@valid-user', 8: [{ ...savedContact, handle: 'valid-user' }], 9: 'ready' },
  });
  assert.doesNotMatch(good.screen().text(), /Venmo says usernames are 5–30 characters/);
  assert.doesNotMatch(good.screen().text(), /Check this username in Venmo/);
});

test('a failed write preserves the draft and a safe retry saves it', async () => {
  const app = await createHarness();
  app.failNextWrite();
  app.screen().input('Bitcoin').props.onChangeText('0.1');
  await app.settle();
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  let view = app.screen();
  assert.equal(app.current().portfolioStatus, 'save-unverified');
  assert.equal(view.input('Bitcoin').props.value, '0.1');
  assert.equal(view.input('Bitcoin').props.editable, false);
  assert.match(view.text(), /may or may not already be stored/);
  assert.deepEqual(app.saved(), { bitcoin: '2', ethereum: '3' });
  view.retry().props.onPress();
  await app.settle();
  view = app.screen();
  assert.equal(app.current().portfolioStatus, 'saved-web');
  assert.equal(view.input('Bitcoin').props.value, '0.1');
  assert.deepEqual(app.saved(), { bitcoin: '0.1', ethereum: '3' });
  assert.equal(app.holdingWrites().length, 2);
});

test('a successful write with failed verification is confirmed without writing again', async () => {
  const app = await createHarness();
  app.failNextVerification();
  app.screen().input('Bitcoin').props.onChangeText('0.1');
  await app.settle();
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  assert.equal(app.current().portfolioStatus, 'save-unverified');
  assert.equal(app.saved().bitcoin, '0.1');
  assert.equal(app.holdingWrites().length, 1);
  app.screen().retry().props.onPress();
  await app.settle();
  assert.equal(app.current().portfolioStatus, 'saved-web');
  assert.equal(app.holdingWrites().length, 1, 'matching attempted bytes need no rewrite');
});

test('a later queued edit waits when an earlier write fails', async () => {
  const app = await createHarness();
  const failPausedWrite = app.pauseNextWrite();
  app.screen().input('Bitcoin').props.onChangeText('0.1');
  await app.settle();
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  app.screen().input('Ethereum').props.onChangeText('4.5');
  await app.settle();
  app.screen().input('Ethereum').props.onBlur();
  await app.settle();
  failPausedWrite();
  await app.settle();
  assert.equal(app.current().portfolioStatus, 'save-unverified');
  assert.equal(app.holdingWrites().length, 1, 'later queued save never blindly runs');
  assert.deepEqual(app.saved(), { bitcoin: '2', ethereum: '3' });
  assert.equal(app.screen().input('Bitcoin').props.value, '0.1');
  assert.equal(app.screen().input('Ethereum').props.value, '4.5');
  app.screen().retry().props.onPress();
  await app.settle();
  assert.equal(app.current().portfolioStatus, 'saved-web');
  assert.deepEqual(app.saved(), { bitcoin: '0.1', ethereum: '4.5' });
});

test('retry can verify an earlier attempted snapshot before writing a later queued edit', async () => {
  let stored = 'baseline';
  const writes = [];
  let failCheck = true;
  const writer = persistence.createGuardedPortfolioWriter(
    async () => stored,
    async (snapshot) => {
      writes.push(snapshot);
      stored = snapshot;
      if (failCheck) { failCheck = false; throw new Error('synthetic verification failure'); }
    },
  );
  writer.reset('baseline');
  assert.equal(await writer.save('first'), 'unverified');
  assert.equal(await writer.save('second'), 'unverified');
  assert.deepEqual(writes, ['first']);
  assert.equal(await writer.retry('second'), 'saved');
  assert.equal(stored, 'second');
  assert.deepEqual(writes, ['first', 'second']);
});

test('an unexpected stored copy before a first write is not overwritten', async () => {
  const app = await createHarness();
  app.changeStored({ bitcoin: '9', ethereum: '3' });
  app.screen().input('Bitcoin').props.onChangeText('0.1');
  await app.settle();
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  assert.equal(app.current().portfolioStatus, 'save-conflict');
  assert.equal(app.screen().input('Bitcoin').props.value, '0.1');
  assert.equal(app.saved().bitcoin, '9');
  assert.equal(app.holdingWrites().length, 0);
});

test('a third stored copy produces a conflict and is never overwritten by retry', async () => {
  const app = await createHarness();
  app.failNextVerification();
  app.screen().input('Bitcoin').props.onChangeText('0.1');
  await app.settle();
  app.screen().input('Bitcoin').props.onBlur();
  await app.settle();
  app.changeStored({ bitcoin: '9', ethereum: '3' });
  app.screen().retry().props.onPress();
  await app.settle();
  assert.equal(app.current().portfolioStatus, 'save-conflict');
  assert.equal(app.screen().input('Bitcoin').props.value, '0.1');
  assert.equal(app.saved().bitcoin, '9');
  assert.equal(app.holdingWrites().length, 1);
  app.screen().retry().props.onPress();
  await app.settle();
  assert.equal(app.current().portfolioStatus, 'save-conflict');
  assert.equal(app.saved().bitcoin, '9');
  assert.equal(app.holdingWrites().length, 1);
  // This method is only offered behind an explicit discard confirmation in the screen.
  assert.equal(await app.current().loadSavedPortfolio(), true);
  await app.settle();
  assert.equal(app.screen().input('Bitcoin').props.value, '9');
  assert.equal(app.holdingWrites().length, 1);
});
