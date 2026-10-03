import fs from 'node:fs/promises';
import {parseMetricConfiguration,validateMetricSelection} from '../dist/metric-config.mjs';
import {BridgeError} from './bridge.mjs';

export const ACCOUNT_ID='1000000000000000';
export const PATHS={config:'/ad/api/data/v1/common/getUserConfAndDataSet',query:'/ad/api/data/v1/common/statQuery',plans:'/ad/api/pmc/v1/uni-promotion/ad/list-required',summary:'/ad/api/pmc/v1/uni-promotion/ad/list-summary',optional:'/ad/api/pmc/v1/uni-promotion/ad/list-optional'};
const templates=JSON.parse(await fs.readFile(new URL('./api-templates.json',import.meta.url),'utf8'));
const clone=v=>structuredClone(v);
const norm=s=>String(s).replace(/_/g,'').toLowerCase();
const shanghaiParts=time=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(time).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
export function today(time=new Date()){const p=shanghaiParts(time);return `${p.year}-${p.month}-${p.day}`;}
function dateValid(date){try{return /^\d{4}-\d{2}-\d{2}$/.test(date)&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;}catch{return false;}}
function shift(date,days){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function period(from,to,time=new Date()){
 if(!dateValid(from)||!dateValid(to)||from>to||to>today(time))throw new BridgeError('请选择有效的日期范围','INVALID_QUERY',400);
 const p=shanghaiParts(time),endClock=to===today(time)?`${p.hour}:${p.minute}:${p.second}`:'23:59:59';
 const days=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
 return {start:from+' 00:00:00',end:to+' '+endClock,listEnd:to+' 23:59:59',compareStart:shift(from,-days)+' 00:00:00',compareEnd:shift(to,-days)+' '+endClock};
}
function patchFilterDates(filter,p){
 for(const c of filter?.Conditions??[]){
  const key=c.Field??c.Key??c.Name;
  if(/advertiser/i.test(key||'')){if(c.Value)c.Value=ACCOUNT_ID;if(c.Values)c.Values=[ACCOUNT_ID];}
 }
 return filter;
}
export function metricMap(raw={}){const map=new Map();for(const[k,v]of Object.entries(raw))map.set(norm(k),v);return map;}
export function metricValue(map,key){const m=map.get(norm(key));if(!m)return null;return {value:m.Value??m.value??null,text:m.ValueStr??m.valueStr??'-',comparison:m.Comparison??m.comparison??null};}
export function mapPlan(ad,stats={}){
 const metrics=metricMap(stats.metrics||{});
 const services=[...(ad.overallRoiCostItems?.includes(2)?['含达人佣金出价']:[]),...(ad.overallRoiCostItems?.includes(1)?['千川星选素材投放']:[]),'基础投放'];
 return {id:String(ad.id),name:ad.name||'',accountId:String(ad.advId),marGoal:ad.marGoal,status:ad.adDeliveryName==='投放中'?'active':ad.adDeliveryName?.includes('暂停')?'paused':'other',isEnabled:ad.adOptType===0,statusText:ad.adDeliveryName||'未知',budget:Number(ad.budget)/100000,roiTarget:ad.ecpRoi2Goal,budgetMode:ad.budgetMode,budgetRaw:ad.budget,service:services.join(' / '),metrics:Object.fromEntries(metrics),operations:ad.operation||{},raw:ad};
}
export class QianchuanApi {
 constructor(bridge,{replay=false,allowWrites=false}={}){this.bridge=bridge;this.replay=replay;this.allowWrites=allowWrites&&!replay;this.config=null;this.configAt=0;this.configPromise=null;this.audit=[];this.planCache=new Map();}
 async call(path,body,{method='POST',reqFrom='replica_product_page',query={},intent='read'}={}) {
  if(this.replay)return this.fixture(path,body);
  if(intent==='write'&&!this.allowWrites)throw new BridgeError('当前为只读模式，未向千川提交','READONLY_MODE',409);
  if(!this.bridge.status().connected)throw new BridgeError('请连接已登录目标账户的千川浏览器','BRIDGE_OFFLINE',503);
  const result=await this.bridge.request({accountId:ACCOUNT_ID,path,method,query:{reqFrom,gfversion:'1.0.0.2186',...query,aavid:ACCOUNT_ID},body,intent,confirmedOperation:intent==='write'});
  if(result.status===401||result.status===403||/login|passport/i.test(result.finalUrl||''))throw new BridgeError('千川登录已失效或当前账号无访问权限，请在原页面重新登录','AUTH_REQUIRED',401);
  let data;try{data=JSON.parse(result.text);}catch{throw new BridgeError('千川返回非JSON数据，请检查登录状态','INVALID_RESPONSE',502);}
  if(result.status<200||result.status>=300)throw new BridgeError('千川请求失败（HTTP '+result.status+'）','UPSTREAM_ERROR',502);
  if(data.status_code!==0){const message=data.message||data.msg||'千川接口返回异常';throw new BridgeError(message,/登录|login|unauth|认证/i.test(message)?'AUTH_REQUIRED':'UPSTREAM_ERROR',/登录|login|unauth|认证/i.test(message)?401:502);}
  return data;
 }
 async bootstrap(force=false){
  if(this.config&&!force&&Date.now()-this.configAt<3600000)return this.config;
  if(this.configPromise)return this.configPromise;
  this.configPromise=(async()=>{
   const topRaw=await this.call(PATHS.config,clone(templates.overviewConfig),{reqFrom:'uniDataOverview_config'});
   const tableRaw=await this.call(PATHS.config,clone(templates.tableConfig),{reqFrom:'uniPromotionTable_config'});
   const top=parseMetricConfiguration(topRaw,{honorLockDefault:false}),table=parseMetricConfiguration(tableRaw);
   this.config={accountId:ACCOUNT_ID,top,table,source:this.replay?'recorded':'live',rawModules:{top:topRaw.data.ModuleInfo.ModuleId,table:tableRaw.data.ModuleInfo.ModuleId}};this.configAt=Date.now();return this.config;
  })();try{return await this.configPromise;}finally{this.configPromise=null;}
 }
 async dashboard(query){
  const startedAt=Date.now();if(query.accountId!==ACCOUNT_ID)throw new BridgeError('账户不匹配','ACCOUNT_MISMATCH',400);
  const config=await this.bootstrap(),p=period(query.from,query.to);
  const topMetrics=validateMetricSelection(config.top,query.topMetrics||config.top.selected),tableMetrics=validateMetricSelection(config.table,query.tableMetrics||config.table.selected);
  const page=Number(query.page||1),pageSize=Number(query.pageSize||10);
  if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new BridgeError('分页参数无效','INVALID_QUERY',400);
  const overview=clone(templates.overview);overview.StartTime=p.start;overview.EndTime=p.end;overview.Metrics=topMetrics;overview.ComparisonParams={RatioStartTime:p.compareStart,RatioEndTime:p.compareEnd};patchFilterDates(overview.Filters,p);
  const trend=clone(templates.trend);trend.StartTime=p.start;trend.EndTime=p.end;trend.Metrics=topMetrics;if(query.from!==query.to){trend.Dimensions=['stat_time_day'];trend.OrderBy=[{Type:1,Field:'stat_time_day'}];}
  const plans=clone(templates.plans);const params=plans.Params;
  params.PageParams={Page:page,PageSize:pageSize};params.AdFilter.DataTimeRange={StartTime:p.start,EndTime:p.listEnd};
  if(query.product==='managed')params.SophonxDataSetKey='overall_roi_unishop_promotion_list_for_product_v2';
  params.AdFilter.MarGoal=1;params.AdFilter.UniPromShopFilter={UniPromShopView:query.product==='managed'?2:1};
  params.Metrics=tableMetrics.flatMap(k=>templates.plans.Params.Metrics.includes(k+'_primary')?[k,k+'_primary']:[k]);
  params.OrderBy={Field:query.sortField||'create_time',Type:query.sortType==='asc'?1:2};
  if(query.search)params.SearchFilter={Type:Number(query.searchOption||1),Keyword:String(query.search)};
  const statuses=new Set([0,13,2,15,16,4,11,22,10,23,14,6,24,19,1,3,30,21]);
  const status=Number(query.status==='all'?0:query.status||0);if(!statuses.has(status))throw new BridgeError('状态筛选参数无效','INVALID_QUERY',400);
  if(status)params.AdFilter.AdStatusFilterType=status;
  if(query.service&&query.service!=='all'){const service=Number(query.service);if(![1,2,3].includes(service))throw new BridgeError('营销服务参数无效','INVALID_QUERY',400);params.AdFilter.OverallROICostItems=query.serviceMode==='exclude'?[service,4]:[service];params.AdFilter.OverallROICostItemsFilterType=query.serviceMode==='exclude'?'0':'1';}
  if(query.costStatus&&query.costStatus!=='all')params.HavingFilter={Metric:'stat_cost',IsZero:query.costStatus==='zero'};
  const summary=clone(templates.summary);summary.Metrics=params.Metrics;summary.SophonxDataSetKey=params.SophonxDataSetKey;summary.Dimensions=params.Dimensions;summary.AdFilter={...summary.AdFilter,...params.AdFilter,StartTime:p.start,EndTime:p.listEnd};delete summary.AdFilter.DataTimeRange;
  if(params.SearchFilter)summary.SearchFilter=params.SearchFilter;
  if(params.HavingFilter)summary.HavingFilter=params.HavingFilter;
  const topRaw=await this.call(PATHS.query,overview,{reqFrom:'uniDataOverview'});
  const trendRaw=await this.call(PATHS.query,trend,{reqFrom:'uniDataOverview_trend_today'});
  const listRaw=await this.call(PATHS.plans,plans);
  const summaryRaw=await this.call(PATHS.summary,summary);
  let optionalRaw={data:{}};if(listRaw.data.sessionId){const optional=clone(templates.optional);optional.SessionId=listRaw.data.sessionId;optional.SessionID=listRaw.data.sessionId;optionalRaw=await this.call(PATHS.optional,optional);}
  const extra=optionalRaw.data||{},data=listRaw.data;
  const ads=data.adInfos||[];
  if(ads.some(a=>String(a.advId)!==ACCOUNT_ID||a.marGoal!==1))throw new BridgeError('响应中含非目标账户或非商品计划，已拒绝更新','ACCOUNT_MISMATCH',502);
  const mapped=ads.map(ad=>{const plan=mapPlan(ad,data.adStatsMap?.[ad.id]);plan.extra={goods:extra.adGoodsMap?.[ad.id]??data.adGoodsMap?.[ad.id],pairs:extra.adId2PairsMap?.[ad.id],materials:extra.adShowMaterialInfoMap?.[ad.id]};this.planCache.set(plan.id,plan);return plan;});
  const topMap=metricMap(topRaw.data.StatsData.Totals);
  const rows=trendRaw.data.StatsData.Rows||[];
  const metrics=topMetrics.map(key=>{const def=config.top.metrics.find(m=>m.key===key),v=metricValue(topMap,key);return {key,label:def.label,value:v?.text??'-',raw:v?.value??null,change:v?.comparison?.RatioStr??'',trend:rows.map(r=>({time:Object.values(r.Dimensions||{})[0]?.ValueStr??Object.values(r.Dimensions||{})[0]?.Value,value:metricValue(metricMap(r.Metrics),key)?.value??null}))};});
  const totalMetrics=Object.fromEntries(metricMap(summaryRaw.data.totalMetrics?.metrics));
  const result={source:this.replay?'recorded':'live',allowWrites:this.allowWrites,accountId:ACCOUNT_ID,from:query.from,to:query.to,metrics,plans:mapped,totals:{metrics:totalMetrics},total:Number(summaryRaw.data.totalNum),page: data.pagination?.page??page,pageSize:data.pagination?.pageSize??pageSize,topConfig:config.top,tableConfig:config.table,fetchedAt:new Date().toISOString(),period:p};
  this.audit.push({startedAt,finishedAt:Date.now(),accountId:ACCOUNT_ID,from:query.from,to:query.to,page,source:result.source,total:result.total});if(this.audit.length>100)this.audit.shift();return result;
 }
 async fixture(path,body){let name;if(path===PATHS.config)name=body.ModuleId===templates.overviewConfig.ModuleId?'035-getUserConfAndDataSet':'037-getUserConfAndDataSet';else if(path===PATHS.query)name=body.Dimensions?.includes('marketing_goal')?'045-statQuery':'046-statQuery';else if(path===PATHS.plans)name='049-list-required';else if(path===PATHS.summary)name='050-list-summary';else if(path===PATHS.optional)name='051-list-optional';else throw new BridgeError('样本模式不支持该请求','NOT_AVAILABLE',400);return JSON.parse(await fs.readFile(new URL('../fixtures/'+name+'.response.json',import.meta.url),'utf8'));}
}
