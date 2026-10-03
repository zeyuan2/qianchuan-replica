import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {OperatorAccess} from '../server/operator-access.mjs';
import {RangeQueryService} from '../server/range-query.mjs';
import {BrowserBridge} from '../server/bridge.mjs';
import {ACCOUNT_ID} from '../server/api.mjs';
import {prepareOperation,commitOperation} from '../server/operations.mjs';
import {allowedWrite} from '../bridge-extension/write-policy.mjs';
import {datePreset,validateDateRange} from '../dist/lan-data.mjs';
async function temp(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-operator-test-'));t.after(async()=>{const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());if(path.dirname(real).toLowerCase()!==parent.toLowerCase()||!path.basename(real).startsWith('qc-operator-test-'))throw new Error('Unexpected cleanup target');await fs.rm(real,{recursive:true,force:true});});return directory;}
test('operator password is hashed, persistent sessions renew, logout and reset revoke access',async t=>{
 const directory=await temp(t),filename=path.join(directory,'operators.json');let now=1000000;const a=await new OperatorAccess({filename,clock:()=>now}).init();
 assert.throws(()=>a.require(''),e=>e.code==='OPERATOR_LOGIN_REQUIRED');await assert.rejects(a.setPassword('short'));
 const password='only-test-password';await a.setPassword(password);const cookie=await a.login(password);assert.match(cookie,/HttpOnly; SameSite=Strict/);assert.ok(a.session(cookie));
 const stored=await fs.readFile(filename,'utf8');assert.equal(stored.includes(password),false);assert.equal(stored.includes(a.token(cookie)),false);
 const b=await new OperatorAccess({filename,clock:()=>now}).init();assert.ok(b.session(cookie));now+=29*86400000;await b.renew(cookie);now+=2*86400000;assert.ok(b.session(cookie));await b.logout(cookie);assert.equal(b.session(cookie),null);
 const next=await b.login(password);await b.setPassword('replacement-test-password');assert.equal(b.session(next),null);
 for(let i=0;i<5;i++)await assert.rejects(b.login('wrong','client'),e=>e.code==='INVALID_PASSWORD');await assert.rejects(b.login('replacement-test-password','client'),e=>e.code==='LOGIN_RATE_LIMITED');
});
test('confirmation belongs to its session, expires, rejects changed plan and cannot be replayed',async()=>{
 const id='1000000000000100',ad={id,marGoal:1,name:'测试',budget:30000000,modifyTime:1,operation:{budgetEditOperation:{editable:true}}};let writes=0;
 const api={allowWrites:true,planCache:new Map([[id,{}]]),async call(_path,_body,options){if(options.intent==='write'){writes++;return {data:{results:[{flag:true}]}};}return {data:{adDetailInfo:{...ad}}};}};
 const q={accountId:ACCOUNT_ID,id,action:'budget',value:'500'},p=await prepareOperation(api,q,'session-a'),commit={accountId:ACCOUNT_ID,planId:id,token:p.token,confirmed:true};
 await assert.rejects(commitOperation(api,commit,'session-b'),e=>e.code==='CONFIRMATION_REQUIRED');assert.equal(writes,0);
 ad.modifyTime=2;await assert.rejects(commitOperation(api,commit,'session-a'),e=>e.code==='PLAN_CHANGED');assert.equal(writes,0);
 const p2=await prepareOperation(api,q,'session-a');commit.token=p2.token;assert.equal((await commitOperation(api,commit,'session-a')).success,true);assert.equal(writes,1);
 await assert.rejects(commitOperation(api,commit,'session-a'),e=>e.code==='CONFIRMATION_EXPIRED');assert.equal(writes,1);
});
test('legacy read clients cannot dequeue write jobs; extension rejects wrong account or missing confirmation',async()=>{
 const bridge=new BrowserBridge(),promise=bridge.request({intent:'write',path:'/verified'});assert.equal(await bridge.next(1),null);const job=await bridge.next(1,{writes:true});assert.equal(job.path,'/verified');bridge.reply(job.id,{status:200});await promise;bridge.close();
 const spec={accountId:ACCOUNT_ID,query:{aavid:ACCOUNT_ID},method:'POST',intent:'write',confirmedOperation:true,expiresAt:Date.now()+30000,path:'/ad/api/pmc/v1/batch_update_operation',body:{objects:[{objectID:'1000000000000100',type:1}],optType:2}};
 assert.equal(allowedWrite(spec),true);for(const change of [{confirmedOperation:false},{intent:'read'},{accountId:'other'},{query:{aavid:'other'}},{expiresAt:0},{path:'/unknown'}])assert.equal(allowedWrite({...spec,...change}),false);
});
test('exclusive re-pairing invalidates old browsers and releases their long polls without duplicating work',async()=>{
 const bridge=new BrowserBridge(),old=bridge.token,waiting=bridge.next(15000,{writes:true});
 bridge.replaceToken('b'.repeat(48));assert.equal(await waiting,null);assert.equal(bridge.authenticate(old),false);assert.equal(bridge.authenticate('b'.repeat(48)),true);assert.equal(bridge.status().connected,false);assert.equal(bridge.status().writeReady,false);
 const promise=bridge.request({intent:'read',path:'/check'});assert.throws(()=>bridge.replaceToken('c'.repeat(48)),e=>e.code==='BRIDGE_BUSY');const job=await bridge.next(1);bridge.reply(job.id,{status:200});await promise;bridge.close();
});
test('date shortcuts respect calendar boundaries and invalid/future ranges are rejected',()=>{
 assert.deepEqual(datePreset('last7','2026-10-01'),{from:'2026-09-25',to:'2026-10-01'});assert.deepEqual(datePreset('yesterday','2026-03-01'),{from:'2026-02-28',to:'2026-02-28'});
 assert.throws(()=>validateDateRange('2026-02-30','2026-03-01','2026-10-01'));assert.throws(()=>validateDateRange('2026-10-01','2026-10-02','2026-10-01'));
});
test('range queries coalesce and reuse cache, preserve daily monitor, and retain range data on failure',async t=>{
 const directory=await temp(t);let now=Date.parse('2026-10-01T11:00:00Z'),calls=0,fail=false;const daily={snapshot:{from:'2026-10-01',newPlanEvents:[]},monitor:{}};
 const monitor={view:()=>daily};const service=new RangeQueryService({directory,clock:()=>now,api:{bridge:{status:()=>({connected:true})}},monitor,collect:async(_api,{from,to})=>{calls++;if(fail)throw new Error('test failure');return {accountId:ACCOUNT_ID,complete:true,from,to,fetchedAt:new Date(now).toISOString(),total:132};}});
 await assert.rejects(service.get('../bad','2026-10-01'));assert.equal(calls,0);
 const [a,b]=await Promise.all([service.get('2026-09-25','2026-10-01'),service.get('2026-09-25','2026-10-01')]);assert.equal(calls,1);assert.deepEqual(a.snapshot,b.snapshot);assert.equal((await service.get('2026-09-25','2026-10-01')).rangeQuery.cached,true);
 assert.equal(daily.snapshot.from,'2026-10-01');assert.equal(await service.get('2026-10-01','2026-10-01'),daily);
 now+=1;service.invalidate();await service.get('2026-09-25','2026-10-01');assert.equal(calls,2);
 now+=300001;fail=true;const stale=await service.get('2026-09-25','2026-10-01');assert.equal(stale.rangeQuery.stale,true);assert.equal(stale.snapshot.total,132);
});
