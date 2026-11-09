// Synthetic React hook and native-component harness: no device, real storage, or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadSource(relativePath, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, id)) return dependencies[id];
    throw new Error(`Unexpected module in synthetic test: ${id}`);
  };
  new Function('exports', 'require', 'module', compiled)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

const holding = loadSource('src/lib/holding-input.ts');
const persistence = loadSource('src/lib/portfolio-persistence.ts');
const actualCurrency = loadSource('src/lib/currency.ts');
const formatProviderUpdate = () => '';
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


const scope = loadSource('src/lib/customer-storage-scope.ts');
const guest = scope.GUEST_PRIVATE_STORAGE_KEYS;
const owner = (letter) => ({kind: 'owner', dataScope: 'v1_' + letter.repeat(42) + 'A'});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function harness(initial = {kind: 'guest'}) {
  const fence = scope.createCustomerStorageFence(initial);
  const values = new Map(); const operations = [];
  let blockedRead; let blockedWrite; let revision = 0;
  const native = {
    isAvailableAsync: async () => true,
    async getItemAsync(key) { operations.push(['secure-read', key]); const block = blockedRead; blockedRead = null; if (block) await block.promise; return values.get(key) ?? null; },
    async setItemAsync(key, value) { operations.push(['secure-write', key]); const block = blockedWrite; blockedWrite = null; if (block) await block.promise; values.set(key,value); },
    async deleteItemAsync(key) { operations.push(['secure-delete', key]); values.delete(key); },
  };
  const plain = {
    async getItem(key) { operations.push(['plain-read', key]); return values.get(key) ?? null; },
    async setItem(key,value) { operations.push(['plain-write',key]); values.set(key,value); },
    async removeItem(key) { operations.push(['plain-delete',key]); values.delete(key); },
  };
  const runtime = createHookRuntime();
  const {DataProvider} = loadSource('src/lib/data-context.tsx', {
    react:runtime.hooks, 'react/jsx-runtime':jsxRuntime, 'react-native':{Platform:{OS:'android'}},
    '@react-native-async-storage/async-storage':{__esModule:true,default:plain}, 'expo-secure-store':native,
    './currency':actualCurrency, './holding-input':holding, './market':market,
    './customer-storage-scope':scope, './portfolio-persistence':persistence,
    './market-resource':{
      loadPreferenceWithTimeout: (read,success,fail) => {void read().then(success,fail); return () => {};},
      loadMarketResource: () => () => {}, marketDataToPersist:()=>null, createLatestCacheWriter:()=>()=>{},
    },
  });
  const render = () => runtime.render(() => DataProvider({storageFence:fence, storageRevision:revision, children:null}));
  let context;
  return {
    values, operations, fence, current:()=>context,
    render() { context=render(); return context; },
    transition(next) {fence.transition(next); revision++; context=render(); return context;},
    blockRead() {blockedRead=deferred(); return blockedRead;},
    blockWrite() {blockedWrite=deferred(); return blockedWrite;},
    async settle() {for(let n=0;n<20;n++){await new Promise(r=>setImmediate(r)); if(runtime.isDirty()) context=render();} return context;},
  };
}

test('hold masks synchronously, old callbacks refuse edits, public preference survives', async()=>{
  const h=harness(); h.values.set(guest.portfolioSecure,JSON.stringify({bitcoin:'2'})); h.render(); await h.settle();
  const old=h.current(); assert.equal(old.holdings.bitcoin,'2'); assert.equal(old.currencyReady,true);
  const held=h.transition({kind:'hold'}); assert.deepEqual(held.holdings,{}); assert.deepEqual(held.holdingDrafts,{}); assert.equal(held.portfolioReady,false); assert.equal(held.currencyReady,true);
  old.setHolding('bitcoin','99'); assert.equal(old.commitHolding('bitcoin'),false); assert.equal(await old.forgetHoldings(),false);
  h.transition({kind:'guest'}); assert.deepEqual(h.current().holdings,{}); await h.settle(); assert.equal(h.current().holdings.bitcoin,'2');
});

test('owner loads and deletes only its secure key, preserving every guest copy',async()=>{
 const who=owner('B'); const h=harness(who); const key=scope.privateStorageKey('portfolioSecure',who);
 h.values.set(guest.legacyPortfolio,JSON.stringify({bitcoin:'9'})); h.values.set(guest.portfolioSecure,JSON.stringify({bitcoin:'8'})); h.values.set(key,JSON.stringify({bitcoin:'1'}));
 h.render(); await h.settle(); assert.equal(h.current().holdings.bitcoin,'1'); assert.equal(h.current().portfolioRecovery,null);
 assert.equal(await h.current().forgetHoldings(),true); await h.settle(); assert.equal(h.values.has(key),false);
 assert.equal(h.values.has(guest.legacyPortfolio),true); assert.equal(h.values.has(guest.portfolioSecure),true);
 assert.equal(h.operations.some(([,k])=>k===guest.legacyPortfolio || k===guest.portfolioSecure),false);
});

test('late owner read cannot publish into a new owner',async()=>{
 const a=owner('B'),b=owner('C');const h=harness(a);const block=h.blockRead();
 h.values.set(scope.privateStorageKey('portfolioSecure',a),JSON.stringify({bitcoin:'1'}));h.values.set(scope.privateStorageKey('portfolioSecure',b),JSON.stringify({bitcoin:'7'}));
 h.render();await h.settle();h.transition(b);await h.settle();assert.equal(h.current().holdings.bitcoin,'7');
 block.resolve();await h.settle();assert.equal(h.current().holdings.bitcoin,'7');
});

test('issued write retains its owner destination; queued later write is cancelled on identity change',async()=>{
 const a=owner('B'),b=owner('C');const h=harness(a);const keyA=scope.privateStorageKey('portfolioSecure',a),keyB=scope.privateStorageKey('portfolioSecure',b);
 h.values.set(keyA,JSON.stringify({bitcoin:'1'}));h.values.set(keyB,JSON.stringify({bitcoin:'7'}));h.render();await h.settle();
 const block=h.blockWrite();h.current().setHolding('bitcoin','2');h.current().commitHolding('bitcoin');await h.settle();
 h.current().setHolding('bitcoin','3');h.current().commitHolding('bitcoin');h.render();
 h.transition(b);await h.settle();block.resolve();await h.settle();
 assert.equal(JSON.parse(h.values.get(keyA)).bitcoin,'2');assert.equal(JSON.parse(h.values.get(keyB)).bitcoin,'7');assert.equal(h.current().holdings.bitcoin,'7');
 assert.equal(h.operations.filter(([op])=>op==='secure-write').length,1);
});

test('guest legacy migration still requires explicit recovery confirmation',async()=>{
 const h=harness();h.values.set(guest.legacyPortfolio,JSON.stringify({bitcoin:'4'}));h.render();await h.settle();
 assert.equal(h.current().portfolioStatus,'recovery');assert.equal(h.current().holdings.bitcoin,'4');assert.equal(h.values.has(guest.legacyPortfolio),true);
 assert.equal(await h.current().resolvePortfolioRecovery('secure'),true);await h.settle();assert.equal(h.values.has(guest.legacyPortfolio),false);assert.equal(h.current().portfolioReady,true);
});
