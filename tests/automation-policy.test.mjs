import test from 'node:test';
import assert from 'node:assert/strict';
import {RULES,HOUR,DAY,localDay,dayStart,roiIntervalReady,spendReached,validateEnrollment,decide,evaluateWindows,confirmedChange} from '../server/automation-policy.mjs';
const now=Date.parse('2026-10-07T17:00:00+08:00');
const accountId='1000000000000000',id='1000000000000001';
const enrollment={version:RULES.version,accountId,planIds:[id]};
const plan=(p={})=>({id,accountId,source:'live',verified:true,readAt:now,active:true,auditPassed:true,
  roi:2,budget:300,basicSpend:240,spendDay:localDay(now),createdAt:now-30*HOUR,
  approvedAt:now-29*HOUR,boostState:'eligible',...p});
const state=(s={})=>({lastRoiChangedAt:now-2*HOUR,boostHistoryVerified:true,...s});
const stableState=(s={})=>state({lastRoiChangedAt:now-2*HOUR,observation:{start:now-2*HOUR,end:now+22*HOUR,roiChangedAt:now-2*HOUR,roi:3.3,evaluation:null},...s});
function windows({roiBefore=3.5,roiAfter=3.85,spendBefore=2000,spendAfter=1800}={}){
 const common={accountId,planId:id,complete:true,settingsStable:true,metricDefinition:'synthetic-net-revenue/overall-cost',roiCost:1000};
 return [{...common,start:now-2*DAY,end:now-DAY,revenue:roiBefore*1000,basicSpend:spendBefore},
   {...common,start:now-DAY,end:now,revenue:roiAfter*1000,basicSpend:spendAfter}];
}
test('allowlist rejects other plans, mismatched accounts, malformed IDs and unsafe numbers',()=>{
 assert.equal(decide(enrollment,plan({id:'1000000000000002'}),state(),now).reason,'PLAN_NOT_ENROLLED');
 assert.equal(decide(enrollment,plan({accountId:'1000000000000002'}),state(),now).reason,'ACCOUNT_MISMATCH');
 assert.throws(()=>validateEnrollment({...enrollment,planIds:[Number(id)]}));
 assert.throws(()=>validateEnrollment({...enrollment,planIds:[id,id]}));
 for(const basicSpend of [null,NaN,Infinity,-1])assert.equal(decide(enrollment,plan({basicSpend}),state(),now).kind,'blocked');
});
test('only fresh live verified active and approved data can produce actions',()=>{
 for(const patch of [{source:'recorded'},{verified:false},{active:false},{auditPassed:false},{readAt:now-300001},{readAt:now+1},{spendDay:'2026-10-06'}])
  assert.equal(decide(enrollment,plan(patch),state(),now).kind,'blocked');
 for(const patch of [{pendingWrite:{}},{uncertainWrite:true}])assert.equal(decide(enrollment,plan(),state(patch),now).kind,'blocked');
});
test('cold threshold uses day spend and current budget with strict one-hour spacing',()=>{
 assert.deepEqual(decide(enrollment,plan(),state(),now),{kind:'roi-budget',roi:2.2,budget:600,reason:'COLD_ADVANCE'});
 assert.equal(decide(enrollment,plan({basicSpend:239.99}),state(),now).kind,'wait');
 assert.equal(decide(enrollment,plan({budget:600,basicSpend:479.99}),state(),now).kind,'wait');
 assert.equal(decide(enrollment,plan({budget:600,basicSpend:480}),state(),now).budget,900);
 assert.equal(roiIntervalReady(now-HOUR,now),false);
 assert.equal(roiIntervalReady(now-HOUR-1,now),true);
 assert.equal(roiIntervalReady(null,now),false);
 assert.equal(spendReached(300,240),true);
});
test('enrollment evaluates cold plans immediately without waiting for midnight or an approval timestamp',()=>{
 for(const approvedAt of [now-1000,null,undefined]){
  const d=decide(enrollment,plan({createdAt:now-2*HOUR,approvedAt}),state(),now);
  assert.deepEqual(d,{kind:'roi-budget',roi:2.2,budget:600,reason:'COLD_ADVANCE'});
 }
 assert.equal(decide(enrollment,plan({createdAt:now-1000,approvedAt:now-1000}),state({lastRoiChangedAt:now-1000}),now).reason,'COLD_BUDGET_AHEAD');
 assert.equal(decide(enrollment,plan({basicSpend:239.99,approvedAt:null}),state(),now).reason,'SPEND_BELOW_THRESHOLD');
 assert.equal(decide(enrollment,plan({auditPassed:false,approvedAt:null}),state(),now).reason,'PLAN_PAUSED_OR_UNAPPROVED');
 assert.equal(localDay(dayStart(now)),'2026-10-07');
});

test('cold target clips to 3.1 without reducing the existing budget',()=>{
 for(const roi of [2.9,2.95,3,3.09]){
  const d=decide(enrollment,plan({roi,budget:1800,basicSpend:1440}),state(),now);
  assert.equal(d.roi,3.1);assert.equal(d.budget,1800);assert.equal(d.reason,'ENTER_STABLE');
 }
});
test('daily reset changes only cold budget and is idempotent',()=>{
 const p=plan({roi:2.6,budget:900});const d=decide(enrollment,p,state(),now,'midnight');
 assert.equal(d.kind,'budget');assert.equal(d.budget,300);assert.equal(d.roi,undefined);
 assert.equal(decide(enrollment,p,state({completedEvents:[d.eventKey]}),now,'midnight').kind,'wait');
 assert.equal(decide(enrollment,plan({roi:3.1,budget:2000}),state(),now,'midnight').kind,'wait');
 assert.equal(decide(enrollment,plan({active:false}),state(),now,'midnight').kind,'blocked');
});
test('scheduled boost rejects age 72h, stable ROI, permanent stops and unknown history',()=>{
 const d=decide(enrollment,plan(),state(),now,'boost-evening');
 assert.equal(d.kind,'boost');assert.equal(d.budget,100);assert.equal(d.duration,6);
 for(const p of [{createdAt:now-3*DAY},{roi:3.1}])assert.equal(decide(enrollment,plan(p),state(),now,'boost-evening').kind,'wait');
 assert.equal(decide(enrollment,plan(),state({boostPermanentlyStopped:true}),now,'boost-evening').kind,'wait');
 assert.equal(decide(enrollment,plan(),state({boostHistoryVerified:false}),now,'boost-evening').reason,'BOOST_HISTORY_UNKNOWN');
 assert.equal(decide(enrollment,plan({boostState:'active'}),state(),now,'boost-evening').notify,true);
 assert.equal(decide(enrollment,plan({createdAt:now-HOUR}),state(),now,'boost-morning').reason,'NOT_CREATED_YESTERDAY');
 assert.equal(decide(enrollment,plan(),state({completedEvents:[d.eventKey]}),now,'boost-evening').kind,'wait');
});
test('confirmed same-day 300 to 600 to 900 stops boost permanently; cross-day additions do not',()=>{
 const p=plan();let s=confirmedChange(state(),{before:p,after:{...p,budget:600,roi:2.2},at:now,source:'automation',reason:'COLD_ADVANCE'});
 s=confirmedChange(s,{before:{...p,budget:600,roi:2.2},after:{...p,budget:900,roi:2.4},at:now+HOUR+1,source:'automation',reason:'COLD_ADVANCE'});
 assert.equal(s.boostPermanentlyStopped,true);
 s=confirmedChange(s,{before:{...p,budget:900,roi:2.4},after:{...p,budget:300,roi:2.4},at:now+DAY,source:'automation',reason:'COLD_DAILY_RESET'});
 assert.equal(s.boostPermanentlyStopped,true);
 let next=confirmedChange(state(),{before:p,after:{...p,budget:600},at:now,source:'automation',reason:'COLD_ADVANCE'});
 next=confirmedChange(next,{before:{...p,budget:600},after:{...p,budget:300},at:now+DAY,source:'automation',reason:'COLD_DAILY_RESET'});
 next=confirmedChange(next,{before:p,after:{...p,budget:600},at:now+DAY+HOUR,source:'automation',reason:'COLD_ADVANCE'});
 assert.notEqual(next.boostPermanentlyStopped,true);
});
test('weights use full 24-hour amounts and cannot offset an actual ROI below 3.1',()=>{
 assert.equal(evaluateWindows(...windows(),now).score,2);
 assert.equal(evaluateWindows(...windows(),now).decision,'hold');
 const loss=evaluateWindows(...windows({roiAfter:3,spendAfter:10000}),now);
 assert.equal(loss.decision,'rollback');assert.equal(loss.reason,'ROI_BELOW_FLOOR');
 const zero=evaluateWindows(...windows({roiAfter:0}),now);assert.equal(zero.decision,'rollback');
});
test('score boundaries are inclusive at +5 and -5 without floating-point drift',()=>{
 assert.equal(evaluateWindows(...windows({roiBefore:4,roiAfter:4,spendAfter:2250}),now).decision,'explore');
 assert.equal(evaluateWindows(...windows({roiBefore:4,roiAfter:4,spendAfter:1750}),now).decision,'rollback');
});
test('reject mixed identity, partial windows, premature data, missing cost, zero baseline and changed settings',()=>{
 const [b,a]=windows();
 for(const patch of [{complete:false},{end:now-1},{end:now+1},{planId:'1000000000000002'},{roiCost:0},{settingsStable:false},{metricDefinition:'other'}])
  assert.throws(()=>evaluateWindows(b,{...a,...patch},now));
 assert.throws(()=>evaluateWindows({...b,basicSpend:0},a,now));
});
test('stable observation permits budget-only increases, with cap, and never resets its clock',()=>{
 const p=plan({roi:3.3,budget:9500,basicSpend:7600}),s=stableState();
 const d=decide(enrollment,p,s,now);assert.equal(d.kind,'budget');assert.equal(d.budget,10000);
 const next=confirmedChange(s,{before:p,after:{...p,budget:10000},at:now,source:'automation',reason:d.reason});
 assert.deepEqual(next.observation,s.observation);assert.equal(next.lastRoiChangedAt,s.lastRoiChangedAt);
 assert.equal(decide(enrollment,{...p,budget:10000,basicSpend:9000},s,now).reason,'BUDGET_CAP_REACHED');
});
test('manual ROI edit resets both interval and rolling observation across midnight',()=>{
 const p=plan({roi:3.3}),at=Date.parse('2026-10-07T23:30:00+08:00');
 const s=confirmedChange(stableState(),{before:p,after:{...p,roi:3.5},at,source:'manual'});
 assert.equal(s.lastRoiChangedAt,at);assert.equal(s.observation.end,at+DAY);
 assert.equal(roiIntervalReady(at,at+HOUR),false);
});
test('entering stable delivery without passing 900 permanently ends scheduled boosts',()=>{
 const p=plan({roi:3,budget:300});
 let s=confirmedChange(state(),{before:p,after:{...p,roi:3.1,budget:1000},at:now,source:'automation',reason:'ENTER_STABLE'});
 assert.equal(s.boostPermanentlyStopped,true);
 s=confirmedChange(s,{before:{...p,roi:3.1,budget:1000},after:p,at:now+2*HOUR,source:'manual'});
 assert.equal(s.boostPermanentlyStopped,true);
 assert.equal(decide(enrollment,p,s,now,'boost-evening').reason,'BOOST_STOP_CONDITION');
});
test('completed observation gates exploration and verified rollback; no historical guess',()=>{
 const p=plan({roi:3.3,budget:2000,basicSpend:1600});
 const observation={start:now-DAY,end:now,roiChangedAt:now-DAY,roi:3.3,evaluation:null};
 const s=state({lastRoiChangedAt:now-DAY,observation});
 assert.equal(decide(enrollment,p,s,now).reason,'WINDOW_DATA_BUDGET_ONLY');
 const d=evaluation=>decide(enrollment,p,{...s,observation:{...observation,evaluation}},now);
 assert.equal(d({decision:'explore'}).roi,3.5);assert.equal(d({decision:'hold'}).kind,'budget');
 assert.equal(d({decision:'rollback'}).reason,'NO_VERIFIED_ROLLBACK_TARGET');
 s.goodSettings=[{at:now-DAY,roi:3.1,actualRoi:3.5,complete:true}];
 assert.equal(d({decision:'rollback'}).roi,3.1);
});


test('budget-first cold adjustments accumulate tickets and catch up without another spend trigger',()=>{
 const p=plan({roi:2.5}),initial=state({lastRoiChangedAt:now-30*60000});
 const action=decide(enrollment,p,initial,now);assert.equal(action.kind,'budget');assert.equal(action.budget,600);assert.equal(action.deferredRoiTarget,2.7);
 const next=confirmedChange(initial,{before:p,after:{...p,budget:600},at:now,source:'automation',reason:action.reason,deferredRoiTarget:action.deferredRoiTarget});
 assert.equal(next.pendingRoi.target,2.7);const again=decide(enrollment,{...p,budget:600,basicSpend:590},next,now);assert.equal(again.reason,'COLD_BUDGET_AHEAD');assert.equal(again.deferredRoiTarget,2.9);const queued=confirmedChange(next,{before:{...p,budget:600},after:{...p,budget:900},at:now+1,source:'automation',reason:again.reason,deferredRoiTarget:again.deferredRoiTarget});assert.equal(queued.pendingRoi.queue.length,2);
 const later=now+31*60000,result=decide(enrollment,{...p,budget:600,basicSpend:250,readAt:later},next,later);assert.deepEqual(result,{kind:'roi',roi:2.7,reason:'COLD_ROI_CATCH_UP'});
 const done=confirmedChange(queued,{before:{...p,budget:900},after:{...p,budget:900,roi:2.7},at:later,source:'automation',reason:result.reason});assert.equal(done.pendingRoi.target,2.9);assert.equal(done.pendingRoi.queue.length,1);assert.equal(decide(enrollment,{...p,roi:2.7,budget:900,readAt:later},done,later).reason,'WAITING_FOR_DEFERRED_ROI');
});

test('deferred stable entry respects a midnight budget reset and never reduces budget',()=>{
 const p=plan({roi:2.9,budget:300}),s=state({pendingRoi:{beforeRoi:2.9,target:3.1,roiChangedAt:now-2*HOUR}});
 assert.equal(decide(enrollment,p,s,now).budget,1000);assert.equal(decide(enrollment,{...p,budget:2000},s,now).budget,2000);
 const high=decide(enrollment,plan({roi:2.9,budget:2000,basicSpend:1600}),state({lastRoiChangedAt:now-1}),now);assert.equal(high.budget,2300);assert.equal(high.deferredRoiTarget,3.1);
});
