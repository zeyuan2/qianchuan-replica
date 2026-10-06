import fs from 'node:fs/promises';
import {ACCOUNT_ID,PATHS,period,today} from './api.mjs';
import {BridgeError} from './bridge.mjs';
import {isGlobalFailure} from './boost-state.mjs';
const templates=JSON.parse(await fs.readFile(new URL('./api-templates.json',import.meta.url),'utf8'));
const epoch=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?(n<1e12?n*1000:n):null;};
export function classifyBoostList(ad,now=Date.now()){
 const task=ad.assistTaskInfoMap?.['1'],aggregate=ad.assistTaskAggInfo?.assistTaskAggShowStatusMap?.['1'];
 const checkedAt=new Date(now).toISOString(),start=epoch(task?.startTime),end=epoch(task?.endTime);
 const evidence=task?{showStatus:task.showStatus,status:task.status,aggregateStatus:aggregate,hasTaskId:Boolean(task.id),operation:task.operation,startAt:start?new Date(start).toISOString():null,endAt:end?new Date(end).toISOString():null}:null;
 const base={id:String(ad.id),state:'unknown',complete:true,checkedAt,source:'list-optional',taskCount:task?.id?1:0,listEvidence:evidence};
 if(!task||Array.isArray(task))return base;
 // Only verified structures can allow selection. Missing fields never mean no active task.
 if(task.id&&start&&end&&end>=start&&end>now&&task.status===0&&aggregate===1&&task.operation?.finish?.visible===true&&task.operation.finish.editable===true)return {...base,state:'active',reason:'平台列表显示未结束的起量任务'};
 if(aggregate!==0)return base;
 if(task.id&&start&&end&&end>=start&&end<=now&&task.status===12&&task.showStatus===0)return {...base,state:'eligible'};
 if(!task.id&&!start&&!end&&task.showStatus===1&&task.operation?.create?.visible===true&&task.operation.create.editable===true)return {...base,state:'eligible',taskCount:0};
 return base;
}
export async function loadBoostList(api,{clock=Date.now,beforeRead=async()=>{},gapMs=1200}={}){
 let requests=0;const pause=()=>new Promise(r=>setTimeout(r,gapMs));
 const read=async(path,body)=>{if(requests++&&gapMs)await pause();await beforeRead();return api.call(path,body,{intent:'read',reqFrom:'replica_boost_list_status'});};
 const date=today(new Date(clock())),range=period(date,date,new Date(clock()));
 const summary=structuredClone(templates.summary);summary.AdFilter={...summary.AdFilter,MarGoal:1,UniPromShopFilter:{UniPromShopView:1},StartTime:range.start,EndTime:range.listEnd};delete summary.AdFilter.AdStatusFilterType;delete summary.SearchFilter;delete summary.HavingFilter;
 const totalOf=d=>{const n=Number(d?.data?.totalNum);if(!Number.isSafeInteger(n)||n<0||n>100000)throw new BridgeError('列表汇总不完整','INCOMPLETE_CAPTURE',409);return n;};
 const total=totalOf(await read(PATHS.summary,summary)),rows=new Map(),seen=new Set();
 for(let page=1;page<=Math.max(1,Math.ceil(total/100));page++){
  const body=structuredClone(templates.plans);body.Params.PageParams={Page:page,PageSize:100};body.Params.OrderBy={Field:'create_time',Type:1};
  body.Params.AdFilter={...body.Params.AdFilter,MarGoal:1,UniPromShopFilter:{UniPromShopView:1},DataTimeRange:{StartTime:range.start,EndTime:range.listEnd}};delete body.Params.AdFilter.AdStatusFilterType;delete body.Params.SearchFilter;delete body.Params.HavingFilter;
  const {data}=await read(PATHS.plans,body),ads=data?.adInfos;
  if(!Array.isArray(ads)||Number(data.pagination?.page)!==page||Number(data.pagination?.pageSize)!==100)throw new BridgeError('列表分页未完整返回','INCOMPLETE_CAPTURE',409);
  for(const ad of ads){if(String(ad.advId)!==ACCOUNT_ID||ad.marGoal!==1)throw new BridgeError('列表账户不匹配','ACCOUNT_MISMATCH',502);if(seen.has(String(ad.id)))throw new BridgeError('列表分页重复','INCOMPLETE_CAPTURE',409);seen.add(String(ad.id));}
  let extras=[];
  if(data.sessionId){
   const optional=structuredClone(templates.optional);optional.SessionId=data.sessionId;optional.SessionID=data.sessionId;
   try{const result=await read(PATHS.optional,optional);if(!Object.keys(result.data?.moduleErrors||{}).length&&Array.isArray(result.data?.adInfos))extras=result.data.adInfos;}
   catch(e){if(isGlobalFailure(e))throw e;}
  }
  const pageIds=new Set(ads.map(a=>String(a.id))),extraIds=new Set();
  for(const ad of extras){if(String(ad.advId)!==ACCOUNT_ID||ad.marGoal!==1)throw new BridgeError('附加状态账户不匹配','ACCOUNT_MISMATCH',502);const id=String(ad.id);if(!pageIds.has(id)||extraIds.has(id))throw new BridgeError('附加状态与当前分页不匹配','INCOMPLETE_CAPTURE',409);extraIds.add(id);rows.set(id,classifyBoostList(ad,clock()));}
  for(const ad of ads)if(!rows.has(String(ad.id)))rows.set(String(ad.id),{id:String(ad.id),state:'unknown',source:'list-optional',reason:'附加状态缺失，需逐条核实'});
 }
 if(seen.size!==total||totalOf(await read(PATHS.summary,summary))!==total)throw new BridgeError('查询期间计划列表发生变化','INCOMPLETE_CAPTURE',409);
 return {rows,requests,total};
}
