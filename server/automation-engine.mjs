import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './monitor.mjs';
import {RULES,DAY,HOUR,localDay,dayStart,validateEnrollment,decide,confirmedChange,evaluateWindows,windowTotals} from './automation-policy.mjs';
import {comparisonWindows} from './automation-windows.mjs';
import {approvalDayEvidence} from './automation-history.mjs';
export const SLOT_GRACE_MS=5*60000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const minimal=p=>({id:p.id,accountId:p.accountId,roi:p.roi,budget:p.budget});
const error=code=>Object.assign(Error(code),{code});
export class AutomationEngine {
 constructor({accountId,allowedIds,directory,reader,gate,notifier,isBusy=()=>false,onWrite=()=>{},clock=Date.now,timers=globalThis,gapMs=1200}){
  Object.assign(this,{accountId,allowedIds:new Set(allowedIds),directory,reader,gate,notifier,isBusy,onWrite,clock,timers,gapMs});this.config={enabled:false};this.state={plans:{},applied:[],lastTick:null,pilotVerifiedAt:null};this.journal=new Map();this.running=null;this.started=false;this.captureRequested=false;this.lastCapture=0;this.pendingEvents=[];this.saves=Promise.resolve();
 }
 async init(){
  try{await fs.mkdir(path.join(this.directory,'journal'),{recursive:true});this.config=JSON.parse(await fs.readFile(path.join(this.directory,'config.json'),'utf8'));validateEnrollment(this.config);if(this.config.accountId!==this.accountId||this.config.planIds.some(id=>!this.allowedIds.has(id)))throw error('ENROLLMENT_SCOPE_MISMATCH');
   try{this.state=JSON.parse(await fs.readFile(path.join(this.directory,'state.json'),'utf8'));if(this.state.accountId!==this.accountId||!this.state.plans||!Array.isArray(this.state.applied))throw error('AUTOMATION_STATE_INVALID');}catch(e){if(e.code!=='ENOENT')throw e;}
   const recovered=[];for(const file of await fs.readdir(path.join(this.directory,'journal'))){if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;const j=JSON.parse(await fs.readFile(path.join(this.directory,'journal',file),'utf8'));if(j.accountId!==this.accountId||!this.config.planIds.includes(j.planId))throw error('JOURNAL_SCOPE_INVALID');recovered.push(j);}for(const j of recovered.sort((a,b)=>a.startedAt-b.startedAt)){this.journal.set(j.id,j);const s=this.planState(j.planId);if(['resolved','rejected','cancelled'].includes(j.status)&&s.pendingWrite===j.id){s.pendingWrite=null;s.uncertainWrite=null;if(this.state.pilotPendingTx===j.id)this.state.pilotPendingTx=null;}if(j.status==='confirmed')this.applyJournal(j);else if(j.status!=='rejected'&&j.status!=='cancelled'&&j.status!=='resolved'){if(!j.steps.some(v=>v.startedAt)){j.status='cancelled';await this.saveJournal(j);}else{s.pendingWrite=j.id;s.uncertainWrite=j.id;if(!this.state.pilotVerifiedAt)this.state.pilotPendingTx=j.id;}}}
   this.reader.windowMode=this.config.windowMode||'exact';this.state.accountId=this.accountId;await this.save();
  }catch(e){if(e.code!=='ENOENT'){this.startupError=e.code||'AUTOMATION_STORAGE_INVALID';}this.config.enabled=false;}
  return this;
 }
 planState(id){return this.state.plans[id]??=( {completedEvents:[],knownFacts:[],facts:[],goodSettings:[],budgetChanges:[]} );}
 save(){const value=structuredClone(this.state),job=this.saves.catch(()=>{}).then(()=>atomicJson(path.join(this.directory,'state.json'),value));this.saves=job;return job;}
 saveJournal(j){return atomicJson(path.join(this.directory,'journal',j.id+'.json'),j);}
 async interlocked(){const stop=await fs.stat(path.join(this.directory,'STOP')).then(()=>true,()=>false),maintenance=await fs.stat(path.join(this.directory,'..','watchdog.pause')).then(()=>true,()=>false);this.interlockReason=stop?'STOP':maintenance?'MAINTENANCE':null;return Boolean(this.interlockReason);}
 scope(id){if(!this.config.planIds?.includes(id)||!this.allowedIds.has(id)||this.config.accountId!==this.accountId)throw error('AUTOMATION_SCOPE_DENIED');}
 ingest(plan){
  const s=this.planState(plan.id),h=plan.history;if(!h?.verified){s.historyError=h?.issues?.join(',')||'HISTORY_NOT_VERIFIED';s.historyVerified=false;return;}
  s.historyError=null;s.historyVerified=true;
  for(const fact of h.facts){if(!s.knownFacts.includes(fact.key)){
   if(fact.field==='budget'&&!fact.initial){const own=[...this.journal.values()].some(j=>j.planId===plan.id&&j.steps.some(v=>v.field==='budget'&&v.status==='confirmed'&&v.changedAt===fact.at&&v.before===fact.before&&v.target===fact.after));if(!own)s.coldBudgetChain=null;}
   s.knownFacts.push(fact.key);s.facts.push({...fact,source:'platform-log'});
  }}
  if(s.pendingRoi&&(s.pendingRoi.beforeRoi!==plan.roi||s.pendingRoi.roiChangedAt!==h.lastRoiChangedAt)){
   s.deferredRoiHistory=[...(s.deferredRoiHistory||[]),{...s.pendingRoi,resolvedAt:this.clock(),resolution:'superseded_by_platform_roi',actualRoi:plan.roi}].slice(-100);s.pendingRoi=null;
  }
  if(s.lastRoiChangedAt!==h.lastRoiChangedAt){
   s.lastRoiChangedAt=h.lastRoiChangedAt;
   // Initial stable enrollment must accumulate evidence, not invent a past result.
   const start=s.lastSeen? h.lastRoiChangedAt : this.clock();
   s.observation=plan.roi>=RULES.stableRoi?{start,end:start+DAY,roiChangedAt:h.lastRoiChangedAt,roi:plan.roi,evaluation:null}:null;
  }
  if(plan.active&&plan.auditPassed&&!s.approvalWindow)s.approvalWindow=approvalDayEvidence(plan.createdAt,plan.readAt);
  if(plan.roi>=RULES.stableRoi)s.boostPermanentlyStopped=true;
  // Existing verified stop facts are permanent. Unknown historical chains block boosts.
  s.boostHistoryVerified=h.boostHistoryVerified||s.boostPermanentlyStopped===true;

  s.lastSeen={...minimal(plan),readAt:plan.readAt,basicSpend:plan.basicSpend,status:plan.status,deliveryCode:plan.deliveryCode,operationCode:plan.operationCode,permissions:plan.permissions,auditEvidence:plan.auditEvidence,stateReason:plan.reason,warning:plan.warning,createdAt:plan.createdAt};s.knownFacts=s.knownFacts.slice(-5000);s.facts=s.facts.slice(-5000);plan.approvalWindow=s.approvalWindow;
 }
 async evaluate(plan,s){
  const o=s.observation;if(plan.roi<RULES.stableRoi||!o||o.evaluation)return;
  const ranges=comparisonWindows(o,this.config.windowMode||'exact');o.ranges=ranges;
  if(this.clock()<ranges.after.end||o.lastAttemptAt&&this.clock()-o.lastAttemptAt<300000)return;o.lastAttemptAt=this.clock();
  try{
   const stable=(a,b)=>!s.facts.some(f=>f.field==='roi'&&!f.initial&&f.before!==f.after&&f.at>a&&f.at<b);
   const after=await this.reader.window(plan.id,ranges.after.start,ranges.after.end);after.settingsStable=stable(after.start,after.end);after.comparisonAnchor=o.start;
   if(!after.settingsStable)throw error('AUTOMATION_WINDOWS_NOT_COMPARABLE');
   const totals=windowTotals(after);s.windowEvidence={ranges,after,at:this.clock()};
   let evaluation;
   if(totals.roi<RULES.stableRoi)evaluation={decision:'rollback',reason:'ROI_BELOW_FLOOR',before:null,after:totals,score:null};
   else{
    s.goodSettings=[...(s.goodSettings||[]).filter(v=>v.at!==after.end),{at:after.end,roi:o.roi,actualRoi:totals.roi,complete:true}].slice(-200);
    try{
     const before=await this.reader.window(plan.id,ranges.before.start,ranges.before.end);before.settingsStable=stable(before.start,before.end);before.comparisonAnchor=o.start;s.windowEvidence.before=before;
     evaluation=evaluateWindows(before,after,this.clock());
    }catch(e){
     // A complete, stable, good after-window can become the next baseline;
     // never invent a comparison against missing/mixed pre-change data.
     s.evaluationError=e.code||e.message||'BASELINE_UNAVAILABLE';s.baselineEvents=[...(s.baselineEvents||[]),{at:this.clock(),reason:s.evaluationError,baselineStart:after.start,baselineEnd:after.end}].slice(-100);
     s.observation={start:after.end,end:after.end+DAY,roiChangedAt:o.roiChangedAt,roi:o.roi,evaluation:null};return;
    }
   }
   o.evaluation=evaluation;s.evaluationError=null;
   s.reviews=[...(s.reviews||[]),{start:o.start,end:ranges.after.end,roi:o.roi,ranges,evaluation}].slice(-100);
   if(evaluation.decision==='hold')s.observation={start:ranges.after.end,end:ranges.after.end+DAY,roiChangedAt:o.roiChangedAt,roi:o.roi,evaluation:null};
  }catch(e){s.evaluationError=e.code||e.message||'WINDOW_DATA_UNAVAILABLE';}
 }

 applyJournal(j){
  if(this.state.applied.includes(j.id))return;const s=this.planState(j.planId);
  if(j.action.kind!=='boost')Object.assign(s,confirmedChange(s,{before:j.before,after:j.after,at:j.changedAt,source:'automation',reason:j.action.reason,deferredRoiTarget:j.action.deferredRoiTarget,transactionId:j.id}));
  if(j.eventKey&&!s.completedEvents.includes(j.eventKey))s.completedEvents.push(j.eventKey);
  s.lastSeen={...s.lastSeen,...j.after,readAt:j.confirmedAt};s.pendingWrite=null;s.uncertainWrite=null;this.state.applied.push(j.id);this.state.pilotVerifiedAt??=j.confirmedAt;this.state.pilotPendingTx=null;
 }
 async verifyStep(j,step){
  if(step.field==='task'){
   const result=await this.reader.inspectBoost(j.planId,j.startedAt),matches=result.tasks.filter(t=>t.name===step.name&&t.budget===100&&t.duration===6&&Date.parse(t.startAt)>=j.startedAt-30000);
   if(result.complete&&matches.length===1){step.status='confirmed';step.confirmedAt=this.clock();step.taskId=matches[0].id;return true;}return false;
  }
  const plan=await this.reader.read(j.planId);if(plan[step.field]!==step.target)return false;
  const matches=plan.history?.verified?plan.history.facts.filter(f=>!f.initial&&f.field===step.field&&f.before===step.before&&f.after===step.target&&f.at>=step.startedAt-2000&&f.at<=Math.min(plan.readAt,step.startedAt+300000)):[];
  if(matches.length!==1)return false;const fact=matches[0];step.status='confirmed';step.changedAt=fact.at;step.confirmedAt=this.clock();return true;
 }
 async reconcile(j){
  for(const step of j.steps){if(step.status==='confirmed')continue;if(!step.startedAt)return false;try{if(!await this.verifyStep(j,step))return false;}catch{return false;}await this.saveJournal(j);}
  return this.finish(j);
 }
 async finish(j){
  if(j.action.kind==='boost')j.after=j.before;
  else{const p=await this.reader.read(j.planId);if(!p.history.verified||['roi','budget'].some(field=>p[field]!== (j.steps.find(v=>v.field===field)?.target??j.before[field])))return false;j.after=minimal(p);j.changedAt=j.steps.find(v=>v.field==='roi')?.changedAt||j.steps.at(-1).changedAt;}
  j.status='confirmed';j.confirmedAt=this.clock();await this.saveJournal(j);this.applyJournal(j);await this.save();await this.onWrite(j.planId);return true;
 }
 async execute(plan,action,eventKey,deadline){
  this.scope(plan.id);if(!this.config.enabled||!this.started||await this.interlocked())throw error('AUTOMATION_NOT_ENABLED');
  const steps=action.kind==='boost'?[{field:'task',target:100,name:`自动起量-${localDay(this.clock())}-${action.eventKey?.endsWith('boost-morning')?'05':'17'}-${plan.id.slice(-6)}`}]:['roi','budget'].filter(k=>action[k]!==undefined&&action[k]!==plan[k]).map(field=>({field,target:action[field],before:plan[field]}));
  if(!steps.length)return null;await this.reader.validate?.(plan,action);if(action.budget>RULES.maxBudget)throw error('BUDGET_CAP_REACHED');
  const j={id:randomUUID(),accountId:this.accountId,planId:plan.id,startedAt:this.clock(),status:'planned',action,before:minimal(plan),steps,eventKey,deadline};const s=this.planState(plan.id);await this.saveJournal(j);this.journal.set(j.id,j);s.pendingWrite=j.id;if(!this.state.pilotVerifiedAt)this.state.pilotPendingTx=j.id;await this.save();
  for(const step of j.steps){
   let prepared;
   try{
    if(!this.config.enabled||await this.interlocked()||deadline&&this.clock()>=deadline)throw error('SLOT_EXPIRED_OR_STOPPED');
    const current=await this.reader.read(plan.id);if(current.accountId!==this.accountId||current.id!==plan.id||!current.active||!current.auditPassed||!current.history.verified)throw error('LIVE_STATE_NOT_FRESH');
    for(const field of ['roi','budget']){const previous=j.steps.find(v=>v.field===field&&v.status==='confirmed');if(current[field]!==(previous?previous.target:j.before[field]))throw error('SETTING_CHANGED_BEFORE_WRITE');}
    if(step.field==='roi'&&(!current.history.lastRoiChangedAt||this.clock()-current.history.lastRoiChangedAt<=HOUR))throw error('ROI_INTERVAL_NOT_READY');
    if(step.field==='task'){const boost=await this.reader.inspectBoost(plan.id,plan.createdAt);if(!boost.complete||boost.state!=='eligible')throw error('BOOST_ACTIVE_OR_UNKNOWN');current.boostState=boost.state;}
    if(step===j.steps[0]){
     this.ingest(current);if(!s.historyVerified)throw error('HISTORY_NOT_VERIFIED');
     const fresh=decide(this.config,current,{...s,pendingWrite:null,uncertainWrite:null},this.clock(),eventKey?.split(':').at(-1)||'capture');
     if(['kind','roi','budget','duration','deferredRoiTarget'].some(k=>fresh[k]!==action[k]))throw error('RULE_CHANGED_BEFORE_WRITE');
    }
    prepared=await this.reader.prepare(plan.id,step.field==='task'?'task':step.field,step.field==='task'?{kind:'boost',budget:100,duration:6,name:step.name}:String(step.target));
    if(!this.config.enabled||await this.interlocked()||deadline&&this.clock()>=deadline)throw error('SLOT_EXPIRED_OR_STOPPED');
   }catch(e){j.status=j.steps.some(v=>v.status==='confirmed')?'partial':'rejected';j.error=e.code||'WRITE_REJECTED';await this.saveJournal(j);if(j.status==='rejected'){s.pendingWrite=null;s.uncertainWrite=null;if(this.state.pilotPendingTx===j.id)this.state.pilotPendingTx=null;}else s.uncertainWrite=j.id;await this.save();return j;}
   step.startedAt=this.clock();step.status='submitting';j.status='submitting';await this.saveJournal(j);
   try{step.writeAttempted=true;await this.reader.commit(plan.id,prepared);}catch(e){step.error=e.code||'WRITE_UNCERTAIN';step.writeAttempted=e.writeAttempted!==false;}
   let confirmed=false;for(let i=0;i<2&&!confirmed;i++){if(this.gapMs)await sleep(this.gapMs);try{confirmed=await this.verifyStep(j,step);}catch(e){step.readbackError=e.code||'READBACK_FAILED';}}
   await this.saveJournal(j);if(!confirmed){j.status='uncertain';s.uncertainWrite=j.id;await this.saveJournal(j);await this.save();return j;}
  }
  if(!await this.finish(j)){j.status='uncertain';s.uncertainWrite=j.id;await this.saveJournal(j);await this.save();}return j;
 }
 async cycle({event='capture',slot=null,allowWrites=false}={}){
  const messages=[];this.lastCycleStartedAt=this.clock();
  for(const id of this.config.planIds||[]){
   const s=this.planState(id),eventKey=event==='capture'?null:`${id}:${localDay(slot)}:${event}`;if(eventKey&&s.completedEvents.includes(eventKey))continue;
   if(eventKey&&this.clock()>=slot+SLOT_GRACE_MS){s.completedEvents.push(eventKey);s.lastDecision={kind:'blocked',reason:'SLOT_EXPIRED',at:this.clock()};messages.push(this.notifier.event({id,name:s.name},'SLOT_EXPIRED'));continue;}
   const release=this.isBusy()?null:this.gate.tryAcquire('automation');
   if(!release){s.lastDecision={kind:'wait',reason:'SHARED_OPERATION_BUSY',at:this.clock()};if(eventKey){if(!this.pendingEvents.some(e=>e.event===event&&e.slot===slot))this.pendingEvents.push({event,slot});break;}continue;}
   try{
    let plan=await this.reader.read(id);this.scope(plan.id);if(plan.accountId!==this.accountId)throw error('ACCOUNT_MISMATCH');s.name=plan.name;this.ingest(plan);
    if(s.pendingWrite){const j=this.journal.get(s.pendingWrite);if(j&&await this.reconcile(j))messages.push(this.notifier.event(plan,'WRITE_CONFIRMED','已回读确认先前提交',j.id));else{s.lastDecision={kind:'blocked',reason:'PREVIOUS_WRITE_UNRESOLVED',at:this.clock()};messages.push(this.notifier.event(plan,s.lastDecision.reason));continue;}}
    if(!s.historyVerified){s.lastDecision={kind:'blocked',reason:'HISTORY_NOT_VERIFIED',at:this.clock()};messages.push(this.notifier.event(plan,'HISTORY_NOT_VERIFIED',s.historyError));continue;}
    await this.evaluate(plan,s);if(plan.roi>=RULES.stableRoi&&this.config.windowMode!=='full-hour')messages.push(this.notifier.event(plan,'EXACT_WINDOW_PRECISION_UNSUPPORTED'));if(s.evaluationError)messages.push(this.notifier.event(plan,s.evaluationError));
    if(event.startsWith('boost-')||!s.lastBoostCheckedAt){const boost=await this.reader.inspectBoost(id,plan.createdAt);plan.boostState=boost.state;s.lastBoostState=boost.state;s.lastBoostCheckedAt=this.clock();}
    if(slot!==null&&this.clock()>=slot+SLOT_GRACE_MS){s.lastDecision={kind:'blocked',reason:'SLOT_EXPIRED',at:this.clock()};messages.push(this.notifier.event(plan,'SLOT_EXPIRED'));continue;}
    // Reading logs/tasks can take time; the policy receives the fresh verified read time.
    const action=decide(this.config,plan,s,this.clock(),event);s.lastDecision={...action,at:this.clock()};
    if(action.kind==='blocked'||action.notify)messages.push(this.notifier.event(plan,action.reason));
    if(allowWrites&&['budget','roi','roi-budget','boost'].includes(action.kind)){
     if(!this.state.pilotVerifiedAt&&this.state.pilotPendingTx){s.lastDecision={kind:'blocked',reason:'PILOT_WRITE_UNRESOLVED',at:this.clock()};messages.push(this.notifier.event(plan,'PILOT_WRITE_UNRESOLVED'));continue;}
     const j=await this.execute(plan,action,eventKey,slot===null?null:slot+SLOT_GRACE_MS);if(j){s.lastDecision={kind:j.status,reason:action.reason,journalId:j.id,at:this.clock()};messages.push(this.notifier.event(plan,j.status==='confirmed'?'WRITE_CONFIRMED':j.status==='rejected'?'WRITE_REJECTED':'WRITE_UNCERTAIN',j.status==='confirmed'?(j.action.kind==='boost'?'一键起量任务已创建并回读：100元 / 6小时':`ROI ${j.before.roi}→${j.after.roi}；预算 ${j.before.budget}→${j.after.budget}`):j.error||'请查看主机账本，未自动重复提交',j.id));}
    }
   }catch(e){s.lastDecision={kind:'blocked',reason:e.code||'STATE_READ_FAILED',at:this.clock()};messages.push(this.notifier.event({id,name:s.name},'STATE_READ_FAILED',e.code||'READ_FAILED'));}
   finally{try{if(eventKey&&!s.completedEvents.includes(eventKey))s.completedEvents.push(eventKey);s.completedEvents=s.completedEvents.slice(-200);await this.save();}finally{release();}}
   if(this.gapMs)await sleep(this.gapMs);
  }
  this.lastCycleFinishedAt=this.clock();if(allowWrites)await this.notifier.send(messages);await this.save();await this.heartbeat();return this.status();
 }
 status(){return {version:RULES.version,accountId:this.accountId,enabled:this.config.enabled===true,schedulerStarted:this.started,processId:process.pid,startedAt:this.startedAt,lastTickAt:this.state.lastTick,lastCycleStartedAt:this.lastCycleStartedAt,lastCycleFinishedAt:this.lastCycleFinishedAt,running:!!this.running,startupError:this.startupError||null,gate:this.gate.owner,phase:this.state.pilotVerifiedAt?'active':'pilot_waiting_first_eligible_action',pilotVerifiedAt:this.state.pilotVerifiedAt,pausedBy:this.interlockReason||null,waitingForConnection:!!this.waitingForConnection,windowCapability:this.config.windowMode==='full-hour'?'complete-hour-windows':'exact-subhour-unsupported',notifications:this.notifier.status(),plans:(this.config.planIds||[]).map(id=>{const s=this.planState(id);return {id,name:s.name,...s.lastSeen,stage:s.lastSeen?.roi>=RULES.stableRoi?'stable':'cold',lastRoiChangedAt:s.lastRoiChangedAt,approvalWindow:s.approvalWindow,decision:s.lastDecision,observation:s.observation,pendingRoi:s.pendingRoi||null,boostPermanentlyStopped:!!s.boostPermanentlyStopped,boostHistoryVerified:!!s.boostHistoryVerified,boostState:s.lastBoostState,boostCheckedAt:s.lastBoostCheckedAt,nextEvaluationAt:this.lastCapture+300000,pendingWrite:s.pendingWrite||null};})};}
 heartbeat(){return atomicJson(path.join(this.directory,'status.json'),this.status());}
 kick(){this.captureRequested=true;}
 async announceStart(){
  if(this.state.startNotified)return;if(this.startAnnouncement)return this.startAnnouncement;
  this.startAnnouncement=(async()=>{this.state.startNotified=true;await this.save();await this.notifier.send([this.notifier.event(null,'STARTED','仅限配置名单；先等待自然满足规则的动作，不为测试调价')]);})();
  try{await this.startAnnouncement;}finally{this.startAnnouncement=null;}
 }
 async start(){
  if(this.started||!this.config.enabled||this.startupError||this.state.suspended)return;
  await this.interlocked();if(this.interlockReason==='STOP'){await this.heartbeat();return;}
  // Maintenance can outlive process startup. Keep the timer armed, but every
  // tick and write remain blocked until the owner removes the pause flag.
  this.started=true;this.startedAt=this.clock();this.state.lastTick=this.clock();this.captureRequested=true;
  this.timer=this.timers.setInterval(()=>void this.tick().catch(()=>{}),5000);void this.tick().catch(()=>{});
 }
 async tick(){
  const now=this.clock(),previous=this.state.lastTick??now;this.state.lastTick=now;
  if(!this.started||!this.config.enabled)return;if(await this.interlocked()){await this.heartbeat();return;}
  for(const offset of [-DAY,0])for(const [hour,event] of [[0,'midnight'],[5,'boost-morning'],[17,'boost-evening']]){const slot=dayStart(now)+offset+hour*HOUR;if(slot>previous&&slot<=now&&slot>=this.startedAt)this.pendingEvents.push({event,slot});}
  this.waitingForConnection=this.reader.ready?.()===false&&now-this.startedAt<60000;
  if(this.waitingForConnection){await this.heartbeat();return;}
  if(this.running){await this.heartbeat();return;}
  await this.announceStart();if(this.running||!this.started||!this.config.enabled||await this.interlocked())return;
  const next=this.pendingEvents.shift();if(!next&&!this.captureRequested&&now-this.lastCapture<300000){await this.heartbeat();return;}
  this.captureRequested=false;if(!next)this.lastCapture=now;
  this.running=this.cycle({...next,allowWrites:true}).catch(async e=>{this.startupError=e.code||'AUTOMATION_CYCLE_ERROR';this.config.enabled=false;this.state.suspended=this.startupError;await this.save();}).finally(()=>{this.running=null;});await this.running;
 }
 async inspect(){if(this.running)throw error('AUTOMATION_BUSY');this.running=this.cycle({allowWrites:false}).finally(()=>this.running=null);return this.running;}
 async stop(){this.started=false;this.config.enabled=false;this.timers.clearInterval(this.timer);await atomicJson(path.join(this.directory,'config.json'),this.config);await this.heartbeat();}
}
