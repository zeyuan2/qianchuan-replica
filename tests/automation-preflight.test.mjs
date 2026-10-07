import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectHost,localBase,preflight} from '../scripts/automation-preflight.mjs';
import {RULES} from '../server/automation-policy.mjs';
const now=Date.parse('2026-10-07T12:00:00+08:00');
const accountId='1000000000000099',id='1000000000000001';
const request={version:RULES.version,activate:false,planIds:[id]};
const status={accountId,replay:false,allowWrites:true,bridge:{writeReady:true,token:'synthetic-secret'}};
const row={id,accountId,marGoal:1,name:'Synthetic plan',status:'active',isEnabled:true,roiTarget:3.1,budget:1000,
  metrics:{statcostforroi2primary:{Value:'800'}},raw:{createTime:now/1000-86400,modifyTime:now/1000,secret:'synthetic-secret'}};
const view={accountId,snapshot:{accountId,source:'live',complete:true,from:'2026-10-07',to:'2026-10-07',fetchedAt:new Date(now).toISOString(),total:1,plans:[row]}};
test('source checks never claim activation, export credentials or infer ROI edit time',()=>{
  const report=inspectHost(request,status,view,now);
  assert.equal(report.sourceChecksPassed,true);assert.equal(report.automationStarted,false);
  assert.equal(report.plans[0].basicSpend,800);
  assert.equal(JSON.stringify(report).includes('synthetic-secret'),false);
  assert.equal('lastRoiChangedAt' in report.plans[0],false);
});
test('missing, duplicate, stale, historical and wrong account data fail preflight',()=>{
  for (const patch of [{accountId:'1000000000000002'},{source:'recorded'},{complete:false},{from:'2026-10-06'},
    {plans:[]},{plans:[row,row],total:2},{fetchedAt:new Date(now-300001).toISOString()}]) {
    assert.equal(inspectHost(request,status,{...view,snapshot:{...view.snapshot,...patch}},now).sourceChecksPassed,false);
  }
  assert.equal(inspectHost(request,{...status,replay:true},view,now).sourceChecksPassed,false);
});
test('paused, wrong-identity and missing-spend plans are not accepted',()=>{
  for (const patch of [{status:'paused'},{accountId:'1000000000000002'},{metrics:{}},{budget:0}])
    assert.equal(inspectHost(request,status,{...view,snapshot:{...view.snapshot,plans:[{...row,...patch}]}},now).sourceChecksPassed,false);
});
test('preflight accepts loopback only and cannot become an activation command',()=>{
  assert.equal(localBase('http://127.0.0.1:5173'),'http://127.0.0.1:5173');
  for(const url of ['https://example.com','http://user:password@localhost:5173','http://localhost:5173/path','http://localhost:5173/?token=x'])assert.throws(()=>localBase(url));
  assert.throws(()=>inspectHost({...request,activate:true},status,view,now));
});
test('only two read-only endpoints are requested; redirects are forbidden',async()=>{
  const calls=[];
  const report=await preflight({request,now,fetchImpl:async(url,options)=>{
    calls.push({url,...options});return {ok:true,json:async()=>url.endsWith('/api/status')?status:view};
  }});
  assert.equal(report.sourceChecksPassed,true);assert.equal(calls.length,2);
  assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/api/status','/api/monitor']);
  for(const call of calls){assert.equal(call.method,'GET');assert.equal(call.redirect,'error');}
});
