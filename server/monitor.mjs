import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ACCOUNT_ID,today} from './api.mjs';
import {collectFullSnapshot} from './full-capture.mjs';

export const COLLECTION_INTERVAL_MS=300000;
export async function atomicJson(filename,value){
 await fs.mkdir(path.dirname(filename),{recursive:true});const tmp=filename+'.'+randomUUID()+'.tmp';
 try{await fs.writeFile(tmp,JSON.stringify(value),'utf8');await fs.rename(tmp,filename);}catch(e){await fs.unlink(tmp).catch(()=>{});throw e;}
}

export class ProductMonitor {
 constructor({api,directory,seedFile,collect=collectFullSnapshot,clock=Date.now,timers=globalThis,interval=COLLECTION_INTERVAL_MS,onSnapshot=async()=>{}}){
  Object.assign(this,{api,directory,seedFile,collect,clock,timers,interval,onSnapshot});this.packet=null;this.running=null;this.stopped=true;this.timer=null;this.attempts=[];this.status={phase:'waiting',lastAttemptAt:null,lastSuccessAt:null,nextCaptureAt:null,error:null,progress:null};
 }
 async init(){
  try{const saved=JSON.parse(await fs.readFile(path.join(this.directory,'latest.json'),'utf8'));if(saved.accountId!==ACCOUNT_ID||!saved.snapshot?.complete)throw new Error('Invalid saved account');this.packet=saved;this.status.lastSuccessAt=saved.snapshot.fetchedAt;}catch(e){if(e.code!=='ENOENT')this.status.error={code:'SAVED_DATA_ERROR',message:'上次数据文件无法使用，将重新完整采集'};}
  if(!this.packet&&this.seedFile){try{const seed=JSON.parse(await fs.readFile(this.seedFile,'utf8'));if(seed.accountId===ACCOUNT_ID){seed.complete=false;seed.source='recorded';seed.total=seed.originalTotal??seed.total;this.packet={accountId:ACCOUNT_ID,snapshot:seed,seen:{},events:[],baselineEstablished:false};}}catch{}}
  for(const p of this.packet?.snapshot?.plans||[])this.api.planCache.set(p.id,p);
  return this;
 }
 view(){const snapshot=this.packet?.snapshot;return {accountId:ACCOUNT_ID,snapshot:snapshot?{...snapshot,newPlanEvents:(this.packet.events||[]).filter(e=>this.clock()-Date.parse(e.detectedAt)<86400000)}:null,monitor:{...this.status,intervalMs:this.interval,running:Boolean(this.running),bridgeConnected:this.api.bridge.status().connected,complete:Boolean(snapshot?.complete),collected:snapshot?.plans.length||0,total:snapshot?.total??null,attempts:this.attempts.slice(-12)}};}
 schedule(delay){this.timers.clearTimeout(this.timer);if(!this.stopped)this.timer=this.timers.setTimeout(()=>{void this.run();},delay);}
 start(){if(!this.stopped)return;this.stopped=false;const last=Date.parse(this.packet?.snapshot?.complete?this.packet.snapshot.startedAt||this.packet.snapshot.fetchedAt:'');const delay=Number.isFinite(last)?Math.max(0,last+this.interval-this.clock()):0;if(delay){this.status.phase='ready';this.status.nextCaptureAt=new Date(this.clock()+delay).toISOString();}this.schedule(delay);}
 stop(){this.stopped=true;this.timers.clearTimeout(this.timer);}
 bridgeAvailable(){if(!this.stopped&&!this.running&&this.status.phase==='waiting'){this.schedule(0);}}
 run(){if(this.running)return this.running;if(this.stopped)return Promise.resolve(this.view());this.running=this.perform();return this.running;}
 async perform(){
  const begin=this.clock(),attempt={startedAt:new Date(begin).toISOString(),day:today(new Date(begin))};
  this.status.lastAttemptAt=attempt.startedAt;this.status.nextCaptureAt=new Date(begin+this.interval).toISOString();
  try{
   if(!this.api.bridge.status().connected){this.status.phase='waiting';this.status.error={code:'BRIDGE_OFFLINE',message:'采集连接未接通，请在采集电脑保持Chrome登录并连接只读扩展'};attempt.outcome='waiting';return this.view();}
   this.status.phase='collecting'; // Keep the last failure until a complete capture actually succeeds.
   const snapshot=await this.collect(this.api,{day:attempt.day,onProgress:p=>this.status.progress=p});
   if(!snapshot.complete||snapshot.accountId!==ACCOUNT_ID||snapshot.plans.length!==snapshot.total||new Set(snapshot.plans.map(p=>p.id)).size!==snapshot.total)throw Object.assign(new Error('采集结果未完整，拒绝覆盖上次数据'),{code:'INCOMPLETE_CAPTURE'});
   const established=Boolean(this.packet?.baselineEstablished),seen={...(this.packet?.seen||{})},events=[...(this.packet?.events||[])];
   const since=Date.parse(this.packet?.snapshot?.startedAt||this.packet?.snapshot?.fetchedAt||snapshot.startedAt);
   for(const plan of snapshot.plans){if(!Object.hasOwn(seen,plan.id)){
    seen[plan.id]={firstSeenAt:snapshot.fetchedAt,createdAt:Number(plan.raw?.createTime)||null};
    if(established){const createdMs=Number(plan.raw?.createTime)*1000;events.push({id:plan.id,name:plan.name,detectedAt:snapshot.fetchedAt,createdAt:Number.isFinite(createdMs)?new Date(createdMs).toISOString():null,kind:createdMs>=Math.floor(since/1000)*1000?'created':'discovered'});}
   }}
   const packet={version:1,accountId:ACCOUNT_ID,baselineEstablished:true,snapshot,seen,events};
   await atomicJson(path.join(this.directory,'latest.json'),packet);
   this.packet=packet;this.status.lastSuccessAt=snapshot.fetchedAt;this.status.phase='ready';this.status.error=null;
   await atomicJson(path.join(this.directory,'daily',snapshot.from+'.json'),{accountId:ACCOUNT_ID,snapshot,events}).catch(e=>{this.status.error={code:'ARCHIVE_ERROR',message:'实时数据已保存，但当日备份写入失败：'+e.message};});
   attempt.outcome='success';attempt.total=snapshot.total;attempt.requests=snapshot.capture?.requests;attempt.newIds=events.filter(e=>e.detectedAt===snapshot.fetchedAt).map(e=>e.id);
   void Promise.resolve().then(()=>this.onSnapshot(snapshot)).then(()=>{this.status.alertError=null;}).catch(()=>{this.status.alertError='预算提醒处理失败，数据采集继续运行，请查看通知设置';});
  }catch(error){this.status.phase='error';this.status.error={code:error.code||'CAPTURE_FAILED',message:error.message};attempt.outcome='failed';attempt.error=error.code||'CAPTURE_FAILED';}
  finally{
   attempt.finishedAt=new Date(this.clock()).toISOString();this.attempts.push(attempt);if(this.attempts.length>100)this.attempts.shift();
   await fs.mkdir(this.directory,{recursive:true}).catch(()=>{});await fs.appendFile(path.join(this.directory,'cycles.jsonl'),JSON.stringify(attempt)+'\n').catch(()=>{});
   const next=begin+Math.max(1,Math.ceil((this.clock()-begin+1)/this.interval))*this.interval;
   this.status.nextCaptureAt=new Date(next).toISOString();this.status.progress=null;this.running=null;this.schedule(Math.max(1000,next-this.clock()));
  }
  return this.view();
 }
 async forDate(day){
  if(!day||day===this.packet?.snapshot?.from)return this.view();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Object.assign(new Error('日期无效'),{status:400});
  try{const saved=JSON.parse(await fs.readFile(path.join(this.directory,'daily',day+'.json'),'utf8'));if(saved.accountId!==ACCOUNT_ID||!saved.snapshot?.complete)throw new Error('Invalid archive');return {...this.view(),snapshot:{...saved.snapshot,newPlanEvents:saved.events||[]},historical:true};}
  catch{throw Object.assign(new Error('该日期尚无完整采集记录'),{status:404,code:'DATE_NOT_CAPTURED'});}
 }
}
