import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {comparison,change,HOUR} from '../dist/roi-change-model.mjs';
import {RoiObservations} from '../server/roi-observations.mjs';
import {readRoiHours,ROI_KEYS} from '../server/roi-hours.mjs';
import {ACCOUNT_ID} from '../server/api.mjs';
import {prepareOperation,commitOperation} from '../server/operations.mjs';
import {selectSnapshot} from '../dist/lan-data.mjs';
const id='1000000000000100',T=Date.parse('2026-10-03T04:00:00Z');
const row=(time,roi=2,spend=10,cost=10)=>({time,roi,spend,roiCost:cost,revenue:roi*cost,full:true});
function record(changed=T){return {changedAt:new Date(changed).toISOString(),expiresAt:new Date(changed+24*HOUR).toISOString(),rows:Array.from({length:49},(_,i)=>row(T+(i-24)*HOUR,i<24?2:3,i<24?10:15))};}
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qc-roi-test-'));t.after(async()=>{const real=await fs.realpath(dir);assert.equal(path.dirname(real).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());assert.ok(path.basename(real).startsWith('qc-roi-test-'));await fs.rm(real,{recursive:true,force:true});});return dir;}
test('hour comparison sums primary spend and calculates weighted ROI rather than averaging hourly ratios',()=>{
 const r=record();r.rows.find(r=>r.time===T).roi=4;r.rows.find(r=>r.time===T).roiCost=100;r.rows.find(r=>r.time===T).revenue=400;
 const m=comparison(r,{},T+2*HOUR);assert.equal(m.count,2);assert.equal(m.roi.after,430/110);assert.equal(m.spend.percent,50);assert.equal(m.beforeEnd-m.beforeStart,m.afterEnd-m.afterStart);
});
test('mixed/current hours excluded; custom ranges stay bounded; missing values and zero baseline are not fabricated',()=>{
 const r=record(T+HOUR/2),m=comparison(r,{},T+24.5*HOUR);assert.equal(m.count,23);assert.equal(m.afterStart,T+HOUR);assert.equal(m.beforeEnd,T);
 const custom=comparison(r,{from:6,to:12},T+24*HOUR);assert.equal(custom.count,5);assert.equal(custom.afterStart,T+7*HOUR);
 assert.throws(()=>comparison(r,{from:12,to:6}));assert.equal(comparison(r,{},T+.75*HOUR).count,0);
 const broken=record();broken.rows=broken.rows.filter(r=>r.time!==T);assert.equal(comparison(broken,{},T+2*HOUR).spend.after,null);
 assert.equal(change(0,4).percent,null);assert.match(change(0,4).text,/前值为0/);assert.equal(change(null,4).delta,null);assert.equal(change(100,99).text,'下降 1%');
});
test('reader uses fork=0 ROI and fork=1 basic spend, rejects foreign plans and incomplete responses',async()=>{
 const calls=[];const metrics=keys=>Object.fromEntries(keys.map(k=>[k,{Value:k===ROI_KEYS.roi?2:k===ROI_KEYS.revenue?20:10,ValueStr:'value'}]));
 const api={planCache:new Map([[id,{}]]),call:async(_path,body,opt)=>{calls.push({body,opt});return {data:{StatsData:{TotalCount:1,Rows:[{Dimensions:{ad_id:{Value:id},stat_time_hour:{Value:T}},Metrics:metrics(body.Metrics)}]}}};}};
 const args={id,accountId:ACCOUNT_ID,from:new Date(T).toISOString(),to:new Date(T+HOUR).toISOString()};
 const r=await readRoiHours(api,args,{clock:()=>T+2*HOUR,gapMs:0});assert.equal(r.rows[0].spend,10);assert.ok(r.rows[0].full);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.opt.intent==='read'));
 assert.deepEqual(calls.map(c=>c.body.Filters.Conditions.find(c=>c.Field==='roi2_project_scene_fork').Values),[['0'],['1']]);assert.ok(!calls.some(c=>c.body.Metrics.includes('stat_cost_for_roi2_primary')));
 await assert.rejects(readRoiHours(api,{...args,accountId:'other'}),e=>e.code==='ACCOUNT_MISMATCH');
 api.call=async()=>({data:{StatsData:{Rows:[],TotalCount:24}}});await assert.rejects(readRoiHours(api,args,{clock:()=>T+2*HOUR,gapMs:0}),e=>e.code==='ROI_HOURS_INCOMPLETE');
});
test('tracking starts only on confirmation, coalesces reads, preserves data on errors, freezes at 24h and survives restart',async t=>{
 const directory=await temp(t);let now=T,calls=0,fail=false;
 const options={api:{planCache:new Map([[id,{}]])},directory,clock:()=>now,gapMs:0,read:async(_api,q)=>{calls++;if(fail)throw new Error('offline');return {fetchedAt:new Date(now).toISOString(),rows:[row(T-HOUR)]};}};
 const service=await new RoiObservations(options).init(),key=await service.reserve({action:'roi',id,name:'test',before:2,after:3});assert.equal(service.list().length,0);assert.equal(calls,0);
 await service.confirm(key);await service.queue;assert.equal(calls,1);assert.equal(service.index().recentPlanIds.length,1);
 await Promise.all([service.enqueue(key),service.enqueue(key)]);assert.equal(calls,2);
 now+=HOUR;fail=true;await service.enqueue(key);assert.equal(service.get(key).rows.length,1);assert.equal(service.get(key).error,'offline');
 now=T+24*HOUR;await service.enqueue(key);const frozen=calls;assert.equal(service.get(key).status,'completed');assert.equal(service.index().recentPlanIds.length,0);service.tick();await service.queue;assert.equal(calls,frozen);
 const restarted=await new RoiObservations(options).init();restarted.tick();await restarted.queue;assert.equal(calls,frozen);assert.equal(restarted.get(key).rows.length,1);
});
test('successive edits interrupt old observation including an in-flight read; restart reconciles interrupted saves',async t=>{
 const directory=await temp(t);let now=T,release;let deferred=true;const opts={api:{planCache:new Map([[id,{}]])},directory,clock:()=>now,gapMs:0,read:async()=>{if(deferred){deferred=false;await new Promise(r=>release=r);}return {rows:[],fetchedAt:new Date(now).toISOString()};}};
 const s=await new RoiObservations(opts).init();const a=await s.reserve({action:'roi',id,before:2,after:3});await s.confirm(a);await new Promise(r=>setImmediate(r));now+=2*HOUR;
 const b=await s.reserve({action:'roi',id,before:3,after:4});await s.confirm(b);release();await s.queue;assert.equal(s.get(a).status,'interrupted');await s.queue;s.tick();await s.queue;assert.ok(s.get(a).finalized);assert.equal(s.list(id).length,2);
 // Simulate persisted old record from a crash between new and old writes.
 const old=s.records.get(a);delete old.stoppedAt;old.finalized=false;await s.save(old);
 const restarted=await new RoiObservations(opts).init();assert.equal(restarted.records.get(a).stoppedAt,new Date(now).toISOString());
});
test('ROI operation preview creates no record; only successful confirmed write starts tracking; storage failure never retries platform write',async()=>{
 let writes=0,reserves=0,confirms=0,unknown=0,failWrite=false,failReserve=false,failConfirm=false;
 const ad={id,marGoal:1,name:'test',modifyTime:1,ecpRoi2Goal:'2',operation:{roi2GoalOperation:{editable:true}}};
 const api={allowWrites:true,planCache:new Map([[id,{}]]),roiObservations:{reserve:async()=>{reserves++;if(failReserve)throw new Error('disk');return 'record';},confirm:async()=>{confirms++;if(failConfirm)throw new Error('disk');},unconfirmed:async()=>unknown++},call:async(_p,_b,o={})=>{if(o.intent==='write'){writes++;if(failWrite)throw new Error('timeout');return {data:{results:[{flag:true}]}};}return {data:{adDetailInfo:ad}};}};
 const prepare=()=>prepareOperation(api,{accountId:ACCOUNT_ID,id,action:'roi',value:'3'},'actor');
 const commit=p=>commitOperation(api,{accountId:ACCOUNT_ID,planId:id,token:p.token,confirmed:true},'actor');
 const p=await prepare();assert.equal(reserves,0);assert.equal((await commit(p)).observationId,'record');assert.equal(confirms,1);
 failWrite=true;await assert.rejects(commit(await prepare()),e=>e.code==='OPERATION_UNCERTAIN');assert.equal(unknown,1);assert.equal(confirms,1);
 failWrite=false;failReserve=true;await assert.rejects(commit(await prepare()),/disk/);assert.equal(writes,2);
 failReserve=false;failConfirm=true;const success=await commit(await prepare());assert.ok(success.success);assert.match(success.observationWarning,/勿重复提交/);assert.equal(writes,3);
});
test('recent ROI filter applies before pagination, and history metadata remains after recent window expires',()=>{
 const plans=Array.from({length:35},(_,i)=>({id:String(i),name:'test',metrics:{},raw:{createTime:i}})),snapshot={total:35,plans,roiChanges:{recentPlanIds:plans.slice(0,25).map(p=>p.id),byPlan:{'0':{active:false}}}};
 const page=selectSnapshot(snapshot,{roiChanged24:true,page:2,pageSize:20});assert.equal(page.total,25);assert.equal(page.plans.length,5);assert.equal(page.roiRecentCount,25);assert.ok(page.plans.find(p=>p.id==='0').roiChange);
});
