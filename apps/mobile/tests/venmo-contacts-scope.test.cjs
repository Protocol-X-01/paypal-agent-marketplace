const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
function load(file, deps = {}) { const m = { exports: {} }; new Function('exports','require','module',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,k=>deps[k],m); return m.exports; }
const scope = load('customer-storage-scope.ts');
const owner = n => ({kind:'owner',dataScope:'v1_'+Buffer.alloc(32,n).toString('base64url')});
function fixture() { const map = new Map(), calls=[]; const api = { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, isAvailableAsync: async()=>true, getItemAsync: async k=>{ calls.push(['get',k]); return map.get(k)??null; }, setItemAsync: async(k,v)=>{ calls.push(['set',k]); map.set(k,v); }, deleteItemAsync: async k=>{calls.push(['delete',k]);map.delete(k);} }; return {map,calls,api,p:load('venmo-contacts.ts',{'expo-secure-store':api})}; }
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('guest wrappers preserve namespace; owners isolate; old callbacks stay invalid',async()=>{
 const f=fixture(); await f.p.addVenmoContact('Guest','guest'); const guest=f.map.get(scope.GUEST_PRIVATE_STORAGE_KEYS.venmoContacts);
 const fence=scope.createCustomerStorageFence(owner(1)), a=f.p.createVenmoContactsRepository(fence); await a.addVenmoContact('A','alpha');
 fence.transition(owner(2)); const b=f.p.createVenmoContactsRepository(fence); assert.deepEqual(await b.loadVenmoContacts(),{status:'ready',contacts:[]});
 assert.equal((await a.addVenmoContact('Old','old')).status,'unavailable'); await b.addVenmoContact('B','beta');
 assert.equal(f.map.get(scope.GUEST_PRIVATE_STORAGE_KEYS.venmoContacts),guest); assert.equal((await b.loadVenmoContacts()).contacts[0].handle,'beta');
 fence.transition(owner(1)); assert.equal((await a.loadVenmoContacts()).status,'unavailable'); assert.equal((await f.p.createVenmoContactsRepository(fence).loadVenmoContacts()).contacts[0].handle,'alpha');
});
test('delayed reads and queued mutations cannot expose or write into a new owner',async()=>{
 const f=fixture(), fence=scope.createCustomerStorageFence(owner(1)), a=f.p.createVenmoContactsRepository(fence), wait=deferred();
 const original=f.api.getItemAsync; let entered=false; f.api.getItemAsync=async k=>{if(!entered){entered=true;await wait.promise;}return original(k);};
 const first=a.addVenmoContact('A','alpha'); await Promise.resolve();await Promise.resolve();
 const queued=a.addVenmoContact('Queued','queued'); fence.transition(owner(2)); wait.resolve();
 assert.equal((await first).status,'unavailable');assert.equal((await queued).status,'unavailable');assert.equal(f.map.size,0);
 const b=f.p.createVenmoContactsRepository(fence), readWait=deferred(); f.api.getItemAsync=async()=>{await readWait.promise;return null;};
 const read=b.loadVenmoContacts();await Promise.resolve();fence.invalidate();readWait.resolve();assert.equal((await read).status,'unavailable');
});
test('forget checks baseline and verifies deletion, including failed native deletes',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),a=f.p.createVenmoContactsRepository(fence);await a.addVenmoContact('A','alpha');
 const originalContacts=(await a.loadVenmoContacts()).contacts;
 const key=scope.privateStorageKey('venmoContacts',owner(1)); const original=f.api.getItemAsync;let reads=0;
 f.api.getItemAsync=async k=>{if(++reads===2)f.map.set(k,'external-change');return original(k);};
 const changed=await a.forgetVenmoContacts({status:'ready',contacts:originalContacts});
 assert.equal(changed.status,'corrupt');assert.equal(changed.changed,true);assert.equal(f.calls.filter(c=>c[0]==='delete').length,0);
 f.api.getItemAsync=original;f.api.deleteItemAsync=async()=>{};
 let unreadable=await a.loadVenmoContacts();assert.equal(unreadable.status,'corrupt');
 assert.equal((await a.forgetVenmoContacts({status:'corrupt',snapshot:unreadable.snapshot})).status,'unavailable');
 unreadable=await a.loadVenmoContacts();f.api.deleteItemAsync=async k=>{f.map.delete(k);};
 assert.equal((await a.forgetVenmoContacts({status:'corrupt',snapshot:unreadable.snapshot})).status,'ready');assert.equal(f.map.has(key),false);
});
test('scope change during issued delete returns unavailable and never touches next owner',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),a=f.p.createVenmoContactsRepository(fence);await a.addVenmoContact('A','alpha');
 const contacts=(await a.loadVenmoContacts()).contacts;
 f.api.deleteItemAsync=async k=>{f.map.delete(k);fence.transition(owner(2));};
 assert.equal((await a.forgetVenmoContacts({status:'ready',contacts})).status,'unavailable');assert.equal(f.map.has(scope.privateStorageKey('venmoContacts',owner(2))),false);
});

test('removing a stale confirmed contact preserves an edited or removed row',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const original=(await repo.addVenmoContact('Alex','alex')).contacts[0];
 const changed=(await repo.updateVenmoContact(original,'Alex Updated','new-handle')).contacts[0];
 const key=scope.privateStorageKey('venmoContacts',owner(1)),saved=f.map.get(key),sets=f.calls.filter(c=>c[0]==='set').length;
 const stale=await repo.removeVenmoContact(original);
 assert.equal(stale.status,'conflict');assert.deepEqual(stale.contacts,[changed]);
 assert.equal(f.map.get(key),saved);assert.equal(f.calls.filter(c=>c[0]==='set').length,sets);
 assert.equal((await repo.removeVenmoContact(changed)).status,'ready');
 const missing=await repo.removeVenmoContact(changed);assert.equal(missing.status,'conflict');assert.deepEqual(missing.contacts,[]);
});

test('removing one reviewed contact retains unrelated changes made before confirmation',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const first=(await repo.addVenmoContact('Alex','alex')).contacts[0];
 const second=(await repo.addVenmoContact('Bailey','bailey')).contacts[1];
 const changed=(await repo.updateVenmoContact(second,'Bailey Updated','bailey-new')).contacts[1];
 const result=await repo.removeVenmoContact(first);
 assert.equal(result.status,'ready');assert.deepEqual(result.contacts,[changed]);
 assert.deepEqual((await repo.loadVenmoContacts()).contacts,[changed]);
});

test('forgetting a reviewed list cannot delete newly added or edited contacts',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const original=(await repo.addVenmoContact('Alex','alex')).contacts;
 const confirmed={status:'ready',contacts:original.map(contact=>({...contact}))};
 const added=(await repo.addVenmoContact('Bailey','bailey')).contacts;
 let result=await repo.forgetVenmoContacts(confirmed);
 assert.equal(result.status,'conflict');assert.deepEqual(result.contacts,added);
 assert.equal(f.calls.filter(c=>c[0]==='delete').length,0);
 assert.equal((await repo.forgetVenmoContacts(confirmed)).status,'unavailable', 'a confirmation is one-use');
 const secondConfirmed={status:'ready',contacts:added.map(contact=>({...contact}))};
 const edited=(await repo.updateVenmoContact(added[0],'Alex Updated','alex-new')).contacts;
 result=await repo.forgetVenmoContacts(secondConfirmed);
 assert.equal(result.status,'conflict');assert.deepEqual(result.contacts,edited);
 assert.equal(f.calls.filter(c=>c[0]==='delete').length,0);
 assert.equal((await repo.forgetVenmoContacts({status:'ready',contacts:edited})).status,'ready');
});

test('forgetting unreadable contacts requires the exact observed opaque snapshot',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const key=scope.privateStorageKey('venmoContacts',owner(1));f.map.set(key,'unreadable-one');
 const first=await repo.loadVenmoContacts();assert.equal(first.status,'corrupt');
 assert.doesNotMatch(JSON.stringify(first),/unreadable-one/);
 f.map.set(key,'unreadable-two');
 const stale=await repo.forgetVenmoContacts({status:'corrupt',snapshot:first.snapshot});
 assert.equal(stale.status,'corrupt');assert.equal(stale.changed,true);assert.equal(f.map.get(key),'unreadable-two');
 assert.equal(f.calls.filter(c=>c[0]==='delete').length,0);
 assert.equal((await repo.forgetVenmoContacts({status:'corrupt',snapshot:{}})).status,'unavailable');
 assert.equal((await repo.forgetVenmoContacts({status:'corrupt',snapshot:stale.snapshot})).status,'ready');
 assert.equal(f.map.has(key),false);
});

test('a stale scope cannot remove a confirmed contact or forget a confirmed list',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),old=f.p.createVenmoContactsRepository(fence);
 const contacts=(await old.addVenmoContact('Alex','alex')).contacts;
 fence.transition(owner(2));const next=f.p.createVenmoContactsRepository(fence);await next.addVenmoContact('Bailey','bailey');
 assert.equal((await old.removeVenmoContact(contacts[0])).status,'unavailable');
 assert.equal((await old.forgetVenmoContacts({status:'ready',contacts})).status,'unavailable');
 assert.equal((await next.loadVenmoContacts()).contacts[0].handle,'bailey');
});

test('editing preserves identity and rejects invalid, duplicate and stale contact changes',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const first=await repo.addVenmoContact('Alex','alex'); await repo.addVenmoContact('Bailey','bailey');
 const original=first.contacts[0], key=scope.privateStorageKey('venmoContacts',owner(1));
 let result=await repo.updateVenmoContact(original,'Alex Smith','@alex-new');
 assert.equal(result.status,'ready'); assert.deepEqual(result.contacts[0],{id:original.id,displayName:'Alex Smith',handle:'alex-new'});
 const saved=f.map.get(key), sets=f.calls.filter(c=>c[0]==='set').length, edited=result.contacts[0];
 assert.equal((await repo.updateVenmoContact(edited,'','valid')).status,'invalid-name');
 assert.equal((await repo.updateVenmoContact(edited,'Alex','bad handle')).status,'invalid-handle');
 assert.equal((await repo.updateVenmoContact(edited,'Alex','BAILEY')).status,'duplicate');
 result=await repo.updateVenmoContact(original,'Stale','other');
 assert.equal(result.status,'conflict'); assert.equal(result.contacts[0].handle,'alex-new');
 assert.equal(f.map.get(key),saved); assert.equal(f.calls.filter(c=>c[0]==='set').length,sets);
});

test('queued edits of one baseline cannot silently overwrite each other',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const original=(await repo.addVenmoContact('Alex','alex')).contacts[0];
 const first=repo.updateVenmoContact(original,'First','first');
 const second=repo.updateVenmoContact(original,'Second','second');
 assert.equal((await first).status,'ready');
 const stale=await second; assert.equal(stale.status,'conflict'); assert.equal(stale.contacts[0].handle,'first');
 assert.equal((await repo.loadVenmoContacts()).contacts[0].handle,'first');
});

test('a scope change during an edit does not write a new owner contact list',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const original=(await repo.addVenmoContact('Alex','alex')).contacts[0],wait=deferred();
 const before=f.map.get(scope.privateStorageKey('venmoContacts',owner(1))),get=f.api.getItemAsync; let entered=false;
 f.api.getItemAsync=async key=>{if(!entered){entered=true;await wait.promise;}return get(key);};
 const pending=repo.updateVenmoContact(original,'Updated','updated');await Promise.resolve();await Promise.resolve();
 fence.transition(owner(2));wait.resolve();
 assert.equal((await pending).status,'unavailable');
 assert.equal(f.map.get(scope.privateStorageKey('venmoContacts',owner(1))),before);
 assert.equal(f.map.has(scope.privateStorageKey('venmoContacts',owner(2))),false);
});

test('an unverified contact edit reports unavailable even if the native write already happened',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const original=(await repo.addVenmoContact('Alex','alex')).contacts[0];
 f.api.setItemAsync=async(key,value)=>{f.map.set(key,value);throw new Error('synthetic storage failure after write');};
 assert.equal((await repo.updateVenmoContact(original,'Updated','updated')).status,'unavailable');
 assert.equal((await repo.loadVenmoContacts()).contacts[0].handle,'updated');
});

test('an issued edit stays in its original scope if the owner changes during the native write',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const original=(await repo.addVenmoContact('Alex','alex')).contacts[0],set=f.api.setItemAsync;
 f.api.setItemAsync=async(key,value)=>{await set(key,value);fence.transition(owner(2));};
 assert.equal((await repo.updateVenmoContact(original,'Updated','updated')).status,'unavailable');
 assert.equal(f.map.has(scope.privateStorageKey('venmoContacts',owner(2))),false);
 const prior=JSON.parse(f.map.get(scope.privateStorageKey('venmoContacts',owner(1))));
 assert.equal(prior.contacts[0].handle,'updated', 'an already-issued native write can finish in its original scope');
});

test('a changed collection between the two edit reads is never overwritten',async()=>{
 const f=fixture(),fence=scope.createCustomerStorageFence(owner(1)),repo=f.p.createVenmoContactsRepository(fence);
 const original=(await repo.addVenmoContact('Alex','alex')).contacts[0], key=scope.privateStorageKey('venmoContacts',owner(1));
 const prior=f.map.get(key), get=f.api.getItemAsync; let reads=0;
 const changed=JSON.parse(prior);changed.contacts[0].displayName='Changed elsewhere';
 f.api.getItemAsync=async k=>{if(++reads===2)f.map.set(k,JSON.stringify(changed));return get(k);};
 assert.equal((await repo.updateVenmoContact(original,'New','new')).status,'unavailable');
 assert.equal(f.map.get(key),JSON.stringify(changed));
});
