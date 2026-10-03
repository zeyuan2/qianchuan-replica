import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {BatchBoost} from '../server/batch-boost.mjs';
import {ACCOUNT_ID} from '../server/api.mjs';
import {filterBatchPlans,batchMetric} from '../dist/batch-model.mjs';
const ids=['1000000000000100','1000000000000101','1000000000000102'];
async function fixture(t,overrides={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-batch-test-'));t.after(async()=>{const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());if(path.dirname(real).toLowerCase()!==parent.toLowerCase()||!path.basename(real).startsWith('qc-batch-test-'))throw new Error('Unsafe cleanup');await fs.rm(real,{recursive:true,force:true});});let writes=[];
 const api={allowWrites:true,confirmations:new Map(),planCache:new Map(ids.map(id=>[id,{id,name:'测试'+id,raw:{id,marGoal:1,budget:30000000}}]))};
 const prepare=async(_api,q)=>{const token='preview-'+q.id;api.confirmations.set(token,{expiresAt:Date.now()+90000});return {token,name:'测试'+q.id,description:'额外100元4小时'};};
 const batch=await new BatchBoost({api,directory,gapMs:0,prepare,commit:async(_api,q)=>{writes.push(q.planId);return {success:true};},...overrides}).init();return {batch,api,directory,writes};
}
const input={accountId:ACCOUNT_ID,ids,budget:'100',duration:'4',namePrefix:'测试批量'};
async function finished(batch){for(let i=0;i<100&&batch.running;i++)await new Promise(r=>setTimeout(r,5));assert.equal(batch.running,null);}
test('batch preview never writes; confirmation is session-bound and double submit creates one job',async t=>{
 const {batch,writes}=await fixture(t);const p=await batch.prepare(input,'actor');assert.equal(p.totalBudget,300);assert.equal(writes.length,0);assert.equal(p.items[0].token,undefined);
 await assert.rejects(batch.start({accountId:ACCOUNT_ID,token:p.token,confirmed:true},'other'));assert.equal(writes.length,0);
 const q={accountId:ACCOUNT_ID,token:p.token,confirmed:true};await batch.start(q,'actor');await batch.start(q,'actor');await finished(batch);assert.deepEqual(writes,ids);assert.equal(batch.get(p.token,'actor').status,'completed');await batch.start(q,'actor');assert.equal(writes.length,3);
});
test('invalid identities, duplicates, oversized batches and invalid budgets fail before preparing',async t=>{
 let prepares=0;const {batch}=await fixture(t,{prepare:async()=>{prepares++;throw new Error('should not run');}});
 for(const q of [{...input,accountId:'wrong'},{...input,ids:[ids[0],ids[0]]},{...input,ids:['0000000000000001']},{...input,ids:Array(21).fill(ids[0])},{...input,budget:'99'}])await assert.rejects(batch.prepare(q,'actor'));assert.equal(prepares,0);
});
test('uncertain result stops remaining plans and survives restart without replay',async t=>{
 let calls=0;const {batch,directory,api}=await fixture(t,{commit:async()=>{calls++;throw Object.assign(new Error('未知结果'),{code:'OPERATION_UNCERTAIN'});}});const p=await batch.prepare(input,'actor');await batch.start({accountId:ACCOUNT_ID,token:p.token,confirmed:true},'actor');await finished(batch);assert.equal(calls,1);assert.deepEqual(batch.get(p.token,'actor').items.map(i=>i.status),['uncertain','skipped','skipped']);
 const restored=await new BatchBoost({api,directory}).init();assert.equal(restored.get(p.token,'actor').status,'stopped');assert.equal(restored.running,null);
});
test('stop request lets the current item settle but does not submit the next plan',async t=>{
 let release,started;const began=new Promise(r=>started=r);const {batch}=await fixture(t,{commit:async()=>{started();await new Promise(r=>release=r);return {success:true};}});const p=await batch.prepare(input,'actor');await batch.start({accountId:ACCOUNT_ID,token:p.token,confirmed:true},'actor');await began;await batch.cancel(p.token,'actor');release();await finished(batch);assert.deepEqual(batch.get(p.token,'actor').items.map(i=>i.status),['success','skipped','skipped']);
});
test('metric filters use queried actual ROI and primary spend, include boundaries, and exclude missing data',()=>{
 const plans=[{id:ids[0],name:'计划甲',statusText:'投放中',budget:300,roiTarget:9,metrics:{statcostforroi2primary:{value:100,valueStr:'100'},totalprepayandpaysettleoverallroi21h:{value:1.5,valueStr:'1.5'}}},{id:ids[1],name:'计划乙',statusText:'已暂停',budget:500,metrics:{statcostforroi2primary:{value:200,valueStr:'200'},totalprepayandpaysettleoverallroi21h:{value:0,valueStr:'-'}}}];
 assert.deepEqual(filterBatchPlans(plans,{spendMin:'100',spendMax:'100',roiMax:'2'}).map(p=>p.id),[ids[0]]);assert.equal(batchMetric(plans[1],'roi'),null);assert.equal(filterBatchPlans(plans,{roiMin:'0'}).length,1);assert.equal(filterBatchPlans(plans,{status:'已暂停',search:'乙'}).length,1);assert.throws(()=>filterBatchPlans(plans,{roiMin:'3',roiMax:'1'}));
});
