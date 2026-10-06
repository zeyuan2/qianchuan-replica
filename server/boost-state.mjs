import fs from 'node:fs/promises';
import {ACCOUNT_ID,PATHS,today} from './api.mjs';
import {BridgeError} from './bridge.mjs';
const template=JSON.parse(await fs.readFile(new URL('./detail-templates.json',import.meta.url),'utf8')).boost;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const isGlobalFailure=e=>['AUTH_REQUIRED','ACCOUNT_MISMATCH','BRIDGE_OFFLINE','BRIDGE_TIMEOUT','WRITE_BRIDGE_REQUIRED','READONLY_MODE','OPERATOR_LOGIN_REQUIRED','RATE_LIMITED','INVALID_RESPONSE'].includes(e.upstreamCode||e.code)||/登录|连接断开|限流|频繁|系统繁忙|HTTP (?:429|5\d\d)/i.test(e.message||'');
const epoch=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?(n<1e12?n*1000:n):null;};
export function classifyBoostTask(ad,now=Date.now()){
 const start=epoch(ad.startTime),end=epoch(ad.endTime),status=String(ad.adDeliveryName||'');let state='unknown';
 if(start&&end&&end>=start){if(end>now&&!/已完成|已结束|已终止|已取消|已删除/.test(status))state='active';else if(end<=now&&/已完成|已结束|已终止|已取消|已删除/.test(status))state='ended';}
 return {id:String(ad.id),name:String(ad.name||''),status,startAt:start?new Date(start).toISOString():null,endAt:end?new Date(end).toISOString():null,budget:Number(ad.budget)/100000,duration:start&&end?(end-start)/3600000:null,state};
}
export class BoostState {
 constructor({api,clock=Date.now,gapMs=1200,beforeRead=async()=>{}}){Object.assign(this,{api,clock,gapMs,beforeRead});this.queue=Promise.resolve();this.cache=new Map();}
 inspect(id,{force=false,since}={}){
  if(!this.api.planCache.has(id))return Promise.reject(new BridgeError('请从当前账户计划列表核实起量任务','PLAN_NOT_LOADED',400));
  const saved=this.cache.get(id);
  if(!force&&saved&&this.clock()-Date.parse(saved.checkedAt)<60000&&!saved.tasks.some(t=>t.state==='active'&&Date.parse(t.endAt)<=this.clock()))return Promise.resolve(saved);
  const job=this.queue.catch(()=>{}).then(async()=>{try{const value=await this.load(id,since);this.cache.set(id,value);return value;}finally{if(this.gapMs)await sleep(this.gapMs);}});this.queue=job;return job;
 }
 async load(id,since){
  const now=this.clock(),to=today(new Date(now));let from=today(new Date(now-30*86400000));if(since&&Number.isFinite(Date.parse(since)))from=[from,today(new Date(Date.parse(since)-86400000))].sort()[0];
  const tasks=[],seen=new Set();let expected=null;
  for(let page=1;;page++){
   await this.beforeRead();const body=structuredClone(template);body.Params.AdFilter.AssistTaskFilter.PrimaryAID=id;
   body.Params.AdFilter.DataTimeRange={StartTime:from+' 00:00:00',EndTime:to+' 23:59:59'};body.Params.PageParams={Page:page,PageSize:100};
   const {data}=await this.api.call(PATHS.plans,body,{reqFrom:'replica_boost_status'});const total=Number(data?.pagination?.totalNum),rows=data?.adInfos;
   if(!Array.isArray(rows)||!Number.isSafeInteger(total)||total<0||Number(data.pagination.page)!==page||Object.keys(data.moduleErrors||{}).length||expected!==null&&total!==expected)throw new BridgeError('起量任务列表不完整或查询中发生变化，请重新核实','BOOST_STATUS_UNKNOWN',409);
   expected=total;
   for(const ad of rows){if(String(ad.advId)!==ACCOUNT_ID||ad.marGoal!==1)throw new BridgeError('起量任务账户不匹配','ACCOUNT_MISMATCH',502);if(!ad.id||seen.has(String(ad.id)))throw new BridgeError('起量任务分页重复，请重新核实','BOOST_STATUS_UNKNOWN',409);seen.add(String(ad.id));tasks.push(classifyBoostTask(ad,now));}
   if(tasks.length===expected)break;if(!rows.length||tasks.length>expected)throw new BridgeError('起量任务分页缺失，请重新核实','BOOST_STATUS_UNKNOWN',409);if(this.gapMs)await sleep(this.gapMs);
  }
  return {id,state:tasks.some(t=>t.state==='active')?'active':tasks.some(t=>t.state==='unknown')?'unknown':'eligible',tasks,complete:true,checkedAt:new Date(this.clock()).toISOString()};
 }
}
