import {AutomationRecovery} from '../server/automation-recovery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AutomationEngine} from '../server/automation-engine.mjs';
import {AutomationNotifier} from '../server/automation-notify.mjs';
import {ActivityGate} from '../server/activity-gate.mjs';
import {parsePlanHistory,approvalDayEvidence} from '../server/automation-history.mjs';
import {RULES,HOUR,DAY,localDay,decide} from '../server/automation-policy.mjs';
const account='1000000000000000',ids=['1000000000000100','1000000000000101'];
async function temp(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qc-auto-test-'));t.after(async()=>{const real=await fs.realpath(directory);assert.equal(path.dirname(real).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());assert.ok(path.basename(real).startsWith('qc-auto-test-'));await fs.rm(real,{recursive:true,force:true});});return directory;}
async function fixture(t,options={}){
 const directory=await temp(t),config={version:RULES.version,accountId:account,planIds:ids,enabled:true};await fs.writeFile(path.join(directory,'config.json'),JSON.stringify(config));
 let now=Date.parse('2026-10-08T01:00:00+08:00');const created=Date.parse('2026-10-07T16:00:00+08:00'),plans=new Map(ids.map(id=>[id,{id,accountId:account,name:'synthetic',source:'live',verified:true,readAt:now,active:true,auditPassed:true,roi:2.5,budget:300,basicSpend:240,spendDay:localDay(now),createdAt:created,approvedAt:created+60000,history:{verified:true,issues:[],boostHistoryVerified:true,lastRoiChangedAt:created,facts:[{key:'initial-roi',field:'roi',initial:true,at:created,before:null,after:2.5},{key:'initial-budget',field:'budget',initial:true,at:created,before:null,after:300}]}}]));
 const writes=[],messages=[],tasks=new Map();let failField=options.failField;
 const reader={async read(id){const p=plans.get(id);return structuredClone({...p,readAt:now,spendDay:localDay(now)});},async inspectBoost(id){const rows=tasks.get(id)||[];return {state:rows.length?'active':'eligible',complete:true,tasks:rows};},async prepare(id,field,value){return {id,field,value};},async commit(id,p){writes.push({id,field:p.field,value:p.value});if(p.field===failField&&!options.throwAfter)throw Object.assign(Error('uncertain'),{code:'OPERATION_UNCERTAIN'});const plan=plans.get(id);if(p.field==='task'){tasks.set(id,[{id:'synthetic-task',name:p.value.name,budget:100,duration:6,startAt:new Date(now).toISOString(),state:'active'}]);}else{const before=plan[p.field];plan[p.field]=Number(p.value);plan.history.facts.push({key:'change-'+writes.length,field:p.field,initial:false,at:now,before,after:plan[p.field]});if(p.field==='roi')plan.history.lastRoiChangedAt=now;}if(p.field===failField)throw Object.assign(Error('uncertain'),{code:'OPERATION_UNCERTAIN'});return {success:true};},async window(){throw Object.assign(Error('unverified'),{code:'EXACT_WINDOW_PRECISION_UNVERIFIED'});}};
 const notifier={event:(p,reason,detail,unique)=>({id:p?.id,reason,detail,key:[p?.id,reason,unique].join(':')}),async send(m){messages.push(...m);},status:()=>({})},gate=new ActivityGate();
 const args={accountId:account,allowedIds:ids,directory,reader,notifier,gate,clock:()=>now,gapMs:0,timers:{setInterval:()=>1,clearInterval(){}}};const engine=await new AutomationEngine(args).init();engine.started=true;engine.startedAt=now;return {engine,args,plans,writes,messages,tasks,gate,directory,setNow:v=>now=v,getNow:()=>now,setFailure:v=>failField=v};
}
test('complete creation and budget logs establish ROI epoch; unknown ROI text or inconsistent replay blocks execution',()=>{
 const created=Date.parse('2026-10-07T16:00:00+08:00'),id=ids[0];const rows=[{id:'1',objectId:id,status:1,createTime:'2026-10-07 16:00:00',contentTitle:'新建',contentLog:['预算: 日预算300.0元','综合营销ROI目标: 2.50']},{id:'2',objectId:id,status:1,createTime:'2026-10-07 17:00:00',contentTitle:'修改',contentLog:['修改 预算: 日预算300.0元 -> 日预算500.0元']}];
 const q={id,roi:2.5,budget:500,createdAt:created,readAt:created+2*HOUR,complete:true};const h=parsePlanHistory(rows,q);assert.ok(h.verified);assert.equal(h.lastRoiChangedAt,created);assert.ok(h.boostHistoryVerified);assert.equal(parsePlanHistory(rows,{...q,roi:3}).verified,false);rows.push({id:'3',objectId:id,status:1,createTime:'2026-10-07 17:30:00',contentTitle:'修改',contentLog:['综合营销ROI目标: UNKNOWN']});assert.equal(parsePlanHistory(rows,q).verified,false);
});
test('same-day approval evidence is retained without delaying enrollment',()=>{
 const created=Date.parse('2026-10-07T16:00:00+08:00'),active=created+HOUR+1,evidence=approvalDayEvidence(created,active);assert.ok(evidence);assert.equal(approvalDayEvidence(created,created+DAY),null);
 const plan={id:ids[0],accountId:account,source:'live',verified:true,readAt:active,active:true,auditPassed:true,roi:2.5,budget:300,basicSpend:300,spendDay:localDay(active),createdAt:created,approvalWindow:evidence};const enrollment={version:RULES.version,accountId:account,planIds:ids};assert.equal(decide(enrollment,plan,{lastRoiChangedAt:created},active).reason,'COLD_ADVANCE');
});
test('gate serializes captures, batches and automation and rejects immediate acquisition while busy',async()=>{
 const gate=new ActivityGate(),order=[];const release=gate.tryAcquire('manual');assert.equal(gate.tryAcquire('automation'),null);const job=gate.run('capture',async()=>order.push('capture'));assert.equal(gate.owner,'manual');release();await job;assert.deepEqual(order,['capture']);assert.equal(gate.owner,null);
});
test('manual budget changes invalidate a cold chain even when budget returns to the previous value',async t=>{
 const f=await fixture(t);await f.engine.cycle({allowWrites:true});const s=f.engine.state.plans[ids[0]];assert.equal(s.coldBudgetChain.current,600);
 const p=f.plans.get(ids[0]),at=f.getNow()+10000;p.history.facts.push({key:'manual-1',field:'budget',at,before:600,after:500},{key:'manual-2',field:'budget',at:at+1000,before:500,after:600});f.setNow(at+2000);await f.engine.cycle({allowWrites:false});assert.equal(s.coldBudgetChain,null);
});
test('scheduled slot waits behind capture within its bounded window instead of being silently lost',async t=>{
 const f=await fixture(t),now=Date.parse('2026-10-08T05:00:01+08:00');f.setNow(now);const release=f.gate.tryAcquire('capture');await f.engine.cycle({event:'boost-morning',slot:now-1000,allowWrites:true});assert.equal(f.writes.length,0);assert.equal(f.engine.pendingEvents.length,1);release();const pending=f.engine.pendingEvents.shift();await f.engine.cycle({...pending,allowWrites:true});assert.equal(f.writes.length,2);
});
test('cold combo is serialized, fully read back, enables pilot only after success, and rejects off-list plans',async t=>{
 const f=await fixture(t);await assert.rejects(f.engine.execute({...f.plans.get(ids[0]),id:'9999999999999999'},{kind:'budget',budget:1000}),e=>e.code==='AUTOMATION_SCOPE_DENIED');await f.engine.cycle({allowWrites:true});assert.equal(f.writes.length,4);assert.deepEqual(f.writes.map(w=>w.field),['roi','budget','roi','budget']);assert.ok(f.engine.state.pilotVerifiedAt);assert.ok([...f.engine.journal.values()].every(j=>j.status==='confirmed'));await f.engine.cycle({allowWrites:true});assert.equal(f.writes.length,4);assert.ok(f.engine.state.plans[ids[0]].lastRoiChangedAt);
});
test('partial combo is not replayed on restart and pilot failure holds all later plan writes',async t=>{
 const f=await fixture(t,{failField:'budget'});await f.engine.cycle({allowWrites:true});assert.equal(f.writes.length,2);assert.equal(f.plans.get(ids[0]).roi,2.7);assert.equal(f.plans.get(ids[0]).budget,300);assert.equal(f.engine.state.plans[ids[1]].lastDecision.reason,'PILOT_WRITE_UNRESOLVED');const restarted=await new AutomationEngine(f.args).init();restarted.started=true;await restarted.cycle({allowWrites:true});assert.equal(f.writes.length,2);assert.ok(restarted.state.plans[ids[0]].uncertainWrite);
});
test('ambiguous HTTP outcome with verified matching platform history is confirmed without a duplicate submit',async t=>{
 const f=await fixture(t,{failField:'roi',throwAfter:true});await f.engine.cycle({allowWrites:true});assert.equal(f.writes.filter(w=>w.field==='roi').length,2);assert.ok([...f.engine.journal.values()].every(j=>j.status==='confirmed'));
});
test('pause/unapproved/missing history are skipped, and unchanged blocks are emitted as explicit reasons',async t=>{
 const f=await fixture(t);f.plans.get(ids[0]).active=false;f.plans.get(ids[1]).history.verified=false;await f.engine.cycle({allowWrites:true});assert.equal(f.writes.length,0);assert.ok(f.messages.some(m=>m.reason==='PLAN_PAUSED_OR_UNAPPROVED'));assert.ok(f.messages.some(m=>m.reason==='HISTORY_NOT_VERIFIED'));
});
test('scheduled boost fires once inside its slot; restart never replays it and elapsed slots are settled',async t=>{
 const f=await fixture(t);let now=Date.parse('2026-10-08T05:00:01+08:00');f.setNow(now);const slot=now-1000;await f.engine.cycle({event:'boost-morning',slot,allowWrites:true});assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.field==='task'&&w.value.budget===100&&w.value.duration===6));await f.engine.cycle({event:'boost-morning',slot,allowWrites:true});assert.equal(f.writes.length,2);
 const restarted=await new AutomationEngine(f.args).init();restarted.started=true;restarted.startedAt=now;restarted.state.lastTick=now;restarted.lastCapture=now;await restarted.tick();assert.equal(f.writes.length,2);
 now=Date.parse('2026-10-08T17:06:00+08:00');f.setNow(now);await restarted.cycle({event:'boost-evening',slot:now-6*60000,allowWrites:true});assert.equal(f.writes.length,2);assert.ok(restarted.state.plans[ids[0]].completedEvents.some(k=>k.endsWith('boost-evening')));
});
test('missing windows preserve ROI but permit only authorized threshold budget increases',async t=>{
 const f=await fixture(t);for(const p of f.plans.values()){p.roi=3.1;p.budget=1000;p.basicSpend=900;p.history.facts[0].after=3.1;}await f.engine.cycle({allowWrites:false});f.setNow(f.getNow()+DAY);await f.engine.cycle({allowWrites:true});assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.field==='budget'));assert.equal(f.engine.state.plans[ids[0]].evaluationError,'EXACT_WINDOW_PRECISION_UNVERIFIED');assert.equal(f.engine.state.plans[ids[0]].observation.evaluation,null);
});
test('corrupt ledger disables automation without escaping init or writing any account',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.directory,'state.json'),'bad');const e=await new AutomationEngine(f.args).init();assert.equal(e.config.enabled,false);assert.ok(e.startupError);assert.equal(f.writes.length,0);
});
test('notification deduplication is recipient-specific and ambiguous delivery is not resent after restart',async t=>{
 const directory=await temp(t),sent=[];const alerts={config:{enabled:true},recipients:()=>[{id:'a',token:'synthetic-a'},{id:'b',token:'synthetic-b'}],async send(token){sent.push(token);if(token==='synthetic-b')throw Object.assign(Error('ambiguous'),{uncertain:true,code:'PUSH_UNCERTAIN'});return {receipt:'synthetic-receipt'};}};
 const n=await new AutomationNotifier({directory,alerts}).init(),events=[n.event({id:ids[0],name:'synthetic'},'PLAN_PAUSED_OR_UNAPPROVED')];await n.send(events);await n.send(events);assert.equal(sent.length,2);const r=await new AutomationNotifier({directory,alerts}).init();await r.send(events);assert.equal(sent.length,2);assert.equal(r.status().recent[0].status,'accepted');assert.equal(r.status().recent[1].status,'uncertain');
});


test('maintenance at process startup arms a paused scheduler; clearing it resumes, STOP never arms',async t=>{
 const f=await fixture(t);f.engine.started=false;let blocked='MAINTENANCE';f.engine.interlocked=async()=>{f.engine.interlockReason=blocked;return Boolean(blocked);};
 await f.engine.start();assert.equal(f.engine.started,true);assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);
 blocked=null;await f.engine.tick();assert.equal(f.writes.length,4);assert.equal(f.messages.filter(m=>m.reason==='STARTED').length,1);
 await f.engine.tick();assert.equal(f.writes.length,4);
 const other=await fixture(t);other.engine.started=false;other.engine.interlocked=async()=>{other.engine.interlockReason='STOP';return true;};await other.engine.start();assert.equal(other.engine.started,false);assert.equal(other.writes.length,0);
});


test('fresh pre-submit policy cancels a threshold action when spend no longer qualifies',async t=>{
 const f=await fixture(t);let reads=0;const original=f.args.reader.read;f.args.reader.read=async id=>{const value=await original(id);if(++reads===2)value.basicSpend=0;return value;};
 await f.engine.cycle({allowWrites:true});assert.equal(f.writes.filter(w=>w.id===ids[0]).length,0);assert.equal([...f.engine.journal.values()][0].error,'RULE_CHANGED_BEFORE_WRITE');assert.equal(f.writes.filter(w=>w.id===ids[1]).length,2);
});


test('valid JSON with a corrupt notification schema disables notifications, preserves evidence and does not crash the server',async t=>{
 const directory=await temp(t),filename=path.join(directory,'notifications.json');await fs.writeFile(filename,'null');
 const n=await new AutomationNotifier({directory,alerts:{recipients:()=>[]}}).init();assert.equal(n.disabled,true);assert.equal(n.status().error,'NOTIFICATION_LEDGER_INVALID');assert.equal(await fs.readFile(filename,'utf8'),'null');await n.send([{key:'test'}]);
});


test('startup waits up to one minute for extension reconnect without issuing reads, writes or false alerts',async t=>{
 const f=await fixture(t);let connected=false;f.args.reader.ready=()=>connected;
 await f.engine.tick();assert.equal(f.engine.waitingForConnection,true);assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);
 connected=true;f.setNow(f.getNow()+5000);await f.engine.tick();assert.equal(f.engine.waitingForConnection,false);assert.equal(f.writes.length,4);
 const offline=await fixture(t);offline.args.reader.ready=()=>false;offline.args.reader.read=async()=>{throw Object.assign(Error('offline'),{code:'BRIDGE_OFFLINE'});};offline.setNow(offline.getNow()+60001);await offline.engine.tick();assert.equal(offline.writes.length,0);assert.ok(offline.messages.some(m=>m.reason==='STATE_READ_FAILED'));
});


test('new enrollment before midnight immediately evaluates and verifies eligible actions',async t=>{
 const f=await fixture(t);f.setNow(Date.parse('2026-10-07T18:00:00+08:00'));
 for(const p of f.plans.values())delete p.approvedAt;
 await f.engine.cycle({allowWrites:true});assert.equal(f.writes.length,4);assert.ok(f.engine.state.pilotVerifiedAt);
 assert.ok([...f.engine.journal.values()].every(j=>j.status==='confirmed'&&j.action.reason==='COLD_ADVANCE'));
});


test('deferred ROI survives restart, follows the original target, and manual ROI changes supersede the debt',async t=>{
 const f=await fixture(t);for(const p of f.plans.values()){p.history.lastRoiChangedAt=f.getNow()-30*60000;}
 await f.engine.cycle({allowWrites:true});assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.field==='budget'));assert.equal(f.engine.planState(ids[0]).pendingRoi.target,2.7);
 const restarted=await new AutomationEngine(f.args).init();restarted.started=true;f.setNow(f.getNow()+31*60000);await restarted.cycle({allowWrites:true});assert.equal(f.writes.length,4);assert.ok(f.writes.slice(2).every(w=>w.field==='roi'));assert.equal(restarted.planState(ids[0]).pendingRoi,null);
 restarted.planState(ids[0]).pendingRoi={beforeRoi:2.7,target:2.9,roiChangedAt:f.getNow()};const p=f.plans.get(ids[0]);p.roi=2.8;p.history.lastRoiChangedAt=f.getNow()+1000;f.setNow(f.getNow()+2000);await restarted.cycle({allowWrites:false});assert.equal(restarted.planState(ids[0]).pendingRoi,null);
});

async function partialBeforeBudget(t){
 const f=await fixture(t),prepare=f.args.reader.prepare;let blocked=true;
 f.args.reader.prepare=async(id,field,value)=>{if(field==='budget'&&blocked)throw Object.assign(Error('synthetic prepare failed'),{code:'PREPARE_FAILED'});return prepare(id,field,value);};
 await f.engine.cycle({allowWrites:true});blocked=false;return {...f,recovery:new AutomationRecovery(f.engine),job:[...f.engine.journal.values()][0]};
}

test('manual recovery completes only the never-submitted budget step, binds confirmation to actor and cannot replay it',async t=>{
 const f=await partialBeforeBudget(t);assert.equal(f.writes.length,1);let view=await f.recovery.review(f.job.id,'operator-a');assert.equal(view.review.retryStep,1);assert.equal(view.review.unknown,false);
 const p=await f.recovery.prepare({id:f.job.id,kind:'step',index:1},'operator-a');await assert.rejects(f.recovery.commit({token:p.token,confirmed:true},'operator-b'),e=>e.code==='RECOVERY_CONFIRMATION_INVALID');assert.equal(f.writes.length,1);
 view=await f.recovery.commit({token:p.token,confirmed:true},'operator-a');assert.equal(view.status,'confirmed');assert.deepEqual(f.writes.map(w=>w.field),['roi','budget']);assert.equal(f.engine.planState(ids[0]).pendingWrite,null);
 await assert.rejects(f.recovery.commit({token:p.token,confirmed:true},'operator-a'));assert.equal(f.writes.length,2);assert.ok(f.job.recoveryEvents.some(e=>e.event==='submit-step'));
});

test('uncertain submitted outcome cannot be retried or unlocked by the recovery UI',async t=>{
 const f=await fixture(t,{failField:'budget'});await f.engine.cycle({allowWrites:true});const r=new AutomationRecovery(f.engine),j=[...f.engine.journal.values()][0];const view=await r.review(j.id,'operator');assert.equal(view.review.unknown,true);assert.equal(view.review.retryStep,-1);
 await assert.rejects(r.prepare({id:j.id,kind:'step',index:1},'operator'),e=>e.code==='RECOVERY_STEP_NOT_RETRYABLE');await assert.rejects(r.prepare({id:j.id,kind:'resolve'},'operator'),e=>e.code==='RECOVERY_OUTCOME_STILL_UNKNOWN');assert.equal(f.writes.length,2);
});

test('verified partial result can be accepted at current platform state without replaying any financial action',async t=>{
 const f=await partialBeforeBudget(t),p=await f.recovery.prepare({id:f.job.id,kind:'resolve'},'operator');const view=await f.recovery.commit({token:p.token,confirmed:true},'operator');assert.equal(view.status,'resolved');assert.equal(f.writes.length,1);assert.equal(f.engine.planState(ids[0]).pendingWrite,null);assert.equal(f.engine.state.pilotVerifiedAt,null);
 const restarted=await new AutomationEngine(f.args).init();assert.equal(restarted.planState(ids[0]).pendingWrite,null);assert.equal(restarted.journal.get(f.job.id).status,'resolved');
});

test('changed platform state invalidates a recovery confirmation',async t=>{
 const f=await partialBeforeBudget(t),preview=await f.recovery.prepare({id:f.job.id,kind:'step',index:1},'operator');f.plans.get(ids[0]).budget=400;
 await assert.rejects(f.recovery.commit({token:preview.token,confirmed:true},'operator'),e=>e.code==='RECOVERY_PLAN_CHANGED');assert.equal(f.writes.length,1);
});


test('complete after-window establishes a new baseline when earlier data cannot be compared',async t=>{
 const f=await fixture(t);f.engine.config.windowMode='full-hour';for(const p of f.plans.values()){p.roi=3.1;p.budget=1000;p.history.facts[0].after=3.1;}
 await f.engine.cycle({allowWrites:false});const start=f.engine.planState(ids[0]).observation.start;f.setNow(start+DAY);
 f.args.reader.window=async(id,a,b)=>{if(b===start)throw Object.assign(Error('missing baseline'),{code:'WINDOW_HOURS_INCOMPLETE'});return {accountId:account,planId:id,start:a,end:b,metricDefinition:'full-hour-v1',precision:'full-hour',complete:true,revenue:400,roiCost:100,basicSpend:100};};
 await f.engine.cycle({allowWrites:false});const state=f.engine.planState(ids[0]);assert.equal(state.observation.start,start+DAY);assert.equal(state.observation.evaluation,null);assert.equal(state.goodSettings.at(-1).actualRoi,4);assert.equal(f.writes.length,0);
});

test('verified low actual ROI takes precedence even if the pre-change baseline is missing',async t=>{
 const f=await fixture(t);f.engine.config.windowMode='full-hour';for(const p of f.plans.values()){p.roi=3.1;p.budget=1000;p.history.facts[0].after=3.1;}
 await f.engine.cycle({allowWrites:false});const start=f.engine.planState(ids[0]).observation.start;f.setNow(start+DAY);
 let calls=0;f.args.reader.window=async(id,a,b)=>{calls++;if(b===start)throw Error('before must not be needed for absolute floor');return {accountId:account,planId:id,start:a,end:b,metricDefinition:'full-hour-v1',precision:'full-hour',complete:true,revenue:0,roiCost:100,basicSpend:100};};
 await f.engine.cycle({allowWrites:true});assert.equal(f.engine.planState(ids[0]).observation.evaluation.decision,'rollback');assert.equal(f.engine.planState(ids[0]).lastDecision.reason,'NO_VERIFIED_ROLLBACK_TARGET');assert.equal(calls,2);assert.equal(f.writes.length,0);
});


test('multiple budget advances accumulate durable ROI tickets and settle sequentially at the stable boundary',async t=>{
 const f=await fixture(t),origin=f.getNow();for(const p of f.plans.values())p.history.lastRoiChangedAt=origin-30*60000;
 for(let n=0;n<4;n++){f.setNow(origin+n*5*60000);for(const p of f.plans.values())p.basicSpend=p.budget*.8;await f.engine.cycle({allowWrites:true});}
 assert.equal(f.engine.planState(ids[0]).pendingRoi.queue.length,4);assert.deepEqual(f.engine.planState(ids[0]).pendingRoi.queue.map(v=>v.target),[2.7,2.9,3.1,3.1]);assert.ok(f.engine.planState(ids[0]).boostPermanentlyStopped);
 const resumed=await new AutomationEngine(f.args).init();resumed.started=true;for(const p of f.plans.values())p.basicSpend=0;
 for(const [n,roi]of [2.7,2.9,3.1].entries()){f.setNow(origin+31*60000+n*(HOUR+1));await resumed.cycle({allowWrites:true});assert.equal(f.plans.get(ids[0]).roi,roi);}
 assert.equal(resumed.planState(ids[0]).pendingRoi,null);assert.equal(resumed.planState(ids[0]).deferredRoiHistory.length,4);assert.equal(f.plans.get(ids[0]).budget,1500);assert.equal(f.writes.length,14);
});


test('a concurrent manual ROI change after budget-only success requires review rather than creating a stale debt',async t=>{
 const f=await fixture(t);for(const p of f.plans.values())p.history.lastRoiChangedAt=f.getNow()-30*60000;
 const commit=f.args.reader.commit;f.args.reader.commit=async(id,prepared)=>{const result=await commit(id,prepared);if(id===ids[0]&&prepared.field==='budget'){const p=f.plans.get(id);p.roi=2.8;p.history.lastRoiChangedAt=f.getNow();p.history.facts.push({key:'manual-concurrent-roi',field:'roi',at:f.getNow(),before:2.5,after:2.8});}return result;};
 await f.engine.cycle({allowWrites:true});const j=[...f.engine.journal.values()][0];assert.equal(j.status,'uncertain');assert.equal(f.engine.planState(ids[0]).pendingRoi,undefined);
 const recovery=new AutomationRecovery(f.engine),view=await recovery.review(j.id,'operator');assert.equal(view.review.canResolve,true);const p=await recovery.prepare({id:j.id,kind:'resolve'},'operator');await recovery.commit({token:p.token,confirmed:true},'operator');assert.equal(f.engine.planState(ids[0]).pendingWrite,null);assert.equal(f.writes.length,1);
});
