const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
test('provider installs browser-aware lifecycle listeners, masks before updates and tears down cleanly',()=>{
 const calls=[],listeners={},effects=[],states=[];let dependencies,subscriber;
 const fence={invalidate:()=>calls.push('invalidate')};
 const runtime={storageFence:fence,subscribe(fn){subscriber=fn;fn({session:{status:'holding'},loginStatus:'checking',revision:0});return()=>calls.push('unsubscribe')},initialize:()=>calls.push('initialize'),setForeground:active=>calls.push(['foreground',active]),dispose:()=>calls.push('dispose'),start:async()=>{},logout:async()=>{},retry:async()=>{}};
 const React={createContext:()=>({Provider:'Provider'}),useState(initial){let value=typeof initial==='function'?initial():initial;return[value,next=>{value=typeof next==='function'?next(value):next;states.push(value)}]},useEffect:fn=>effects.push(fn),useMemo:fn=>fn(),useContext:()=>null};
 const appState={currentState:'active',addEventListener(name,fn){listeners[name]=fn;return{remove:()=>calls.push(['remove',name])}}};
 const aliases={'react':React,'react/jsx-runtime':{jsx:(type,props)=>({type,props})},'react-native':{Platform:{OS:'android'},AppState:appState},'./customer-session-config':{readCustomerSessionConfiguration:()=>({status:'disabled'})},'./customer-storage-scope':{createCustomerStorageFence:()=>fence},'./customer-session-runtime':{createCustomerSessionRuntime:deps=>{dependencies=deps;return runtime}}};
 const source=fs.readFileSync(path.join(__dirname,'../src/lib/customer-session-context.tsx'),'utf8');const m={exports:{}};
 new Function('exports','require','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(m.exports,k=>{if(Object.hasOwn(aliases,k))return aliases[k];throw Error('Native modules must remain lazy')},m);
 m.exports.CustomerSessionProvider({children:'public markets'});const cleanup=effects[0]();assert.equal(dependencies.foreground,true);assert.equal(dependencies.configuration.status,'disabled');assert.ok(calls.includes('initialize'));
 listeners.blur();listeners.focus();appState.currentState='background';listeners.change('background');listeners.focus();assert.deepEqual(calls.filter(Array.isArray).map(x=>x[1]),[false,true,false,false]);
 subscriber({session:{status:'guest'},loginStatus:'disabled',revision:1});assert.equal(states.at(-1).identity,null);assert.equal(states.at(-1).loginAvailable,false);assert.ok(states.at(-1).revision>0);
 const revision=states.at(-1).revision;subscriber({session:{status:'guest'},loginStatus:'available',revision:1});assert.equal(states.at(-1).revision,revision);
 cleanup();assert.deepEqual(calls.slice(-5),['unsubscribe',['remove','change'],['remove','blur'],['remove','focus'],'dispose']);
});
