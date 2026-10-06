import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {BatchBoost} from '../server/batch-boost.mjs';
import {ACCOUNT_ID} from '../server/api.mjs';
import {filterBatchPlans,batchMetric,sortBatchPlans} from '../dist/batch-model.mjs';
const ids=['1000000000000100','1000000000000101','1000000000000102'];
const base=Date.parse('2026-10-03T06:00:00Z');
async function fixture(t,{count=3,...overrides}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-batch-test-'));t.after(async()=>{const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());if(path.dirname(real).toLowerCase()!==parent.toLowerCase()||!path.basename(real).startsWith('qc-batch-test-'))throw new Error('Unsafe cleanup');await fs.rm(real,{recursive:true,force:true});});
 let now=base;const plans=Array.from({length:count},(_,i)=>String(1000000000000100n+BigInt(i))),writes=[],prepares=[],tasks=new Map();
 const api={allowWrites:true,confirmations:new Map(),planCache:new Map(plans.map(id=>[id,{id,name:'测试'+id,raw:{id,marGoal:1,budget:30000000}}]))};
 const inspect=async id=>{const list=tasks.get(id)||[];return {id,state:list.some(t=>t.state==='active')?'active':'eligible',tasks:list,complete:true,checkedAt:new Date(now).toISOString()};};
 const prepare=async(_api,q)=>{prepares.push(q);const token='preview-'+q.id;api.confirmations.set(token,{expiresAt:now+90000,value:q.value});return {token,name:'测试'+q.id,description:'额外100元4小时'};};
 const commit=async(_api,q)=>{writes.push(q.planId);const {value,expiresAt}=api.confirmations.get(q.token);assert.ok(expiresAt>now);tasks.set(q.planId,[{id:'task-'+q.planId,name:value.name,budget:Number(value.budget),duration:Number(value.duration),state:'active',startAt:new Date(now).toISOString(),endAt:new Date(now+14400000).toISOString()}]);return {success:true};};
 const batch=await new BatchBoost({api,directory,gapMs:0,clock:()=>now,prepare,commit,inspect,...overrides}).init();
 return {batch,api,directory,writes,plans,prepares,tasks,inspect,prepare,commit,advance:ms=>now+=ms};
}
const input={accountId:ACCOUNT_ID,ids,budget:'100',duration:'4',namePrefix:'测试批量'};
async function finished(batch){for(let i=0;i<500&&(batch.running||batch.scanning);i++)await new Promise(r=>setTimeout(r,5));assert.equal(batch.running,null);assert.equal(batch.scanning,null);}
async function preview(f,q=input){const scan=f.batch.scan({accountId:ACCOUNT_ID,ids:q.ids},'actor');await finished(f.batch);return f.batch.prepare({...q,scanId:scan.id},'actor');}
const start=(batch,p)=>batch.start({accountId:ACCOUNT_ID,token:p.token,confirmed:true},'actor');

test('preview never writes; session binding and double submit survive large batches beyond 20',async t=>{
 const f=await fixture(t,{count:134}),p=await preview(f,{...input,ids:f.plans});assert.equal(p.totalBudget,13400);assert.equal(f.prepares.length,0);assert.equal(f.writes.length,0);assert.equal(p.items[0].requestName,undefined);
 await assert.rejects(f.batch.start({accountId:ACCOUNT_ID,token:p.token,confirmed:true},'other'));
 await start(f.batch,p);await start(f.batch,p);await finished(f.batch);assert.deepEqual(f.writes,f.plans);assert.equal(f.batch.get(p.token,'actor').status,'completed');await start(f.batch,p);assert.equal(f.writes.length,134);
});
test('long queue revalidates each item just before writing, not with expired child confirmations',async t=>{
 const f=await fixture(t);const original=f.batch.commitOne;f.batch.commitOne=async(...args)=>{await original(...args);f.advance(301000);};
 const p=await preview(f);await start(f.batch,p);await finished(f.batch);assert.equal(f.writes.length,3);assert.equal(f.prepares.length,3);
});
test('invalid ids, missing eligibility scan and budgets fail without writing',async t=>{
 const f=await fixture(t);for(const q of [{...input,accountId:'wrong'},{...input,ids:[ids[0],ids[0]]},{...input,ids:['0000000000000001']},input])await assert.rejects(f.batch.prepare(q,'actor'));
 await assert.rejects(preview(f,{...input,budget:99}));assert.equal(f.writes.length,0);
});
test('one uncertain item is not resent; remaining items run and unknown holds survive restart',async t=>{
 const f=await fixture(t);const commit=f.batch.commitOne;let calls=0;f.batch.commitOne=async(...args)=>{calls++;if(calls===1)throw Object.assign(new Error('未知结果'),{code:'OPERATION_UNCERTAIN'});return commit(...args);};
 const p=await preview(f);await start(f.batch,p);await finished(f.batch);assert.equal(calls,3);assert.deepEqual(f.batch.get(p.token,'actor').items.map(i=>i.status),['uncertain','success','success']);
 assert.equal((await f.batch.eligibility(ids[0],{force:true})).state,'unknown');
 const restored=await new BatchBoost({api:f.api,directory:f.directory,inspect:f.inspect,gapMs:0}).init();assert.equal((await restored.eligibility(ids[0])).state,'unknown');assert.equal(restored.running,null);
});
test('creation timeout reconciles a matching task without another write',async t=>{
 const f=await fixture(t);const commit=f.batch.commitOne;let calls=0;f.batch.commitOne=async(...args)=>{calls++;await commit(...args);throw Object.assign(new Error('timeout'),{code:'OPERATION_UNCERTAIN'});};const p=await preview(f);await start(f.batch,p);await finished(f.batch);assert.equal(calls,3);assert.ok(f.batch.get(p.token,'actor').items.every(i=>i.status==='success'));
});
test('active task hides plan and only verified ended task restores eligibility',async t=>{
 const f=await fixture(t),p=await preview(f);await start(f.batch,p);await finished(f.batch);assert.equal((await f.batch.eligibility(ids[0])).state,'active');
 const task=f.tasks.get(ids[0])[0];task.state='ended';assert.equal((await f.batch.eligibility(ids[0])).state,'eligible');
 f.tasks.set(ids[0],[]);assert.equal((await f.batch.eligibility(ids[0])).state,'unknown');
});
test('authentication failure pauses remaining items and cancellation never resends current item',async t=>{
 const f=await fixture(t);f.batch.prepareOne=async()=>{throw Object.assign(new Error('登录失效'),{code:'AUTH_REQUIRED'});};let p=await preview(f);await start(f.batch,p);await finished(f.batch);assert.deepEqual(f.batch.get(p.token,'actor').items.map(i=>i.status),['failed','skipped','skipped']);assert.equal(f.writes.length,0);
});
test('manual recheck then single-item retry requires fresh confirmation and cannot include successful items',async t=>{
 const f=await fixture(t);const commit=f.batch.commitOne;let failed=true;f.batch.commitOne=async(...args)=>{if(failed){failed=false;throw Object.assign(new Error('未知结果'),{code:'OPERATION_UNCERTAIN'});}return commit(...args);};
 const p=await preview(f);await start(f.batch,p);await finished(f.batch);
 let result=await f.batch.recheck(p.token,ids[0],'actor');assert.equal(result.items[0].verification.canRetry,true);
 const q={...input,ids:[ids[0]],retryOf:p.token};await assert.rejects(f.batch.prepare(q,'actor'),e=>e.code==='MANUAL_VERIFICATION_REQUIRED');
 await assert.rejects(f.batch.prepare({...q,ids:[ids[1]],verifiedNotCreated:true},'actor'),e=>e.code==='RETRY_DENIED');
 const retry=await f.batch.prepare({...q,verifiedNotCreated:true},'actor');assert.equal(f.writes.length,2);await start(f.batch,retry);await finished(f.batch);assert.deepEqual(f.writes,[ids[1],ids[2],ids[0]]);
 f.tasks.get(ids[0])[0].state='ended';assert.equal((await f.batch.eligibility(ids[0])).state,'eligible');assert.equal(f.batch.history('other').batches.length,0);assert.equal(f.batch.history('actor').batches.length,2);
 await assert.rejects(f.batch.prepare({...q,verifiedNotCreated:true},'actor'),e=>e.code==='RETRY_DENIED');
});
test('retry rechecks platform again after user confirms and blocks a task appearing meanwhile',async t=>{
 const f=await fixture(t);f.batch.prepareOne=async()=>{throw new Error('plan rejected before write');};const p=await preview(f);await start(f.batch,p);await finished(f.batch);f.batch.prepareOne=f.prepare;
 const retry=await f.batch.prepare({...input,ids:[ids[0]],retryOf:p.token},'actor');f.tasks.set(ids[0],[{id:'external-task',name:'external',state:'active'}]);await start(f.batch,retry);await finished(f.batch);assert.equal(f.writes.length,0);
});
test('stop waits for current result; later plans are not submitted',async t=>{
 const f=await fixture(t);const commit=f.batch.commitOne;let release,started;const began=new Promise(r=>started=r);f.batch.commitOne=async(...args)=>{started();await new Promise(r=>release=r);return commit(...args);};const p=await preview(f);await start(f.batch,p);await began;await f.batch.cancel(p.token,'actor');release();await finished(f.batch);assert.deepEqual(f.batch.get(p.token,'actor').items.map(i=>i.status),['success','skipped','skipped']);
});
test('comprehensive cost is distinct from primary spend; sort covers all pages with null values last',()=>{
 const plans=Array.from({length:32},(_,i)=>({id:String(i),name:'计划'+i,statusText:'投放中',budget:300,metrics:{statcostforoverallroi2:{value:i+10,valueStr:String(i+10)},statcostforroi2primary:{value:i,valueStr:String(i)}}}));plans.push({id:'missing',name:'无值',budget:300});
 assert.equal(batchMetric(plans[0],'cost'),10);assert.equal(batchMetric(plans[0],'spend'),0);assert.equal(filterBatchPlans(plans,{costMin:20,costMax:20}).length,1);
 assert.equal(sortBatchPlans(plans,'cost','desc')[0].id,'31');assert.equal(sortBatchPlans(plans,'cost','asc')[0].id,'0');assert.equal(sortBatchPlans(plans,'cost','asc').at(-1).id,'missing');assert.equal(sortBatchPlans(plans,'cost','desc').at(-1).id,'missing');assert.equal(plans[0].id,'0');
 assert.throws(()=>filterBatchPlans(plans,{costMin:30,costMax:10}));
});

test('multiple matching tasks after timeout are recognized as created and never offered for retry',async t=>{
 const f=await fixture(t);f.batch.commitOne=async()=>{throw Object.assign(new Error('timeout'),{code:'OPERATION_UNCERTAIN'});};const p=await preview(f);await start(f.batch,p);await finished(f.batch);
 const item=f.batch.jobs.get(p.token).items[0];f.tasks.set(ids[0],[1,2].map(i=>({id:'created-'+i,name:item.requestName,budget:100,duration:4,state:'ended'})));
 const result=await f.batch.recheck(p.token,ids[0],'actor');assert.equal(result.items[0].status,'success');assert.equal(result.items[0].verification.canRetry,false);
});
test('a queued job interrupted on restart does not reissue writes or release uncertain holds',async t=>{
 const f=await fixture(t);const j={id:'11111111-2222-4333-8444-555555555555',accountId:ACCOUNT_ID,actor:'actor',status:'running',createdAt:new Date(base).toISOString(),items:[{id:ids[0],name:'test',budget:100,duration:4,status:'submitting',requestName:'interrupted-name'},{id:ids[1],name:'test',budget:100,duration:4,status:'pending'}]};await f.batch.persist(j);
 const restored=await new BatchBoost({api:f.api,directory:f.directory,inspect:f.inspect,gapMs:0}).init();assert.deepEqual(restored.get(j.id,'actor').items.map(i=>i.status),['uncertain','skipped']);assert.equal((await restored.eligibility(ids[0])).state,'unknown');assert.equal(f.writes.length,0);
});

test('corrupt batch history disables batch writes without preventing the main server from initializing',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.directory,'11111111-2222-4333-8444-555555555555.json'),'{broken');
 const restored=await new BatchBoost({api:f.api,directory:f.directory,inspect:f.inspect,gapMs:0}).init();assert.ok(restored.history('actor').error);await assert.rejects(restored.prepare(input,'actor'),e=>e.code==='BATCH_HISTORY_INVALID');assert.equal(f.writes.length,0);
});

test('batch scan uses fast rows but falls back for missing data and unresolved local submissions',async t=>{
 const f=await fixture(t);let reads=0;f.batch.inspect=async id=>{reads++;return f.inspect(id);};f.batch.bulkInspect=async()=>({requests:6,rows:new Map(ids.map(id=>[id,{id,state:'eligible',complete:true,taskCount:0}]))});
 f.batch.jobs.set('prior',{id:'prior',accountId:ACCOUNT_ID,actor:'actor',createdAt:new Date(base-300000).toISOString(),status:'partial',items:[{id:ids[0],status:'uncertain',requestName:'missing-task'}]});
 const scan=f.batch.scan({accountId:ACCOUNT_ID,ids},'actor');await finished(f.batch);const result=f.batch.scanStatus(scan.id,'actor');assert.equal(result.fastCount,2);assert.equal(result.detailCount,1);assert.equal(reads,1);assert.equal(result.rows.find(r=>r.id===ids[0]).state,'unknown');
});

test('fast eligible rows are published before slow details and can be confirmed without waiting for unrelated plans',async t=>{
 const f=await fixture(t);let release,started;const began=new Promise(r=>started=r);const original=f.batch.inspect;const reads=[];
 f.batch.inspect=async(id,options)=>{reads.push({id,force:options.force});if(id===ids[0]){started();await new Promise(r=>release=r);}return original(id,options);};
 f.batch.bulkInspect=async()=>({requests:6,rows:new Map([[ids[1],{id:ids[1],state:'eligible',complete:true}]])});
 const scan=f.batch.scan({accountId:ACCOUNT_ID,ids},'actor');await began;
 const partial=f.batch.scanStatus(scan.id,'actor');assert.equal(partial.state,'running');assert.equal(partial.fastCount,1);assert.deepEqual(partial.rows.map(r=>r.id),[ids[1]]);
 const p=await f.batch.prepare({...input,ids:[ids[1]],scanId:scan.id},'actor');await assert.rejects(f.batch.prepare({...input,ids:[ids[2]],scanId:scan.id},'actor'));
 await start(f.batch,p);for(let i=0;i<100&&f.batch.running;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.writes.length,1);assert.ok(reads.some(r=>r.id===ids[1]&&r.force===true));release();await finished(f.batch);assert.equal(reads.some(r=>r.id===ids[2]),false);assert.equal(f.batch.listCache.saved,null);
});

test('fresh pre-submit inspection blocks a plan that became active after a cached fast result',async t=>{
 const f=await fixture(t);f.batch.bulkInspect=async()=>({requests:6,rows:new Map(ids.map(id=>[id,{id,state:'eligible',complete:true}]))});
 const p=await preview(f,{...input,ids:[ids[0]]});f.tasks.set(ids[0],[{id:'external',name:'external',state:'active'}]);await start(f.batch,p);await finished(f.batch);assert.equal(f.writes.length,0);assert.equal(f.batch.get(p.token,'actor').items[0].status,'failed');
});
