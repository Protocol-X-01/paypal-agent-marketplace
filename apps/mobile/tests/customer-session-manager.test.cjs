// Pure synthetic adapter tests; no Expo APIs, native storage or device calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
function load(file, aliases = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', code)(loaded.exports, name => { if (Object.hasOwn(aliases, name)) return aliases[name]; throw Error('Unexpected runtime dependency'); }, loaded);
  return loaded.exports;
}
const scope = load('customer-storage-scope.ts');
const links = load('customer-session-links.ts', { './customer-storage-scope': scope });
const p = load('customer-session-storage.ts', { './customer-session-links': links });
const token = n => Buffer.alloc(32, n).toString('base64url');
const config = { origin: 'https://app.example.test', androidReturnUrl: 'https://app.example.test/native/android', iosReturnUrl: 'https://app.example.test/native/ios' };
const stamp = 1793980800000;
const identity = { authenticated: true, accountType: 'personal', dataScope: `v1_${token(5)}`, expiresAt: stamp + 1700000 };
const pending = { state: token(1), codeVerifier: token(2) };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const values = new Map([['paypal-markets.mobile.manual-holdings.secure.v1', 'guest portfolio unchanged'], ['paypal-markets.venmo-contacts.v1', 'guest contacts unchanged']]);
  const writes = []; const reads = [];
  const adapter = { kind: 'native-secure-device-only', async getItem(key) { reads.push(key); return values.get(key) ?? null; }, async setItem(key, value) { writes.push({ key, value }); values.set(key, value); } };
  const store = p.createCustomerSessionStorage(adapter, config, { now: () => stamp, ...options });
  return { adapter, store, values, writes, reads };
}

const clientModule = load('customer-session-client.ts', { './customer-session-links': links });
const managerModule = load('customer-session-manager.ts', { './customer-session-links': links, './customer-session-client': clientModule });
function setup() {
 const f = fixture(); let tick = stamp; const calls = []; let expire;
 const client = {
  async availability(){return {loginAvailable:true}},
  async createHandoff(){calls.push('handoff');return {handoff:token(3),authorizationUrl:`${config.origin}/api/auth/native/authorize?handoff=${token(3)}`,expiresAt:stamp+300000,expiresIn:300}},
  async exchange(){calls.push('exchange');return {sessionToken:token(8)}},
  async session(){calls.push('session');return identity},
  async cancel(){calls.push('cancel')}, async logout(){calls.push('logout')}
 };
 const deps = {client,storage:f.store,platform:'android',now:()=>tick,setTimer:fn=>{expire=fn;return 1},clearTimer:()=>{},
  secrets:async()=>({...pending,codeChallenge:token(4),codeChallengeMethod:'S256'}),
  openBrowser:async()=>{calls.push('browser');const stored=JSON.parse(f.writes.at(-1).value);assert.equal(stored.pending.handoff,token(3));return {type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${pending.state}`}}
 };
 const manager=managerModule.createCustomerSessionManager(config,deps);
 return {...f,client,deps,manager,calls,expire:()=>expire(),time:n=>{tick=n}};
}
test('verified sign-in persists handoff before browser and session before identity exposure',async()=>{
 const f=setup();const seen=[];f.manager.subscribe(x=>seen.push(x));await f.manager.restore();assert.equal(f.manager.getState().status,'guest');await f.manager.start();
 assert.deepEqual(f.calls,['handoff','browser','exchange','session']);assert.equal(f.manager.getState().status,'authenticated');assert.equal(JSON.parse(f.writes.at(-1).value).pending,null);
 assert.ok(!JSON.stringify(seen).includes(token(8)));f.expire();assert.equal(f.manager.getState().status,'holding');
});
test('immediate repeated start requests keep the first sign-in attempt', { timeout: 5000 }, async()=>{
 const f=setup();const seen=[];f.manager.subscribe(state=>seen.push(state.status));await f.manager.restore();
 const first=f.manager.start(),afterFirst=seen.length,second=f.manager.start();
 assert.equal(seen.length,afterFirst,'A repeated start must not publish another scope transition');
 await Promise.all([first,second]);
 assert.deepEqual(f.calls,['handoff','browser','exchange','session']);
 assert.equal(f.manager.getState().status,'authenticated');
 assert.equal(JSON.parse(f.writes.at(-1).value).pending,null);
});
test('a synchronous holding subscriber can cancel before start is queued', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();let cancelled,armed=true,availability=0,secrets=0;
 const getAvailability=f.client.availability,makeSecrets=f.deps.secrets;
 f.client.availability=async()=>{availability++;return getAvailability()};
 f.deps.secrets=async()=>{secrets++;return makeSecrets()};
 const unsubscribe=f.manager.subscribe(state=>{if(armed&&state.status==='holding'){armed=false;cancelled=f.manager.cancel()}});
 const started=f.manager.start();assert.ok(cancelled);await Promise.all([started,cancelled]);
 assert.equal(f.manager.getState().status,'guest');assert.deepEqual(f.calls,[]);
 assert.equal(availability,0);assert.equal(secrets,0);assert.equal(f.writes.length,0);
 unsubscribe();await f.manager.start();assert.equal(f.manager.getState().status,'authenticated');
});
test('a synchronous holding subscriber can sign out before reauthentication is queued', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();let signedOut,armed=true,availability=0,secrets=0;
 const getAvailability=f.client.availability,makeSecrets=f.deps.secrets;
 f.client.availability=async()=>{availability++;return getAvailability()};
 f.deps.secrets=async()=>{secrets++;return makeSecrets()};
 const unsubscribe=f.manager.subscribe(state=>{if(armed&&state.status==='holding'){armed=false;signedOut=f.manager.logout()}});
 const started=f.manager.start();assert.ok(signedOut);await Promise.all([started,signedOut]);
 assert.equal(f.manager.getState().status,'guest');
 assert.deepEqual(f.calls,['handoff','browser','exchange','session','logout']);
 assert.equal(availability,0);assert.equal(secrets,0);
 const stored=JSON.parse(f.writes.at(-1).value);assert.equal(stored.session,null);assert.equal(stored.pending,null);
 unsubscribe();
});
test('a reentrant capability check cannot supersede explicit sign-out', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();let out,probed=false;
 f.deps.canStartSignIn=()=>{if(!probed){probed=true;out=f.manager.logout()}return true};
 const started=f.manager.start();assert.ok(out);await Promise.all([started,out]);
 assert.equal(f.manager.getState().status,'guest');assert.equal(f.calls.filter(call=>call==='logout').length,1);
});
test('a reentrant capability check cannot start a duplicate flow', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();let nested,probes=0;
 f.deps.canStartSignIn=()=>{probes++;if(probes===1)nested=f.manager.start();return true};
 const started=f.manager.start();assert.ok(nested);await Promise.all([started,nested]);
 assert.equal(probes,1);assert.equal(f.manager.getState().status,'authenticated');
 assert.deepEqual(f.calls,['handoff','browser','exchange','session']);
});
test('reentrant restore and foreground wait for the same pending sign-out', { timeout: 5000 }, async()=>{
 for(const action of ['restore','foreground']){
  const f=setup(),gate=deferred(),entered=deferred();await f.manager.restore();await f.manager.start();
  f.client.logout=async()=>{f.calls.push('logout');entered.resolve();await gate.promise};
  const observed=[];let nested,duplicate,armed=true,nestedDone=false;
  f.manager.subscribe(state=>{
   observed.push(state.status);
   if(armed&&state.status==='holding'){
    armed=false;nested=action==='restore'?f.manager.restore():f.manager.setForeground(true);
    duplicate=f.manager.logout();void nested.then(()=>{nestedDone=true});
   }
  });
  const out=f.manager.logout();assert.equal(duplicate,out);await entered.promise;
  assert.equal(nestedDone,false);assert.equal(f.manager.getState().status,'holding');
  assert.ok(!observed.slice(observed.indexOf('holding')).includes('authenticated'));
  gate.resolve();await Promise.all([out,nested]);
  assert.equal(f.manager.getState().status,'guest');assert.equal(f.calls.filter(c=>c==='logout').length,1);
 }
});
test('reentrant logout wins over a restore even when durable revocation fails', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();let out,armed=true;
 f.adapter.setItem=async()=>{throw Error('storage unavailable')};
 f.manager.subscribe(state=>{if(armed&&state.status==='holding'){armed=false;out=f.manager.logout()}});
 const count=f.calls.length,restoring=f.manager.restore();assert.ok(out);await Promise.all([restoring,out]);
 assert.equal(f.manager.getState().status,'holding');assert.ok(!f.calls.slice(count).includes('session'));
});
test('an accepted sign-out survives disposal and the next manager sees guest', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();const seen=[];
 f.manager.subscribe(state=>seen.push(state.status));const out=f.manager.logout();f.manager.dispose();const after=seen.length;
 await out;assert.equal(seen.length,after);assert.equal(f.calls.filter(c=>c==='logout').length,1);
 const store=p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp});
 const next=managerModule.createCustomerSessionManager(config,{...f.deps,storage:store});await next.restore();
 assert.equal(next.getState().status,'guest');next.dispose();
});
test('an accepted sign-out holds every active manager sharing the secure adapter', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();
 const otherStore=p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp});
 const other=managerModule.createCustomerSessionManager(config,{...f.deps,storage:otherStore});await other.restore();
 assert.equal(other.getState().status,'authenticated');const gate=deferred(),entered=deferred(),seen=[];
 f.client.logout=async()=>{entered.resolve();await gate.promise};other.subscribe(state=>seen.push(state.status));
 let otherDuringNotification;f.manager.subscribe(state=>{if(state.status==='holding')otherDuringNotification=other.getState().status});
 const out=f.manager.logout();assert.equal(otherDuringNotification,'holding');assert.equal(other.getState().status,'holding');await entered.promise;
 assert.ok(!seen.slice(seen.indexOf('holding')).includes('authenticated'));
 gate.resolve();await out;await other.restore();assert.equal(other.getState().status,'guest');other.dispose();
});
test('a remounted manager cannot restore while prior sign-out is pending or failed', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();const gate=deferred(),entered=deferred(),original=f.adapter.getItem;
 f.adapter.getItem=async key=>{entered.resolve();await gate.promise;return original(key)};
 const out=f.manager.logout();f.manager.dispose();await entered.promise;
 const store=p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp});let sessions=0;
 const next=managerModule.createCustomerSessionManager(config,{...f.deps,storage:store,client:{...f.client,session:async()=>{sessions++;return identity}}});
 const restoring=next.restore();await Promise.resolve();await Promise.resolve();
 assert.equal(next.getState().status,'holding');assert.equal(sessions,0);
 gate.resolve();await Promise.all([out,restoring]);assert.equal(next.getState().status,'guest');assert.equal(sessions,0);next.dispose();

 for(const failure of ['before-write','after-write']){
  const g=setup();await g.manager.restore();await g.manager.start();const setItem=g.adapter.setItem;let failing=true;
  g.adapter.setItem=async(...args)=>{if(failing){if(failure==='after-write')await setItem(...args);throw Error('storage unavailable')}return setItem(...args)};
  const failed=g.manager.logout();g.manager.dispose();await failed;
  const otherStore=p.createCustomerSessionStorage(g.adapter,config,{now:()=>stamp});let validations=0;
  const other=managerModule.createCustomerSessionManager(config,{...g.deps,storage:otherStore,client:{...g.client,session:async()=>{validations++;return identity}}});
  await other.restore();assert.equal(other.getState().status,'holding');assert.equal(validations,0);
  failing=false;await other.restore();assert.equal(other.getState().status,'holding');assert.equal(validations,0);
  await other.restore(true);assert.equal(other.getState().status,'guest');assert.equal(validations,0);other.dispose();
 }
});
test('a remount remains held while the accepted sign-out write is in flight', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();const gate=deferred(),entered=deferred(),write=f.adapter.setItem;
 f.adapter.setItem=async(key,value)=>{if(JSON.parse(value).revocations.length){entered.resolve();await gate.promise}return write(key,value)};
 const out=f.manager.logout();await entered.promise;f.manager.dispose();let validations=0;
 const next=managerModule.createCustomerSessionManager(config,{...f.deps,storage:p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp}),client:{...f.client,session:async()=>{validations++;return identity}}});
 const restore=next.restore();await Promise.resolve();assert.equal(next.getState().status,'holding');assert.equal(validations,0);
 gate.resolve();await Promise.all([out,restore]);assert.equal(next.getState().status,'guest');assert.equal(validations,0);next.dispose();
});
test('a different manager cannot finish an older verification after shared sign-out begins', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();const gate=deferred(),entered=deferred();
 const otherStore=p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp});
 const other=managerModule.createCustomerSessionManager(config,{...f.deps,storage:otherStore,client:{...f.client,session:async()=>{entered.resolve();await gate.promise;return identity}}});
 const seen=[];other.subscribe(state=>seen.push(state.status));const verify=other.restore();await entered.promise;
 const out=f.manager.logout();assert.equal(other.getState().status,'holding');gate.resolve();await Promise.all([out,verify]);
 assert.equal(other.getState().status,'holding');assert.ok(!seen.includes('authenticated'));
 await other.restore();assert.equal(other.getState().status,'guest');other.dispose();
});
test('shared sign-out waits for a late handoff even when its initiating manager is disposed', { timeout: 5000 }, async()=>{
 for(const disposed of [false,true]){
  const f=setup(),gate=deferred(),entered=deferred();await f.manager.restore();
  const other=managerModule.createCustomerSessionManager(config,{...f.deps,storage:p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp})});await other.restore();
  const make=f.client.createHandoff;f.client.createHandoff=async()=>{entered.resolve();await gate.promise;return make()};
  const start=f.manager.start();await entered.promise;if(disposed)f.manager.dispose();
  let finished=false;const out=other.logout();void out.then(()=>{finished=true});await new Promise(resolve=>setImmediate(resolve));const tooEarly=finished;
  gate.resolve();await Promise.all([start,out]);
  assert.equal(tooEarly,false);assert.equal(other.getState().status,'guest');
  assert.ok(f.calls.includes('cancel'));assert.ok(!f.calls.includes('browser'));
  const saved=JSON.parse(f.writes.at(-1).value);assert.equal(saved.pending,null);assert.deepEqual(saved.revocations,[]);
  other.dispose();if(!disposed)f.manager.dispose();
 }
});
test('an unverified late handoff is cancelled before shared sign-out can complete', { timeout: 5000 }, async()=>{
 for(const failure of ['before-write','after-write']){
  const f=setup(),gate=deferred(),entered=deferred();await f.manager.restore();
  const other=managerModule.createCustomerSessionManager(config,{...f.deps,storage:p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp})});await other.restore();
  const make=f.client.createHandoff;f.client.createHandoff=async()=>{entered.resolve();await gate.promise;return make()};
  const write=f.adapter.setItem;let failAttach=true;
  f.adapter.setItem=async(key,value)=>{if(failAttach&&JSON.parse(value).pending?.handoff){failAttach=false;if(failure==='after-write')await write(key,value);throw Error('attachment unavailable')}return write(key,value)};
  let cancelAttempts=0,allowCancel=false;f.client.cancel=async()=>{cancelAttempts++;if(!allowCancel)throw Error('offline')};
  const start=f.manager.start();await entered.promise;const out=other.logout();gate.resolve();await Promise.all([start,out]);
  assert.equal(other.getState().status,'holding');assert.ok(cancelAttempts>0);assert.ok(!f.calls.includes('browser'));
  allowCancel=true;await other.restore(true);assert.equal(other.getState().status,'guest');assert.ok(cancelAttempts>1);
  const saved=JSON.parse(f.writes.at(-1).value);assert.equal(saved.pending,null);assert.deepEqual(saved.revocations,[]);
  other.dispose();f.manager.dispose();
 }
});
test('an unverified handoff without concurrent sign-out is retained for later cleanup', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();const write=f.adapter.setItem;
 f.adapter.setItem=async(key,value)=>{if(JSON.parse(value).pending?.handoff)throw Error('attachment unavailable');return write(key,value)};
 let cancellations=0;f.client.cancel=async proof=>{cancellations++;assert.equal(proof.handoff,token(3));assert.equal(proof.codeVerifier,pending.codeVerifier)};
 await f.manager.start();assert.equal(f.manager.getState().status,'holding');assert.ok(!f.calls.includes('browser'));
 await f.manager.restore();assert.equal(f.manager.getState().status,'holding');
 await f.manager.restore(true);assert.equal(f.manager.getState().status,'guest');assert.equal(cancellations,1);
 assert.equal(JSON.parse(f.writes.at(-1).value).pending,null);
});
test('a replacement manager cancels an unverified handoff with its originating client', { timeout: 5000 }, async()=>{
 const f=setup(),gate=deferred(),entered=deferred();await f.manager.restore();
 const otherClient={...f.client,cancel:async()=>{throw Error('unexpected different client')}};
 const other=managerModule.createCustomerSessionManager(config,{...f.deps,client:otherClient,storage:p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp})});await other.restore();
 const make=f.client.createHandoff;f.client.createHandoff=async()=>{entered.resolve();await gate.promise;return make()};
 const write=f.adapter.setItem;f.adapter.setItem=async(key,value)=>{if(JSON.parse(value).pending?.handoff)throw Error('attachment unavailable');return write(key,value)};
 let called=0;f.client.cancel=async()=>{called++};const start=f.manager.start();await entered.promise;
 const out=other.logout();gate.resolve();await Promise.all([start,out]);
 assert.equal(called,1);assert.equal(other.getState().status,'guest');other.dispose();f.manager.dispose();
});
test('a failed privacy preparation does not skip other holds or report guest', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();let failing=true,otherHeld=0;
 f.deps.preparePrivacyHold=()=>{if(failing)throw Error('preparation failed')};
 const other=managerModule.createCustomerSessionManager(config,{...f.deps,preparePrivacyHold:()=>{otherHeld++},storage:p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp})});await other.restore();
 await f.manager.logout();assert.equal(f.manager.getState().status,'holding');assert.equal(other.getState().status,'holding');assert.equal(otherHeld,1);
 failing=false;await f.manager.restore(true);assert.equal(f.manager.getState().status,'guest');other.dispose();f.manager.dispose();
});
test('a failed account switch keeps deferred and remounted peers held until explicit recovery', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();
 const makeStore=()=>p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp});
 const other=managerModule.createCustomerSessionManager(config,{...f.deps,storage:makeStore()});await other.restore();
 const gate=deferred(),entered=deferred();f.client.createHandoff=async()=>{entered.resolve();await gate.promise;throw Error('unavailable')};
 let deferredRestore,armed=true;f.manager.subscribe(state=>{if(armed&&state.status==='holding'){armed=false;deferredRestore=other.restore()}});
 const validations=f.calls.filter(call=>call==='session').length,start=f.manager.start();await entered.promise;gate.resolve();await Promise.all([start,deferredRestore]);
 assert.equal(other.getState().status,'holding');assert.equal(f.calls.filter(call=>call==='session').length,validations);
 const replacement=managerModule.createCustomerSessionManager(config,{...f.deps,storage:makeStore()});await replacement.restore();
 assert.equal(replacement.getState().status,'holding');assert.equal(f.calls.filter(call=>call==='session').length,validations);
 await other.restore(true);assert.equal(other.getState().status,'guest');await replacement.restore();assert.equal(replacement.getState().status,'guest');
 replacement.dispose();other.dispose();f.manager.dispose();
});
test('disposing inside the initial sign-out notification does not cancel accepted cleanup', { timeout: 5000 }, async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();let armed=true;
 f.manager.subscribe(state=>{if(armed&&state.status==='holding'){armed=false;f.manager.dispose()}});
 await f.manager.logout();assert.equal(f.calls.filter(c=>c==='logout').length,1);
 const next=managerModule.createCustomerSessionManager(config,{...f.deps,storage:p.createCustomerSessionStorage(f.adapter,config,{now:()=>stamp})});
 await next.restore();assert.equal(next.getState().status,'guest');next.dispose();
});
test('a new subscriber never receives an expired identity when its timer is delayed',async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();f.time(identity.expiresAt);
 const seen=[];f.manager.subscribe(state=>seen.push(state.status));assert.deepEqual(seen,['holding']);
});
test('repeated start during browser wait does not dismiss or supersede it', { timeout: 5000 }, async()=>{
 const f=setup(),gate=deferred(),entered=deferred();let dismissed=0;
 f.deps.dismissBrowser=()=>{dismissed++};
 f.deps.openBrowser=async()=>{f.calls.push('browser');entered.resolve();return gate.promise};
 await f.manager.restore();const first=f.manager.start();await entered.promise;
 try {
  await f.manager.start();
  assert.equal(f.manager.isBusy(),true);assert.equal(dismissed,0);
  assert.ok(JSON.parse(f.writes.at(-1).value).pending.handoff);
  assert.deepEqual(f.calls,['handoff','browser']);
 } finally {
  gate.resolve({type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${pending.state}`});
  await first;
 }
 assert.equal(f.manager.getState().status,'authenticated');
 assert.deepEqual(f.calls,['handoff','browser','exchange','session']);
});
test('explicit cancellation still interrupts an attempt after a repeated start', { timeout: 5000 }, async()=>{
 const f=setup(),gate=deferred(),entered=deferred();let dismissed=0;
 f.deps.dismissBrowser=()=>{dismissed++};
 f.deps.openBrowser=async()=>{f.calls.push('browser');entered.resolve();return gate.promise};
 await f.manager.restore();const first=f.manager.start();await entered.promise;
 await f.manager.start();await f.manager.cancel();await first;
 assert.equal(dismissed,1);assert.equal(f.manager.getState().status,'guest');
 assert.deepEqual(f.calls,['handoff','browser','cancel']);
 gate.resolve({type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${pending.state}`});
 await Promise.resolve();assert.ok(!f.calls.includes('exchange'));
});
test('a start during restoration does not interrupt the pending verification', { timeout: 5000 }, async()=>{
 const f=setup(),gate=deferred(),entered=deferred(),original=f.adapter.getItem;
 f.adapter.getItem=async key=>{entered.resolve();await gate.promise;return original(key)};
 const restoring=f.manager.restore();await entered.promise;
 try {await f.manager.start();assert.equal(f.manager.getState().status,'holding');assert.deepEqual(f.calls,[])}
 finally {gate.resolve();await restoring}
 assert.equal(f.manager.getState().status,'guest');
});
test('a start during sign-out cannot supersede the revocation', { timeout: 5000 }, async()=>{
 const f=setup(),gate=deferred(),entered=deferred();await f.manager.restore();await f.manager.start();
 f.client.logout=async()=>{f.calls.push('logout');entered.resolve();await gate.promise};
 const signingOut=f.manager.logout();await entered.promise;
 try {
  await f.manager.start();assert.equal(f.manager.getState().status,'holding');
  assert.equal(JSON.parse(f.writes.at(-1).value).revocations[0].kind,'session');
 } finally {gate.resolve();await signingOut}
 assert.equal(f.manager.getState().status,'guest');
 assert.deepEqual(f.calls,['handoff','browser','exchange','session','logout']);
});
test('restart revalidates; failed verification never falls back to guest',async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();f.client.session=async()=>{throw Error('private token')};await f.manager.restore();assert.equal(f.manager.getState().status,'holding');
});
test('wrong return holds until cancellation and no exchange occurs',async()=>{
 const f=setup();f.deps.openBrowser=async()=>({type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${token(9)}`});await f.manager.restore();await f.manager.start();assert.equal(f.manager.getState().status,'holding');assert.ok(!f.calls.includes('exchange'));await f.manager.retryCleanup();assert.equal(f.manager.getState().status,'guest');assert.ok(f.calls.includes('cancel'));
});
test('lost exchange and failed cancellation retain verifier and privacy hold',async()=>{
 const f=setup();f.client.exchange=async()=>{throw Error('lost')};await f.manager.restore();await f.manager.start();f.client.cancel=async()=>{throw Error('offline')};await f.manager.retryCleanup();assert.equal(f.manager.getState().status,'holding');const held=JSON.parse(f.writes.at(-1).value);assert.equal(held.pending.codeVerifier,pending.codeVerifier);assert.equal(held.revocations[0].kind,'handoff');f.client.cancel=async()=>{};await f.manager.retryCleanup();assert.equal(f.manager.getState().status,'guest');
});
test('logout hides identity synchronously and retains failed revocation for retry',async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();const gate=deferred();f.client.logout=()=>gate.promise;const out=f.manager.logout();assert.equal(f.manager.getState().status,'holding');gate.resolve();await out;assert.equal(f.manager.getState().status,'guest');
});
test('superseded handoff creation persists cleanup proof but never opens browser',async()=>{
 const f=setup();await f.manager.restore();const gate=deferred(),entered=deferred();const original=f.client.createHandoff;f.client.createHandoff=async()=>{entered.resolve();await gate.promise;return original()};const start=f.manager.start();await entered.promise;const cancel=f.manager.cancel();gate.resolve();await Promise.all([start,cancel]);assert.ok(!f.calls.includes('browser'));assert.ok(f.calls.includes('cancel'));assert.equal(f.manager.getState().status,'guest');
});
test('unbound failure requires explicit recovery and corrupt storage remains held',async()=>{
 const f=setup();await f.manager.restore();f.client.createHandoff=async()=>{throw Error('lost creation')};await f.manager.start();await f.manager.restore();assert.equal(f.manager.getState().status,'holding');await f.manager.restore(true);assert.equal(f.manager.getState().status,'guest');f.values.set(f.writes[0].key,'broken');await f.manager.restore();assert.equal(f.manager.getState().status,'holding');
});
test('suspend while verification is pending blocks later hydration',async()=>{
 const f=setup();await f.manager.restore();const gate=deferred(),entered=deferred();f.client.session=async()=>{entered.resolve();await gate.promise;return identity};const start=f.manager.start();await entered.promise;f.manager.suspend();gate.resolve();await start;assert.equal(f.manager.getState().status,'holding');assert.ok(JSON.parse(f.writes.at(-1).value).pending);
});

test('pending browser cancellation never blocks cleanup; late success cannot exchange', async()=>{
 const f=setup();await f.manager.restore();const gate=deferred(),entered=deferred();let dismissed=0;
 f.deps.dismissBrowser=()=>{dismissed++};f.deps.openBrowser=()=>{entered.resolve();return gate.promise};
 const start=f.manager.start();await entered.promise;await f.manager.logout();await start;
 assert.equal(f.manager.getState().status,'guest');assert.equal(dismissed,1);assert.ok(f.calls.includes('cancel'));
 gate.resolve({type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${pending.state}`});await Promise.resolve();assert.ok(!f.calls.includes('exchange'));
});
test('cancel during exchange leaves no authentication and revokes lost issued session through handoff',async()=>{
 const f=setup();await f.manager.restore();const gate=deferred(),entered=deferred();
 f.client.exchange=async()=>{entered.resolve();await gate.promise;return {sessionToken:token(8)}};
 const start=f.manager.start();await entered.promise;const cancel=f.manager.cancel();gate.resolve();await Promise.all([start,cancel]);
 assert.equal(f.manager.getState().status,'guest');assert.ok(f.calls.includes('cancel'));assert.ok(!f.calls.includes('session'));
});
test('cancel during session persistence cleans both candidate and handoff',async()=>{
 const f=setup();await f.manager.restore();const gate=deferred(),entered=deferred(),original=f.adapter.setItem;
 f.adapter.setItem=async(key,value)=>{if(JSON.parse(value).session){entered.resolve();await gate.promise}await original(key,value)};
 const start=f.manager.start();await entered.promise;const cancel=f.manager.cancel();gate.resolve();await Promise.all([start,cancel]);
 assert.equal(f.manager.getState().status,'guest');assert.ok(f.calls.includes('logout'));assert.ok(f.calls.includes('cancel'));assert.equal(JSON.parse(f.writes.at(-1).value).session,null);
});
test('dispose clears observers and prevents resumed authentication',async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();let count=0;f.manager.subscribe(()=>count++);f.manager.dispose();const after=count;await f.manager.restore();assert.equal(count,after);assert.equal(f.manager.getState().status,'holding');
});

test('auth-browser background survives; background completion cannot expose identity',async()=>{
 const f=setup();await f.manager.restore();const gate=deferred(),entered=deferred();
 f.deps.openBrowser=async()=>{entered.resolve();return gate.promise};const start=f.manager.start();await entered.promise;
 assert.equal(f.manager.isBusy(),true);await f.manager.setForeground(false);
 gate.resolve({type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${pending.state}`});await start;
 assert.equal(f.manager.getState().status,'holding');assert.equal(f.manager.isBusy(),false);
 await f.manager.setForeground(true);assert.equal(f.manager.getState().status,'authenticated');
 await f.manager.setForeground(false);assert.equal(f.manager.getState().status,'holding');
});

test('foreground during browser wait allows completion without cancelling generation',async()=>{
 const f=setup();await f.manager.restore();const gate=deferred(),entered=deferred();f.deps.openBrowser=async()=>{entered.resolve();return gate.promise};
 const start=f.manager.start();await entered.promise;await f.manager.setForeground(false);const active=f.manager.setForeground(true);
 gate.resolve({type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${pending.state}`});await Promise.all([start,active]);assert.equal(f.manager.getState().status,'authenticated');
});
test('background during ordinary verification stays held; queued logout cannot resurrect on foreground',async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();const gate=deferred(),entered=deferred();f.client.session=async()=>{entered.resolve();await gate.promise;return identity};
 const restore=f.manager.restore();await entered.promise;await f.manager.setForeground(false);const logout=f.manager.logout();const active=f.manager.setForeground(true);assert.equal(f.manager.isBusy(),true);
 gate.resolve();await Promise.all([restore,logout,active]);assert.equal(f.manager.getState().status,'guest');assert.equal(f.manager.isBusy(),false);
});

test('foreground at background persistence completion revalidates rather than sticking in hold',async()=>{
 const f=setup();await f.manager.restore();const finish=f.store.finishVerifiedSignIn;let foreground;
 f.store.finishVerifiedSignIn=async(...args)=>{const result=await finish(...args);queueMicrotask(()=>queueMicrotask(()=>{foreground=f.manager.setForeground(true)}));return result};
 f.deps.openBrowser=async()=>{await f.manager.setForeground(false);return {type:'success',url:`${config.androidReturnUrl}?code=${token(6)}&state=${pending.state}`}};
 await f.manager.start();await foreground;assert.equal(f.manager.getState().status,'authenticated');
});

test('typed session401 persists revocation before terminal204 and only then restores guest',async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();f.client.session=async()=>{throw new clientModule.CustomerSessionError('unauthorized',401)};
 f.client.logout=async()=>{const row=JSON.parse(f.writes.at(-1).value);assert.equal(row.session,null);assert.equal(row.revocations[0].sessionToken,token(8));assert.equal(f.manager.getState().status,'holding')};
 await f.manager.restore();assert.equal(f.manager.getState().status,'guest');assert.deepEqual(JSON.parse(f.writes.at(-1).value).revocations,[]);
});
test('session401 with failed revocation or confirmation write keeps privacy hold and retry proof',async()=>{
 for(const failure of ['logout','confirmation-write']){
  const f=setup();await f.manager.restore();await f.manager.start();f.client.session=async()=>{throw new clientModule.CustomerSessionError('unauthorized',401)};
  if(failure==='logout')f.client.logout=async()=>{throw new clientModule.CustomerSessionError('unavailable',503)};
  else {const original=f.adapter.setItem;f.adapter.setItem=async(key,value)=>{if(JSON.parse(value).revocations.length===0)throw Error('storage unavailable');return original(key,value)}}
  await f.manager.restore();assert.equal(f.manager.getState().status,'holding');assert.equal(JSON.parse(f.writes.at(-1).value).revocations.length,1);
 }
});
test('non401 validation failures never automatically revoke or expose guest',async()=>{
 for(const code of ['timeout','rate_limited','unavailable','invalid_response']){const f=setup();await f.manager.restore();await f.manager.start();f.client.session=async()=>{throw new clientModule.CustomerSessionError(code)};await f.manager.restore();assert.equal(f.manager.getState().status,'holding');assert.ok(!f.calls.includes('logout'));assert.ok(JSON.parse(f.writes.at(-1).value).session)}
});

test('terminal204 with unverified local clear cannot publish guest until a later successful read',async()=>{
 const f=setup();await f.manager.restore();await f.manager.start();f.client.session=async()=>{throw new clientModule.CustomerSessionError('unauthorized',401)};
 const original=f.adapter.getItem;let rejectClear=true;
 f.adapter.getItem=async key=>{const raw=await original(key);if(rejectClear&&raw&&JSON.parse(raw).session===null&&JSON.parse(raw).revocations.length===0)throw Error('readback unavailable');return raw};
 await f.manager.restore();assert.equal(f.manager.getState().status,'holding');rejectClear=false;await f.manager.restore();assert.equal(f.manager.getState().status,'guest');
});


test('unsupported browser start creates no secrets, storage, handoff or state change', async()=>{
 for (const capability of [()=>false, ()=>{throw Error('unavailable')}]) {
  const f=setup(); await f.manager.restore();
  f.deps.canStartSignIn=capability;
  f.deps.secrets=async()=>{throw Error('secrets must not be requested')};
  const before=f.manager.getState(), reads=f.reads.length, writes=f.writes.length;
  await f.manager.start();
  assert.equal(f.manager.getState(),before);
  assert.deepEqual(f.calls,[]); assert.equal(f.reads.length,reads); assert.equal(f.writes.length,writes);
 }
 const f=setup(); f.deps.canStartSignIn=()=>true;
 await f.manager.restore(); await f.manager.start();
 assert.equal(f.manager.getState().status,'authenticated');
 f.deps.canStartSignIn=()=>false;
 const before=f.manager.getState(), count=f.calls.length, writes=f.writes.length;
 await f.manager.start(); assert.equal(f.manager.getState(),before);
 assert.equal(f.calls.length,count); assert.equal(f.writes.length,writes);
 await f.manager.logout(); assert.equal(f.manager.getState().status,'guest');
});
