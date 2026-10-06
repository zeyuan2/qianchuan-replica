import test from 'node:test';
import assert from 'node:assert/strict';
import {BoostState,classifyBoostTask} from '../server/boost-state.mjs';
import {ACCOUNT_ID} from '../server/api.mjs';
const now=Date.parse('2026-10-03T06:00:00Z'),id='1000000000000100';
const ad=(n,overrides={})=>({id:String(n),name:'test',advId:ACCOUNT_ID,marGoal:1,budget:10000000,startTime:String(now/1000-3600),endTime:String(now/1000+3600),adDeliveryName:'投放中',...overrides});
test('task classification requires platform end status and end time; paused/scheduled remain active',()=>{
 assert.equal(classifyBoostTask(ad(1),now).state,'active');assert.equal(classifyBoostTask(ad(1,{adDeliveryName:'手动暂停'}),now).state,'active');
 assert.equal(classifyBoostTask(ad(1,{adDeliveryName:'已完成',endTime:String(now/1000-1)}),now).state,'ended');
 assert.equal(classifyBoostTask(ad(1,{adDeliveryName:'投放中',endTime:String(now/1000-1)}),now).state,'unknown');
 assert.equal(classifyBoostTask(ad(1,{adDeliveryName:'已完成'}),now).state,'unknown');assert.equal(classifyBoostTask(ad(1,{endTime:'0'}),now).state,'unknown');
});
test('all task pages are checked; account mismatch, missing pages and total drift never become eligible',async()=>{
 const calls=[];const api={planCache:new Map([[id,{}]]),async call(_path,body){calls.push(body);const page=body.Params.PageParams.Page;return {data:{adInfos:page===1?[ad(1,{adDeliveryName:'已完成',endTime:String(now/1000-1)})]:[ad(2)],pagination:{page,pageSize:100,totalNum:2}}};}};
 const state=new BoostState({api,clock:()=>now,gapMs:0});const result=await state.inspect(id);assert.equal(result.state,'active');assert.equal(calls.length,2);assert.equal(calls[0].Params.AdFilter.AssistTaskFilter.PrimaryAID,id);
 api.call=async()=>({data:{adInfos:[ad(1,{advId:'other'})],pagination:{page:1,totalNum:1}}});await assert.rejects(state.inspect(id,{force:true}),e=>e.code==='ACCOUNT_MISMATCH');
 api.call=async()=>({data:{adInfos:[],pagination:{page:1,totalNum:1}}});await assert.rejects(state.inspect(id,{force:true}));
 let n=0;api.call=async()=>({data:{adInfos:[ad(++n)],pagination:{page:n,totalNum:n===1?2:3}}});await assert.rejects(state.inspect(id,{force:true}));
});
test('state cache cannot keep an active task eligible or hide its end without a new query',async()=>{
 let clock=now,calls=0;const api={planCache:new Map([[id,{}]]),call:async()=>({data:{adInfos:[ad(1,{endTime:String(now/1000+1),adDeliveryName:++calls===1?'投放中':'已完成'})],pagination:{page:1,totalNum:1}}})};
 const state=new BoostState({api,clock:()=>clock,gapMs:0});assert.equal((await state.inspect(id)).state,'active');clock+=1001;assert.equal((await state.inspect(id)).state,'eligible');assert.equal(calls,2);
});
