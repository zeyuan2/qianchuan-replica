import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ACCOUNT_ID} from './api.mjs';
import {BridgeError} from './bridge.mjs';
import {atomicJson} from './monitor.mjs';
import {prepareOperation,commitOperation} from './operations.mjs';
import {buildTaskOperation} from './tasks.mjs';
import {BoostState,isGlobalFailure} from './boost-state.mjs';
import {loadBoostList} from './boost-list.mjs';
import {BoostListCache} from './boost-cache.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export class BatchBoost {
 constructor({api,directory,prepare=prepareOperation,commit=commitOperation,inspect,bulkInspect,isActorActive=()=>true,onComplete=()=>{},beforeRead=async()=>{},gapMs=1200,clock=Date.now}){
  Object.assign(this,{api,directory,prepareOne:prepare,commitOne:commit,isActorActive,onComplete,gapMs,clock});
  const state=new BoostState({api,clock,gapMs,beforeRead});this.inspect=inspect||((id,options)=>state.inspect(id,options));
  this.bulkInspect=bulkInspect||(inspect?null:()=>loadBoostList(api,{clock,beforeRead,gapMs}));
  this.stateReader=state;this.listCache=new BoostListCache({clock,load:()=>this.bulkInspect()});
  this.previews=new Map();this.jobs=new Map();this.scans=new Map();this.running=null;this.scanning=null;this.makingPreview=false;this.historyError=null;
 }
 async init(){
  await fs.mkdir(this.directory,{recursive:true});
  for(const file of await fs.readdir(this.directory)){
   if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;
   let j;try{j=JSON.parse(await fs.readFile(path.join(this.directory,file),'utf8'));if(!Array.isArray(j.items))throw new Error('Invalid batch');}catch{this.historyError='本机批次记录无法读取，暂时停止批量操作，请先修复记录';continue;}if(j.accountId!==ACCOUNT_ID)continue;
   if(j.status==='running'){j.status='interrupted';for(const i of j.items)if(i.status==='submitting')i.status='uncertain';else if(['pending','checking'].includes(i.status))i.status='skipped';j.message='服务重启中断了批次，未自动重发。请核实异常项后单独补做。';await this.persist(j);}
   this.jobs.set(j.id,j);
  }return this;
 }
 requireHistory(){if(this.historyError)throw new BridgeError(this.historyError,'BATCH_HISTORY_INVALID',409);}
 invalidatePlan(id){
  this.listCache.invalidate();this.stateReader.cache.delete(id);
  for(const scan of this.scans.values())scan.rows=scan.rows.map(r=>r.id===id?{...r,state:'unknown',reason:'计划操作后需要重新核实'}:r);
 }
 stamp(){return new Date(this.clock()).toISOString();}
 persist(job){return atomicJson(path.join(this.directory,job.id+'.json'),job);}
 view(job){return {id:job.id,accountId:ACCOUNT_ID,status:job.status,message:job.message,createdAt:job.createdAt,finishedAt:job.finishedAt,cancelRequested:Boolean(job.cancelRequested),items:job.items.map(({id,name,budget,duration,status,error,verification,retryJobId})=>({id,name,budget,duration,status,error,verification,retryJobId})),totalBudget:job.totalBudget};}
 get(id,actor){const job=this.jobs.get(id);if(!job||job.actor!==actor)throw new BridgeError('找不到当前登录会话的批次','BATCH_NOT_FOUND',404);return this.view(job);}
 history(actor){return {error:this.historyError,batches:[...this.jobs.values()].filter(j=>j.actor===actor).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50).map(j=>({id:j.id,status:j.status,createdAt:j.createdAt,total:j.items.length,success:j.items.filter(i=>i.status==='success').length,unresolved:j.items.filter(i=>['failed','uncertain','skipped'].includes(i.status)&&!this.hasSuccessor(j,i)).length}))};}
 hasSuccessor(job,item){return [...this.jobs.values()].some(child=>child.retryOf===job.id&&child.items.some(i=>i.id===item.id));}
 validateIds(ids){if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^\d{10,25}$/.test(id)||!this.api.planCache.has(id)))throw new BridgeError('请选择当前账户内的不重复计划','INVALID_BATCH',400);}
 matches(item,result){return item.requestName?result.tasks.filter(t=>t.name===item.requestName&&t.budget===item.budget&&t.duration===item.duration):[];}
 async eligibility(id,{force=false,ignoreJob,ignoreRetryOf}={}){
  this.requireHistory();
  const related=[...this.jobs.values()].flatMap(j=>[ignoreJob,ignoreRetryOf].includes(j.id)?[]:j.items.filter(i=>i.id===id&&!this.hasSuccessor(j,i)&&(['success','uncertain','submitting','failed'].includes(i.status)||(j.status==='running'&&['pending','checking'].includes(i.status)))).map(i=>({j,i})));
  const since=related.map(({j})=>j.createdAt).sort()[0];
  const result=await this.inspect(id,{force,since});
  if(!result.complete||!Array.isArray(result.tasks))throw new BridgeError('起量任务查询未完成','BOOST_STATUS_UNKNOWN',409);
  if(result.state!=='eligible')return result;
  for(const {j,i} of related){
   if(this.matches(i,result).some(t=>t.state==='ended'))continue;
   // Older batches have no correlation name; do not silently release uncertain writes.
   if(i.status==='success'&&!i.requestName&&result.tasks.some(t=>t.state==='ended'&&Date.parse(t.startAt)>=Date.parse(j.createdAt)-60000))continue;
   return {...result,state:'unknown',reason:'该计划有本机已提交或未核实的起量记录，请先查看最近批次核实。'};
  }return result;
 }
 scan(q,actor){
  this.requireHistory();
  if(q.accountId!==ACCOUNT_ID)throw new BridgeError('账户不匹配','ACCOUNT_MISMATCH',400);this.validateIds(q.ids);
  if(this.running)throw new BridgeError('批次正在执行，请结束后再核实计划','BATCH_BUSY',409);
  if(this.scanning){const current=this.scans.get(this.scanning);if(current.actor===actor&&JSON.stringify(current.ids)===JSON.stringify(q.ids))return this.scanView(current);throw new BridgeError('正在逐条核实起量状态，请稍后重试','BOOST_SCAN_BUSY',409);}
  for(const [id,s] of this.scans)if(this.clock()-s.at>1800000)this.scans.delete(id);
  const scan={id:randomUUID(),actor,ids:q.ids,rows:[],state:'running',phase:'list',fastCount:0,detailCount:0,at:this.clock()};this.scans.set(scan.id,scan);this.scanning=scan.id;
  void(async()=>{try{
   let list=null;if(this.bulkInspect)try{list=await this.listCache.get();scan.listRequests=list.requests;scan.cacheHit=list.cacheHit;scan.cacheAgeSeconds=list.cacheAgeSeconds;}catch(e){if(isGlobalFailure(e))throw e;scan.listWarning='列表状态暂不可用，已回退逐条核实';}
   scan.phase='details';
   const pending=[];
   for(const id of scan.ids){if(!this.isActorActive(actor)){scan.error='操作登录已失效';break;}
    const candidate=list?.rows.get(id);
    const hold=[...this.jobs.values()].some(j=>j.items.some(i=>i.id===id&&!this.hasSuccessor(j,i)&&(['uncertain','failed','submitting'].includes(i.status)||j.status==='running'||i.status==='success'&&this.clock()-Date.parse(i.submittedAt||j.createdAt)<120000)));
    if(candidate&&(candidate.state==='active'||candidate.state==='eligible'&&!hold)){scan.rows.push(candidate);scan.fastCount++;continue;}
    pending.push({id,candidate});
   }
   for(const {id,candidate} of pending){
    if(scan.error)break;
    if(scan.cancelRequested||this.running){scan.paused=true;break;}
    if(!this.isActorActive(actor)){scan.error='操作登录已失效';break;}
    scan.detailCount++;
    try{const result=await this.eligibility(id,{force:false});scan.rows.push({...result,source:'task-detail',listEvidence:candidate?.listEvidence});}
    catch(e){scan.rows.push({id,state:'unknown',reason:e.message});if(isGlobalFailure(e)){scan.error=e.message;break;}}
   }if(scan.error){this.listCache.invalidate();this.stateReader.cache.clear();}scan.state=scan.error?'stopped':scan.paused?'paused':'completed';
  }catch(e){this.listCache.invalidate();scan.state='stopped';scan.error=e.message||'核实中断，请重新查询';}finally{this.scanning=null;}})();
  return this.scanView(scan);
 }
 scanView(s){return {id:s.id,state:s.state,phase:s.phase,done:s.rows.length,total:s.ids.length,fastCount:s.fastCount,detailCount:s.detailCount,listRequests:s.listRequests,cacheHit:s.cacheHit,cacheAgeSeconds:s.cacheAgeSeconds,listWarning:s.listWarning,rows:s.rows.map(({tasks,...r})=>({...r,taskCount:r.taskCount??tasks?.length??0})),error:s.error};}
 scanStatus(id,actor){const s=this.scans.get(id);if(!s||s.actor!==actor)throw new BridgeError('状态核实记录已过期，请重新查询','BOOST_SCAN_MISSING',404);return this.scanView(s);}
 async prepare(q,actor){
  this.requireHistory();
  if(this.makingPreview||this.running)throw new BridgeError('请等待当前批次结束','BATCH_BUSY',409);
  this.makingPreview=true;try{return await this.makePreview(q,actor);}finally{this.makingPreview=false;}
 }
 async makePreview(q,actor){
  if(q.accountId!==ACCOUNT_ID)throw new BridgeError('账户不匹配','ACCOUNT_MISMATCH',400);this.validateIds(q.ids);
  if(!this.api.allowWrites||!this.isActorActive(actor))throw new BridgeError('操作登录或连接已失效','OPERATOR_LOGIN_REQUIRED',401);
  let retryOf=null;
  if(q.retryOf){
   if(q.ids.length!==1)throw new BridgeError('异常项只能单条补做','INVALID_BATCH',400);
   this.get(q.retryOf,actor);const j=this.jobs.get(q.retryOf),i=j.items.find(i=>i.id===q.ids[0]);
   if(j.status==='running'||!i||i.status==='success'||i.retryJobId||[...this.jobs.values()].some(c=>c.retryOf===j.id&&c.items.some(x=>x.id===i.id)))throw new BridgeError('此计划不能重复补做','RETRY_DENIED',409);
   const checked=await this.recheck(j.id,i.id,actor),row=checked.items.find(x=>x.id===i.id);
   if(row.status==='success'||!row.verification?.canRetry)throw new BridgeError('平台存在任务或状态不明确，不能补做','RETRY_DENIED',409);
   if(i.status==='uncertain'&&q.verifiedNotCreated!==true)throw new BridgeError('请先在千川原页核实未创建，并勾选确认','MANUAL_VERIFICATION_REQUIRED',409);
   retryOf=j.id;
  }else{
   const scan=this.scans.get(q.scanId);
   if(!scan||scan.actor!==actor||scan.error||!['running','completed','paused'].includes(scan.state)||scan.phase==='list'||q.ids.some(id=>!scan.rows.some(r=>r.id===id&&r.state==='eligible')))throw new BridgeError('请选择已经核实可起量的计划','BOOST_SCAN_REQUIRED',409);
  }
  const token=randomUUID(),input={kind:'boost',budget:q.budget,duration:q.duration,name:q.namePrefix||'批量起量'};
  const items=q.ids.map(id=>{const plan=this.api.planCache.get(id),requestName=`${input.name}_${token.slice(0,8)}_${id}`,operation=buildTaskOperation(plan.raw||{id,marGoal:1,budget:plan.budget*100000},{...input,name:requestName});return {id,name:plan.name,requestName,budget:Number(input.budget),duration:Number(input.duration),description:operation.description,status:'ready'};});
  for(const [k,v]of this.previews)if(v.expiresAt<this.clock())this.previews.delete(k);
  const preview={token,expiresAt:this.clock()+300000,actor,items,retryOf,totalBudget:items.reduce((n,i)=>n+Math.round(i.budget*100),0)/100};this.previews.set(token,preview);
  return {...preview,actor:undefined,canSubmit:true,items:items.map(({requestName,...i})=>i)};
 }
 async start(q,actor){
  this.requireHistory();
  if(q.accountId!==ACCOUNT_ID||q.confirmed!==true)throw new BridgeError('请确认批量任务','CONFIRMATION_REQUIRED',400);
  if(this.jobs.has(q.token))return this.get(q.token,actor);
  if(this.running||this.makingPreview)throw new BridgeError('已有批次正在执行','BATCH_BUSY',409);
  const p=this.previews.get(q.token);if(!p||p.actor!==actor||p.expiresAt<this.clock())throw new BridgeError('批量确认已过期，请重新核对','CONFIRMATION_EXPIRED',409);
  if(!this.api.allowWrites||!this.isActorActive(actor))throw new BridgeError('操作登录或连接已失效','OPERATOR_LOGIN_REQUIRED',401);
  const prior=p.retryOf?this.jobs.get(p.retryOf):null,priorItem=prior?.items.find(i=>i.id===p.items[0].id);
  if(prior&&(prior.status==='running'||priorItem.status==='success'||priorItem.retryJobId||[...this.jobs.values()].some(c=>c.retryOf===prior.id&&c.items.some(x=>x.id===priorItem.id))))throw new BridgeError('补做已执行或原任务已确认成功','RETRY_DENIED',409);
  const job={id:p.token,accountId:ACCOUNT_ID,actor,status:'running',createdAt:this.stamp(),items:p.items.map(({description,...i})=>({...i,status:'pending'})),retryOf:p.retryOf,totalBudget:p.totalBudget};
  this.running=job.id;this.jobs.set(job.id,job);for(const s of this.scans.values())if(s.state==='running')s.cancelRequested=true;
  try{await this.persist(job);if(priorItem){priorItem.retryJobId=job.id;await this.persist(prior);}}catch(e){this.running=null;job.status='interrupted';await this.persist(job).catch(()=>{});throw e;}
  this.previews.delete(q.token);
  void this.execute(job).catch(async()=>{job.status='interrupted';job.message='批次中断，请核实异常项后单独补做';for(const i of job.items)if(i.status==='submitting')i.status='uncertain';else if(['pending','checking'].includes(i.status))i.status='skipped';await this.persist(job).catch(()=>{});}).finally(()=>{this.running=null;});return this.view(job);
 }
 async execute(job){
  for(let n=0;n<job.items.length;n++){
   const item=job.items[n];if(job.cancelRequested||!this.isActorActive(job.actor)||!this.api.allowWrites){job.message='已停止后续提交；请检查登录、连接或停止请求';break;}
   item.status='checking';await this.persist(job);let token;
   try{
    // Each item is refreshed immediately before its write, so large batches cannot expire old child confirmations.
    const state=await this.eligibility(item.id,{force:true,ignoreJob:job.id,ignoreRetryOf:job.retryOf});
    const previous=job.retryOf?this.jobs.get(job.retryOf)?.items.find(i=>i.id===item.id):null;
    let eligible=state.state==='eligible';
    if(previous){
     const raw=await this.inspect(item.id,{force:true,since:this.jobs.get(job.retryOf).createdAt});
     eligible=eligible&&raw.complete&&raw.state==='eligible'&&this.matches(previous,raw).length===0;
    }
    if(!eligible)throw new BridgeError(state.state==='active'?'计划仍有未结束的起量任务':'起量状态不明，请先核实','BOOST_NOT_ELIGIBLE',409);
    const p=await this.prepareOne(this.api,{accountId:ACCOUNT_ID,id:item.id,action:'task',value:{kind:'boost',name:item.requestName,budget:item.budget,duration:item.duration}},job.actor);token=p.token;
    if(job.cancelRequested||!this.isActorActive(job.actor))break;
    this.invalidatePlan(item.id);item.status='submitting';item.submittedAt=this.stamp();await this.persist(job);
    await this.commitOne(this.api,{accountId:ACCOUNT_ID,planId:item.id,token,confirmed:true},job.actor);
    const result=await this.inspect(item.id,{force:true,since:job.createdAt}),matches=this.matches(item,result);
    if(!result.complete||matches.length!==1)throw Object.assign(new BridgeError('提交已返回，但平台任务尚未核实；不自动重发','OPERATION_UNCERTAIN',502),{writeAttempted:true});
    item.status='success';item.taskId=matches[0].id;item.error=null;
   }catch(e){
    item.status=item.status==='submitting'&&(e.writeAttempted!==false)?'uncertain':'failed';item.error=e.message;item.code=e.code;
    if(isGlobalFailure(e)){job.message='登录、连接、账户或限流异常，已暂停后续提交：'+e.message;await this.persist(job);break;}
    if(item.status==='uncertain'){
     try{const result=await this.inspect(item.id,{force:true,since:job.createdAt}),matches=this.matches(item,result);if(result.complete&&matches.length===1){item.status='success';item.taskId=matches[0].id;item.error=null;}}catch(check){if(isGlobalFailure(check)){job.message='核实结果时连接异常，已暂停后续提交';await this.persist(job);break;}}
    }
   }finally{if(token)this.api.confirmations?.delete(token);if(item.submittedAt){this.invalidatePlan(item.id);for(const s of this.scans.values())s.rows=s.rows.map(r=>r.id===item.id?{...r,state:item.status==='success'?'active':'unknown',reason:item.status==='success'?'刚创建起量任务':'提交结果需要核实'}:r);}}
   await this.persist(job);if(n<job.items.length-1&&this.gapMs)await wait(this.gapMs);
  }
  for(const i of job.items)if(['pending','checking'].includes(i.status))i.status='skipped';
  job.status=job.items.every(i=>i.status==='success')?'completed':job.cancelRequested?'cancelled':job.items.some(i=>i.status==='skipped')?'stopped':'partial';
  job.finishedAt=this.stamp();job.message||='本批已处理。异常项请核实后单独补做，成功项不会重复提交。';await this.persist(job);
  if(job.items.some(i=>i.status==='success'))try{await this.onComplete();}catch{}
 }
 async recheck(id,planId,actor){
  this.requireHistory();
  this.get(id,actor);const job=this.jobs.get(id),item=job.items.find(i=>i.id===planId);
  if(this.running||this.scanning||!item)throw new BridgeError('请在当前批次结束后核实异常项','BATCH_BUSY',409);
  const result=await this.inspect(planId,{force:true,since:job.createdAt}),matches=this.matches(item,result);
  if(!result.complete)throw new BridgeError('任务列表不完整，暂不能补做','BOOST_STATUS_UNKNOWN',409);
  if(matches.length>=1){item.status='success';item.error=null;item.taskId=matches[0].id;item.verification={checkedAt:result.checkedAt,canRetry:false,message:'已找到本次起量任务，不重复补做'};}
  else item.verification={checkedAt:result.checkedAt,canRetry:result.state==='eligible'&&item.status!=='success'&&!item.retryJobId,message:result.state==='eligible'?'完整查询未找到本次任务；未确认项仍需在原页人工核实未创建':'存在未结束的任务或状态不明确，不能补做'};
  await this.persist(job);return this.view(job);
 }
 async cancel(id,actor){this.get(id,actor);const job=this.jobs.get(id);if(job.status==='running'){job.cancelRequested=true;await this.persist(job);}return this.view(job);}
}
