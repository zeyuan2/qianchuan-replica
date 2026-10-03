import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {QianchuanApi,ACCOUNT_ID,PATHS,period,metricMap,metricValue} from '../server/api.mjs';
import {parseMetricConfiguration,validateMetricSelection} from '../dist/metric-config.mjs';
import {buildOperation,commitOperation} from '../server/operations.mjs';
import {buildTaskOperation} from '../server/tasks.mjs';
const fixture=async name=>JSON.parse(await fs.readFile(new URL('../fixtures/'+name+'.response.json',import.meta.url),'utf8'));
test('synthetic metric configurations preserve top order, table locked columns, and 47 real keys',async()=>{
 const topRaw=await fixture('035-getUserConfAndDataSet'),tableRaw=await fixture('037-getUserConfAndDataSet');
 const top=parseMetricConfiguration(topRaw,{honorLockDefault:false}),table=parseMetricConfiguration(tableRaw);
 assert.equal(top.metrics.length,47);assert.equal(table.metrics.length,47);assert.deepEqual(top.frozen,[]);assert.equal(top.minMetricCount,3);assert.equal(top.maxMetricCount,14);
 assert.deepEqual(top.selected,topRaw.data.ModuleInfo.SelectInfos.map(s=>s.SelectMetricsOrDimension));assert.deepEqual(table.selected.slice(0,2),table.frozen);
 assert.throws(()=>validateMetricSelection(top,top.selected.slice(0,2)),/至少/);assert.throws(()=>validateMetricSelection(top,top.metrics.slice(0,15).map(m=>m.key)),/最多/);
 assert.throws(()=>validateMetricSelection(table,table.selected.filter(k=>!table.frozen.includes(k))),/固定/);
});
test('Shanghai current period and comparison preserve calendar boundaries',()=>{
 const p=period('2026-10-01','2026-10-01',new Date('2026-10-01T09:20:30Z'));
 assert.equal(p.end,'2026-10-01 17:20:30');assert.equal(p.listEnd,'2026-10-01 23:59:59');assert.equal(p.compareEnd,'2026-09-30 17:20:30');
 assert.throws(()=>period('2026-02-30','2026-02-30'),/日期/);assert.throws(()=>period('2026-10-02','2026-10-01'),/日期/);
});
test('camel-case numeric-suffix metrics map to real snake-case catalog keys',()=>{
 const m=metricMap({totalOrderSettleAmountForRoi27D:{value:123.45,valueStr:'123.45'}});
 assert.equal(metricValue(m,'total_order_settle_amount_for_roi2_7d').text,'123.45');assert.equal(metricValue(m,'absent'),null);
});
test('budget and ROI builders enforce original units and minimum change without sending',async()=>{
 const ad=(await fixture('049-list-required')).data.adInfos[0];
 const op=buildOperation('budget',ad,'500');assert.equal(op.body.UpdateBudgetInfos[0].Value,50000000);assert.equal(op.body.UpdateBudgetInfos[0].ID,ad.id);
 assert.throws(()=>buildOperation('budget',ad,'350'),/100元/);assert.throws(()=>buildOperation('budget',ad,'299'),/300/);assert.throws(()=>buildOperation('budget',ad,'500.001'),/两位/);
 assert.throws(()=>buildOperation('roi',ad,'10000'),/10000/);assert.throws(()=>buildOperation('status',{...ad,operation:{}},'pause'),/不允许/);
 assert.equal(buildOperation('status',ad,'pause').body.optType,2);assert.equal(buildOperation('delete',ad).body.optType,3);
 assert.throws(()=>buildOperation('delete',{...ad,marGoal:2}),/商品计划/);
});
test('task limits require eligible material IDs and half-hour durations',()=>{
 const ad={id:'1000000000000100',budget:'30000000',modifyTime:'123',marGoal:1};
 const op=buildTaskOperation(ad,{kind:'boost',name:'测试任务',budget:'200',duration:'4'});assert.equal(op.body.Budget,20000000);assert.equal(op.body.Duration,14400);assert.equal(op.body.Scene,1);
 assert.throws(()=>buildTaskOperation(ad,{kind:'boost',name:'测试',budget:'200',duration:'.7'}),/0.5/);
 assert.throws(()=>buildTaskOperation(ad,{kind:'boost',name:'测试',budget:'301',duration:'4'}),/300/);
 assert.throws(()=>buildTaskOperation(ad,{kind:'heat',name:'测试',budget:'200',duration:'4',materialIds:['1']}),/允许追投/);
 assert.equal(buildTaskOperation(ad,{kind:'heat',name:'测试',budget:'200',duration:'4',materialIds:['123']},new Set(['123'])).body.VideoLegoMids[0],'123');
});
test('read-only commit cannot make any upstream call',async()=>{
 let calls=0;const api={allowWrites:false,call(){calls++;}};
 await assert.rejects(commitOperation(api,{confirmed:true}),e=>e.code==='READONLY_MODE');assert.equal(calls,0);
});
test('synthetic fixtures flow through query, summary, account checks and server-side filters',async()=>{
 const calls=[];const bridge={status:()=>({connected:true}),async request(spec){calls.push(spec);let f=spec.path===PATHS.config?(spec.body.ModuleId==='7580267836992405542'?'035-getUserConfAndDataSet':'037-getUserConfAndDataSet'):spec.path===PATHS.query?(spec.body.Dimensions.includes('marketing_goal')?'045-statQuery':'046-statQuery'):spec.path===PATHS.plans?'049-list-required':spec.path===PATHS.summary?'050-list-summary':'051-list-optional';return {status:200,text:JSON.stringify(await fixture(f))};}};
 const api=new QianchuanApi(bridge),data=await api.dashboard({accountId:ACCOUNT_ID,from:'2026-10-01',to:'2026-10-01',page:1,pageSize:10,search:'1000000000000100',status:'13',costStatus:'zero'});
 assert.equal(data.accountId,ACCOUNT_ID);assert.equal(data.total,132);assert.equal(data.plans.length,10);assert.equal(data.plans[0].budget,300);assert.equal(data.source,'live');assert.equal(data.allowWrites,false);
 const list=calls.find(c=>c.path===PATHS.plans).body.Params,summary=calls.find(c=>c.path===PATHS.summary).body;
 assert.deepEqual(list.SearchFilter,{Type:1,Keyword:'1000000000000100'});assert.equal(list.AdFilter.AdStatusFilterType,13);assert.equal(list.HavingFilter.IsZero,true);assert.deepEqual(summary.SearchFilter,list.SearchFilter);assert.equal(summary.AdFilter.AdlabMode,1);
 await assert.rejects(api.dashboard({accountId:'1000000000000001'}),e=>e.code==='ACCOUNT_MISMATCH');
});
test('responses from another account never reach the client model',async()=>{
 const api=new QianchuanApi({status:()=>({connected:true}),async request(spec){let name=spec.path===PATHS.config?(spec.body.ModuleId==='7580267836992405542'?'035-getUserConfAndDataSet':'037-getUserConfAndDataSet'):spec.path===PATHS.query?(spec.body.Dimensions.includes('marketing_goal')?'045-statQuery':'046-statQuery'):spec.path===PATHS.plans?'049-list-required':spec.path===PATHS.summary?'050-list-summary':'051-list-optional';const data=await fixture(name);if(spec.path===PATHS.plans)data.data.adInfos[0].advId='different';return {status:200,text:JSON.stringify(data)};}});
 await assert.rejects(api.dashboard({accountId:ACCOUNT_ID,from:'2026-10-01',to:'2026-10-01'}),e=>e.code==='ACCOUNT_MISMATCH');
});
