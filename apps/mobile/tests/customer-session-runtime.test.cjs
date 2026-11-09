const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
function load(file,aliases={}){const m={exports:{}};new Function('exports','require','module',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,k=>{if(Object.hasOwn(aliases,k))return aliases[k];throw Error(k)},m);return m.exports}
const scope=load('customer-storage-scope.ts');const h=n=>Buffer.alloc(32,n).toString('base64url');const links={origin:'https://app.example.test',androidReturnUrl:'https://app.example.test/a',iosReturnUrl:'https://app.example.test/i'};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
function fixture(overrides={}){
 let state={status:'holding'},listener,disposed=false;const calls=[];
 const manager={subscribe(fn){listener=fn;fn(state);return()=>{listener=undefined}},getState:()=>state,setForeground:async active=>{calls.push(['foreground',active]);if(active)manager.emit({status:'guest'})},restore:async()=>manager.emit({status:'guest'}),start:async()=>calls.push('start'),logout:async()=>manager.emit({status:'guest'}),retryCleanup:async()=>calls.push('retry'),dispose(){disposed=true},emit(next){state=next;listener?.(next)}};
 const mod=load('customer-session-runtime.ts',{'./customer-storage-scope':scope,'./customer-session-manager':{createCustomerSessionManager:()=>manager}});
 const deps={platform:'android',configuration:{status:'ready',links},foreground:true,loadNative:async()=>{calls.push('native');return{client:{availability:async()=>({loginAvailable:true})}}},presence:async()=>{calls.push('presence');return'empty'},...overrides};
 return{runtime:mod.createCustomerSessionRuntime(deps),manager,calls,disposed:()=>disposed};
}
test('web remains guest without loading any native module',async()=>{const f=fixture({platform:'web'});await f.runtime.initialize();assert.equal(f.runtime.getState().session.status,'guest');assert.equal(f.runtime.getState().loginStatus,'disabled');assert.deepEqual(f.calls,[])});
test('disabled config loads presence only and never guesses guest over unknown storage',async()=>{for(const presence of ['empty','present','unavailable']){const f=fixture({configuration:{status:'disabled'},presence:async()=>presence});await f.runtime.initialize();assert.equal(f.runtime.getState().session.status,presence==='empty'?'guest':'holding');assert.ok(!f.calls.includes('native'));assert.equal(f.runtime.getState().loginStatus,'disabled')}});
test('presence rejection and native import rejection remain held',async()=>{for(const deps of [{configuration:{status:'disabled'},presence:async()=>{throw Error('secret')}},{loadNative:async()=>{throw Error('missing module')}}]){const f=fixture(deps);await f.runtime.initialize();assert.equal(f.runtime.getState().session.status,'holding');assert.equal(f.runtime.getState().loginStatus,'unavailable')}});
test('fence changes before subscriber observes identity and old leases die synchronously',async()=>{const f=fixture();await f.runtime.initialize();const old=f.runtime.storageFence.capture('portfolioSecure');let checked=false;f.runtime.subscribe(v=>{if(v.session.status==='authenticated'){assert.equal(f.runtime.storageFence.isCurrent(old),false);assert.equal(f.runtime.storageFence.current().kind,'owner');checked=true}});f.manager.emit({status:'authenticated',identity:{authenticated:true,accountType:'personal',dataScope:`v1_${h(2)}`,expiresAt:9999999999999}});assert.equal(checked,true);const owner=f.runtime.storageFence.capture('portfolioSecure');f.manager.emit({status:'holding'});assert.equal(f.runtime.storageFence.isCurrent(owner),false)});
test('availability failure disables login without turning a restored guest into a hold',async()=>{const f=fixture({loadNative:async()=>({client:{availability:async()=>{throw Error('offline')}}})});await f.runtime.initialize();assert.equal(f.runtime.getState().session.status,'guest');assert.equal(f.runtime.getState().loginStatus,'unavailable');await f.runtime.start();assert.ok(!f.calls.includes('start'))});
test('dispose fences pending import completion and removes subscribers',async()=>{const gate=deferred();const f=fixture({loadNative:()=>gate.promise});const init=f.runtime.initialize();f.runtime.dispose();gate.resolve({client:{availability:async()=>({loginAvailable:true})}});await init;assert.equal(f.runtime.storageFence.current().kind,'hold');assert.equal(f.runtime.getState().session.status,'holding')});
test('foreground is forwarded without implicit browser cancellation and actions are stable',async()=>{const f=fixture();await f.runtime.initialize();const action=f.runtime.start;await f.runtime.setForeground(false);await f.runtime.start();assert.ok(!f.calls.includes('start'));await f.runtime.setForeground(true);await f.runtime.start();assert.ok(f.calls.includes('start'));assert.equal(f.runtime.start,action);f.runtime.dispose();assert.equal(f.disposed(),true)});

test('disabled guest backgrounds to hold and foreground rechecks secure presence',async()=>{let presence='empty';const f=fixture({configuration:{status:'disabled'},presence:async()=>presence});await f.runtime.initialize();assert.equal(f.runtime.getState().session.status,'guest');const lease=f.runtime.storageFence.capture('portfolioSecure');await f.runtime.setForeground(false);assert.equal(f.runtime.getState().session.status,'holding');assert.equal(f.runtime.storageFence.isCurrent(lease),false);presence='present';await f.runtime.setForeground(true);assert.equal(f.runtime.getState().session.status,'holding')});
test('late presence and availability results cannot reveal data while backgrounded',async()=>{
 const presence=deferred(),f=fixture({configuration:{status:'disabled'},presence:()=>presence.promise});const init=f.runtime.initialize();await f.runtime.setForeground(false);presence.resolve('empty');await init;assert.equal(f.runtime.getState().session.status,'holding');
 const available=deferred(),g=fixture({loadNative:async()=>({client:{availability:()=>available.promise}})});const initialized=g.runtime.initialize();await Promise.resolve();await Promise.resolve();await g.runtime.setForeground(false);available.resolve({loginAvailable:true});await initialized;assert.equal(g.runtime.getState().session.status,'holding');
});
test('retry validates existing session and permits explicit failed-sign-out recovery',async()=>{const f=fixture();await f.runtime.initialize();const restores=[];f.manager.restore=async(...args)=>{restores.push(args)};await f.runtime.retry();assert.deepEqual(restores,[[true]]);assert.ok(!f.calls.includes('retry'))});

test('explicit retry refreshes availability without metadata-only lease invalidation',async()=>{let available=false;const f=fixture({loadNative:async()=>({client:{availability:async()=>({loginAvailable:available})}})});await f.runtime.initialize();assert.equal(f.runtime.getState().loginStatus,'unavailable');const lease=f.runtime.storageFence.capture('portfolioSecure');const revision=f.runtime.getState().revision;available=true;f.manager.restore=async()=>{};await f.runtime.retry();assert.equal(f.runtime.getState().loginStatus,'available');assert.equal(f.runtime.getState().revision,revision);assert.equal(f.runtime.storageFence.isCurrent(lease),true)});


test('unsupported browser skips availability and start but preserves restore and logout',async()=>{
 for (const capability of [()=>false,()=>{throw Error('unsupported')}]) {
  let probes=0; const f=fixture({loadNative:async()=>({canStartSignIn:capability,client:{availability:async()=>{probes++;return {loginAvailable:true}}}})});
  await f.runtime.initialize();
  assert.equal(f.runtime.getState().session.status,'guest');
  assert.equal(f.runtime.getState().loginStatus,'unavailable');
  await f.runtime.start(); await f.runtime.retry();
  assert.equal(probes,0); assert.ok(!f.calls.includes('start'));
  await f.runtime.logout(); assert.equal(f.runtime.getState().session.status,'guest');
 }
});
test('capability is rechecked at start after successful availability',async()=>{
 let supported=true; const f=fixture({loadNative:async()=>({canStartSignIn:()=>supported,client:{availability:async()=>({loginAvailable:true})}})});
 await f.runtime.initialize(); assert.equal(f.runtime.getState().loginStatus,'available');
 supported=false; await f.runtime.start(); assert.ok(!f.calls.includes('start'));
 supported=true; await f.runtime.start(); assert.ok(f.calls.includes('start'));
});
