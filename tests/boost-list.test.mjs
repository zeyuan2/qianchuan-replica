import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyBoostList,loadBoostList} from '../server/boost-list.mjs';
import {ACCOUNT_ID,PATHS} from '../server/api.mjs';
const now=Date.parse('2026-10-03T06:00:00Z');
const noTask=id=>({id,advId:ACCOUNT_ID,marGoal:1,assistTaskInfoMap:{1:{showStatus:1,operation:{create:{visible:true,editable:true}}}},assistTaskAggInfo:{assistTaskAggShowStatusMap:{1:0}}});
test('fast list classification never treats missing fields, a plus button alone, or conflicting dates as eligible',()=>{
 const a=noTask('1');assert.equal(classifyBoostList(a,now).state,'eligible');assert.equal(classifyBoostList({id:'1'},now).state,'unknown');
 const b=structuredClone(a);delete b.assistTaskAggInfo;assert.equal(classifyBoostList(b,now).state,'unknown');
 a.assistTaskInfoMap[1]={id:'task',startTime:now/1000-100,endTime:now/1000+100,status:0,showStatus:0,operation:{finish:{visible:true,editable:true}}};a.assistTaskAggInfo.assistTaskAggShowStatusMap[1]=1;assert.equal(classifyBoostList(a,now).state,'active');
 a.assistTaskInfoMap[1].status=12;assert.equal(classifyBoostList(a,now).state,'unknown');a.assistTaskInfoMap[1].endTime=now/1000-1;a.assistTaskAggInfo.assistTaskAggShowStatusMap[1]=0;assert.equal(classifyBoostList(a,now).state,'eligible');
 a.assistTaskAggInfo.assistTaskAggShowStatusMap[1]=1;assert.equal(classifyBoostList(a,now).state,'unknown');
});
function fixture({missing=false,foreign=false,drift=false}={}){
 let summaries=0;const calls=[],ads=Array.from({length:134},(_,i)=>noTask(String(1000000000000100n+BigInt(i))));
 const api={async call(path,body){calls.push({path,body});if(path===PATHS.summary)return {data:{totalNum:++summaries>1&&drift?135:134}};
 if(path===PATHS.plans){const page=body.Params.PageParams.Page;return {data:{adInfos:ads.slice((page-1)*100,page*100).map(({id,advId,marGoal})=>({id,advId,marGoal})),sessionId:'page-'+page,pagination:{page,pageSize:100}}};}
 if(path===PATHS.optional){assert.equal(body.SessionId,body.SessionID);const page=Number(body.SessionId.slice(5));const data=structuredClone(ads.slice((page-1)*100,page*100));if(foreign)data[0].advId='other';return {data:{adInfos:missing?[]:data}};}
 throw new Error('Unexpected request');}};return {api,calls};
}
test('134 plans require six read-only paged requests, with each optional response bound to its page session',async()=>{
 const f=fixture();const result=await loadBoostList(f.api,{clock:()=>now,gapMs:0});assert.equal(result.rows.size,134);assert.equal(result.requests,6);assert.equal(f.calls.length,6);assert.ok([...result.rows.values()].every(r=>r.state==='eligible'));assert.equal(f.calls.filter(c=>c.path===PATHS.optional).length,2);
});
test('missing optional fields fall back and foreign or drifting lists are rejected',async()=>{
 let f=fixture({missing:true});let result=await loadBoostList(f.api,{clock:()=>now,gapMs:0});assert.ok([...result.rows.values()].every(r=>r.state==='unknown'));
 f=fixture({foreign:true});await assert.rejects(loadBoostList(f.api,{clock:()=>now,gapMs:0}),e=>e.code==='ACCOUNT_MISMATCH');
 f=fixture({drift:true});await assert.rejects(loadBoostList(f.api,{clock:()=>now,gapMs:0}),e=>e.code==='INCOMPLETE_CAPTURE');
});
