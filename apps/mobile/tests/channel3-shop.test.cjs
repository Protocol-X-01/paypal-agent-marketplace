// Run from apps/mobile: node --test tests/channel3-shop.test.cjs
// Synthetic data only; no network, device, or real collection storage is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const values = new Map();
let beforeRead = null;
let beforeWrite = null;
const storageCalls = [];
const storage = {
  async getItem(key) { storageCalls.push(['read',key]); if (beforeRead) { const hook=beforeRead; beforeRead=null; await hook(key); } return values.get(key) ?? null; },
  async setItem(key, value) { storageCalls.push(['write',key]); if (beforeWrite) { const hook=beforeWrite; beforeWrite=null; await hook(key,value); } values.set(key, value); },
};
const modules = new Map();
function loadSource(file) {
  const absolute = path.resolve(file.endsWith('.ts') ? file : `${file}.ts`);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  const source = fs.readFileSync(absolute, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  const localRequire = (name) => {
    if (name === '@react-native-async-storage/async-storage') return { __esModule: true, default: storage };
    if (name === './market') return { getApiBaseUrl: () => 'https://example.com' };
    return name.startsWith('.') ? loadSource(path.resolve(path.dirname(absolute), name)) : require(name);
  };
  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
    module.exports, localRequire, module, absolute, path.dirname(absolute),
  );
  return module.exports;
}

const source = (name) => path.join(__dirname, '..', 'src', 'lib', name);
const { safeChannel3Url, selectChannel3Image } = loadSource(source('channel3-url'));
const { isFreshVerifiedOffer, VERIFIED_OFFERS_TTL_MS } = loadSource(source('channel3-offers'));
const { CHANNEL3_COLLECTIONS_KEY, fetchChannel3Catalog, searchChannel3, loadCollections, planProductSave, saveCollections } = loadSource(source('channel3'));
const { createStorefrontFence, loadShopStorefront, saveShopStorefront, SHOP_STOREFRONT_KEY } = loadSource(source('shop-storefront'));

test('image candidates are limited to Channel3 CDN and prefer the marked main image', () => {
  assert.equal(selectChannel3Image([
    { url: 'https://cdn.trychannel3.com/secondary.jpg' },
    { is_main_image: true, cleaned_url: 'https://cdn.trychannel3.com/main.jpg', url: 'https://retailer.example/main.jpg' },
  ]), 'https://cdn.trychannel3.com/main.jpg');
  assert.equal(selectChannel3Image([
    { is_main_image: true, cleaned_url: 'http://cdn.trychannel3.com/insecure.jpg', url: 'https://cdn.trychannel3.com.evil.example/trick.jpg' },
    { url: 'https://cdn.trychannel3.com/backup.jpg' },
  ]), 'https://cdn.trychannel3.com/backup.jpg');
  assert.equal(selectChannel3Image([{ url: 'https://retailer.example/image.jpg' }]), null);
  assert.equal(selectChannel3Image(null), null);
});

test('untrusted local, literal, credentialed, and non-HTTPS URLs are rejected', () => {
  for (const value of [
    'http://cdn.trychannel3.com/a.jpg', 'https://localhost./a', 'https://router.local./a',
    'https://router.lan/a', 'https://router.lan./a', 'https://router.localdomain/a', 'https://router.localdomain./a',
    'https://device.internal/a', 'https://device.home.arpa/a', 'https://127.0.0.1/a',
    'https://[::1]/a', 'https://user:password@cdn.trychannel3.com/a',
    'https://cdn.trychannel3.com:8443/a', 'https://host..example/a',
    'https://cdn.trychannel3.com/a\nb', 'https://cdn.trychannel3.com/a\rb',
    'https://cdn.trychannel3.com/a\tb', 'https://cdn.trychannel3.com/a\x00b', 'https://cdn.trychannel3.com/a\x7fb',
  ]) assert.equal(safeChannel3Url(value), null, value);
  assert.equal(safeChannel3Url('https://cdn.trychannel3.com:443/a'), 'https://cdn.trychannel3.com/a');
});

test('a verified retailer link expires at five minutes and cannot gain time if the clock moves backwards', () => {
  const verifiedAt = 1_000_000;
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt), true);
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt + VERIFIED_OFFERS_TTL_MS - 1), true);
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt + VERIFIED_OFFERS_TTL_MS), false);
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt - 1), false);
  assert.equal(isFreshVerifiedOffer(verifiedAt, Number.NaN), false);
});

test('a curated response retains a suitable thumbnail and validates offers', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://example.com/api/marketplace/catalog?storefront=GB&limit=24&section=audio');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => ({
      provider: 'Channel3', section: 'audio', title: 'Audio', storefront: 'GB', currency: 'GBP', retrievedAt: '2026-11-06T00:00:00Z',
      products: [{
        id: 'item-1', title: 'Headphones', brands: [{ name: 'Example' }],
        images: [{ is_main_image: true, cleaned_url: 'https://cdn.trychannel3.com/one.jpg' }],
        offers: [
          { url: 'https://shop.example/product', price: { price: 42, currency: 'GBP' }, availability: 'InStock' },
          { url: 'https://127.0.0.1/product', price: { price: 1, currency: 'GBP' }, availability: 'InStock' },
          { url: 'https://shop.example/wrong-currency', price: { price: 10, currency: 'USD' }, availability: 'InStock' },
        ],
      }],
    }) };
  };
  try {
    const result = await fetchChannel3Catalog('audio', 'GB');
    assert.equal(result.storefront, 'GB');
    assert.equal(result.currency, 'GBP');
    assert.equal(result.products[0].imageUrl, 'https://cdn.trychannel3.com/one.jpg');
    assert.equal(result.products[0].offers.length, 1);
    assert.equal(result.products[0].offers[0].domain, 'shop.example');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a missing curated route reports an incompatible service without parsing HTML or falling back', async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  let parsed = false;
  global.fetch = async (url) => {
    requests += 1;
    assert.equal(url, 'https://example.com/api/marketplace/catalog?storefront=GB&limit=24&section=audio');
    return { ok: false, status: 404, json: async () => { parsed = true; throw new SyntaxError('HTML'); } };
  };
  try {
    await assert.rejects(fetchChannel3Catalog('audio', 'GB'), /shop service needs an update before curated picks can load/);
    assert.equal(requests, 1);
    assert.equal(parsed, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('other curated response failures keep their own messages even when the response is HTML', async () => {
  const originalFetch = global.fetch;
  let status = 429;
  global.fetch = async () => ({ ok: status === 200, status, json: async () => { throw new SyntaxError('HTML'); } });
  try {
    await assert.rejects(fetchChannel3Catalog('audio', 'GB'), /temporarily limited/);
    status = 503;
    await assert.rejects(fetchChannel3Catalog('audio', 'GB'), /temporarily unavailable/);
    status = 200;
    await assert.rejects(fetchChannel3Catalog('audio', 'GB'), /unexpected response/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('first save creates Favourites without persisting images or offers', async () => {
  values.clear();
  const product = {
    id: 'item-1', title: 'Headphones', brand: 'Example', imageUrl: 'https://cdn.trychannel3.com/one.jpg',
    offers: [{ url: 'https://shop.example/product', domain: 'shop.example', price: 42, currency: 'GBP', availability: 'InStock' }],
  };
  const plan = planProductSave([], null, product, 'US');
  assert.equal(plan.createdFavourites, true);
  assert.equal(plan.collections[0].name, 'Favourites');
  assert.equal(plan.activeId, plan.collections[0].id);
  await saveCollections(plan.collections);
  const raw = values.get(CHANNEL3_COLLECTIONS_KEY);
  assert.doesNotMatch(raw, /https:|imageUrl|offers|"price"/);
  const saved = await loadCollections();
  assert.deepEqual(Object.keys(saved[0].items[0]).sort(), ['brand', 'id', 'savedAt', 'storefront', 'title']);
  assert.equal(saved[0].items[0].storefront, 'US');
  assert.equal(saved[0].items[0].title, 'Headphones');
});

test('saving to an existing collection preserves other lists and rejects duplicates or full lists', () => {
  const item = { id: 'item-1', title: 'Headphones', brand: null, imageUrl: null, offers: [] };
  const lists = [
    { id: 'a', name: 'First', items: [], updatedAt: '2026-11-06T00:00:00Z' },
    { id: 'b', name: 'Second', items: [], updatedAt: '2026-11-06T00:00:00Z' },
  ];
  const plan = planProductSave(lists, 'b', item, 'GB');
  assert.equal(plan.activeId, 'b');
  assert.equal(plan.collections[0], lists[0]);
  assert.equal(lists[1].items.length, 0);
  assert.equal(plan.collections[1].items[0].id, 'item-1');
  assert.throws(() => planProductSave(plan.collections, 'b', item, 'GB'), /already saved/);
  const full = { ...lists[0], items: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, title: 'Item', brand: null, savedAt: '2026-11-06T00:00:00Z' })) };
  assert.throws(() => planProductSave([full], 'a', item, 'GB'), /collection is full/);
});

test('shop region preference defaults to UK and preserves an invalid stored value until chosen', async () => {
  values.clear();
  assert.deepEqual(await loadShopStorefront(), { storefront: 'GB', status: 'default' });
  values.set(SHOP_STOREFRONT_KEY, 'unknown');
  assert.deepEqual(await loadShopStorefront(), { storefront: 'GB', status: 'invalid' });
  assert.equal(values.get(SHOP_STOREFRONT_KEY), 'unknown');
  await saveShopStorefront('US');
  assert.deepEqual(await loadShopStorefront(), { storefront: 'US', status: 'saved' });
  await assert.rejects(saveShopStorefront('FR'), /supported shop region/);
});

test('storefront revisions reject late responses even after switching back', () => {
  const fence = createStorefrontFence('GB');
  const oldUK = fence.capture();
  assert.equal(fence.select('US'), true);
  const us = fence.capture();
  assert.equal(fence.isCurrent(oldUK), false);
  assert.equal(fence.isCurrent(us), true);
  fence.select('GB');
  assert.equal(fence.isCurrent(oldUK), false);
  assert.equal(fence.isCurrent(us), false);
  assert.equal(fence.isCurrent(fence.capture()), true);
});

test('search sends the selected region and rejects mismatched response metadata', async () => {
  const originalFetch = global.fetch;
  let returnedStorefront = 'US';
  let returnedCurrency = 'USD';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://example.com/api/marketplace/search');
    assert.deepEqual(JSON.parse(options.body), { query: 'headphones', limit: 24, storefront: 'US' });
    return { ok: true, json: async () => ({ provider: 'Channel3', query: 'headphones', storefront: returnedStorefront, currency: returnedCurrency, retrievedAt: '2026-11-06T00:00:00Z', priceRange: null, products: [] }) };
  };
  try {
    const result = await searchChannel3('headphones', 'US');
    assert.equal(result.storefront, 'US');
    assert.equal(result.currency, 'USD');
    returnedStorefront = 'GB';
    await assert.rejects(searchChannel3('headphones', 'US'), /unexpected response/);
    returnedStorefront = 'US';
    returnedCurrency = 'GBP';
    await assert.rejects(searchChannel3('headphones', 'US'), /unexpected response/);
  } finally { global.fetch = originalFetch; }
});

test('search sends typed bounds and accepts the server-applied range from a budget phrase', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), {
      query: 'bags under 150', limit: 24, storefront: 'GB',
      priceRange: { minPrice: 25, maxPrice: 200 },
    });
    return { ok: true, json: async () => ({
      provider: 'Channel3', query: 'bags under 150', storefront: 'GB', currency: 'GBP',
      retrievedAt: '2026-11-06T00:00:00Z', priceRange: { minPrice: 25, maxPrice: 150 }, products: [],
    }) };
  };
  try {
    const result = await searchChannel3('bags under 150', 'GB', undefined, { priceRange: { minPrice: 25, maxPrice: 200 } });
    assert.deepEqual(result.priceRange, { minPrice: 25, maxPrice: 150 });
  } finally { global.fetch = originalFetch; }
});

test('search forwards an opaque continuation and rejects malformed continuations', async () => {
  const originalFetch = global.fetch;
  let token = 'next-page';
  global.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { query: 'headphones', limit: 24, storefront: 'GB', pageToken: 'previous-page' });
    return { ok: true, json: async () => ({ provider: 'Channel3', query: 'headphones', storefront: 'GB', currency: 'GBP', retrievedAt: '2026-11-06T00:00:00Z', priceRange: null, products: [], nextPageToken: token }) };
  };
  try {
    assert.equal((await searchChannel3('headphones', 'GB', undefined, { pageToken: 'previous-page' })).nextPageToken, 'next-page');
    token = 42;
    await assert.rejects(searchChannel3('headphones', 'GB', undefined, { pageToken: 'previous-page' }), /unexpected response/);
    await assert.rejects(searchChannel3('headphones', 'GB', undefined, { pageToken: '' }), /Restart this search/);
  } finally { global.fetch = originalFetch; }
});

test('catalog refuses a response from the wrong storefront or currency', async () => {
  const originalFetch = global.fetch;
  let storefront = 'GB';
  let currency = 'GBP';
  global.fetch = async (url) => {
    assert.equal(url, 'https://example.com/api/marketplace/catalog?storefront=US&limit=24&section=travel');
    return { ok: true, json: async () => ({ provider: 'Channel3', section: 'travel', title: 'Travel', storefront, currency, retrievedAt: '2026-11-06T00:00:00Z', products: [] }) };
  };
  try {
    await assert.rejects(fetchChannel3Catalog('travel', 'US'), /unexpected response/);
    storefront = 'US';
    await assert.rejects(fetchChannel3Catalog('travel', 'US'), /unexpected response/);
    currency = 'USD';
    assert.equal((await fetchChannel3Catalog('travel', 'US')).currency, 'USD');
  } finally { global.fetch = originalFetch; }
});

test('older services without storefront metadata report a compatibility issue', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({ ok: true, json: async () => url.includes('/search')
    ? { provider: 'Channel3', query: 'headphones', retrievedAt: '2026-11-06T00:00:00Z', products: [] }
    : { provider: 'Channel3', section: 'audio', title: 'Audio', retrievedAt: '2026-11-06T00:00:00Z', products: [] } });
  try {
    await assert.rejects(searchChannel3('headphones', 'GB'), /shop service needs an update/);
    await assert.rejects(fetchChannel3Catalog('audio', 'GB'), /shop service needs an update/);
  } finally { global.fetch = originalFetch; }
});

test('a missing regional search route reports an update without parsing HTML', async () => {
  const originalFetch = global.fetch;
  let parsed = false;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => { parsed = true; throw new SyntaxError('HTML'); } });
  try {
    await assert.rejects(searchChannel3('headphones', 'US'), /shop service needs an update/);
    assert.equal(parsed, false);
  } finally { global.fetch = originalFetch; }
});

test('an aborted region request cannot resolve successfully even if transport ignores abort', async () => {
  const originalFetch = global.fetch;
  let release;
  global.fetch = () => new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  try {
    const pending = searchChannel3('headphones', 'GB', controller.signal);
    controller.abort();
    release({ ok: true, json: async () => ({ provider: 'Channel3', query: 'headphones', storefront: 'GB', currency: 'GBP', retrievedAt: '2026-11-06T00:00:00Z', priceRange: null, products: [] }) });
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { global.fetch = originalFetch; }
});

test('legacy saved items remain readable without inventing a storefront', async () => {
  values.clear();
  const legacy = { version: 1, collections: [{ id: 'legacy', name: 'Favourites', updatedAt: '2026-11-06T00:00:00Z', items: [{ id: 'p1', title: 'Item', brand: null, savedAt: '2026-11-06T00:00:00Z' }] }] };
  const raw = JSON.stringify(legacy);
  values.set(CHANNEL3_COLLECTIONS_KEY, raw);
  const loaded = await loadCollections();
  assert.equal(loaded[0].items[0].storefront, undefined);
  assert.equal(values.get(CHANNEL3_COLLECTIONS_KEY), raw);
});


const {createCustomerCollectionsRepository} = loadSource(source('channel3'));
const {createCustomerStorageFence, privateStorageKey} = loadSource(source('customer-storage-scope'));
const ownerScope = (letter) => ({kind:'owner',dataScope:'v1_'+letter.repeat(42)+'A'});
const syntheticList = (name) => [{id:name,name,updatedAt:'2026-11-06',items:[]}];
const deferred = () => {let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('scoped collection load/save never touches guest storage and requires a validated baseline',async()=>{
 const who=ownerScope('B'),fence=createCustomerStorageFence(who),repo=createCustomerCollectionsRepository(fence);
 const key=privateStorageKey('channel3Collections',who);values.delete(key);storageCalls.length=0;
 const guestBefore=values.get(CHANNEL3_COLLECTIONS_KEY);
 await assert.rejects(repo.save(syntheticList('Owner')), /Reload/);
 assert.deepEqual(await repo.load(),[]);await repo.save(syntheticList('Owner'));
 assert.equal(JSON.parse(values.get(key)).collections[0].name,'Owner');
 assert.equal(values.get(CHANNEL3_COLLECTIONS_KEY),guestBefore);assert.ok(storageCalls.every(([,k])=>k===key));
});

test('a retired collection repository rejects delayed reads and cannot acquire the next identity',async()=>{
 const fence=createCustomerStorageFence(ownerScope('C')),repo=createCustomerCollectionsRepository(fence);
 const wait=deferred(),started=deferred();beforeRead=async()=>{started.resolve();await wait.promise;};
 const pending=repo.load();await started.promise;fence.transition(ownerScope('D'));wait.resolve();
 await assert.rejects(pending,/account changes/);assert.equal(repo.isCurrent(),false);
 const count=storageCalls.length;await assert.rejects(repo.save([]),/account changes/);assert.equal(storageCalls.length,count);
});

test('an issued write stays on its captured owner; queued stale writes never start',async()=>{
 const a=ownerScope('E'),b=ownerScope('F'),fence=createCustomerStorageFence(a),repo=createCustomerCollectionsRepository(fence);
 const keyA=privateStorageKey('channel3Collections',a),keyB=privateStorageKey('channel3Collections',b);values.delete(keyA);values.delete(keyB);await repo.load();
 const wait=deferred(),started=deferred();beforeWrite=async()=>{started.resolve();await wait.promise;};
 const first=repo.save(syntheticList('First'));await started.promise;
 const second=repo.save(syntheticList('Second'));fence.transition(b);
 const next=createCustomerCollectionsRepository(fence);const loaded=next.load();
 // Attach rejection observers before releasing the paused native operation.
 const failures=Promise.all([assert.rejects(first,/account changes/),assert.rejects(second,/account changes/)]);
 wait.resolve();await failures;assert.deepEqual(await loaded,[]);
 assert.equal(JSON.parse(values.get(keyA)).collections[0].name,'First');assert.equal(values.has(keyB),false);
});

test('collection snapshots are immutable while queued and saves serialize against confirmed baselines',async()=>{
 const who=ownerScope('G'),repo=createCustomerCollectionsRepository(createCustomerStorageFence(who));const key=privateStorageKey('channel3Collections',who);values.delete(key);await repo.load();
 const wait=deferred(),started=deferred();beforeWrite=async()=>{started.resolve();await wait.promise;};
 const first=repo.save(syntheticList('One'));await started.promise;const draft=syntheticList('Two');const second=repo.save(draft);draft[0].name='Mutated';wait.resolve();await first;await second;
 assert.equal(JSON.parse(values.get(key)).collections[0].name,'Two');
});

test('conflicts and damaged snapshots never overwrite storage; reload is required',async()=>{
 const who=ownerScope('H'),repo=createCustomerCollectionsRepository(createCustomerStorageFence(who));const key=privateStorageKey('channel3Collections',who);values.delete(key);await repo.load();
 values.set(key,JSON.stringify({version:1,collections:syntheticList('Elsewhere')}));
 await assert.rejects(repo.save(syntheticList('Mine')),/changed/);await assert.rejects(repo.save([]),/Reload/);
 assert.equal(JSON.parse(values.get(key)).collections[0].name,'Elsewhere');
 values.set(key,'');await assert.rejects(repo.load(),/damaged/);await assert.rejects(repo.save([]),/Reload/);assert.equal(values.get(key),'');
});

test('failed save read-back blocks further writes until a validated reload',async()=>{
 const who=ownerScope('I'),repo=createCustomerCollectionsRepository(createCustomerStorageFence(who));const key=privateStorageKey('channel3Collections',who);values.delete(key);await repo.load();
 beforeWrite=async()=>{beforeRead=async()=>{throw new Error('synthetic verification failure');};};
 await assert.rejects(repo.save(syntheticList('Saved')),/verification failure/);
 await assert.rejects(repo.save([]),/Reload/);assert.equal((await repo.load())[0].name,'Saved');await repo.save([]);
});

test('privacy hold collection repository never accesses storage',async()=>{
 const repo=createCustomerCollectionsRepository(createCustomerStorageFence({kind:'hold'}));const count=storageCalls.length;
 await assert.rejects(repo.load(),/account changes/);await assert.rejects(repo.save([]),/account changes/);assert.equal(storageCalls.length,count);
});

test('retailer catalog keeps region, forwards opaque cursor, parses 24 items and finite fractional commissions',async()=>{
 const original=global.fetch;const rates=[0,0.05,1,null,-1,1.1,'0.05'];
 global.fetch=async(url)=>{const parsed=new URL(url);assert.equal(parsed.searchParams.get('retailer'),'target');assert.equal(parsed.searchParams.get('section'),null);assert.equal(parsed.searchParams.get('storefront'),'GB');assert.equal(parsed.searchParams.get('limit'),'24');assert.equal(parsed.searchParams.get('pageToken'),'opaque.+/token');return {ok:true,status:200,json:async()=>({provider:'Channel3',section:null,retailer:'target',limit:24,nextPageToken:null,title:'Target',storefront:'GB',currency:'GBP',retrievedAt:'2026-11-06',products:Array.from({length:30},(_,i)=>({id:'p'+i,title:'Product'+i,offers:[{url:'https://target.com/product',price:{price:10,currency:'GBP'},max_commission_rate:rates[i%rates.length]}]}))})};};
 try{const result=await fetchChannel3Catalog(null,'GB',undefined,{retailer:'target',pageToken:'opaque.+/token'});assert.equal(result.products.length,24);assert.deepEqual(result.products.slice(0,7).map(p=>p.offers[0].maxCommissionRate),[0,0.05,1,null,null,null,null]);}finally{global.fetch=original;}
});


test('retailer metadata cannot replace or authorize a tracked handoff URL', async () => {
 const originalFetch=global.fetch;
 const tracked='https://buy.trychannel3.com/example?offer=1';
 const base={url:tracked,domain:'www.BestBuy.com',price:{price:42,currency:'GBP'},availability:'InStock'};
 const invalidDomains=['https://bestbuy.com','bestbuy.com@evil.example','bestbuy.com/path','bestbuy.com:443','bestbuy.com\n','127.0.0.1','router.local','bad..example','-bad.example'];
 global.fetch=async()=>({ok:true,json:async()=>({provider:'Channel3',section:'audio',title:'Audio',storefront:'GB',currency:'GBP',retrievedAt:'2026-11-06',products:[{id:'p1',title:'Example',offers:[base,...invalidDomains.map(domain=>({...base,domain})),{...base,url:'javascript:alert(1)'},{...base,url:'https://127.0.0.1/item'}]}]})});
 try {
  const offers=(await fetchChannel3Catalog('audio','GB')).products[0].offers;
  assert.equal(offers.length,10);assert.equal(offers[0].domain,'bestbuy.com');
  for(const offer of offers)assert.equal(offer.url,tracked);
  for(const offer of offers.slice(1))assert.equal(offer.domain,'buy.trychannel3.com');
 }finally{global.fetch=originalFetch;}
});
