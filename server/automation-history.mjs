import {localDay} from './automation-policy.mjs';
const n=s=>Number(String(s).replaceAll(',',''));
export function logTime(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return NaN;return Date.parse(value.replace(' ','T')+'+08:00');}
export function parsePlanHistory(rows,{id,roi,budget,createdAt,readAt,complete}){
 const issues=[],facts=[],seen=new Set();
 if(!complete)issues.push('LOG_PAGES_INCOMPLETE');
 for(const row of rows){
  const at=logTime(row.createTime),key=String(row.id||row.logId||'');
  if(String(row.objectId)!==id||!key||seen.has(key)||!Number.isFinite(at)||at<createdAt-1000||at>readAt+1000||!Array.isArray(row.contentLog)){issues.push('LOG_IDENTITY_OR_TIME_INVALID');continue;}seen.add(key);
  for(const text of row.contentLog){
   if(typeof text!=='string')continue;
   if(row.contentTitle==='新建'){
    if(row.status!==1&&/^(综合营销ROI目标|预算):/.test(text)){issues.push('SETTING_LOG_STATUS_UNKNOWN');continue;}
    let m=/^综合营销ROI目标:\s*([\d.]+)$/.exec(text);if(m)facts.push({key:key+':roi',field:'roi',at,before:null,after:n(m[1]),initial:true});
    m=/^预算:\s*日预算([\d,.]+)元$/.exec(text);if(m)facts.push({key:key+':budget',field:'budget',at,before:null,after:n(m[1]),initial:true});
   }else{
    const m=/^修改\s+(综合营销ROI目标|预算):\s*(?:日预算)?([\d,.]+)(?:元)?\s*->\s*(?:日预算)?([\d,.]+)(?:元)?$/.exec(text);
    if(m){if(row.status!==1){issues.push('SETTING_LOG_STATUS_UNKNOWN');continue;}facts.push({key:key+':'+m[1],field:m[1]==='预算'?'budget':'roi',at,before:n(m[2]),after:n(m[3]),initial:false});}
    else if(/ROI|投产|预算/i.test(text))issues.push('SETTING_LOG_FORMAT_UNKNOWN');
   }
  }
 }
 facts.sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key));
 for(const field of ['roi','budget']){const sequence=facts.filter(f=>f.field===field);let value=null;if(!sequence.length||!sequence[0].initial)issues.push('INITIAL_SETTING_MISSING');for(const f of sequence){if(!Number.isFinite(f.after)||f.after<=0||f.initial&&value!==null&&value!==f.after||!f.initial&&value!==f.before)issues.push('SETTING_HISTORY_GAP');value=f.after;}if(value!==(field==='roi'?roi:budget))issues.push('SETTING_HISTORY_NOT_CURRENT');}
 const roiFacts=facts.filter(f=>f.field==='roi'&&(f.initial||f.before!==f.after));
 // If no 600->900 transition exists in the complete budget history, this stop
 // condition cannot have happened. Otherwise require the local automation ledger.
 const possibleChain=facts.some(f=>f.field==='budget'&&f.before===600&&f.after===900);
 return {verified:!issues.length,issues:[...new Set(issues)],facts,lastRoiChangedAt:issues.length?null:roiFacts.at(-1)?.at,boostHistoryVerified:!issues.length&&!possibleChain};
}
export function approvalDayEvidence(createdAt,activeAt){
 if(!Number.isFinite(createdAt)||!Number.isFinite(activeAt)||activeAt<createdAt||localDay(createdAt)!==localDay(activeAt))return null;
 // This proves the calendar day, not the exact review timestamp.
 return {notBefore:createdAt,notAfter:activeAt,day:localDay(activeAt),source:'created-and-observed-delivering-same-day'};
}
