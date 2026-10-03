import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ACCOUNT_ID} from './api.mjs';
import {BridgeError} from './bridge.mjs';
import {atomicJson} from './monitor.mjs';
import {prepareOperation,commitOperation} from './operations.mjs';
import {buildTaskOperation} from './tasks.mjs';
export const MAX_BATCH_PLANS=20;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export class BatchBoost {
 constructor({api,directory,prepare=prepareOperation,commit=commitOperation,isActorActive=()=>true,onComplete=()=>{},gapMs=1200}){Object.assign(this,{api,directory,prepareOne:prepare,commitOne:commit,isActorActive,onComplete,gapMs});this.previews=new Map();this.jobs=new Map();this.running=null;}
 async init(){await fs.mkdir(this.directory,{recursive:true});for(const file of await fs.readdir(this.directory)){if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;try{const j=JSON.parse(await fs.readFile(path.join(this.directory,file),'utf8'));if(j.accountId!==ACCOUNT_ID)continue;if(j.status==='running'){j.status='interrupted';for(const i of j.items)if(i.status==='submitting')i.status='uncertain';else if(i.status==='pending')i.status='skipped';j.message='服务重启中断了批次，未自动重发。请核查原页和日志。';await this.persist(j);}this.jobs.set(j.id,j);}catch{}}return this;}
 persist(job){return atomicJson(path.join(this.directory,job.id+'.json'),job);}
 view(job){return {id:job.id,accountId:job.accountId,status:job.status,message:job.message,createdAt:job.createdAt,finishedAt:job.finishedAt,cancelRequested:Boolean(job.cancelRequested),items:job.items.map(({id,name,budget,duration,status,error})=>({id,name,budget,duration,status,error})),totalBudget:job.totalBudget};}
 get(id,actor){const job=this.jobs.get(id);if(!job||job.actor!==actor)throw new BridgeError('找不到当前登录会话的批次','BATCH_NOT_FOUND',404);return this.view(job);}
 async prepare(q,actor){
  if(q.accountId!==ACCOUNT_ID)throw new BridgeError('账户不匹配','ACCOUNT_MISMATCH',400);
  const ids=q.ids;if(!Array.isArray(ids)||!ids.length||ids.length>MAX_BATCH_PLANS||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^\d{10,25}$/.test(id)||!this.api.planCache.has(id)))throw new BridgeError('请选择1至20条当前账户内的不重复计划','INVALID_BATCH',400);
  const input={kind:'boost',budget:q.budget,duration:q.duration,name:q.namePrefix||'批量起量'};
  for(const id of ids){const p=this.api.planCache.get(id);buildTaskOperation(p.raw||{id,marGoal:1,budget:p.budget*100000},input);}
  const items=[];for(const id of ids){try{const value={...input,name:input.name+'_'+id};const result=await this.prepareOne(this.api,{accountId:ACCOUNT_ID,id,action:'task',value},actor);items.push({id,name:result.name,budget:Number(q.budget),duration:Number(q.duration),description:result.description,token:result.token,status:'ready'});}catch(e){items.push({id,name:this.api.planCache.get(id)?.name||id,status:'invalid',error:e.message});}}
  if(items.some(i=>i.status==='invalid')){for(const i of items)this.api.confirmations?.delete(i.token);return {canSubmit:false,items:items.map(({token,...i})=>i)};}
  const token=randomUUID(),expiresAt=Date.now()+300000;for(const i of items){const confirmation=this.api.confirmations?.get(i.token);if(confirmation)confirmation.expiresAt=expiresAt;}
  for(const[k,v]of this.previews)if(v.expiresAt<Date.now())this.previews.delete(k);
  const preview={token,expiresAt,actor,items,totalBudget:Math.round(Number(q.budget)*100)*ids.length/100};this.previews.set(token,preview);
  return {token,expiresAt,canSubmit:this.api.allowWrites,totalBudget:preview.totalBudget,items:items.map(({token,...i})=>i)};
 }
 async start(q,actor){
  if(q.accountId!==ACCOUNT_ID||q.confirmed!==true)throw new BridgeError('请确认批量任务','CONFIRMATION_REQUIRED',400);
  if(this.jobs.has(q.token))return this.get(q.token,actor);
  if(this.running)throw new BridgeError('已有批次正在执行，请等待完成','BATCH_BUSY',409);
  const p=this.previews.get(q.token);if(!p||p.actor!==actor||p.expiresAt<Date.now())throw new BridgeError('批量确认已过期，请重新核对','CONFIRMATION_EXPIRED',409);
  if(!this.api.allowWrites||!this.isActorActive(actor))throw new BridgeError('操作登录或连接已失效，请重新检查','OPERATOR_LOGIN_REQUIRED',401);
  const job={id:p.token,accountId:ACCOUNT_ID,actor,status:'running',createdAt:new Date().toISOString(),items:p.items.map(({token,description,...i})=>({...i,status:'pending'})),totalBudget:p.totalBudget};
  this.running=job.id;this.jobs.set(job.id,job);
  try{await this.persist(job);}catch(e){this.jobs.delete(job.id);this.running=null;throw e;}
  this.previews.delete(q.token);void this.execute(job,p).catch(async()=>{job.status='interrupted';job.message='批次中断，请核查已提交计划，未自动重发';for(const i of job.items)if(i.status==='submitting')i.status='uncertain';else if(i.status==='pending')i.status='skipped';await this.persist(job).catch(()=>{});}).finally(()=>{this.running=null;});return this.view(job);
 }
 async execute(job,preview){
  for(let n=0;n<job.items.length;n++){
   const item=job.items[n];if(job.cancelRequested||!this.isActorActive(job.actor)){job.message=job.cancelRequested?'已停止后续提交，已提交任务不撤销':'登录已退出，停止后续提交';break;}
   item.status='submitting';await this.persist(job);
   try{await this.commitOne(this.api,{accountId:ACCOUNT_ID,planId:item.id,token:preview.items[n].token,confirmed:true},job.actor);item.status='success';}
   catch(e){item.status=e.code==='OPERATION_UNCERTAIN'?'uncertain':'failed';item.error=e.message;job.message='遇到失败或未确认结果，已停止后续计划，请核查后再操作';await this.persist(job);break;}
   await this.persist(job);if(n<job.items.length-1&&this.gapMs)await wait(this.gapMs);
  }
  for(const i of job.items)if(i.status==='pending')i.status='skipped';
  for(const i of preview.items)this.api.confirmations?.delete(i.token);
  job.status=job.items.every(i=>i.status==='success')?'completed':job.cancelRequested?'cancelled':'stopped';job.finishedAt=new Date().toISOString();await this.persist(job);if(job.items.some(i=>i.status==='success'))try{await this.onComplete();}catch{}
 }
 async cancel(id,actor){this.get(id,actor);const job=this.jobs.get(id);if(job.status==='running'){job.cancelRequested=true;await this.persist(job);}return this.view(job);}
}
