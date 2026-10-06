import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ACCOUNT_ID} from './api.mjs';
import {atomicJson} from './monitor.mjs';
import {BridgeError} from './bridge.mjs';
import {HOUR,readRoiHours} from './roi-hours.mjs';
export class RoiObservations {
 constructor({api,directory,clock=Date.now,read=readRoiHours,beforeRead=async()=>{},gapMs=1200}){Object.assign(this,{api,directory,clock,read,beforeRead,gapMs});this.records=new Map();this.pending=new Map();this.queue=Promise.resolve();this.error=null;this.saves=new Map();}
 async init(){
  await fs.mkdir(this.directory,{recursive:true});
  for(const file of await fs.readdir(this.directory)){if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;try{const r=JSON.parse(await fs.readFile(path.join(this.directory,file),'utf8'));if(r.accountId!==ACCOUNT_ID)continue;if(r.status==='pending'){r.status='unconfirmed';r.error='服务中断，修改结果未确认；未自动建立对比';await this.save(r);}this.records.set(r.id,r);}catch{this.error='部分ROI调整记录无法读取';}}
  // Reconcile interrupted observations after a crash between saving two edits.
  const latest=new Map();
  for(const r of [...this.records.values()].filter(r=>r.changedAt).sort((a,b)=>b.changedAt.localeCompare(a.changedAt))){const next=latest.get(r.planId);if(next&&Date.parse(r.expiresAt)>Date.parse(next.changedAt)&&(!r.stoppedAt||r.stoppedAt>next.changedAt)){r.stoppedAt=next.changedAt;r.status='interrupted';r.finalized=false;r.nextAt=0;await this.save(r);}latest.set(r.planId,r);}
  return this;
 }
 save(record){const snapshot=structuredClone(record),job=(this.saves.get(record.id)||Promise.resolve()).catch(()=>{}).then(()=>atomicJson(path.join(this.directory,record.id+'.json'),snapshot));this.saves.set(record.id,job);return job;}
 async reserve(action){
  if(action.action!=='roi'||!this.api.planCache.has(action.id)||!Number.isFinite(action.before)||!Number.isFinite(action.after)||action.before===action.after)throw new BridgeError('ROI调整记录无效','ROI_RECORD_INVALID',400);
  const r={id:randomUUID(),accountId:ACCOUNT_ID,planId:action.id,name:action.name,before:action.before,after:action.after,status:'pending',origin:'website',requestedAt:new Date(this.clock()).toISOString(),rows:[]};await this.save(r);this.records.set(r.id,r);return r.id;
 }
 async confirm(id){
  const r=this.records.get(id);if(!r||r.status!=='pending')throw new Error('ROI confirmation record missing');
  const now=this.clock();r.changedAt=new Date(now).toISOString();r.expiresAt=new Date(now+24*HOUR).toISOString();r.status='tracking';r.nextAt=now;await this.save(r);
  for(const old of this.records.values())if(old.id!==id&&old.planId===r.planId&&old.changedAt&&!old.finalized&&Date.parse(old.expiresAt)>now){old.status='interrupted';old.stoppedAt=r.changedAt;old.nextAt=now;await this.save(old);void this.enqueue(old.id);}
  void this.enqueue(id);return id;
 }
 async unconfirmed(id){const r=this.records.get(id);if(r){r.status='unconfirmed';r.error='平台结果未确认，未开始效果跟踪';await this.save(r);}}
 summary(r){const active=r.changedAt&&!r.stoppedAt&&this.clock()<Date.parse(r.expiresAt);return {id:r.id,planId:r.planId,name:r.name,before:r.before,after:r.after,changedAt:r.changedAt,expiresAt:r.expiresAt,status:active?'tracking':r.stoppedAt?'interrupted':'completed',active:Boolean(active),updatedAt:r.updatedAt,error:r.error};}
 index(){const records=[...this.records.values()].filter(r=>r.changedAt).sort((a,b)=>b.changedAt.localeCompare(a.changedAt)),byPlan={};for(const r of records)if(!byPlan[r.planId])byPlan[r.planId]=this.summary(r);return {byPlan,recentPlanIds:Object.values(byPlan).filter(r=>this.clock()-Date.parse(r.changedAt)<24*HOUR).map(r=>r.planId),error:this.error};}
 list(planId){return [...this.records.values()].filter(r=>r.changedAt&&(!planId||r.planId===planId)).sort((a,b)=>b.changedAt.localeCompare(a.changedAt)).map(r=>this.summary(r));}
 get(id){const r=this.records.get(id);if(!r?.changedAt)throw new BridgeError('未找到本网站的ROI调整记录','ROI_RECORD_NOT_FOUND',404);if(!r.finalized&&this.clock()>=Number(r.nextAt||0))void this.enqueue(id);return {...r,...this.summary(r),asOf:new Date(this.clock()).toISOString(),loading:this.pending.has(id)};}
 tick(){for(const r of this.records.values())if(r.changedAt&&!r.finalized&&this.clock()>=Number(r.nextAt||0))void this.enqueue(r.id);}
 enqueue(id){
  if(this.pending.has(id))return this.pending.get(id);
  const r=this.records.get(id);if(!r?.changedAt||r.finalized)return Promise.resolve();
  const job=this.queue.catch(()=>{}).then(()=>this.refresh(id)).catch(async()=>{this.error='ROI小时数据暂未保存，请检查本机存储';}).finally(()=>this.pending.delete(id));this.pending.set(id,job);this.queue=job;return job;
 }
 async refresh(id){
  const r=this.records.get(id);if(!r||r.finalized)return;
  const cutoff=Date.parse(r.stoppedAt||r.expiresAt),end=Math.min(this.clock(),cutoff),base=Math.floor(Date.parse(r.changedAt)/HOUR)*HOUR-24*HOUR;
  const from=r.fetchedTo?Math.max(base,Math.floor((Date.parse(r.fetchedTo)-2*HOUR)/HOUR)*HOUR):base;
  try{
   const data=await this.read(this.api,{accountId:ACCOUNT_ID,id:r.planId,from:new Date(from).toISOString(),to:new Date(end).toISOString()},{clock:this.clock,gapMs:this.gapMs,beforeRead:this.beforeRead});
   const map=new Map(r.rows.map(row=>[row.time,row]));for(const row of data.rows)map.set(row.time,row);
   r.rows=[...map.values()].filter(row=>row.time>=base&&row.time<Date.parse(r.stoppedAt||r.expiresAt)).sort((a,b)=>a.time-b.time);r.updatedAt=data.fetchedAt;r.fetchedTo=new Date(end).toISOString();r.error=null;
  }catch(e){r.error=e.message;}
  // A single final read is allowed to close the bounded observation; historical viewing never resumes polling.
  const effectiveCutoff=Date.parse(r.stoppedAt||r.expiresAt);
  if(effectiveCutoff!==cutoff){r.nextAt=this.clock();}
  else if(this.clock()>=cutoff){r.finalized=true;r.status=r.stoppedAt?'interrupted':'completed';}
  else r.nextAt=r.error?Math.min(cutoff,this.clock()+5*60000):Math.min(cutoff,(Math.floor(this.clock()/HOUR)+1)*HOUR+60000);
  await this.save(r);
 }
}
