// Fictional products and mocked storage/network only; exercises the actual Shop screen.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function load(relativePath, dependencies) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const requireModule = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected dependency in synthetic Shop test: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(module.exports, requireModule, module);
  return module.exports;
}

function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

function textOf(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree !== 'object') return String(tree);
  return textOf(tree.props?.children);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const product = (id, title, currency) => ({
  id, title, brand: 'Example', imageUrl: null,
  offers: [{ url: 'https://shop.example/item', domain: 'shop.example', price: 42, currency, availability: 'InStock' }],
});
const searchResult = (query, storefront, item, priceRange = null) => ({
  query, storefront, currency: storefront === 'US' ? 'USD' : 'GBP',
  retrievedAt: '2026-11-06T00:00:00Z', priceRange, products: [item],
});

test('first-run Shop defaults to US while saved storefront choices remain unchanged', async () => {
  const values = new Map();
  const storage = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
  };
  const storefront = load('src/lib/shop-storefront.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
  });
  assert.equal(storefront.DEFAULT_SHOP_STOREFRONT, 'US');
  assert.deepEqual(await storefront.loadShopStorefront(), { storefront: 'US', status: 'default' });
  values.set(storefront.SHOP_STOREFRONT_KEY, 'GB');
  assert.deepEqual(await storefront.loadShopStorefront(), { storefront: 'GB', status: 'saved' });

  const screen = createScreen({ initialStorefront: null });
  try {
    screen.render();
    await flush();
    const tree = screen.render();
    assert.equal(labelled(tree, 'United States, USD').props.accessibilityState.checked, true);
  } finally { screen.cleanup(); }
});

function createScreen(options = {}) {
  const scope = load('src/lib/customer-storage-scope.ts', {});
  const storageFence = scope.createCustomerStorageFence({kind:'guest'});
  let storageRevision=0;
  let pausedCollectionWrite=null;
  let pausedCollectionRead=null;
  let failedCollectionReads=options.failInitialCollectionRead ? 1 : 0;
  let failReadbackAfterWrite=false;
  let failAcknowledgementAfterWrite=false;
  let collectionWrites=0;
  const stored = new Map();
  const storage = {
    async getItem(key) {
      if (key.includes('channel3-collections')) {
        if (pausedCollectionRead) { const pause=pausedCollectionRead;pausedCollectionRead=null;pause.started.resolve();await pause.promise; }
        if (failedCollectionReads) { failedCollectionReads--; throw new Error('synthetic collection read failure'); }
      }
      return stored.get(key) ?? null;
    },
    async setItem(key, value) {
      if (key.includes('channel3-collections')) {
        if (pausedCollectionWrite) { const pause=pausedCollectionWrite;pausedCollectionWrite=null;pause.started.resolve();await pause.promise; }
        collectionWrites++;
        stored.set(key, value);
        if (failAcknowledgementAfterWrite) { failAcknowledgementAfterWrite=false;throw new Error('synthetic write acknowledgement failure'); }
        if (failReadbackAfterWrite) { failReadbackAfterWrite=false;failedCollectionReads++; }
        return;
      }
      stored.set(key, value);
    },
  };
  const storefront = load('src/lib/shop-storefront.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
  });
  const initialStorefront = options.initialStorefront === undefined ? 'GB' : options.initialStorefront;
  if (initialStorefront !== null) stored.set(storefront.SHOP_STOREFRONT_KEY, initialStorefront);
  const actualChannel3 = load('src/lib/channel3.ts', {
    '@react-native-async-storage/async-storage': {__esModule:true,default:storage},
    './customer-storage-scope':scope, './channel3-shelves':load('src/lib/channel3-shelves.ts',{}), './channel3-url':{}, './market':{}, './shop-storefront':storefront,
  });
  stored.set(actualChannel3.CHANNEL3_COLLECTIONS_KEY,JSON.stringify({version:1,collections:[{ id:'saved-list',name:'Favourites',updatedAt:'2026-11-06',items:[{id:'saved-product',title:'Saved headphones',brand:null,savedAt:'2026-11-06',storefront:'GB'}]}]}));
  const searches = [];
  const catalogs = [];
  const channel3 = {
    ...actualChannel3,
    searchChannel3(query, region, signal, options) {
      const request = { query, region, signal, options, ...deferred() };
      searches.push(request);
      return request.promise;
    },
    fetchChannel3Catalog(section, region, signal, options) {
      const request = { section, region, signal, options, ...deferred() };
      catalogs.push(request);
      return request.promise;
    },
    async loadCollections() {
      return [{ id: 'saved-list', name: 'Favourites', updatedAt: '2026-11-06T00:00:00Z', items: [
        { id: 'saved-product', title: 'Saved headphones', brand: null, savedAt: '2026-11-06T00:00:00Z', storefront: 'GB' },
      ] }];
    },
    MAX_COLLECTIONS: 12,
    MAX_COLLECTION_NAME_LENGTH: 40,
  };
  const slots = [];
  const cleanups = [];
  let cursor = 0;
  const sameDeps = (a,b) => a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  let pendingEffects=[];
  let responsiveLayout = { wideCanvas: false, pairedPanels: false, shopGrid: false };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(factory,deps) {const i=cursor++;if(!slots[i] || !sameDeps(slots[i].deps,deps))slots[i]={deps,value:factory()};return slots[i].value;},
    useEffect(callback,deps) {const i=cursor++; const prior=slots[i]; if(!prior || !sameDeps(prior.deps,deps)){const slot={deps,cleanup:prior?.cleanup};slots[i]=slot;pendingEffects.push(()=>{slot.cleanup?.();slot.cleanup=callback();cleanups.push(()=>slot.cleanup?.());});}},
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const native = Object.fromEntries(['ActivityIndicator', 'Image', 'KeyboardAvoidingView', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((name) => [name, name]));
  native.StyleSheet = { create: (styles) => styles };
  native.Platform = { OS: 'android' };
  native.Linking = { openURL() { throw new Error('Retailer links must not open in this test'); } };
  const screen = load('src/app/shop.tsx', {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: Symbol('Fragment') },
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo/fetch': { fetch() { throw new Error('Images must not load in this test'); } },
    '@/lib/channel3': channel3,
    '@/lib/channel3-shelves':load('src/lib/channel3-shelves.ts',{}),
    '@/lib/customer-session-context': {useCustomerSession:()=>({storageFence,revision:storageRevision,status:'guest'})},
    '@/lib/channel3-offers': { isFreshVerifiedOffer: () => true, VERIFIED_OFFERS_TTL_MS: 300_000 },
    '@/lib/channel3-image': { createChannel3ImageLoader: () => ({ load() { throw new Error('Images must not load in this test'); } }) },
    '@/lib/shop-storefront': storefront,
    '@/lib/responsive-layout': { useResponsiveLayout: () => responsiveLayout },
    '@/lib/palette': load('src/lib/palette.ts', {}),
    '@/components/native-button': { NativeButton: 'NativeButton' },
  }).default;
  return {
    render() { cursor = 0; pendingEffects=[]; const tree = screen(); for(const effect of pendingEffects)effect();return tree; },
    transition(next){storageFence.transition(next);storageRevision++;},
    setOwnerLists(who,collections){stored.set(scope.privateStorageKey('channel3Collections',who),JSON.stringify({version:1,collections}));},
    pauseSave(){const wait=deferred();wait.started=deferred();pausedCollectionWrite=wait;return wait;},
    pauseCollectionRead(){const wait=deferred();wait.started=deferred();pausedCollectionRead=wait;return wait;},
    failNextCollectionRead(){failedCollectionReads++;},
    failReadbackAfterWrite(){failReadbackAfterWrite=true;},
    failAcknowledgementAfterWrite(){failAcknowledgementAfterWrite=true;},
    collectionWrites(){return collectionWrites;},
    collectionKey:actualChannel3.CHANNEL3_COLLECTIONS_KEY,
    cleanup() { for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup(); },
    stored, storefront, searches, catalogs,
    setLayout(value) { responsiveLayout = value; },
    setPlatform(value) { native.Platform.OS = value; },
  };
}

function labelled(tree, label) {
  const element = nodes(tree).find((node) => node.props?.accessibilityLabel === label);
  assert.ok(element, `Missing control: ${label}`);
  return element;
}

test('tablet product grid preserves search results and storefront when the window resizes', async () => {
  const screen = createScreen();
  try {
    let tree = screen.render();
    await flush();
    tree = screen.render();
    labelled(tree, 'Search for wireless headphones').props.onPress();
    const first = product('first', 'Fictional first headphones', 'GBP');
    const second = product('second', 'Fictional second headphones', 'GBP');
    screen.searches[0].resolve({ ...searchResult('wireless headphones', 'GB', first), products: [first, second] });
    await flush();
    tree = screen.render();
    assert.match(textOf(tree), /Fictional first headphones/);
    assert.match(textOf(tree), /Fictional second headphones/);
    assert.equal(nodes(tree).some((node) => node.type === 'View' && node.props.style?.columnGap === 12), false);
    screen.setLayout({ wideCanvas: true, pairedPanels: true, shopGrid: true });
    tree = screen.render();
    assert.ok(nodes(tree).some((node) => node.type === 'View' && node.props.style?.columnGap === 12 && node.props.style?.flexWrap === 'wrap'));
    assert.match(textOf(tree), /Fictional first headphones/);
    assert.match(textOf(tree), /Fictional second headphones/);
    assert.equal(labelled(tree, 'United Kingdom, GBP').props.accessibilityState.checked, true);
    assert.equal(screen.searches.length, 1, 'resizing does not repeat the search');
  } finally {
    screen.cleanup();
  }
});

test('mobile price bounds combine with a budget phrase and hide offers outside the applied range', async () => {
  const screen = createScreen();
  try {
    screen.render();
    await flush();
    let tree = screen.render();
    labelled(tree, 'Search products').props.onChangeText('bags under 150');
    labelled(tree, 'Minimum price in GBP').props.onChangeText('25');
    labelled(tree, 'Maximum price in GBP').props.onChangeText('200');
    tree = screen.render();
    nodes(tree).find((node) => node.props?.label === 'Search products').props.onPress();
    assert.deepEqual(screen.searches[0].options, { priceRange: { minPrice: 25, maxPrice: 200 } });

    const match = product('price-filter-product', 'Fictional in-range bags', 'GBP');
    match.offers = [24.99, 25, 150, 150.01].map((price) => ({
      url: `https://shop.example/item-${price}`, domain: 'shop.example', price, currency: 'GBP', availability: 'InStock',
    }));
    screen.searches[0].resolve(searchResult('bags under 150', 'GB', match, { minPrice: 25, maxPrice: 150 }));
    await flush();
    tree = screen.render();
    const visible = textOf(tree);
    assert.match(visible, /Price filter applied/);
    assert.match(visible, /2 retailer offers found/);
    assert.match(visible, /£25\.00/);
    assert.match(visible, /£150\.00/);
    assert.doesNotMatch(visible, /£24\.99|£150\.01/);
  } finally {
    screen.cleanup();
  }
});

test('mobile selector sends US requests, shows USD offers and preserves saved lists when switching', async () => {
  const screen = createScreen();
  try {
    let tree = screen.render();
    assert.equal(labelled(tree, 'United States, USD').props.disabled, true);
    await flush();
    tree = screen.render();
    assert.equal(labelled(tree, 'United Kingdom, GBP').props.accessibilityState.checked, true);
    labelled(tree, 'United States, USD').props.onPress();
    await flush();
    tree = screen.render();
    assert.equal(labelled(tree, 'United States, USD').props.accessibilityState.checked, true);
    assert.equal(screen.stored.get(screen.storefront.SHOP_STOREFRONT_KEY), 'US');
    labelled(tree, 'Search for wireless headphones').props.onPress();
    assert.equal(screen.searches[0].region, 'US');
    tree = screen.render();
    assert.equal(labelled(tree, 'Searching the Channel3 product catalog').props.accessibilityState.busy, true);
    screen.searches[0].resolve(searchResult('wireless headphones', 'US', product('us-item', 'US headphones', 'USD')));
    await flush();
    tree = screen.render();
    assert.match(textOf(tree), /United States · USD · 1 products/);
    assert.match(textOf(tree), /US headphones/);
    assert.match(textOf(tree), /US\$42\.00/);
    labelled(tree, 'Recheck offers for US headphones').props.onPress();
    assert.equal(screen.searches[1].region, 'US');
    tree = screen.render();
    labelled(tree, 'United Kingdom, GBP').props.onPress();
    assert.equal(screen.searches[1].signal.aborted, true);
    screen.searches[1].resolve(searchResult('US headphones', 'US', product('us-item', 'US headphones', 'USD')));
    await flush();
    tree = screen.render();
    assert.equal(labelled(tree, 'United Kingdom, GBP').props.accessibilityState.checked, true);
    assert.doesNotMatch(textOf(tree), /US headphones|United States · USD · 1 products/);
    assert.match(textOf(tree), /Favourites/);
    assert.match(textOf(tree), /Saved headphones/);
    assert.equal(labelled(tree, 'Check current United Kingdom offers for Saved headphones').props.disabled, false);
  } finally { screen.cleanup(); }
});

test('a late UK catalog cannot reappear after UK to US to UK switching', async () => {
  const screen = createScreen();
  try {
    screen.render();
    await flush();
    let tree = screen.render();
    labelled(tree, 'Audio curated picks. Headphones and personal audio. Tap to load products.').props.onPress();
    assert.equal(screen.catalogs[0].region, 'GB');
    tree = screen.render();
    assert.equal(labelled(tree, 'Loading Audio picks').props.accessibilityState.busy, true);
    labelled(tree, 'United States, USD').props.onPress();
    tree = screen.render();
    labelled(tree, 'United Kingdom, GBP').props.onPress();
    assert.equal(screen.catalogs[0].signal.aborted, true);
    screen.catalogs[0].resolve({
      section: 'audio', title: 'Audio', storefront: 'GB', currency: 'GBP', retrievedAt: '2026-11-06T00:00:00Z',
      products: [product('stale-item', 'Stale British item', 'GBP')],
    });
    await flush();
    tree = screen.render();
    assert.doesNotMatch(textOf(tree), /Stale British item/);
    assert.equal(nodes(tree).some((node) => node.props?.accessibilityLabel === 'Loading Audio picks'), false);
    labelled(tree, 'Travel curated picks. Backpacks for work and weekends. Tap to load products.').props.onPress();
    assert.equal(screen.catalogs[1].region, 'GB');
    screen.catalogs[1].resolve({
      section: 'travel', title: 'Travel', storefront: 'GB', currency: 'GBP', retrievedAt: '2026-11-06T00:00:00Z',
      products: [product('fresh-item', 'Fresh British bag', 'GBP')],
    });
    await flush();
    tree = screen.render();
    assert.match(textOf(tree), /United Kingdom · GBP · 1 products/);
    assert.match(textOf(tree), /Fresh British bag/);
    assert.match(textOf(tree), /£42\.00/);
  } finally { screen.cleanup(); }
});

test('a failed regional search can be retried from a separate accessible control', async () => {
  const screen = createScreen();
  try {
    screen.render();
    await flush();
    let tree = screen.render();
    labelled(tree, 'United States, USD').props.onPress();
    tree = screen.render();
    labelled(tree, 'Search for wireless headphones').props.onPress();
    screen.render();
    screen.searches[0].reject(new Error('Product search is temporarily unavailable.'));
    await flush();

    tree = screen.render();
    const alert = labelled(tree, 'Product search needs attention. Product search is temporarily unavailable.');
    const retry = labelled(tree, 'Search again');
    assert.equal(alert.props.accessibilityRole, 'alert');
    assert.equal(retry.props.accessibilityRole, 'button');
    assert.equal(nodes(alert).includes(retry), false, 'The retry must not be nested inside the accessible alert');
    retry.props.onPress();
    assert.equal(screen.searches[1].query, 'wireless headphones');
    assert.equal(screen.searches[1].region, 'US');
    screen.searches[1].resolve(searchResult('wireless headphones', 'US', product('retry-item', 'Retry headphones', 'USD')));
    await flush();
    tree = screen.render();
    assert.match(textOf(tree), /Retry headphones/);
    assert.doesNotMatch(textOf(tree), /Product search is temporarily unavailable/);
  } finally { screen.cleanup(); }
});

test('search pages load only on request, deduplicate IDs and retain first and latest retrieval times', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  const first=product('one','First headphones','GBP');
  screen.searches[0].resolve({...searchResult('wireless headphones','GB',first),nextPageToken:'page-two',retrievedAt:'2026-11-06T12:00:00.000Z'});await flush();tree=screen.render();
  assert.equal(screen.searches.length,1,'a continuation never loads automatically');
  assert.match(textOf(tree),/Results for “wireless headphones”/);
  labelled(tree,'Search products').props.onChangeText('a different unsent query');tree=screen.render();
  const more=nodes(tree).find(n=>n.props?.label==='Load more search results');assert.ok(more);more.props.onPress();more.props.onPress();
  assert.equal(screen.searches.length,2,'a double tap starts only one request');
  assert.equal(screen.searches[1].query,'wireless headphones');assert.equal(screen.searches[1].region,'GB');assert.equal(screen.searches[1].options.pageToken,'page-two');
  tree=screen.render();assert.equal(nodes(tree).find(n=>n.props?.label==='Loading more search results…').props.disabled,true);
  assert.ok(nodes(tree).some(n=>n.props?.accessibilityLiveRegion==='polite' && n.props?.accessibilityState?.busy===true && textOf(n)==='Loading more search results…'));
  screen.searches[1].resolve({...searchResult('wireless headphones','GB',first),products:[first,product('two','Second headphones','GBP')],nextPageToken:null,retrievedAt:'2026-11-06T12:03:45.123Z'});await flush();tree=screen.render();
  assert.equal(nodes(tree).filter(n=>n.type==='Text' && textOf(n)==='First headphones').length,1);
  assert.match(textOf(tree),/Second headphones/);
  assert.match(textOf(tree),/First page retrieved 2026-11-06 12:00:00 UTC · Latest page retrieved 2026-11-06 12:03:45\.123 UTC/);
  assert.equal(nodes(tree).find(n=>n.props?.label==='No further page available').props.disabled,true);
  const card=nodes(tree).find(n=>typeof n.type==='function' && n.type.name==='VerifiedOffersCard' && n.props.product.id==='two');assert.equal(card.props.verified,undefined);
 }finally{screen.cleanup();}
});

test('a failed search continuation retains results and retries the same page', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  const first=product('one','First headphones','GBP');screen.searches[0].resolve({...searchResult('wireless headphones','GB',first),nextPageToken:'next'});await flush();tree=screen.render();
  nodes(tree).find(n=>n.props?.label==='Load more search results').props.onPress();screen.searches[1].reject(new Error('Page temporarily unavailable'));await flush();tree=screen.render();
  assert.match(textOf(tree),/First headphones/);assert.match(textOf(tree),/Page temporarily unavailable/);
  assert.ok(nodes(tree).some(n=>n.props?.accessibilityRole==='alert' && textOf(n)==='Page temporarily unavailable'));
  nodes(tree).find(n=>n.props?.label==='Retry loading search results').props.onPress();assert.equal(screen.searches[2].options.pageToken,'next');
  screen.searches[2].resolve({...searchResult('wireless headphones','GB',product('two','Second headphones','GBP')),nextPageToken:null});await flush();tree=screen.render();
  assert.match(textOf(tree),/First headphones/);assert.match(textOf(tree),/Second headphones/);assert.doesNotMatch(textOf(tree),/Page temporarily unavailable/);
 }finally{screen.cleanup();}
});

test('a legacy search response without pagination does not claim the catalog is exhausted', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  screen.searches[0].resolve(searchResult('wireless headphones','GB',product('one','Headphones','GBP')));await flush();tree=screen.render();
  assert.match(textOf(tree),/The service did not provide another page/);assert.doesNotMatch(textOf(tree),/All search results loaded/);
  assert.equal(nodes(tree).find(n=>n.props?.label==='No further page available').props.disabled,true);
 }finally{screen.cleanup();}
});

test('ambiguous or invalid retrieval timestamps are not presented as precise UTC times', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  screen.searches[0].resolve({...searchResult('wireless headphones','GB',product('one','Headphones','GBP')),retrievedAt:'2026-02-30T12:00:00Z',nextPageToken:'next'});await flush();tree=screen.render();
  assert.match(textOf(tree),/Retrieved time unavailable/);assert.doesNotMatch(textOf(tree),/2026-03-02/);
  nodes(tree).find(n=>n.props?.label==='Load more search results').props.onPress();
  screen.searches[1].resolve({...searchResult('wireless headphones','GB',product('two','Other headphones','GBP')),retrievedAt:'2026-11-06T12:00:00',nextPageToken:null});await flush();tree=screen.render();
  assert.match(textOf(tree),/First page retrieved time unavailable · Latest page retrieved time unavailable/);
 }finally{screen.cleanup();}
});

test('switching storefront or starting a new search discards a late continuation', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  screen.searches[0].resolve({...searchResult('wireless headphones','GB',product('one','First headphones','GBP')),nextPageToken:'next'});await flush();tree=screen.render();
  nodes(tree).find(n=>n.props?.label==='Load more search results').props.onPress();tree=screen.render();labelled(tree,'United States, USD').props.onPress();assert.equal(screen.searches[1].signal.aborted,true);
  screen.searches[1].resolve({...searchResult('wireless headphones','GB',product('late','Late UK item','GBP')),nextPageToken:null});await flush();tree=screen.render();assert.doesNotMatch(textOf(tree),/Late UK item|First headphones/);
  labelled(tree,'Search for wireless headphones').props.onPress();screen.searches[2].resolve({...searchResult('wireless headphones','US',product('us','First US item','USD')),nextPageToken:'us-next'});await flush();tree=screen.render();
  nodes(tree).find(n=>n.props?.label==='Load more search results').props.onPress();tree=screen.render();labelled(tree,'Search for desk lamp').props.onPress();assert.equal(screen.searches[3].signal.aborted,true);
  screen.searches[3].resolve({...searchResult('wireless headphones','US',product('late-us','Late US item','USD')),nextPageToken:null});
  screen.searches[4].resolve({...searchResult('desk lamp','US',product('lamp','Fresh lamp','USD')),nextPageToken:null});await flush();tree=screen.render();
  assert.match(textOf(tree),/Fresh lamp/);assert.doesNotMatch(textOf(tree),/Late US item|First US item/);
 }finally{screen.cleanup();}
});

test('identity transitions cancel an in-flight page without hiding previously loaded public results', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  screen.searches[0].resolve({...searchResult('wireless headphones','GB',product('one','Public headphones','GBP')),nextPageToken:'next'});await flush();tree=screen.render();
  nodes(tree).find(n=>n.props?.label==='Load more search results').props.onPress();screen.transition({kind:'hold'});screen.render();assert.equal(screen.searches[1].signal.aborted,true);
  screen.searches[1].resolve({...searchResult('wireless headphones','GB',product('late','Late identity page','GBP')),nextPageToken:null});await flush();tree=screen.render();
  assert.match(textOf(tree),/Public headphones/);assert.doesNotMatch(textOf(tree),/Late identity page/);
  assert.equal(nodes(tree).find(n=>n.props?.label==='Load more search results').props.disabled,false);
 }finally{screen.cleanup();}
});

test('search stops at its result limit and on repeated continuations', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  const page=(number)=>Array.from({length:24},(_,i)=>product(`${number}-${i}`,`Item ${number}-${i}`,'GBP'));
  screen.searches[0].resolve({...searchResult('wireless headphones','GB',page(0)[0]),products:page(0),nextPageToken:'page-1'});await flush();tree=screen.render();
  for(let n=1;n<=3;n++){nodes(tree).find(v=>v.props?.label==='Load more search results').props.onPress();screen.searches[n].resolve({...searchResult('wireless headphones','GB',page(n)[0]),products:page(n),nextPageToken:`page-${n+1}`});await flush();tree=screen.render();}
  assert.match(textOf(tree),/96 products loaded\. Search result limit reached/);assert.equal(nodes(tree).find(n=>n.props?.label==='Search limit reached').props.disabled,true);
  labelled(tree,'Search for desk lamp').props.onPress();screen.searches[4].resolve({...searchResult('desk lamp','GB',product('lamp','Lamp','GBP')),nextPageToken:'repeat'});await flush();tree=screen.render();
  nodes(tree).find(n=>n.props?.label==='Load more search results').props.onPress();screen.searches[5].resolve({...searchResult('desk lamp','GB',product('other','Other lamp','GBP')),nextPageToken:'repeat'});await flush();tree=screen.render();
  assert.match(textOf(tree),/catalog repeated a page/i);assert.equal(nodes(tree).find(n=>n.props?.label==='Search paused').props.disabled,true);
 }finally{screen.cleanup();}
});

test('search bounds page requests even when every page repeats the same product', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Search for wireless headphones').props.onPress();
  const item=product('same','Same headphones','GBP');
  screen.searches[0].resolve({...searchResult('wireless headphones','GB',item),nextPageToken:'page-1'});await flush();tree=screen.render();
  for(let n=1;n<=7;n++){nodes(tree).find(v=>v.props?.label==='Load more search results').props.onPress();screen.searches[n].resolve({...searchResult('wireless headphones','GB',item),nextPageToken:`page-${n+1}`});await flush();tree=screen.render();}
  assert.equal(screen.searches.length,8);assert.match(textOf(tree),/Search page limit reached/);
  assert.equal(nodes(tree).find(n=>n.props?.label==='Search limit reached').props.disabled,true);
 }finally{screen.cleanup();}
});


test('identity hold hides private lists and drafts synchronously while public search stays visible',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();
 labelled(tree,'Search for wireless headphones').props.onPress();screen.searches[0].resolve(searchResult('wireless headphones','GB',product('public','Public headphones','GBP')));await flush();tree=screen.render();
 const oldDraft=labelled(tree,'New collection name');oldDraft.props.onChangeText('Private draft');tree=screen.render();assert.equal(labelled(tree,'New collection name').props.value,'Private draft');
 screen.transition({kind:'hold'});tree=screen.render();assert.doesNotMatch(textOf(tree),/Saved headphones/);assert.match(textOf(tree),/Public headphones/);assert.equal(labelled(tree,'New collection name').props.value,'');assert.equal(labelled(tree,'New collection name').props.editable,false);
 oldDraft.props.onChangeText('Stale edit');screen.transition({kind:'guest'});tree=screen.render();assert.doesNotMatch(textOf(tree),/Saved headphones/);await flush();tree=screen.render();assert.match(textOf(tree),/Saved headphones/);assert.equal(labelled(tree,'New collection name').props.value,'');assert.equal(screen.searches.length,1);
 }finally{screen.cleanup();}
});

test('late saved-product offer recheck cannot publish after owner change',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();
 labelled(tree,'Check current United Kingdom offers for Saved headphones').props.onPress();assert.equal(screen.searches.length,1);
 screen.transition({kind:'hold'});screen.render();screen.searches[0].resolve(searchResult('Saved headphones','GB',product('saved-product','Saved headphones','GBP')));await flush();
 screen.transition({kind:'guest'});screen.render();await flush();tree=screen.render();
 const cards=nodes(tree).filter(node=>typeof node.type==='function' && node.type.name==='VerifiedOffersCard');
 assert.ok(cards.every(node=>!node.props.verified));
 }finally{screen.cleanup();}
});

test('saved product recheck follows scoped continuation and only confirms the exact ID',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();
 labelled(tree,'Check current United Kingdom offers for Saved headphones').props.onPress();
 screen.searches[0].resolve({...searchResult('Saved headphones','GB',product('other','Similar headphones','GBP')),nextPageToken:'page-two'});await flush();
 assert.equal(screen.searches.length,2);assert.equal(screen.searches[1].query,'Saved headphones');assert.equal(screen.searches[1].region,'GB');assert.equal(screen.searches[1].options.pageToken,'page-two');
 screen.searches[1].resolve({...searchResult('Saved headphones','GB',product('saved-product','Saved headphones','GBP')),nextPageToken:null});await flush();tree=screen.render();
 const card=nodes(tree).find(node=>typeof node.type==='function' && node.type.name==='VerifiedOffersCard' && node.props.product.id==='saved-product');
 assert.ok(card?.props.verified);assert.equal(card.props.verified.offers[0].currency,'GBP');
 }finally{screen.cleanup();}
});

test('saved product recheck stops after three pages and reports an inconclusive miss',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();labelled(tree,'Check current United Kingdom offers for Saved headphones').props.onPress();
 for(let i=0;i<3;i++){screen.searches[i].resolve({...searchResult('Saved headphones','GB',product(`other-${i}`,'Similar headphones','GBP')),nextPageToken:`next-${i}`});await flush();}
 assert.equal(screen.searches.length,3);tree=screen.render();
 const card=nodes(tree).find(node=>typeof node.type==='function' && node.type.name==='VerifiedOffersCard' && node.props.product.id==='saved-product');
 assert.equal(card.props.verified,undefined);assert.match(card.props.error,/could not confirm.*checked results/i);
 }finally{screen.cleanup();}
});

test('switching storefront while following a saved-product continuation discards the late page',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();labelled(tree,'Check current United Kingdom offers for Saved headphones').props.onPress();
 screen.searches[0].resolve({...searchResult('Saved headphones','GB',product('other','Similar','GBP')),nextPageToken:'page-two'});await flush();
 tree=screen.render();labelled(tree,'United States, USD').props.onPress();assert.equal(screen.searches[1].signal.aborted,true);
 screen.searches[1].resolve({...searchResult('Saved headphones','GB',product('saved-product','Saved headphones','GBP')),nextPageToken:null});await flush();tree=screen.render();
 const cards=nodes(tree).filter(node=>typeof node.type==='function' && node.type.name==='VerifiedOffersCard');assert.ok(cards.every(card=>!card.props.verified));
 }finally{screen.cleanup();}
});

test('late collection save cannot restore prior drafts or selections after switching owners',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();
 labelled(tree,'New collection name').props.onChangeText('Old private list');tree=screen.render();
 const pause=screen.pauseSave();const create=nodes(tree).find(node=>node.type==='Pressable' && textOf(node)==='Create');assert.ok(create);create.props.onPress();await pause.started.promise;
 const owner={kind:'owner',dataScope:'v1_'+'Z'.repeat(42)+'A'};screen.setOwnerLists(owner,[{id:'owner-list',name:'Owner list',updatedAt:'2026-11-06',items:[]}]);screen.transition(owner);tree=screen.render();
 assert.doesNotMatch(textOf(tree),/Favourites|Old private list/);assert.equal(labelled(tree,'New collection name').props.value,'');
 pause.resolve();await flush();tree=screen.render();assert.match(textOf(tree),/Owner list/);assert.doesNotMatch(textOf(tree),/Old private list/);assert.equal(labelled(tree,'New collection name').props.value,'');
 }finally{screen.cleanup();}
});

test('retailer browsing preserves UK selection, appends deduplicated pages and keeps items on page failure',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();labelled(tree,'Browse Target, US retailer').props.onPress();assert.equal(screen.catalogs[0].region,'GB');assert.equal(screen.catalogs[0].section,null);assert.equal(screen.catalogs[0].options.retailer,'target');
 const first=product('p1','First product','GBP');first.offers[0].maxCommissionRate=0.05;
 const page={section:null,retailer:'target',limit:24,nextPageToken:'token1',title:'Target',storefront:'GB',currency:'GBP',retrievedAt:'2026-11-06T00:00:00.000Z',products:[first]};screen.catalogs[0].resolve(page);await flush();tree=screen.render();assert.match(textOf(tree),/★ Up to 5%/);assert.equal(labelled(tree,'United Kingdom, GBP').props.accessibilityState.checked,true);
 nodes(tree).find(n=>n.props?.label==='Load more products').props.onPress();assert.equal(screen.catalogs[1].options.pageToken,'token1');screen.catalogs[1].resolve({...page,retrievedAt:'2026-11-06T00:05:00.000Z',nextPageToken:'token2',products:[first,product('p2','Second product','GBP')]});await flush();tree=screen.render();assert.match(textOf(tree),/First product/);assert.match(textOf(tree),/Second product/);assert.equal(nodes(tree).filter(n=>n.type==='Text' && textOf(n)==='First product').length,1);assert.match(textOf(tree),/First page retrieved 2026-11-06 00:00:00 UTC · Latest page retrieved 2026-11-06 00:05:00 UTC/);
 nodes(tree).find(n=>n.props?.label==='Load more products').props.onPress();screen.catalogs[2].reject(new Error('Temporary page failure'));await flush();tree=screen.render();assert.match(textOf(tree),/First product/);assert.match(textOf(tree),/Temporary page failure/);
 }finally{screen.cleanup();}
});

test('retailer switch aborts a pending next page and refuses its late products',async()=>{
 const screen=createScreen();try{
 let tree=screen.render();await flush();tree=screen.render();labelled(tree,'Browse Target, US retailer').props.onPress();
 const page={section:null,retailer:'target',limit:24,nextPageToken:'next',title:'Target',storefront:'GB',currency:'GBP',retrievedAt:'2026-11-06',products:[product('first','First','GBP')]};screen.catalogs[0].resolve(page);await flush();tree=screen.render();nodes(tree).find(n=>n.props?.label==='Load more products').props.onPress();
 labelled(screen.render(),'Browse CVS, US retailer').props.onPress();assert.equal(screen.catalogs[1].signal.aborted,true);screen.catalogs[1].resolve({...page,products:[product('late','Late Target item','GBP')]});screen.catalogs[2].resolve({...page,retailer:'cvs',title:'CVS',nextPageToken:null,products:[product('cvs','CVS item','GBP')]});await flush();tree=screen.render();assert.match(textOf(tree),/CVS item/);assert.doesNotMatch(textOf(tree),/Late Target item/);
 }finally{screen.cleanup();}
});

test('an empty curated page with a continuation does not claim the whole selection is empty', async () => {
 const screen=createScreen();try{
  screen.render();await flush();let tree=screen.render();labelled(tree,'Browse Target, US retailer').props.onPress();
  screen.catalogs[0].resolve({section:null,retailer:'target',limit:24,nextPageToken:'next',title:'Target',storefront:'GB',currency:'GBP',retrievedAt:'2026-11-06T00:00:00.000Z',products:[]});await flush();tree=screen.render();
  assert.match(textOf(tree),/No products appeared in this page\. Load more to continue/);
  assert.equal(nodes(tree).find(n=>n.props?.label==='Load more products').props.disabled,false);
 }finally{screen.cleanup();}
});

test('catalog announces exact errors, retailer loading, and paging completion without removing the control', async () => {
 const screen=createScreen();
 try {
  let tree=screen.render();assert.equal(labelled(tree,'Browse Target, US retailer').props.accessibilityState.disabled,true);
  await flush();tree=screen.render();labelled(tree,'Browse Target, US retailer').props.onPress();
  assert.equal(labelled(screen.render(),'Loading Target picks').props.accessibilityState.busy,true);
  screen.catalogs[0].reject(new Error('Retailer temporarily unavailable'));await flush();tree=screen.render();
  assert.equal(labelled(tree,'Curated picks need attention. Retailer temporarily unavailable').props.accessibilityRole,'alert');
  labelled(tree,'Browse Target, US retailer').props.onPress();
  const page={section:null,retailer:'target',limit:24,nextPageToken:'next',title:'Target',storefront:'GB',currency:'GBP',retrievedAt:'2026-11-06',products:[product('one','One','GBP')]};
  screen.catalogs[1].resolve(page);await flush();tree=screen.render();
  nodes(tree).find(n=>n.props?.label==='Load more products').props.onPress();tree=screen.render();
  assert.equal(nodes(tree).find(n=>n.props?.label==='Loading more products…').props.disabled,true);
  assert.ok(nodes(tree).some(n=>n.props?.accessibilityLiveRegion==='polite' && n.props?.accessibilityState?.busy===true && textOf(n)==='Loading more products…'));
  screen.catalogs[2].resolve({...page,nextPageToken:null,products:[product('two','Two','GBP')]});await flush();tree=screen.render();
  assert.equal(nodes(tree).find(n=>n.props?.label==='All loaded').props.disabled,true);
  assert.ok(nodes(tree).some(n=>n.props?.accessibilityLiveRegion==='polite' && textOf(n)==='1 more products added. 2 products loaded. No more products in these results.'));
 } finally {screen.cleanup();}
});

test('cancelled paging cannot announce stale added products for the next retailer', async () => {
 const screen=createScreen();try {
  let tree=screen.render();await flush();tree=screen.render();labelled(tree,'Browse Target, US retailer').props.onPress();
  const page={section:null,retailer:'target',limit:24,nextPageToken:'next',title:'Target',storefront:'GB',currency:'GBP',retrievedAt:'2026-11-06',products:[product('one','One','GBP')]};
  screen.catalogs[0].resolve(page);await flush();tree=screen.render();nodes(tree).find(n=>n.props?.label==='Load more products').props.onPress();
  labelled(screen.render(),'Browse CVS, US retailer').props.onPress();assert.equal(screen.catalogs[1].signal.aborted,true);
  screen.catalogs[1].resolve({...page,nextPageToken:null,products:[product('late','Late','GBP')]});await flush();tree=screen.render();
  assert.doesNotMatch(textOf(tree),/more products added|products loaded/);assert.ok(labelled(tree,'Loading CVS picks'));
 }finally{screen.cleanup();}
});


test('offer checks announce busy/disabled state and restore it after completion',async()=>{
 const screen=createScreen();try{
 screen.render();await flush();let tree=screen.render();
 labelled(tree,'Search for wireless headphones').props.onPress();
 screen.searches[0].resolve({...searchResult('wireless headphones','GB',product('one','First headphones','GBP')),products:[product('one','First headphones','GBP'),product('two','Second headphones','GBP')]});await flush();tree=screen.render();
 const first='Recheck offers for First headphones',second='Recheck offers for Second headphones';
 assert.deepEqual(labelled(tree,first).props.accessibilityState,{disabled:false,busy:false});
 labelled(tree,first).props.onPress();tree=screen.render();
 assert.deepEqual(labelled(tree,first).props.accessibilityState,{disabled:true,busy:true});
 assert.deepEqual(labelled(tree,second).props.accessibilityState,{disabled:true,busy:false});
 assert.equal(labelled(tree,first).props.disabled,true);
 screen.searches[1].resolve(searchResult('First headphones','GB',product('one','First headphones','GBP')));await flush();tree=screen.render();
 assert.deepEqual(labelled(tree,first).props.accessibilityState,{disabled:false,busy:false});
 }finally{screen.cleanup();}
});

test('rechecked retailer actions show and announce the affiliate disclosure', async () => {
  const screen = createScreen();
  try {
    screen.render();
    await flush();
    let tree = screen.render();
    labelled(tree, 'Search for wireless headphones').props.onPress();
    const item = product('one', 'Fictional headphones', 'GBP');
    item.offers[0].maxCommissionRate = 0.05;
    item.offers.push({ ...item.offers[0], url: 'https://another.example/item', domain: 'another.example' });
    screen.searches[0].resolve(searchResult('wireless headphones', 'GB', item));
    await flush();
    tree = screen.render();
    let card = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'VerifiedOffersCard' && node.props.product.id === 'one');
    assert.ok(card);
    assert.equal(card.type(card.props), null, 'No retailer handoff appears before offers are rechecked');

    labelled(tree, 'Recheck offers for Fictional headphones').props.onPress();
    screen.searches[1].resolve(searchResult('Fictional headphones', 'GB', item));
    await flush();
    tree = screen.render();
    card = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'VerifiedOffersCard' && node.props.product.id === 'one');
    const checked = card.type(card.props);
    const disclosure = 'We may earn a commission from retailer links.';
    assert.ok(nodes(checked).some((node) => node.type === 'Text' && textOf(node) === disclosure));
    const links = nodes(checked).filter((node) => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('Open offer '));
    assert.equal(links.length, 2);
    for (const link of links) {
      assert.equal(link.props.accessibilityHint, disclosure);
      assert.doesNotMatch(link.props.accessibilityLabel, /We may earn a commission/);
    }
    assert.match(textOf(checked), /★ Up to 5%/);

    screen.setPlatform('web');
    tree = screen.render();
    card = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'VerifiedOffersCard' && node.props.product.id === 'one');
    const webChecked = card.type(card.props);
    assert.ok(nodes(webChecked).some((node) => node.type === 'Text' && textOf(node) === disclosure));
    const webLinks = nodes(webChecked).filter((node) => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('Open offer '));
    assert.equal(webLinks.length, 2);
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { Pressable, Text } = require('react-native-web');
    for (const link of webLinks) {
      assert.match(link.props.accessibilityLabel, /We may earn a commission from retailer links\./);
      assert.equal(link.props.accessibilityHint, undefined);
      const markup = renderToStaticMarkup(React.createElement(Pressable, link.props, React.createElement(Text, null, 'Open')));
      assert.match(markup, /aria-label="[^"]*We may earn a commission from retailer links\./);
    }
  } finally { screen.cleanup(); }
});

test('create collection has descriptive name, accessible disabled state and adequate touch target',async()=>{
 const screen=createScreen();try{
 screen.render();await flush();let tree=screen.render();
 let button=labelled(tree,'Create collection');
 assert.equal(button.props.accessibilityRole,'button');assert.equal(button.props.accessibilityState.disabled,true);
 const style=Object.assign({},...button.props.style({pressed:false}).filter(Boolean));assert.ok(style.minHeight>=48 && style.minWidth>=48);
 labelled(tree,'New collection name').props.onChangeText('Fictional list');tree=screen.render();button=labelled(tree,'Create collection');
 assert.equal(button.props.disabled,false);assert.equal(button.props.accessibilityState.disabled,false);
 const pause=screen.pauseSave();button.props.onPress();await pause.started.promise;tree=screen.render();
 assert.equal(labelled(tree,'Create collection').props.accessibilityState.disabled,true);
 pause.resolve();await flush();tree=screen.render();assert.equal(labelled(tree,'Create collection').props.accessibilityState.disabled,true);
 }finally{screen.cleanup();}
});

test('collection conflict disables stale edits and reloads without losing either draft', async () => {
 const screen=createScreen();try {
  screen.render();await flush();let tree=screen.render();
  labelled(tree,'New collection name').props.onChangeText('Draft new list');
  labelled(tree,'Rename Favourites').props.onChangeText('Draft renamed list');
  tree=screen.render();const staleRename=nodes(tree).find(n=>n.type==='Pressable'&&textOf(n)==='Rename');
  const staleNewInput=labelled(tree,'New collection name'),staleRenameInput=labelled(tree,'Rename Favourites');
  const externallySaved=[{id:'saved-list',name:'Elsewhere',updatedAt:'2026-11-06',items:[]},{id:'other-list',name:'Other',updatedAt:'2026-11-06',items:[]}];
  screen.stored.set(screen.collectionKey,JSON.stringify({version:1,collections:externallySaved}));
  staleRename.props.onPress();await flush();tree=screen.render();
  assert.match(textOf(tree),/last change may already have been saved/i);
  assert.match(textOf(tree),/Favourites/);assert.equal(labelled(tree,'New collection name').props.value,'Draft new list');
  assert.equal(labelled(tree,'Rename Favourites').props.value,'Draft renamed list');
  assert.equal(labelled(tree,'New collection name').props.editable,false);
  assert.equal(labelled(tree,'Rename Favourites').props.editable,false);
  assert.equal(labelled(tree,'Create collection').props.disabled,true);
  const pause=screen.pauseCollectionRead();nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await pause.started.promise;
  tree=screen.render();assert.match(textOf(tree),/Favourites/);assert.equal(labelled(tree,'Create collection').props.disabled,true);
  pause.resolve();await flush();
  staleRename.props.onPress();await flush();assert.equal(screen.collectionWrites(),0,'a stale pre-reload event must not write');
  tree=screen.render();assert.match(textOf(tree),/Elsewhere/);
  assert.equal(labelled(tree,'New collection name').props.value,'Draft new list');
  assert.equal(labelled(tree,'Rename Elsewhere').props.value,'Draft renamed list');
  assert.equal(labelled(tree,'Rename Elsewhere').props.editable,true);
  labelled(tree,'New collection name').props.onChangeText('Newer reviewed list draft');
  labelled(tree,'Rename Elsewhere').props.onChangeText('Newer reviewed rename');
  staleNewInput.props.onChangeText('Stale list draft');staleRenameInput.props.onChangeText('Stale rename');tree=screen.render();
  assert.equal(labelled(tree,'New collection name').props.value,'Newer reviewed list draft');
  assert.equal(labelled(tree,'Rename Elsewhere').props.value,'Newer reviewed rename');
  assert.deepEqual(JSON.parse(screen.stored.get(screen.collectionKey)).collections,externallySaved);
 }finally{screen.cleanup();}
});

test('a write applied before its acknowledgement fails is recovered without a second write', async () => {
 const screen=createScreen();try {
  screen.render();await flush();let tree=screen.render();labelled(tree,'Rename Favourites').props.onChangeText('Stored before error');tree=screen.render();
  screen.failAcknowledgementAfterWrite();nodes(tree).find(n=>n.type==='Pressable'&&textOf(n)==='Rename').props.onPress();await flush();tree=screen.render();
  assert.equal(screen.collectionWrites(),1);assert.equal(JSON.parse(screen.stored.get(screen.collectionKey)).collections[0].name,'Stored before error');
  assert.match(textOf(tree),/last change may already have been saved/i);assert.equal(labelled(tree,'Rename Favourites').props.editable,false);
  nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await flush();tree=screen.render();
  assert.equal(labelled(tree,'Rename Stored before error').props.value,'Stored before error');assert.equal(screen.collectionWrites(),1);
 }finally{screen.cleanup();}
});

test('overlength pasted collection names stay visible and cause no add or rename', async () => {
 const screen=createScreen();try {
  screen.render();await flush();let tree=screen.render();const original=screen.stored.get(screen.collectionKey);
  const newName='A'.repeat(41),rename='B'.repeat(41);
  assert.equal(labelled(tree,'New collection name').props.maxLength,undefined);
  assert.equal(labelled(tree,'Rename Favourites').props.maxLength,undefined);
  labelled(tree,'New collection name').props.onChangeText(newName);tree=screen.render();
  labelled(tree,'Create collection').props.onPress();await flush();tree=screen.render();
  assert.match(textOf(tree),/Keep collection names to 40 characters/i);assert.equal(labelled(tree,'New collection name').props.value,newName);
  labelled(tree,'Rename Favourites').props.onChangeText(rename);tree=screen.render();
  nodes(tree).find(n=>n.type==='Pressable'&&textOf(n)==='Rename').props.onPress();await flush();tree=screen.render();
  assert.match(textOf(tree),/Keep collection names to 40 characters/i);assert.equal(labelled(tree,'Rename Favourites').props.value,rename);
  assert.equal(screen.stored.get(screen.collectionKey),original);assert.equal(screen.collectionWrites(),0);
 }finally{screen.cleanup();}
});

test('an applied save with failed readback remains unverified until reload and preserves drafts on retry failure', async () => {
 const screen=createScreen();try {
  screen.render();await flush();let tree=screen.render();
  labelled(tree,'New collection name').props.onChangeText('New list draft');
  labelled(tree,'Rename Favourites').props.onChangeText('Renamed locally');
  tree=screen.render();screen.failReadbackAfterWrite();nodes(tree).find(n=>n.type==='Pressable'&&textOf(n)==='Rename').props.onPress();
  await flush();tree=screen.render();
  assert.equal(screen.collectionWrites(),1);assert.equal(JSON.parse(screen.stored.get(screen.collectionKey)).collections[0].name,'Renamed locally');
  assert.match(textOf(tree),/last change may already have been saved/i);assert.match(textOf(tree),/Favourites/);
  assert.equal(labelled(tree,'New collection name').props.value,'New list draft');
  assert.equal(labelled(tree,'Rename Favourites').props.value,'Renamed locally');
  screen.failNextCollectionRead();nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await flush();tree=screen.render();
  assert.match(textOf(tree),/last change may already have been saved/i);
  assert.equal(labelled(tree,'New collection name').props.editable,false);assert.equal(screen.collectionWrites(),1);
  nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await flush();tree=screen.render();
  assert.equal(labelled(tree,'Rename Renamed locally').props.value,'Renamed locally');
  assert.equal(labelled(tree,'New collection name').props.value,'New list draft');
  assert.equal(labelled(tree,'New collection name').props.editable,true);assert.equal(screen.collectionWrites(),1);
 }finally{screen.cleanup();}
});

test('input events queued during an unverified save remain as drafts through recovery', async () => {
 const screen=createScreen();try {
  screen.render();await flush();let tree=screen.render();
  labelled(tree,'New collection name').props.onChangeText('Initial new list');
  labelled(tree,'Rename Favourites').props.onChangeText('Initial rename');tree=screen.render();
  const newName=labelled(tree,'New collection name'),rename=labelled(tree,'Rename Favourites');
  const pause=screen.pauseSave();screen.failReadbackAfterWrite();labelled(tree,'Create collection').props.onPress();await pause.started.promise;
  newName.props.onChangeText('Newer list draft');rename.props.onChangeText('Newer rename draft');
  pause.resolve();await flush();tree=screen.render();
  assert.equal(labelled(tree,'New collection name').props.value,'Newer list draft');
  assert.equal(labelled(tree,'Rename Favourites').props.value,'Newer rename draft');
  nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await flush();tree=screen.render();
  assert.equal(labelled(tree,'New collection name').props.value,'Newer list draft');
  assert.equal(labelled(tree,'Rename Favourites').props.value,'Newer rename draft');
 }finally{screen.cleanup();}
});

test('a failed initial collection read can be retried without writing', async () => {
 const screen=createScreen({failInitialCollectionRead:true});try {
  screen.render();await flush();let tree=screen.render();
  assert.equal(labelled(tree,'New collection name').props.editable,false);
  assert.equal(screen.collectionWrites(),0);
  nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await flush();tree=screen.render();
  assert.match(textOf(tree),/Favourites/);assert.equal(labelled(tree,'New collection name').props.editable,true);
  assert.equal(screen.collectionWrites(),0);
 }finally{screen.cleanup();}
});

test('a removed list leaves its rename draft separate from another list', async () => {
 const screen=createScreen();try {
  screen.render();await flush();let tree=screen.render();const staleRename=labelled(tree,'Rename Favourites');staleRename.props.onChangeText('My unfinished rename');tree=screen.render();
  const other=[{id:'other-list',name:'Different list',updatedAt:'2026-11-06',items:[]}];
  screen.stored.set(screen.collectionKey,JSON.stringify({version:1,collections:other}));
  nodes(tree).find(n=>n.type==='Pressable'&&textOf(n)==='Rename').props.onPress();await flush();tree=screen.render();
  nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await flush();tree=screen.render();
  assert.equal(labelled(tree,'Unfinished name for Favourites').props.value,'My unfinished rename');
  labelled(tree,'Different list, 0 products').props.onPress();tree=screen.render();
  assert.equal(labelled(tree,'Rename Different list').props.value,'Different list');
  assert.equal(labelled(tree,'Unfinished name for Favourites').props.value,'My unfinished rename');
  staleRename.props.onChangeText('Late stale input');tree=screen.render();
  assert.equal(labelled(tree,'Rename Different list').props.value,'Different list');
  assert.equal(labelled(tree,'Unfinished name for Favourites').props.value,'My unfinished rename');
  assert.deepEqual(JSON.parse(screen.stored.get(screen.collectionKey)).collections,other);
 }finally{screen.cleanup();}
});

test('a reload completing after a scope change cannot expose the prior lists or drafts', async () => {
 const screen=createScreen();try {
  screen.render();await flush();let tree=screen.render();labelled(tree,'New collection name').props.onChangeText('Prior private draft');
  labelled(tree,'Rename Favourites').props.onChangeText('Prior private rename');tree=screen.render();
  screen.stored.set(screen.collectionKey,JSON.stringify({version:1,collections:[]}));
  nodes(tree).find(n=>n.type==='Pressable'&&textOf(n)==='Rename').props.onPress();await flush();tree=screen.render();
  const pause=screen.pauseCollectionRead();nodes(tree).find(n=>n.props?.label==='Reload saved collections').props.onPress();await pause.started.promise;
  const owner={kind:'owner',dataScope:'v1_'+'Y'.repeat(42)+'A'};
  screen.setOwnerLists(owner,[{id:'owner-list',name:'Owner list',updatedAt:'2026-11-06',items:[]}]);
  screen.transition(owner);tree=screen.render();assert.doesNotMatch(textOf(tree),/Favourites|Prior private/);
  pause.resolve();await flush();tree=screen.render();assert.match(textOf(tree),/Owner list/);
  assert.doesNotMatch(textOf(tree),/Favourites|Prior private/);assert.equal(labelled(tree,'New collection name').props.value,'');
  assert.equal(labelled(tree,'Rename Owner list').props.value,'Owner list');assert.equal(screen.collectionWrites(),0);
 }finally{screen.cleanup();}
});
