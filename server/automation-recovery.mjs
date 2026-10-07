import {randomUUID,createHash} from 'node:crypto';
import {HOUR,localDay,RULES} from './automation-policy.mjs';
const fail=code=>Object.assign(Error(code),{code,status:409});
const fingerprint=p=>createHash('sha256').update(JSON.stringify([p.id,p.accountId,p.roi,p.budget,p.active,p.auditPassed,p.permissions,p.history?.lastRoiChangedAt,p.history?.facts.map(f=>f.key)])).digest('hex');
export class AutomationRecovery {
 constructor(engine){this.engine=engine;this.previews=new Map();}
 journal(id){const j=this.engine.journal.get(id);if(!j)throw fail('RECOVERY_NOT_FOUND');this.engine.scope(j.planId);return j;}
 held(j){return this.engine.planState(j.planId).pendingWrite===j.id;}
 event(j,actor,event,extra={}){j.recoveryEvents=[...(j.recoveryEvents||[]),{at:this.engine.clock(),actor,event,...extra}].slice(-100);}
 view(j){return {id:j.id,planId:j.planId,name:this.engine.planState(j.planId).name,startedAt:j.startedAt,status:j.status,reason:j.action.reason,error:j.error||null,held:this.held(j),steps:j.steps.map((s,index)=>({index,field:s.field,before:s.before,target:s.target,status:s.status||'not-submitted',attempted:!!s.startedAt&&s.writeAttempted!==false,confirmedAt:s.confirmedAt||null})),review:j.review||null,recoveryEvents:j.recoveryEvents||[]};}
 history(){return {accountId:this.engine.accountId,plans:this.engine.status().plans,jobs:[...this.engine.journal.values()].sort((a,b)=>b.startedAt-a.startedAt).slice(0,100).map(j=>this.view(j))};}
 async review(id,actor){
  const j=this.journal(id);if(!this.held(j))return this.view(j);
  const plan=await this.engine.reader.read(j.planId);if(plan.accountId!==this.engine.accountId||!plan.history?.verified)throw fail('RECOVERY_HISTORY_NOT_VERIFIED');this.engine.ingest(plan);
  for(const step of j.steps){
   if(step.status==='confirmed'||!step.startedAt||step.writeAttempted===false)continue;
   if(step.field==='task'){await this.engine.verifyStep(j,step);continue;}
   const matches=plan.history.facts.filter(f=>!f.initial&&f.field===step.field&&f.before===step.before&&f.after===step.target&&f.at>=step.startedAt-2000&&f.at<=step.startedAt+300000);
   if(matches.length===1){step.status='confirmed';step.changedAt=matches[0].at;step.confirmedAt=this.engine.clock();}
  }
  const unknown=j.steps.some(s=>s.startedAt&&s.writeAttempted!==false&&s.status!=='confirmed');
  const expected=field=>j.steps.find(s=>s.field===field&&s.status==='confirmed')?.target??j.before[field];
  const settingsMatch=['roi','budget'].every(field=>plan[field]===expected(field));
  const next=j.steps.findIndex(s=>s.status!=='confirmed'&&(!s.startedAt||s.writeAttempted===false));
  const slotExpired=j.deadline&&this.engine.clock()>=j.deadline;
  j.review={at:this.engine.clock(),current:{roi:plan.roi,budget:plan.budget,status:plan.status,lastRoiChangedAt:plan.history.lastRoiChangedAt},unknown,settingsMatch,canResolve:!unknown,retryStep:!unknown&&settingsMatch&&plan.active&&plan.auditPassed&&!slotExpired&&localDay(j.startedAt)===localDay(this.engine.clock())?next:-1,slotExpired:!!slotExpired};
  this.event(j,actor,'review',{unknown,settingsMatch});await this.engine.saveJournal(j);
  if(j.steps.every(s=>s.status==='confirmed')&&await this.engine.finish(j))j.review.retryStep=-1;
  await this.engine.save();return this.view(j);
 }
 async prepare({id,kind,index},actor){
  if(!['step','resolve'].includes(kind))throw fail('RECOVERY_ACTION_INVALID');
  await this.review(id,actor);const j=this.journal(id);if(!this.held(j))throw fail('RECOVERY_ALREADY_RESOLVED');
  if(kind==='resolve'&&!j.review.canResolve)throw fail('RECOVERY_OUTCOME_STILL_UNKNOWN');
  if(kind==='step'&&(!Number.isInteger(index)||index<0||j.review.retryStep!==index))throw fail('RECOVERY_STEP_NOT_RETRYABLE');
  const plan=await this.engine.reader.read(j.planId);if(!plan.history?.verified)throw fail('RECOVERY_HISTORY_NOT_VERIFIED');
  if(kind==='step')await this.validateStep(j,j.steps[index],plan);
  const token=randomUUID(),preview={token,id,kind,index,actor,fingerprint:fingerprint(plan),expiresAt:this.engine.clock()+60000};
  this.previews.set(token,preview);for(const [key,p]of this.previews)if(p.expiresAt<this.engine.clock())this.previews.delete(key);
  this.event(j,actor,'prepare',{kind,index});await this.engine.saveJournal(j);
  return {token,expiresAt:preview.expiresAt,planId:j.planId,kind,index,description:kind==='resolve'?`保留平台当前ROI ${plan.roi}、预算 ${plan.budget}元，结束剩余未提交步骤并解除本条阻塞`:`仅补做${j.steps[index].field==='roi'?'ROI':j.steps[index].field==='budget'?'预算':'起量任务'}：${j.steps[index].field==='task'?100:plan[j.steps[index].field]} → ${j.steps[index].target}；已成功步骤不会重复提交`};
 }
 async validateStep(j,step,plan){
  if(!this.engine.config.enabled||await this.engine.interlocked())throw fail('AUTOMATION_NOT_ENABLED');
  if(!plan.active||!plan.auditPassed||!plan.history?.verified)throw fail('RECOVERY_PLAN_NOT_READY');
  if(step.status==='confirmed'||step.startedAt&&step.writeAttempted!==false)throw fail('RECOVERY_STEP_NOT_RETRYABLE');
  if(j.deadline&&this.engine.clock()>=j.deadline||localDay(j.startedAt)!==localDay(this.engine.clock()))throw fail('RECOVERY_INTENT_EXPIRED');
  for(const field of ['roi','budget']){const expected=j.steps.find(s=>s.field===field&&s.status==='confirmed')?.target??j.before[field];if(plan[field]!==expected)throw fail('SETTING_CHANGED_BEFORE_WRITE');}
  if(step.field==='roi'&&(!plan.history.lastRoiChangedAt||this.engine.clock()-plan.history.lastRoiChangedAt<=HOUR))throw fail('ROI_INTERVAL_NOT_READY');
  if(step.field==='budget'&&step.target>RULES.maxBudget)throw fail('BUDGET_CAP_REACHED');
  if(step.field==='task'){const b=await this.engine.reader.inspectBoost(j.planId,plan.createdAt);if(!b.complete||b.state!=='eligible')throw fail('BOOST_ACTIVE_OR_UNKNOWN');}
  await this.engine.reader.validate?.(plan,step.field==='task'?{kind:'boost',budget:100}:{kind:step.field,[step.field]:step.target});
 }
 async commit({token,confirmed},actor){
  const p=this.previews.get(token);if(!p||p.actor!==actor||p.expiresAt<this.engine.clock()||confirmed!==true)throw fail('RECOVERY_CONFIRMATION_INVALID');this.previews.delete(token);
  const j=this.journal(p.id);if(!this.held(j))throw fail('RECOVERY_ALREADY_RESOLVED');
  const plan=await this.engine.reader.read(j.planId);if(!plan.history?.verified||fingerprint(plan)!==p.fingerprint)throw fail('RECOVERY_PLAN_CHANGED');
  if(p.kind==='resolve'){
   if(j.steps.some(s=>s.startedAt&&s.writeAttempted!==false&&s.status!=='confirmed'))throw fail('RECOVERY_OUTCOME_STILL_UNKNOWN');
   j.status='resolved';j.resolvedAt=this.engine.clock();j.resolution='accepted-current-platform-state';this.event(j,actor,'resolve',{roi:plan.roi,budget:plan.budget});await this.engine.saveJournal(j);
   const state=this.engine.planState(j.planId);state.pendingWrite=null;state.uncertainWrite=null;if(this.engine.state.pilotPendingTx===j.id)this.engine.state.pilotPendingTx=null;this.engine.ingest(plan);await this.engine.save();this.engine.kick();return this.view(j);
  }
  const step=j.steps[p.index];await this.validateStep(j,step,plan);
  const prepared=await this.engine.reader.prepare(j.planId,step.field,step.field==='task'?{kind:'boost',budget:100,duration:6,name:step.name}:String(step.target));
  if(await this.engine.interlocked())throw fail('AUTOMATION_NOT_ENABLED');
  step.attempts=[...(step.attempts||[]),...(step.startedAt?[{startedAt:step.startedAt,error:step.error,writeAttempted:step.writeAttempted}]:[])];step.startedAt=this.engine.clock();step.status='submitting';step.writeAttempted=true;j.status='submitting';this.event(j,actor,'submit-step',{index:p.index});await this.engine.saveJournal(j);
  try{await this.engine.reader.commit(j.planId,prepared);}catch(e){step.error=e.code||'WRITE_UNCERTAIN';step.writeAttempted=e.writeAttempted!==false;}
  let verified=false;for(let n=0;n<2&&!verified;n++){if(this.engine.gapMs)await new Promise(r=>setTimeout(r,this.engine.gapMs));try{verified=await this.engine.verifyStep(j,step);}catch{}}
  if(!verified){j.status='uncertain';this.engine.planState(j.planId).uncertainWrite=j.id;await this.engine.saveJournal(j);await this.engine.save();return this.view(j);}
  await this.engine.saveJournal(j);
  if(j.steps.every(s=>s.status==='confirmed'))await this.engine.finish(j);else{j.status='partial';await this.engine.saveJournal(j);}
  await this.engine.save();return this.view(j);
 }
}
