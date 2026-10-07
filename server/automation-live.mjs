import fs from 'node:fs/promises';
import {ACCOUNT_ID,PATHS,metricMap} from './api.mjs';
import {planInfo,DETAIL_PATHS} from './details.mjs';
import {readRoiHours} from './roi-hours.mjs';
import {aggregateHourlyWindow} from './automation-windows.mjs';
import {BoostState} from './boost-state.mjs';
import {classifyAutomationPlan,actionPermitted} from './automation-plan-state.mjs';
import {parsePlanHistory} from './automation-history.mjs';
import {localDay,DAY} from './automation-policy.mjs';
import {prepareOperation,commitOperation,buildOperation} from './operations.mjs';
const T=JSON.parse(await fs.readFile(new URL('./api-templates.json',import.meta.url),'utf8'));
const D=JSON.parse(await fs.readFile(new URL('./detail-templates.json',import.meta.url),'utf8'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const stamp=n=>new Date(n+8*3600000).toISOString().slice(0,19).replace('T',' ');
const numeric=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const failure=code=>Object.assign(Error(code),{code});
export class AutomationLive {
 constructor({api,allowedIds,clock=Date.now,gapMs=1200}){Object.assign(this,{api,allowedIds:new Set(allowedIds),clock,gapMs});this.lastAds=new Map();this.boost=new BoostState({api,clock,gapMs});}
 ready(){return this.api.bridge.status().connected;}
 scope(id){if(!this.allowedIds.has(id)||!this.api.planCache.has(id))throw failure('AUTOMATION_SCOPE_DENIED');}
 async call(...args){const value=await this.api.call(...args);if(this.gapMs)await wait(this.gapMs);return value;}
 async read(id){
  this.scope(id);const now=this.clock(),day=localDay(now),body=structuredClone(T.plans);
  body.Params.PageParams={Page:1,PageSize:10};body.Params.Metrics=['stat_cost_for_roi2_primary'];body.Params.SearchFilter={Type:1,Keyword:id};delete body.Params.HavingFilter;delete body.Params.AdFilter.AdStatusFilterType;
  body.Params.AdFilter.DataTimeRange={StartTime:day+' 00:00:00',EndTime:day+' 23:59:59'};
  const {data}=await this.call(PATHS.plans,body,{intent:'read',reqFrom:'automation_fresh_plan'}),ads=data?.adInfos;
  if(!Array.isArray(ads)||ads.length!==1||String(ads[0].id)!==id||String(ads[0].advId)!==ACCOUNT_ID||ads[0].marGoal!==1)throw failure('AUTOMATION_PLAN_NOT_UNIQUELY_VERIFIED');
  const fresh=ads[0],{ad}=await planInfo(this.api,id,true);if(this.gapMs)await wait(this.gapMs);this.lastAds.set(id,ad);
  if(Number(fresh.budget)!==Number(ad.budget)||Number(fresh.ecpRoi2Goal)!==Number(ad.ecpRoi2Goal))throw failure('SETTING_CHANGED_DURING_READ');
  const metric=metricMap(data.adStatsMap?.[id]?.metrics||{}).get('statcostforroi2primary');
  const plan={id,accountId:ACCOUNT_ID,name:String(ad.name||fresh.name||''),source:'live',verified:true,readAt:this.clock(),...classifyAutomationPlan(fresh,ad),status:fresh.adDeliveryName,roi:numeric(ad.ecpRoi2Goal),budget:Number(ad.budget)/100000,basicSpend:numeric(metric?.value??metric?.Value),spendDay:day,createdAt:Number(ad.createTime)*1000,boostState:'unknown'};
  const logs=await this.logs(id,plan.createdAt);plan.history=parsePlanHistory(logs.rows,{...plan,readAt:this.clock(),complete:logs.complete});plan.readAt=this.clock();return plan;
 }
 async logs(id,createdAt){
  this.scope(id);if(!Number.isFinite(createdAt)||createdAt<=0)throw failure('CREATION_TIME_UNKNOWN');
  const rows=[],seen=new Set(),end=localDay(this.clock()+DAY)+' 00:00:00';let total=null;
  for(let page=1;page<=30;page++){
   const {data}=await this.call(DETAIL_PATHS.log,undefined,{method:'GET',query:{objectID:id,startTime:localDay(createdAt)+' 00:00:00',endTime:end,currentPage:page,pageSize:100,type:1},intent:'read',reqFrom:'automation_verified_history'});
   const count=Number(data?.pagination?.totalNum);if(!Array.isArray(data?.logs)||!Number.isSafeInteger(count)||count<0||total!==null&&total!==count)throw failure('LOG_PAGES_INCOMPLETE');total=count;
   for(const row of data.logs){const key=String(row.id||row.logId||'');if(!key||seen.has(key)||String(row.objectId)!==id)throw failure('LOG_PAGES_INCOMPLETE');seen.add(key);rows.push(row);}
   if(rows.length===total)return {rows,complete:true};if(!data.logs.length||rows.length>total)throw failure('LOG_PAGES_INCOMPLETE');
  }throw failure('LOG_PAGE_LIMIT');
 }
 async inspectBoost(id,since){this.scope(id);return this.boost.inspect(id,{force:true,since:since?new Date(since).toISOString():undefined});}
 validate(plan,action){this.scope(plan.id);if(!actionPermitted(plan,action))throw failure('PLATFORM_OPERATION_DENIED');const ad=this.lastAds.get(plan.id);if(!ad)throw failure('LIVE_STATE_NOT_FRESH');if(action.budget!==undefined&&action.kind!=='boost'&&action.budget!==plan.budget)buildOperation('budget',ad,String(action.budget));if(action.roi!==undefined&&action.roi!==plan.roi)buildOperation('roi',ad,String(action.roi));}
 async prepare(id,field,value){this.scope(id);return prepareOperation(this.api,{accountId:ACCOUNT_ID,id,action:field,value},'automation:'+id);}
 async commit(id,prepared){this.scope(id);return commitOperation(this.api,{accountId:ACCOUNT_ID,planId:id,token:prepared.token,confirmed:true},'automation:'+id);}
 async rawWindow(id,start,end){
  this.scope(id);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%1000||end%1000||start>=end||end>this.clock()||end-start>2*DAY)throw failure('WINDOW_RANGE_INVALID');
  const body=structuredClone(D.dataOverview);body.StartTime=stamp(start);body.EndTime=stamp(end-1000);delete body.ComparisonParams;body.Dimensions=['ad_id'];body.Metrics=['total_order_settle_amount_for_roi2_1h','stat_cost_for_overall_roi2'];
  for(const c of body.Filters.Conditions){if(c.Field==='ad_id')c.Values=[id];if(c.Field==='advertiser_id')c.Values=[ACCOUNT_ID];if(c.Field==='roi2_project_scene_fork')c.Values=['0'];}
  const overall=await this.call(PATHS.query,body,{intent:'read',reqFrom:'automation_window_probe'});body.Metrics=['stat_cost_for_roi2'];for(const c of body.Filters.Conditions)if(c.Field==='roi2_project_scene_fork')c.Values=['1'];const primary=await this.call(PATHS.query,body,{intent:'read',reqFrom:'automation_window_probe'});
  const a=metricMap(overall.data?.StatsData?.Totals||{}),b=metricMap(primary.data?.StatsData?.Totals||{}),value=(map,k)=>numeric(map.get(k)?.Value??map.get(k)?.value);
  return {start,end,accountId:ACCOUNT_ID,planId:id,metricDefinition:'overall-net/overall-cost;fork1-primary',revenue:value(a,'totalordersettleamountforroi21h'),roiCost:value(a,'statcostforoverallroi2'),basicSpend:value(b,'statcostforroi2'),complete:false,precisionVerified:false};
 }
 async window(id,start,end){
  if(this.windowMode!=='full-hour')throw failure('EXACT_WINDOW_PRECISION_UNSUPPORTED');
  this.scope(id);const result=await readRoiHours(this.api,{accountId:ACCOUNT_ID,id,from:new Date(start).toISOString(),to:new Date(end).toISOString()},{clock:this.clock,gapMs:this.gapMs});
  const createdAt=Number(this.lastAds.get(id)?.createTime)*1000;
  const present=new Set(result.rows.map(r=>r.time));
  // The plan did not exist in these complete hours; missing later hours remain errors.
  for(let time=start;time<end;time+=3600000)if(!present.has(time)&&Number.isFinite(createdAt)&&time+3600000<=createdAt)result.rows.push({time,spend:0,revenue:0,roiCost:0,full:true,preCreation:true});
  return aggregateHourlyWindow(result,{accountId:ACCOUNT_ID,planId:id,start,end});
 }
}
