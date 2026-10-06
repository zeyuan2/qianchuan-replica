// Local synthetic UI acceptance harness. Never connects to a browser bridge or Qianchuan.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ACCOUNT_ID,today} from '../server/api.mjs';
import {BatchBoost} from '../server/batch-boost.mjs';
if(ACCOUNT_ID!=='1000000000000000')throw new Error('This preview requires the sanitized account placeholder');
const port=5189,origin=`http://127.0.0.1:${port}`,root=new URL('../dist/',import.meta.url);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-preview-batch-'));
const plans=Array.from({length:134},(_,i)=>({id:String(1000000000000100n+BigInt(i)),accountId:ACCOUNT_ID,marGoal:1,name:`人工测试计划 ${String(i+1).padStart(3,'0')}`,statusText:'投放中',budget:300,metrics:Object.fromEntries([['statcostforoverallroi2',i*10+100],['statcostforroi2primary',i*5+50],['totalprepayandpaysettleoverallroi21h',(i%10)/2],['totalordersettlecountforroi21h',i]].map(([k,n])=>[k,{value:n,valueStr:String(n)}])),raw:{id:String(1000000000000100n+BigInt(i)),marGoal:1,budget:30000000,createTime:i}}));
const tasks=new Map([[plans[133].id,[{id:'active-sample',name:'仍在起量',state:'active'}]]]);
const api={allowWrites:true,confirmations:new Map(),planCache:new Map(plans.map(p=>[p.id,p]))};let simulatedWrites=0;
const batch=await new BatchBoost({api,directory,gapMs:5,
 inspect:async id=>({id,state:tasks.get(id)?.some(t=>t.state==='active')?'active':'eligible',tasks:tasks.get(id)||[],complete:true,checkedAt:new Date().toISOString()}),
 prepare:async(_api,q)=>{const token='local-'+q.id;api.confirmations.set(token,q.value);return {token};},
 commit:async(_api,q)=>{simulatedWrites++;const value=api.confirmations.get(q.token);if(q.planId===plans[132].id&&!value.name.startsWith('核实后补做'))throw Object.assign(new Error('人工模拟超时，未创建'),{code:'OPERATION_UNCERTAIN'});tasks.set(q.planId,[{id:'fake-task-'+simulatedWrites,name:value.name,budget:value.budget,duration:value.duration,state:'active'}]);return {success:true};}
}).init();
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>批量起量·人工测试</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/live.css"><link rel="stylesheet" href="/lan.css"><body style="padding:24px"><h1>人工测试预览 · 不连接真实账户</h1><p>134条虚构计划，1条起量中默认剔除；编号133首次模拟超时，可核实后单独补做。</p><button id="open">打开批量起量</button><button id="end">模拟全部起量结束</button><p id="notice"></p><script type="module">import {openBatchBoost} from '/batch-boost.mjs';document.querySelector('#open').onclick=()=>openBatchBoost({notify:message=>document.querySelector('#notice').textContent=message});document.querySelector('#end').onclick=async()=>{await fetch('/preview-end',{method:'POST'});document.querySelector('#notice').textContent='所有模拟任务已结束，请重新打开批量窗口';};</script>`;
const server=http.createServer(async(req,res)=>{
 const send=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
 try{
  if(req.headers.host!==`127.0.0.1:${port}`)return send({error:{message:'Host denied'}},403);
  if(req.method==='POST'&&req.headers.origin!==origin)return send({error:{message:'Origin denied'}},403);
  const url=new URL(req.url,origin);let q={};if(req.method==='POST'){let text='';for await(const chunk of req){text+=chunk;if(text.length>1048576)return send({error:{message:'Too large'}},413);}q=JSON.parse(text||'{}');}
  if(url.pathname==='/lan-api/operator/status')return send({configured:true,authenticated:true,writeReady:true});
  if(url.pathname==='/lan-api/snapshot')return send({snapshot:{accountId:ACCOUNT_ID,from:url.searchParams.get('from')||today(),to:url.searchParams.get('to')||today(),complete:true,total:134,plans,fetchedAt:new Date().toISOString()},monitor:{}});
  if(url.pathname==='/lan-api/operation/batch-scan')return send(batch.scan(q,'preview'));
  if(url.pathname==='/lan-api/operation/batch-scan-status')return send(batch.scanStatus(url.searchParams.get('id'),'preview'));
  if(url.pathname==='/lan-api/operation/batch-prepare')return send(await batch.prepare(q,'preview'));
  if(url.pathname==='/lan-api/operation/batch-commit')return send(await batch.start(q,'preview'));
  if(url.pathname==='/lan-api/operation/batch-status')return send(batch.get(url.searchParams.get('id'),'preview'));
  if(url.pathname==='/lan-api/operation/batch-history')return send(batch.history('preview'));
  if(url.pathname==='/lan-api/operation/batch-cancel')return send(await batch.cancel(q.id,'preview'));
  if(url.pathname==='/lan-api/operation/batch-recheck')return send(await batch.recheck(q.id,q.planId,'preview'));
  if(url.pathname==='/preview-end'&&req.method==='POST'){for(const list of tasks.values())for(const task of list)task.state='ended';return send({synthetic:true});}
  if(url.pathname==='/preview-evidence')return send({synthetic:true,simulatedWrites,jobs:[...batch.jobs.values()].map(j=>batch.view(j))});
  if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
  if(!/^\/[a-z0-9-]+\.(mjs|css)$/.test(url.pathname))return send({error:{message:'Not found'}},404);
  const file=new URL(url.pathname.slice(1),root);const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':file.pathname.endsWith('.css')?'text/css':'text/javascript'});res.end(data);
 }catch(e){send({error:{message:e.message}},e.status||500);}
});
server.listen(port,'127.0.0.1',()=>console.log(`Synthetic preview only: ${origin}/`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit()));
