import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyAutomationPlan,actionPermitted} from '../server/automation-plan-state.mjs';
import {comparisonWindows,aggregateHourlyWindow} from '../server/automation-windows.mjs';
import {HOUR,DAY,evaluateWindows} from '../server/automation-policy.mjs';
const base={adDeliveryType:0,adOptType:0,operation:{budgetEditOperation:{editable:true},roi2GoalOperation:{editable:true}}};
test('verified numeric delivery codes and independent permissions replace display-label matching',()=>{
 const warning={...base,adDeliveryType:8,adDeliveryName:'任意显示文字'};const p=classifyAutomationPlan(warning,warning);assert.equal(p.active,true);assert.equal(p.auditPassed,true);assert.equal(p.warning,'GROUP_BUDGET_WARNING');assert.equal(classifyAutomationPlan(warning,base).auditPassed,true);
 assert.equal(classifyAutomationPlan({...base,adDeliveryType:99}, {...base,adDeliveryType:99}).active,false);assert.equal(classifyAutomationPlan(base,{...base,adOptType:1}).active,false);assert.equal(classifyAutomationPlan({...base,adDeliveryType:5,adOptType:1},{...base,adDeliveryType:5,adOptType:1}).reason,'PLAN_PAUSED');
 const noBudget={...base,operation:{...base.operation,budgetEditOperation:{editable:false}}};assert.equal(actionPermitted(classifyAutomationPlan(base,noBudget),{kind:'budget',budget:600}),false);assert.equal(actionPermitted(classifyAutomationPlan(base,noBudget),{kind:'roi',roi:2.7}),true);
 const exhausted=classifyAutomationPlan({...base,adDeliveryType:7},{...base,adDeliveryType:7});assert.equal(actionPermitted(exhausted,{kind:'budget',budget:600}),true);assert.equal(actionPermitted(exhausted,{kind:'boost'}),false);
});
test('full-hour comparison excludes the crossing hour and preserves two complete 24 hour periods',()=>{
 const anchor=Date.parse('2026-10-07T23:32:24+08:00'),r=comparisonWindows({start:anchor},'full-hour');assert.equal(r.before.end,Date.parse('2026-10-07T23:00:00+08:00'));assert.equal(r.after.start,Date.parse('2026-10-08T00:00:00+08:00'));assert.equal(r.after.end-r.after.start,DAY);assert.equal(r.before.end-r.before.start,DAY);assert.equal(r.after.start-r.before.end,HOUR);
 const metric={accountId:'1000000000000000',planId:'1000000000000100',metricDefinition:'test',complete:true,settingsStable:true,revenue:400,roiCost:100,basicSpend:100,precision:'full-hour',comparisonAnchor:anchor};assert.equal(evaluateWindows({...metric,...r.before},{...metric,...r.after},r.after.end).score,0);
 assert.throws(()=>evaluateWindows({...metric,...r.before},{...metric,...r.after,start:r.after.start+1,end:r.after.end+1},r.after.end+1));
});
test('hourly totals reject missing, duplicate, partial, mismatched or null buckets and never average hourly ROI',()=>{
 const start=Date.parse('2026-10-07T00:00:00+08:00'),end=start+DAY,scope={accountId:'1000000000000000',planId:'1000000000000100',start,end};
 const data={accountId:scope.accountId,planId:scope.planId,from:new Date(start).toISOString(),to:new Date(end).toISOString(),rows:Array.from({length:24},(_,i)=>({time:start+i*HOUR,full:true,spend:1,revenue:i===0?400:0,roiCost:i===0?100:0}))};const value=aggregateHourlyWindow(data,scope);assert.equal(value.revenue/value.roiCost,4);assert.equal(value.basicSpend,24);
 for(const rows of [data.rows.slice(1),[data.rows[0],...data.rows.slice(0,23)],data.rows.map((r,i)=>i? r:{...r,full:false}),data.rows.map((r,i)=>i? r:{...r,spend:null})])assert.throws(()=>aggregateHourlyWindow({...data,rows},scope));
});
