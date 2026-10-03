import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BudgetAlerts,budgetCandidates,pushplusSend} from '../server/budget-alerts.mjs';
import {ACCOUNT_ID,today} from '../server/api.mjs';
const base=Date.parse('2026-10-02T03:00:00Z');
function plan(id='1000000000001002',spend=800,budget=1000){return {id,accountId:ACCOUNT_ID,marGoal:1,name:'预算测试计划',budget,statusText:'投放中',metrics:{statcostforroi2primary:{value:spend,valueStr:String(spend)},statcostforroi2:{value:9999,valueStr:'9999'}}};}
function snapshot(plans=[plan()],time=base){const day=today(new Date(time));return {accountId:ACCOUNT_ID,source:'live',complete:true,from:day,to:day,fetchedAt:new Date(time).toISOString(),plans,total:plans.length};}
async function directory(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'qc-alert-test-'));t.after(async()=>{const real=await fs.realpath(d),parent=await fs.realpath(os.tmpdir());if(path.dirname(real).toLowerCase()!==parent.toLowerCase()||!path.basename(real).startsWith('qc-alert-test-'))throw new Error('Unsafe test cleanup');await fs.rm(real,{recursive:true,force:true});});return d;}
test('budget threshold uses primary spend, includes exact 80%, and rejects missing/stale/historical data',()=>{
 assert.equal(budgetCandidates(snapshot([plan('1000000000001002',799.99)]),base).length,0);assert.equal(budgetCandidates(snapshot(),base).length,1);
 const p=plan();p.metrics.statcostforroi2primary.value=null;assert.equal(budgetCandidates(snapshot([p]),base).length,0);
 p.metrics.statcostforroi2primary={value:800,valueStr:'-'};assert.equal(budgetCandidates(snapshot([p]),base).length,0);
 for(const change of [{from:'2026-10-01'},{accountId:'other'},{complete:false},{fetchedAt:new Date(base-600001).toISOString()},{total:2}])assert.throws(()=>budgetCandidates({...snapshot(),...change},base));
 assert.equal(budgetCandidates(snapshot([plan('1000000000001002',800,0)]),base).length,0);
});
test('budget notifications persist deduplication across restarts and rearm for budget/date changes',async t=>{
 const dir=await directory(t);let now=base,sends=0;const send=async()=>({receipt:'test-'+ ++sends}),clock=()=>now;
 let a=await new BudgetAlerts({directory:dir,clock,send}).init();await a.run(snapshot());assert.equal(sends,0);
 await a.configure({token:'test-token-0123456789',enabled:true,acceptThirdParty:true});await a.run(snapshot());await a.run(snapshot());assert.equal(sends,1);
 a=await new BudgetAlerts({directory:dir,clock,send}).init();await a.run(snapshot());assert.equal(sends,1);await a.run(snapshot([plan('1000000000001002',1600,2000)]));assert.equal(sends,2);
 now+=86400000;await a.run(snapshot([plan()],now));assert.equal(sends,3);assert.equal(JSON.stringify(a.status()).includes('test-token'),false);
});
test('uncertain deliveries are not retried and rejected messages retry at most three times',async t=>{
 const dir=await directory(t);let now=base,calls=0,uncertain=true;const a=await new BudgetAlerts({directory:dir,clock:()=>now,send:async()=>{calls++;throw Object.assign(new Error('test failure'),{uncertain});}}).init();await a.configure({token:'test-token-0123456789',enabled:true,acceptThirdParty:true});await a.run(snapshot());now+=300001;await a.run(snapshot([plan()],now));assert.equal(calls,1);
 uncertain=false;for(let i=0;i<5;i++){now+=300001;await a.run(snapshot([plan('1000000000001003')],now));}assert.equal(calls,4);
});
test('pushplus receives one private WeChat request and accepted does not claim delivered',async()=>{
 let request;const r=await pushplusSend('test-token',{title:'测试',content:'仅测试'},{now:base,fetcher:async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return {ok:true,json:async()=>({code:200,data:'receipt-test'})};}});
 assert.equal(r.status,'accepted');assert.equal(request.url,'https://www.pushplus.plus/send');assert.equal(request.body.channel,'wechat');assert.equal(request.body.topic,undefined);assert.equal(request.body.to,undefined);assert.equal(request.options.redirect,'error');assert.equal(request.url.includes('test-token'),false);
 await assert.rejects(pushplusSend('test-token',{}, {fetcher:async()=>{throw new Error('timeout with sensitive payload');}}),e=>e.uncertain&&!e.message.includes('sensitive'));
});

test('adding a recipient preserves legacy deduplication and isolates failed deliveries across restart',async t=>{
 const dir=await directory(t),first='first-test-token-012345',second='second-test-token-012345';let now=base;const calls=[];
 const send=async token=>{calls.push(token);if(token===second)throw Object.assign(new Error('unconfirmed'),{uncertain:true});return {receipt:'receipt'};};
 let a=await new BudgetAlerts({directory:dir,clock:()=>now,send}).init();
 await a.configure({token:first,enabled:true,acceptThirdParty:true});await a.run(snapshot());
 await a.configure({addToken:second,enabled:true,acceptThirdParty:true});
 await a.configure({addToken:second,enabled:true,acceptThirdParty:true});
 assert.equal(a.status().recipientCount,2);await a.run(snapshot());assert.deepEqual(calls,[first,second]);
 assert.equal(a.preview(snapshot()).rows[0].pushStatus,'uncertain');
 a=await new BudgetAlerts({directory:dir,clock:()=>now,send}).init();now+=300001;await a.run(snapshot([plan()],now));assert.equal(calls.length,2);
 await a.run(snapshot([plan('1000000000001003')],now));assert.deepEqual(calls,[first,second,first,second]);
 assert.equal(a.status().error,'unconfirmed');assert.equal(JSON.stringify(a.status()).includes('test-token'),false);
 await assert.rejects(a.configure({addToken:'bad',enabled:true,acceptThirdParty:true}));assert.equal(a.status().recipientCount,2);
});
