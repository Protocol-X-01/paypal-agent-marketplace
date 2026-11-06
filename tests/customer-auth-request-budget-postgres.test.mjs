import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {load} from './customer-auth-fixtures.mjs';
const {Pool}=createRequire(import.meta.url)('pg');
const {createAuthRequestBudget}=load('src/lib/customer-auth/request-budget.ts');
test('isolated PG18 shares operation windows across pools, isolates recovery and fails closed',{skip:process.env.PAYPAL_BUDGET_ISOLATED_PG_TEST!=='1',timeout:30000},async()=>{
 const work=mkdtempSync('/tmp/paypal-budget-pg-'),socket=work+'/socket',data=work+'/data',bin='/usr/lib/postgresql/18/bin';mkdirSync(socket,{mode:0o700});
 const env={PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC'};let server,admin,a,b;
 try{
  assert.equal(spawnSync(bin+'/initdb',['-D',data,'--auth=trust','--no-sync','--username=budget_fixture'],{env,stdio:'ignore',timeout:10000}).status,0);
  server=spawn(bin+'/postgres',['-D',data,'-k',socket,'-p','5432','-c','listen_addresses=','-c','shared_buffers=12MB','-c','max_connections=8','-c','max_worker_processes=0','-c','max_parallel_workers=0','-c','max_wal_senders=0','-c','autovacuum=off'],{env,stdio:'ignore'});
  const settings={host:socket,port:5432,user:'budget_fixture',database:'postgres',connectionTimeoutMillis:1000};admin=new Pool({...settings,max:1});
  for(let i=0;i<40;i++){try{await admin.query('SELECT 1');break}catch{if(i===39)throw Error('Fixture startup failed');await delay(100)}}
  a=createAuthRequestBudget(settings);await assert.rejects(a.consume('web.start'));await a.close();a=null;
  await admin.query('CREATE ROLE paypal_auth_runtime LOGIN');
  await admin.query(readFileSync(new URL('../docs/customer-auth-request-budget-migration.sql',import.meta.url),'utf8'));
  a=createAuthRequestBudget({...settings,user:'paypal_auth_runtime'});b=createAuthRequestBudget({...settings,user:'paypal_auth_runtime'});
  const results=await Promise.all(Array.from({length:66},(_,i)=>(i%2?a:b).consume('web.start')));
  assert.equal(results.filter(x=>x.allowed).length,60);assert.equal(results.filter(x=>!x.allowed).length,6);
  assert.ok(results.every(x=>x.retryAfter>=1&&x.retryAfter<=60));
  await assert.rejects(a.consume('web.logout'));
  await admin.query("UPDATE paypal_markets_auth_budget.windows SET window_start_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-60000 WHERE operation='web.start'");assert.equal((await b.consume('web.start')).allowed,true);
  await admin.query("UPDATE paypal_markets_auth_budget.windows SET window_start_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+60000 WHERE operation='web.start'");await assert.rejects(a.consume('web.start'));
  await admin.query("UPDATE paypal_markets_auth_budget.windows SET window_start_ms=0,used=0 WHERE operation='web.start'");
  const lock=await admin.connect();try{await lock.query('BEGIN');await lock.query("SELECT operation FROM paypal_markets_auth_budget.windows WHERE operation='web.start' FOR UPDATE");
  const blocked=a.consume('web.start');const rejected=assert.rejects(blocked);await delay(20);
  await rejected;}finally{await lock.query('ROLLBACK');lock.release();}
  assert.equal((await a.consume('web.start')).allowed,true,'pool usable after timed-out lock rollback');
  const count=await admin.query('SELECT count(*)::int n FROM paypal_markets_auth_budget.windows');assert.equal(count.rows[0].n,10);
  await admin.query('DROP SCHEMA paypal_markets_auth_budget CASCADE');await assert.rejects(b.consume('native.session'));
 }finally{
  await Promise.all([a?.close(),b?.close(),admin?.end()]);
  if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve))}
  rmSync(work,{recursive:true,force:true});
 }
});
