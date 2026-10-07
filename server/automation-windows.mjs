import {HOUR,DAY} from './automation-policy.mjs';
const fail=code=>Object.assign(Error(code),{code});
export function comparisonWindows(observation,mode='exact'){
 const start=observation.start;
 if(mode==='full-hour'){
  const beforeEnd=Math.floor(start/HOUR)*HOUR,afterStart=Math.ceil(start/HOUR)*HOUR;
  return {before:{start:beforeEnd-DAY,end:beforeEnd},after:{start:afterStart,end:afterStart+DAY},mode,excluded:{start:beforeEnd,end:afterStart}};
 }
 return {before:{start:start-DAY,end:start},after:{start,end:start+DAY},mode:'exact',excluded:null};
}
export function aggregateHourlyWindow(result,{accountId,planId,start,end}){
 if(end-start!==DAY||start%HOUR||end%HOUR||result.accountId!==accountId||result.planId!==planId||Date.parse(result.from)!==start||Date.parse(result.to)!==end||!Array.isArray(result.rows)||result.rows.length!==24)throw fail('WINDOW_HOURS_INCOMPLETE');
 const seen=new Set(),sum={revenue:0,roiCost:0,basicSpend:0};
 for(const row of result.rows){
  if(!row.full||!Number.isInteger(row.time)||row.time%HOUR||row.time<start||row.time>=end||seen.has(row.time))throw fail('WINDOW_HOURS_INCOMPLETE');seen.add(row.time);
  for(const [out,key] of [['revenue','revenue'],['roiCost','roiCost'],['basicSpend','spend']]){const value=row[key];if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw fail('WINDOW_METRICS_MISSING');sum[out]+=Math.round(value*100);}
 }
 return {accountId,planId,start,end,metricDefinition:'overall-net/overall-cost;fork1-primary;full-hour-v1',...Object.fromEntries(Object.entries(sum).map(([k,v])=>[k,v/100])),complete:true,precision:'full-hour',fetchedAt:result.fetchedAt};
}
