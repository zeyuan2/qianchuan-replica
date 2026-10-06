import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge} from '../server/bridge.mjs';
import {executeAndReport,selectSourceTab} from '../bridge-extension/execute-guard.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProductMonitor} from '../server/monitor.mjs';
import {ACCOUNT_ID} from '../server/api.mjs';
test('a new capture attempt does not mark the previous failure recovered until fresh data succeeds',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-bridge-test-'));t.after(async()=>{const real=await fs.realpath(directory);assert.equal(path.dirname(real).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());assert.ok(path.basename(real).startsWith('qc-bridge-test-'));await fs.rm(real,{recursive:true,force:true});});
 let release;const m=new ProductMonitor({directory,api:{bridge:{status:()=>({connected:true})}},collect:()=>new Promise(r=>release=r),timers:{clearTimeout(){},setTimeout(){return 0;}}});m.stopped=false;m.status.error={code:'BRIDGE_NO_REPLY'};const run=m.run();assert.equal(m.status.error.code,'BRIDGE_NO_REPLY');const at=new Date().toISOString();release({accountId:ACCOUNT_ID,complete:true,plans:[],total:0,startedAt:at,fetchedAt:at,from:at.slice(0,10)});await run;assert.equal(m.status.error,null);m.stop();
});
test('source selection prefers a live account tab over an inactive discarded duplicate',()=>{
 const url='https://qianchuan.jinritemai.com/overall-prom?aavid=1',tabs=[{id:1,url,discarded:true},{id:2,url},{id:3,url,active:true},{id:4,url:url.replace('aavid=1','aavid=2'),active:true}];assert.equal(selectSourceTab(tabs,'1').id,3);tabs[2].frozen=true;assert.equal(selectSourceTab(tabs,'1').id,2);assert.equal(selectSourceTab([{url:'https://example.com/overall-prom?aavid=1'}],'1'),undefined);
});
test('disconnected long polls cannot consume subsequent read or write jobs',async()=>{
 const b=new BrowserBridge(),c=new AbortController(),old=b.next(15000,{writes:true,signal:c.signal});c.abort();assert.equal(await old,null);assert.equal(b.waiters.length,0);
 const request=b.request({intent:'write',path:'/test'},{timeout:1000});assert.equal(b.queue.length,1);assert.equal(await b.next(1),null);const job=await b.next(1,{writes:true});b.reply(job.id,{status:200});await request;b.close();
});
test('timeout diagnostics distinguish an unclaimed job from a browser that stopped replying',async()=>{
 const b=new BrowserBridge();await assert.rejects(b.request({intent:'read',path:'/test'},{timeout:10}),e=>e.code==='BRIDGE_NOT_PICKED_UP');
 const request=b.request({intent:'read',path:'/test'},{timeout:10});await b.next(1);await assert.rejects(request,e=>e.code==='BRIDGE_NO_REPLY');assert.deepEqual(b.history.map(r=>r.error),['BRIDGE_NOT_PICKED_UP','BRIDGE_NO_REPLY']);b.close();
});
test('injection exceptions produce a reply, do not disclose details, and never replay writes',async()=>{
 let calls=0;const execute=async()=>{calls++;throw Error('secret');};
 const read=await executeAndReport(execute,{intent:'read',expiresAt:Date.now()+1000});assert.equal(read.error.code,'BROWSER_EXECUTION_FAILED');assert.ok(!JSON.stringify(read).includes('secret'));
 const write=await executeAndReport(execute,{intent:'write',expiresAt:Date.now()+1000});assert.equal(write.error.code,'OPERATION_UNCERTAIN');assert.equal(calls,2);
 const expired=await executeAndReport(execute,{intent:'write',expiresAt:0});assert.equal(expired.error.code,'JOB_EXPIRED');assert.equal(calls,2);
});
