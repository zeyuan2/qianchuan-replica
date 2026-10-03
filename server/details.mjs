import fs from 'node:fs/promises';
import {ACCOUNT_ID,PATHS,period,metricMap} from './api.mjs';
import {BridgeError} from './bridge.mjs';
import {parseMetricConfiguration,validateMetricSelection} from '../dist/metric-config.mjs';
const T=JSON.parse(await fs.readFile(new URL('./detail-templates.json',import.meta.url),'utf8'));
const copy=v=>structuredClone(v);
export const DETAIL_PATHS={basic:'/ad/api/creation/v1/ad/ad-detail-basic',plus:'/ad/api/creation/v1/ad/ad-detail-plus',product:'/ad/api/pmc/v1/ad/product/list',aweme:'/ad/api/pmc/v1/ad/get_ad_aweme_list',material:'/ad/api/pmc/v1/uni-promotion/material/list-required',materialOptional:'/ad/api/pmc/v1/uni-promotion/material/list-optional',log:'/ad/api/pmc/v1/ad/get_opt_log',roi:'/ad/api/creation/v1/roi2-goal/batch-get-suggestion'};
const norm=s=>String(s).replace(/_/g,'').toLowerCase();
function filterPlan(body,id){for(const c of body.Filters?.Conditions||[]){if(c.Field==='ad_id')c.Values=[id];if(c.Field==='advertiser_id')c.Values=[ACCOUNT_ID];}return body;}
function recordMetric(raw){return Object.fromEntries(metricMap(raw||{}));}
function textDim(dim,key){const v=metricMap(dim).get(norm(key));return v?.valueStr??v?.ValueStr??v?.value??v?.Value??'';}
export async function planInfo(api,id,force=false){
 if(!/^\d{10,25}$/.test(id)||!api.planCache.has(id))throw new BridgeError('请从当前账户计划列表打开该计划','PLAN_NOT_LOADED',400);
 api.detailCache??=new Map();const saved=api.detailCache.get(id);if(saved&&!force&&Date.now()-saved.time<60000)return saved.data;
 const response=await api.call(DETAIL_PATHS.basic,undefined,{method:'GET',query:{adid:id,needCanDeliveryVerticalImage:true}});
 const ad=response.data.adDetailInfo;
 if(String(ad?.id)!==id||ad.marGoal!==1||(ad.advId&&String(ad.advId)!==ACCOUNT_ID))throw new BridgeError('计划详情与商品计划不匹配','ACCOUNT_MISMATCH',502);
 const data={ad,raw:response.data};api.detailCache.set(id,{time:Date.now(),data});return data;
}
async function configuration(api,key){api.detailConfigs??=new Map();if(api.detailConfigs.has(key))return api.detailConfigs.get(key);const body=T[key+'Config'];if(!body)return null;const result=await api.call(PATHS.config,copy(body));const cfg=parseMetricConfiguration(result,{honorLockDefault:key!=='data'});api.detailConfigs.set(key,cfg);return cfg;}
export async function loadDetail(api,q){
 if(q.accountId!==ACCOUNT_ID)throw new BridgeError('账户不匹配','ACCOUNT_MISMATCH',400);
 const id=String(q.id),info=await planInfo(api,id),p=period(q.from,q.to),page=Math.max(1,Number(q.page)||1),pageSize=Math.min(100,Math.max(1,Number(q.pageSize)||10));
 const tab=q.tab||'data',kind=tab==='material'?(q.materialType||'video'):tab==='control'?(q.controlType||'boost'):tab;
 const cfg=await configuration(api,kind),metrics=cfg?validateMetricSelection(cfg,q.metrics||cfg.selected):[];
 const base={accountId:ACCOUNT_ID,planId:id,name:info.ad.name,tab,kind,from:q.from,to:q.to,page,pageSize,config:cfg,metrics,info:info.ad,source:'live',updatedAt:new Date().toISOString()};
 if(tab==='detail')return {...base,products:info.raw.goodsInfos||[],rows:[]};
 if(tab==='data'){
  const overview=filterPlan(copy(T.dataOverview),id),trend=filterPlan(copy(T.dataTrend),id);
  for(const b of [overview,trend]){b.StartTime=p.start;b.EndTime=p.end;b.Metrics=metrics;}
  overview.ComparisonParams={RatioStartTime:p.compareStart,RatioEndTime:p.compareEnd};
  if(q.from!==q.to){trend.Dimensions=trend.Dimensions.map(d=>d==='stat_time_hour'?'stat_time_day':d);trend.OrderBy=[{Type:1,Field:'stat_time_day'}];}
  const a=await api.call(PATHS.query,overview),b=await api.call(PATHS.query,trend);
  return {...base,totals:recordMetric(a.data.StatsData.Totals),rows:(b.data.StatsData.Rows||[]).map(row=>({id:JSON.stringify(row.Dimensions),name:textDim(row.Dimensions,'stat_time_hour')||textDim(row.Dimensions,'stat_time_day'),metrics:recordMetric(row.Metrics)})),total:Number(b.data.StatsData.TotalCount||0)};
 }
 if(tab==='product'){
  const body={...copy(T.product),adId:id,startTime:p.start,endTime:p.listEnd,page,pageSize,metrics:metrics.join(',')};if(q.search)body.keyword=String(q.search);
  const response=await api.call(DETAIL_PATHS.product,body),d=response.data;
  return {...base,total:Number(d.pagination?.totalNum||0),totals:recordMetric(d.totalMetrics?.metrics||d.totalMetrics),rows:(d.adProductInfos||[]).map(v=>({id:v.productInfo.id,name:v.productInfo.name,image:v.productInfo.mainImageUrl||v.productInfo.image?.urlList?.[0],statusCode:v.adProductAuditStatus,statusReason:Object.values(v.adProductDisableReason?.productDeliveryTypeMap||{}).join('；'),metrics:recordMetric(v.materialStatsMap),related:v.awemeUsers?.map(a=>d.awemeUserInfos?.[a.awemeUid]?.name||a.awemeUid).join('、')}))};
 }
 if(tab==='aweme'){
  const body=copy(T.aweme);body.AdID=id;body.Metrics=metrics;body.Filter.StartTime=p.start;body.Filter.EndTime=p.listEnd;body.Filter.SearchKeyowrd=q.search||'';body.PageParams={Page:page,PageSize:pageSize};
  const {data:d}=await api.call(DETAIL_PATHS.aweme,body);
  return {...base,total:Number(d.totalWithoutZero??d.pagination?.totalNum??0),totals:recordMetric(d.totalMetrics?.metrics||d.totalMetrics),rows:(d.adAwemeUsers||[]).map(v=>({id:v.awemeUid,name:v.awemeUserInfo?.name||'无抖音号（仅含商城流量）',displayId:v.awemeUserInfo?.showId||v.awemeUserInfo?.shortId,image:v.awemeUserInfo?.smallAvatar?.urlList?.[0],related:(v.productInfos||[]).map(p=>p.name).join('；'),metrics:recordMetric(d.adAwemeUserStatsMap?.[v.awemeUid]?.metrics||d.adAwemeUserStatsMap?.[v.awemeUid])}))};
 }
 if(tab==='material'){
  if(!['video','image','atlas','title'].includes(kind))throw new BridgeError('素材类型无效','INVALID_QUERY',400);
  const body=filterPlan(copy(q.eligible?T.heatCandidates:T[kind]),id);body.StartTime=p.start;body.EndTime=p.listEnd;body.Metrics=metrics;body.PageParams={Limit:pageSize,Offset:(page-1)*pageSize};
  const {data}=await api.call(DETAIL_PATHS.material,body,{reqFrom:'uni-prom-creative-tab-list'}),d=data.statsData;
  const rows=(d.rows||[]).map(row=>{
   const dimensions=row.dimensions||{};const materialId=textDim(dimensions,'material_id');
   let media;for(const k of ['roi2_material_image_play_info','roi2_material_video_play_info','roi2_material_image_agg_play_info']){const raw=textDim(dimensions,k);if(raw){try{media=JSON.parse(raw);}catch{}break;}}
   return {id:materialId,name:textDim(dimensions,'roi2_material_image_name')||textDim(dimensions,'roi2_material_video_name')||textDim(dimensions,'roi2_material_image_agg_name')||textDim(dimensions,'roi2_title_material_v3')||media?.Title||materialId,statusText:textDim(dimensions,'roi2_material_status'),createdAt:textDim(dimensions,'roi2_material_upload_time'),image:media?.Images?.[0]?.WebUrl,metrics:recordMetric(row.metrics)};
  });
  if(q.eligible&&rows.length){
   const pairs=api.planCache.get(id).extra?.pairs||{},author=String(info.ad.creativeSetting?.iesCoreUserId||Object.values(pairs).flat()[0]||'0');
   const optional=await api.call(DETAIL_PATHS.materialOptional,{ObjectType:1,ObjectID:author,LegoMidList:rows.map(r=>r.id),OptionalModules:['material_heat_operation_virtual_module','audit_info_module'],MaterialType:1,MarGoal:1,AggregateAid:id});
   for(const row of rows){const eligibility=optional.data.materialInfoMap?.[row.id]?.canMaterialHeat;row.canHeat=eligibility?.enable===true;row.reason=eligibility?.reason||'该素材状态不支持追投';}
   api.heatEligibility??=new Map();const old=api.heatEligibility.get(id);const ids=old&&Date.now()-old.time<90000?old.ids:new Set();rows.filter(r=>r.canHeat).forEach(r=>ids.add(r.id));api.heatEligibility.set(id,{ids,time:Date.now()});
  }
  return {...base,rows,total:Number(d.totalCount||0),totals:recordMetric(d.totals)};
 }
 if(tab==='control'){
  if(!['boost','heat','search'].includes(kind))throw new BridgeError('调控类型无效','INVALID_QUERY',400);
  const body=copy(T[kind]);body.Params.AdFilter.AssistTaskFilter.PrimaryAID=id;body.Params.AdFilter.DataTimeRange={StartTime:p.start,EndTime:p.listEnd};body.Params.PageParams={Page:page,PageSize:pageSize};body.Params.Metrics=metrics;
  const {data:d}=await api.call(PATHS.plans,body);
  if(d.adInfos?.some(a=>String(a.advId)!==ACCOUNT_ID))throw new BridgeError('调控任务账户不匹配','ACCOUNT_MISMATCH',502);
  return {...base,total:Number(d.pagination?.totalNum||0),rows:(d.adInfos||[]).map(a=>({id:a.id,name:a.name,statusText:a.adDeliveryName,budget:(Number(a.budget)/100000).toFixed(2),duration:((Number(a.endTime)-Number(a.startTime))/3600).toFixed(1),createdAt:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date(Number(a.createTime)*1000)),metrics:recordMetric(d.adStatsMap?.[a.id]?.metrics)}))};
 }
 if(tab==='log'){
  const end=new Date(q.to+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+1);
  const {data:d}=await api.call(DETAIL_PATHS.log,undefined,{method:'GET',query:{objectID:id,startTime:p.start,endTime:end.toISOString().slice(0,10)+' 00:00:00',currentPage:page,pageSize,type:1}});
  return {...base,rows:d.logs||[],total:Number(d.pagination?.totalNum||0)};
 }
 throw new BridgeError('该详情入口尚未完成规则核验','NOT_VERIFIED',400);
}
