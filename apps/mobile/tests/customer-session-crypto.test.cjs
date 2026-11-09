const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const ts = require('typescript');
function load(name, deps) {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/',name), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const m={exports:{}};new Function('exports','require','module',code)(m.exports,k=>{if (!(k in deps)) throw Error('Unexpected dependency');return deps[k];},m);return m.exports;
}
const scope=load('customer-storage-scope.ts',{});
const links=load('customer-session-links.ts',{'./customer-storage-scope':scope});
function setup(overrides={},os='android') {
 let calls=0;const fake={CryptoDigestAlgorithm:{SHA256:'SHA-256'},CryptoEncoding:{BASE64:'base64'},
 getRandomBytesAsync:async n=>{assert.equal(n,32);return new Uint8Array(32).fill(++calls);},
 getRandomBytes:()=>{throw Error('Insecure synchronous fallback called');},
 digestStringAsync:async(alg,value,opts)=>{assert.equal(alg,'SHA-256');assert.deepEqual(opts,{encoding:'base64'});return crypto.createHash('sha256').update(value,'ascii').digest('base64');},...overrides};
 return { api:load('customer-session-crypto.ts',{'expo-crypto':fake,'react-native':{Platform:{OS:os}},'./customer-session-links':links}),calls:()=>calls};
}
test('native secrets use independent asynchronous random values and exact S256 ASCII verifier',async()=>{
 const s=setup();const value=await s.api.createCustomerSignInSecrets();assert.equal(s.calls(),2);
 assert.notEqual(value.state,value.codeVerifier);assert.equal(value.codeChallenge,crypto.createHash('sha256').update(value.codeVerifier,'ascii').digest('base64url'));
 assert.equal(value.codeChallengeMethod,'S256');assert.ok(Object.isFrozen(value));
});
test('web never requests native secrets',async()=>{const s=setup({},'web');await assert.rejects(s.api.createCustomerSignInSecrets(),/unavailable/);assert.equal(s.calls(),0);});
test('random and digest failures never fall back or disclose raw failure data',async()=>{
 for (const overrides of [{getRandomBytesAsync:async()=>{throw Error('private-native-detail');}}, {getRandomBytesAsync:async()=>new Uint8Array(31)}, {getRandomBytesAsync:async()=>new Uint8Array(32)}, {digestStringAsync:async()=> 'not-a-digest'}]) {
  const s=setup(overrides);await assert.rejects(s.api.createCustomerSignInSecrets(),e=>e.message==='Native sign-in secrets could not be prepared.');
 }
});
