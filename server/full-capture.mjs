import fs from 'node:fs/promises';
import {ACCOUNT_ID,PATHS,period,today,mapPlan,metricMap,metricValue} from './api.mjs';
import {BridgeError} from './bridge.mjs';
const T=JSON.parse(await fs.readFile(new URL('./api-templates.json',import.meta.url),'utf8'));
const clone=structuredClone;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function collectFullSnapshot(api,{day=today(),from=day,to=from,requestGapMs=1200,onProgress=()=>{},now=()=>new Date()}={}) {
 if(api.replay)throw new BridgeError('自动采集不能使用历史回放数据','REPLAY_READONLY',409);
 const startedAt=now().toISOString(),p=period(from,to,now()),config=await api.bootstrap();
 const topMetrics=config.top.metrics.map(m=>m.key),tableMetrics=config.table.metrics.map(m=>m.key);
 const metrics=tableMetrics.flatMap(k=>T.plans.Params.Metrics.includes(k+'_primary')?[k,k+'_primary']:[k]);
 let requests=0;
 async function read(path,body){if(requests++&&requestGapMs)await pause(requestGapMs);return api.call(path,body,{intent:'read',reqFrom:'product_readonly_monitor'});}
 const summaryBody=clone(T.summary);summaryBody.Metrics=metrics;
 summaryBody.AdFilter={...summaryBody.AdFilter,MarGoal:1,UniPromShopFilter:{UniPromShopView:1},StartTime:p.start,EndTime:p.listEnd};
 delete summaryBody.SearchFilter;delete summaryBody.HavingFilter;delete summaryBody.AdFilter.AdStatusFilterType;
 const totalOf=r=>{const n=Number(r?.data?.totalNum);if(!Number.isSafeInteger(n)||n<0||n>100000)throw new BridgeError('计划汇总条数无效','INCOMPLETE_CAPTURE',502);return n;};
 let plans,summary,pageEvidence;
 for(let attempt=0;attempt<2;attempt++){
  const before=await read(PATHS.summary,summaryBody),target=totalOf(before),unique=new Map();let duplicate=false;pageEvidence=[];
  const pages=Math.max(1,Math.ceil(target/100));
  for(let page=1;page<=pages;page++){
   onProgress({phase:'plans',page,pages,expected:target,collected:unique.size,attempt});
   const body=clone(T.plans);body.Params.PageParams={Page:page,PageSize:100};body.Params.Metrics=metrics;
   body.Params.OrderBy={Field:'create_time',Type:1};
   body.Params.AdFilter={...body.Params.AdFilter,MarGoal:1,UniPromShopFilter:{UniPromShopView:1},DataTimeRange:{StartTime:p.start,EndTime:p.listEnd}};
   delete body.Params.SearchFilter;delete body.Params.HavingFilter;delete body.Params.AdFilter.AdStatusFilterType;
   const {data}=await read(PATHS.plans,body),ads=data?.adInfos;
   if(!Array.isArray(ads)||Number(data.pagination?.page)!==page||Number(data.pagination?.pageSize)!==100)throw new BridgeError('分页响应与请求不一致，保留上一轮完整数据','INCOMPLETE_CAPTURE',502);
   for(const ad of ads){
    if(typeof ad.id!=='string'||String(ad.advId)!==ACCOUNT_ID||ad.marGoal!==1)throw new BridgeError('发现非目标账户、非商品计划或不安全的计划ID','ACCOUNT_MISMATCH',502);
    if(unique.has(ad.id))duplicate=true;
    unique.set(ad.id,mapPlan(ad,data.adStatsMap?.[ad.id]));
   }
   pageEvidence.push({page,rows:ads.length});
  }
  summary=await read(PATHS.summary,summaryBody);const after=totalOf(summary);
  if(target===after&&unique.size===after&&!duplicate){plans=[...unique.values()];break;}
  if(attempt===1)throw new BridgeError(`采集期间计划条数发生变化或分页不完整（读取${unique.size}条，汇总${after}条），保留上轮数据，下轮重试`,'INCOMPLETE_CAPTURE',502);
 }
 onProgress({phase:'metrics',collected:plans.length,expected:plans.length});
 const overview=clone(T.overview);overview.StartTime=p.start;overview.EndTime=p.end;overview.Metrics=topMetrics;overview.ComparisonParams={RatioStartTime:p.compareStart,RatioEndTime:p.compareEnd};
 const trend=clone(T.trend);trend.StartTime=p.start;trend.EndTime=p.end;trend.Metrics=topMetrics;
 if(from!==to){trend.Dimensions=['stat_time_day'];trend.OrderBy=[{Type:1,Field:'stat_time_day'}];}
 const top=await read(PATHS.query,overview),series=await read(PATHS.query,trend);
 if(!top.data?.StatsData?.Totals||!Array.isArray(series.data?.StatsData?.Rows))throw new BridgeError('指标响应不完整','INCOMPLETE_CAPTURE',502);
 const topMap=metricMap(top.data.StatsData.Totals);
 const mappedMetrics=topMetrics.map(key=>{const v=metricValue(topMap,key);return {key,label:config.top.metrics.find(m=>m.key===key).label,value:v?.text??'-',raw:v?.value??null,change:v?.comparison?.RatioStr??'',trend:series.data.StatsData.Rows.map(r=>({time:Object.values(r.Dimensions||{})[0]?.ValueStr??Object.values(r.Dimensions||{})[0]?.Value,value:metricValue(metricMap(r.Metrics),key)?.value??null}))};});
 const fetchedAt=now().toISOString();
 const snapshot={version:1,accountId:ACCOUNT_ID,source:'live',complete:true,allowWrites:false,from,to,total:plans.length,plans,metrics:mappedMetrics,totals:{metrics:Object.fromEntries(metricMap(summary.data.totalMetrics?.metrics))},topConfig:config.top,tableConfig:config.table,period:p,startedAt,fetchedAt,page:1,pageSize:100,capture:{requests,pages:pageEvidence,countVerified:true}};
 for(const plan of plans)api.planCache.set(plan.id,plan);
 return snapshot;
}
