import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './customer-auth-fixtures.mjs';
const {nextAuthBudget,AUTH_BUDGET_LIMITS}=load('src/lib/customer-auth/request-budget.ts');
test('budget boundaries, saturation and backwards database clock fail closed',()=>{
 assert.deepEqual(nextAuthBudget(159999,100000,60,60),{windowStart:100000,count:61,allowed:false,retryAfter:1});
 assert.deepEqual(nextAuthBudget(160000,100000,61,60),{windowStart:160000,count:1,allowed:true,retryAfter:60});
 assert.equal(nextAuthBudget(100001,100000,61,60).count,61);
 assert.throws(()=>nextAuthBudget(99999,100000,1,60));assert.throws(()=>nextAuthBudget(NaN,0,0,60));
 assert.equal(Object.keys(AUTH_BUDGET_LIMITS).length,10);
});
