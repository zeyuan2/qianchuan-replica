import fs from 'node:fs/promises';
import {ACCOUNT_ID,PATHS,metricMap} from './api.mjs';
import {BridgeError} from './bridge.mjs';
const template=JSON.parse(await fs.readFile(new URL('./detail-templates.json',import.meta.url),'utf8')).dataTrend;
export const HOUR=3600000;
export const ROI_KEYS={roi:'total_prepay_and_pay_settle_overall_roi2_1h',spend:'stat_cost_for_roi2',revenue:'total_order_settle_amount_for_roi2_1h',roiCost:'stat_cost_for_overall_roi2'};
const stamp=ms=>new Date(ms+8*HOUR).toISOString().slice(0,19).replace('T',' ');
const norm=s=>s.replace(/_/g,'').toLowerCase();
export function readNumber(metrics,key,allowZero=false){const x=metricMap(metrics).get(norm(key)),value=x?.Value??x?.value,text=x?.ValueStr??x?.valueStr;if(value==null||value==='')return null;const n=Number(value);if((text==='-'||text==='—')&&!(allowZero&&n===0))return null;return Number.isFinite(n)?n:null;}
export async function readRoiHours(api,{accountId=ACCOUNT_ID,id,from,to},{clock=Date.now,gapMs=1200,beforeRead=async()=>{}}={}){
 const start=Date.parse(from),end=Date.parse(to);
 if(accountId!==ACCOUNT_ID||!api.planCache.has(String(id)))throw new BridgeError('计划不属于当前账户','ACCOUNT_MISMATCH',400);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>72*HOUR||end>clock()+1000)throw new BridgeError('小时查询范围无效','INVALID_QUERY',400);
 const result=[],seen=new Set();let cursor=start;
 while(cursor<end){
  const next=Math.min(end,Math.floor((cursor+8*HOUR)/(24*HOUR))*24*HOUR+16*HOUR);
  const body=structuredClone(template);body.Metrics=[ROI_KEYS.roi,ROI_KEYS.revenue,ROI_KEYS.roiCost];body.Dimensions=['ad_id','stat_time_hour'];body.StartTime=stamp(cursor);body.EndTime=stamp(next-1000);
  for(const condition of body.Filters.Conditions){if(condition.Field==='ad_id')condition.Values=[String(id)];if(condition.Field==='advertiser_id')condition.Values=[ACCOUNT_ID];}
  await beforeRead();const response=await api.call(PATHS.query,body,{intent:'read',reqFrom:'replica_roi_change_hours'}),data=response.data?.StatsData;
  if(!Array.isArray(data?.Rows)||Number(data.TotalCount)!==data.Rows.length)throw new BridgeError('小时数据未完整返回，保留上次结果','ROI_HOURS_INCOMPLETE',502);
  if(gapMs)await new Promise(r=>setTimeout(r,gapMs));const basic=structuredClone(body);basic.Metrics=[ROI_KEYS.spend];for(const c of basic.Filters.Conditions)if(c.Field==='roi2_project_scene_fork')c.Values=['1'];await beforeRead();const baseData=(await api.call(PATHS.query,basic,{intent:'read',reqFrom:'replica_roi_change_primary_hours'})).data?.StatsData;if(!Array.isArray(baseData?.Rows)||Number(baseData.TotalCount)!==baseData.Rows.length)throw new BridgeError('基础分时数据未完整返回','ROI_HOURS_INCOMPLETE',502);const primary=new Map();for(const r of baseData.Rows){const idValue=r.Dimensions?.ad_id?.Value;if(idValue!=null&&String(idValue)!==String(id))throw new BridgeError('基础数据计划不匹配','ACCOUNT_MISMATCH',502);const key=String(r.Dimensions?.stat_time_hour?.Value);if(primary.has(key))throw new BridgeError('基础分时数据重复','ROI_HOURS_INCOMPLETE',502);primary.set(key,readNumber(r.Metrics,ROI_KEYS.spend,true));}
  for(const row of data.Rows){
   const dimensions=row.Dimensions||{},plan=dimensions.ad_id?.Value??dimensions.ad_id?.ValueStr;
   if(plan!=null&&String(plan)!==String(id))throw new BridgeError('小时数据计划不匹配','ACCOUNT_MISMATCH',502);
   const value=dimensions.stat_time_hour?.Value;let time=Number(value);if(!Number.isFinite(time)||time<1e12)time=Date.parse(String(dimensions.stat_time_hour?.ValueStr||value).replace(' ','T')+':00+08:00');
   if(!Number.isFinite(time)||time%HOUR!==0||time<Math.floor(cursor/HOUR)*HOUR||time>=next||seen.has(time))throw new BridgeError('小时数据时间重复或无法确认','ROI_HOURS_INCOMPLETE',502);
   seen.add(time);const values=Object.fromEntries(Object.entries(ROI_KEYS).map(([k,key])=>[k,k==='spend'?(primary.get(String(value))??null):readNumber(row.Metrics,key,k!=='roi')]));
   result.push({time,...values,full:time>=start&&time+HOUR<=end});
  }
  cursor=next;if(cursor<end&&gapMs)await new Promise(r=>setTimeout(r,gapMs));
 }
 return {accountId:ACCOUNT_ID,planId:String(id),from:new Date(start).toISOString(),to:new Date(end).toISOString(),fetchedAt:new Date(clock()).toISOString(),rows:result.sort((a,b)=>a.time-b.time)};
}
