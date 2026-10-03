import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ACCOUNT_ID,PATHS} from '../server/api.mjs';
import {collectFullSnapshot} from '../server/full-capture.mjs';
import {ProductMonitor} from '../server/monitor.mjs';
import {selectSnapshot,getShanghaiDate} from '../dist/lan-data.mjs';
import {BrowserBridge} from '../server/bridge.mjs';

const id=n=>(1874859201842300n+BigInt(n)).toString();
const makeAd=n=>({id:id(n),advId:ACCOUNT_ID,marGoal:1,name:'计划'+n,adDeliveryName:'投放中',adOptType:0,budget:'30000000',ecpRoi2Goal:2.5,createTime:'1790840000'});
const config={metrics:[{key:'cost',label:'消耗'}],selected:['cost'],frozen:[]};
function captureApi({total=132,duplicate=false,foreign=false,drift=false}={}){
 const calls=[];let summaryCalls=0;
 return {calls,planCache:new Map(),bootstrap:async()=>({top:config,table:config}),async call(endpoint,body){calls.push({endpoint,body});
  if(endpoint===PATHS.summary){summaryCalls++;return {data:{totalNum:String(drift&&summaryCalls>1?total+1:total),totalMetrics:{metrics:{cost:{value:100,valueStr:'100.00'}}}}};}
  if(endpoint===PATHS.plans){const {Page,PageSize}=body.Params.PageParams,limit=drift&&summaryCalls>1?total+1:total;const ads=Array.from({length:Math.max(0,Math.min(PageSize,limit-(Page-1)*PageSize))},(_,i)=>makeAd((Page-1)*PageSize+i));if(duplicate&&Page>1&&ads.length)ads[0]=makeAd(0);if(foreign&&Page>1&&ads.length)ads[0].advId='other-account';return {data:{adInfos:ads,pagination:{page:Page,pageSize:PageSize},adStatsMap:{}}};}
  if(endpoint===PATHS.query)return {data:{StatsData:{Totals:{cost:{Value:100,ValueStr:'100.00'}},Rows:[{Dimensions:{hour:{ValueStr:'12:00'}},Metrics:{cost:{Value:10,ValueStr:'10.00'}}}]}}};
  throw new Error(endpoint);
 }};
}
test('complete capture reads every page and checks platform totals before publishing',async()=>{
 const api=captureApi(),result=await collectFullSnapshot(api,{day:'2026-10-01',requestGapMs:0,now:()=>new Date('2026-10-01T11:00:00Z')});
 assert.equal(result.total,132);assert.equal(result.plans.length,132);assert.equal(new Set(result.plans.map(p=>p.id)).size,132);assert.equal(result.complete,true);
 assert.deepEqual(result.capture.pages,[{page:1,rows:100},{page:2,rows:32}]);assert.equal(api.calls.filter(c=>c.endpoint===PATHS.summary).length,2);
 assert.ok(api.calls.filter(c=>c.endpoint===PATHS.plans).every(c=>c.body.Params.OrderBy.Type===1));
});
test('range capture queries platform interval totals and daily trend without summing ratios',async()=>{
 const api=captureApi({total:2});const result=await collectFullSnapshot(api,{from:'2026-09-25',to:'2026-10-01',requestGapMs:0,now:()=>new Date('2026-10-01T11:00:00Z')});
 assert.equal(result.from,'2026-09-25');assert.equal(result.to,'2026-10-01');
 const metricCalls=api.calls.filter(c=>c.endpoint===PATHS.query);assert.equal(metricCalls[0].body.StartTime,'2026-09-25 00:00:00');assert.deepEqual(metricCalls[1].body.Dimensions,['stat_time_day']);
 const summary=api.calls.find(c=>c.endpoint===PATHS.summary);assert.equal(summary.body.AdFilter.StartTime,'2026-09-25 00:00:00');
});
test('incomplete or duplicate pages and foreign accounts cannot be published',async()=>{
 await assert.rejects(collectFullSnapshot(captureApi({duplicate:true}),{day:'2026-10-01',requestGapMs:0}),e=>e.code==='INCOMPLETE_CAPTURE');
 await assert.rejects(collectFullSnapshot(captureApi({foreign:true}),{day:'2026-10-01',requestGapMs:0}),e=>e.code==='ACCOUNT_MISMATCH');
});
test('a changing total triggers one bounded recapture instead of silently missing a plan',async()=>{
 const api=captureApi({drift:true}),result=await collectFullSnapshot(api,{day:'2026-10-01',requestGapMs:0});
 assert.equal(result.total,133);assert.equal(result.plans.length,133);assert.equal(api.calls.filter(c=>c.endpoint===PATHS.plans).length,4);
});

const timers=()=>({delays:[],setTimeout(_fn,ms){this.delays.push(ms);return this.delays.length;},clearTimeout(){}});
async function cleanup(directory){const resolved=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase()||!path.basename(resolved).startsWith('qc-monitor-test-'))throw new Error('Unexpected test cleanup path');await fs.rm(resolved,{recursive:true,force:true});}
function snapshot(ids,time){return {accountId:ACCOUNT_ID,complete:true,source:'live',allowWrites:false,from:'2026-10-01',to:'2026-10-01',startedAt:new Date(time).toISOString(),fetchedAt:new Date(time+1000).toISOString(),plans:ids.map(n=>({id:id(n),name:'计划'+n,statusText:'投放中',service:'基础投放',metrics:{},raw:{createTime:String(Math.floor(time/1000))}})),total:ids.length,metrics:[],topConfig:config,tableConfig:config,capture:{requests:6}};}
test('notification failure cannot invalidate a completed capture or stop the next capture',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-monitor-test-'));t.after(()=>cleanup(directory));let notices=0;
 const now=Date.parse('2026-10-01T11:00:00Z'),api={bridge:{status:()=>({connected:true})},planCache:new Map()};
 const monitor=await new ProductMonitor({api,directory,clock:()=>now,timers:timers(),collect:async()=>snapshot([1],now),onSnapshot:async()=>{notices++;throw new Error('notification unavailable');}}).init();
 monitor.start();await monitor.run();await new Promise(resolve=>setImmediate(resolve));assert.equal(monitor.status.phase,'ready');assert.equal(monitor.packet.snapshot.total,1);assert.equal(notices,1);assert.match(monitor.status.alertError,/预算提醒/);monitor.stop();
});
test('baseline is not new; same-count replacement is detected; restart and reappearance do not duplicate events',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-monitor-test-'));t.after(()=>cleanup(directory));
 let now=Date.parse('2026-10-01T11:00:00Z'),ids=[1,2],fail=false;
 const api={bridge:{status:()=>({connected:true})},planCache:new Map()},clock=()=>now,timer=timers();
 const collect=async()=>{if(fail)throw Object.assign(new Error('登录失效'),{code:'AUTH_REQUIRED'});return snapshot(ids,now);};
 const monitor=await new ProductMonitor({api,directory,clock,timers:timer,collect}).init();monitor.start();await monitor.run();
 assert.equal(monitor.packet.events.length,0);assert.equal(monitor.packet.baselineEstablished,true);assert.equal(timer.delays.at(-1),300000);
 now+=300000;ids=[1,3];await monitor.run();assert.deepEqual(monitor.packet.events.map(e=>e.id),[id(3)]);assert.equal(monitor.packet.events[0].kind,'created');
 const persisted=await fs.readFile(path.join(directory,'latest.json'),'utf8');now+=300000;fail=true;await monitor.run();
 assert.equal(await fs.readFile(path.join(directory,'latest.json'),'utf8'),persisted);assert.equal(monitor.view().monitor.error.code,'AUTH_REQUIRED');assert.equal(monitor.view().snapshot.plans.length,2);
 monitor.stop();fail=false;ids=[1,2,3];
 const restarted=await new ProductMonitor({api,directory,clock,timers:timers(),collect}).init();restarted.start();await restarted.run();
 assert.deepEqual(restarted.packet.events.map(e=>e.id),[id(3)]);assert.equal(restarted.packet.snapshot.total,3);restarted.stop();
});
test('in-flight collection is shared; old plans newly appearing are labelled discovery rather than creation',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-monitor-test-'));t.after(()=>cleanup(directory));
 let time=Date.parse('2026-10-01T11:00:00Z'),release,calls=0;const api={bridge:{status:()=>({connected:true})},planCache:new Map()};
 const monitor=await new ProductMonitor({api,directory,clock:()=>time,timers:timers(),collect:async()=>{calls++;await new Promise(r=>release=r);return snapshot([1],time);}}).init();monitor.start();
 const a=monitor.run(),b=monitor.run();assert.equal(a,b);assert.equal(calls,1);release();await a;
 time+=300000;monitor.collect=async()=>{const s=snapshot([1,2],time);s.plans[1].raw.createTime='1700000000';return s;};await monitor.run();
 assert.equal(monitor.packet.events[0].kind,'discovered');monitor.stop();
});
test('LAN view preserves whole-account total while pagination and only-new filtering use full collected IDs',()=>{
 const s=snapshot([1,2,3],Date.parse('2026-10-01T11:00:00Z'));s.newPlanEvents=[{id:id(3),kind:'created',detectedAt:s.fetchedAt}];
 const page=selectSnapshot(s,{page:2,pageSize:2});assert.equal(page.plans.length,1);assert.equal(page.total,3);assert.equal(page.accountTotal,3);
 const view=selectSnapshot(s,{onlyNew:true,page:1,pageSize:10});assert.equal(view.total,1);assert.equal(view.plans[0].id,id(3));assert.equal(view.plans[0].newEvent.kind,'created');assert.equal(view.accountTotal,3);
});

test('local pairing survives service restart and invalid stored tokens are replaced',()=>{
 const initial=new BrowserBridge(),next=new BrowserBridge({token:initial.token});assert.equal(next.token,initial.token);assert.equal(next.authenticate(initial.token),true);assert.equal(next.authenticate('wrong'),false);assert.notEqual(new BrowserBridge({token:'short'}).token,'short');initial.close();next.close();
});

test('monitor date switches at Shanghai midnight, independently of the computer locale',()=>{
 assert.equal(getShanghaiDate(new Date('2026-10-01T15:59:59Z')),'2026-10-01');assert.equal(getShanghaiDate(new Date('2026-10-01T16:00:00Z')),'2026-10-02');
});
