const ACCOUNT='1000000000000000';
import {allowedWrite} from './write-policy.mjs';
const READ_PATHS=new Set(['/ad/api/data/v1/common/getUserConfAndDataSet','/ad/api/data/v1/common/statQuery','/ad/api/pmc/v1/uni-promotion/ad/list-required','/ad/api/pmc/v1/uni-promotion/ad/list-summary','/ad/api/pmc/v1/uni-promotion/ad/list-optional']);
for(const path of ['/ad/api/creation/v1/ad/ad-detail-basic','/ad/api/creation/v1/ad/ad-detail-plus','/ad/api/pmc/v1/ad/product/list','/ad/api/pmc/v1/ad/get_ad_aweme_list','/ad/api/pmc/v1/uni-promotion/material/list-required','/ad/api/pmc/v1/uni-promotion/material/list-optional','/ad/api/pmc/v1/ad/get_opt_log','/ad/api/creation/v1/roi2-goal/batch-get-suggestion'])READ_PATHS.add(path);
let active=false;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function execute(job){
 const read=job.accountId===ACCOUNT&&job.query?.aavid===ACCOUNT&&['GET','POST'].includes(job.method)&&job.intent==='read'&&READ_PATHS.has(job.path);
 if(!read&&!allowedWrite(job))return {error:{code:'SCOPE_DENIED',message:'仅允许目标账户商品查询或经过登录确认的指定计划操作'}};
 const tabs=await chrome.tabs.query({url:'https://qianchuan.jinritemai.com/*'});
 const tab=tabs.find(t=>new URL(t.url).searchParams.get('aavid')===ACCOUNT&&/\/overall-prom|\/uni-prom/.test(new URL(t.url).pathname));
 if(!tab)return {error:{code:'AUTH_REQUIRED',message:'请打开并登录目标账户的千川推商品页面'}};
 const result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async spec=>{
  if(new URL(location.href).searchParams.get('aavid')!==spec.accountId)return {error:{code:'ACCOUNT_MISMATCH',message:'原页账户已切换'}};
  const url=new URL(spec.path,location.origin);for(const[k,v]of Object.entries(spec.query||{}))url.searchParams.set(k,v);
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
  try{const r=await fetch(url,{method:spec.method,credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(spec.body),signal:controller.signal});return {status:r.status,text:await r.text(),finalUrl:r.url};}catch(e){return {error:{code:'UPSTREAM_ERROR',message:e.name==='AbortError'?'千川请求超时':e.message}};}finally{clearTimeout(timeout)}
 },args:[job]});
 return result[0]?.result||{error:{code:'BRIDGE_ERROR',message:'无法读取千川页面响应'}};
}
async function loop(){
 if(active)return;active=true;
 try{while(true){const c=await chrome.storage.local.get(['url','token','enabled']);if(!c.enabled||!c.url||!c.token)break;
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(c.url))break;
  try{const r=await fetch(c.url+'/bridge/next?wait=15000&client=operator-v1',{headers:{'X-Replica-Bridge':c.token}});if(!r.ok)throw new Error('本机服务连接失败');const {job}=await r.json();if(job){const result=await execute(job);await fetch(c.url+'/bridge/reply',{method:'POST',headers:{'Content-Type':'application/json','X-Replica-Bridge':c.token},body:JSON.stringify({id:job.id,result})});await delay(1200);}await chrome.storage.local.set({lastConnected:Date.now(),error:''});}
  catch(e){await chrome.storage.local.set({error:e.message});await delay(10000);}
 }}finally{active=false;}
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(m.action==='pair-from-local-page'){
  (async()=>{try{
   const config=validateLocalPairing(m,sender);
   const check=await fetch(config.url+'/bridge/ping',{headers:{'X-Replica-Bridge':config.token},signal:AbortSignal.timeout(5000)});
   const state=await check.json();if(!check.ok||state.accountId!==ACCOUNT)throw new Error('本机配对校验失败，请刷新连接设置页');
   await chrome.storage.local.set({...config,error:''});void loop();reply({ok:true});
  }catch(error){reply({ok:false,error:error.message});}})();return true;
 }
 if(m.action==='connect'){void loop();reply({ok:true});}
});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create('reconnect',{periodInMinutes:.5});void loop();});
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('reconnect',{periodInMinutes:.5});void loop();});
chrome.alarms.onAlarm.addListener(()=>void loop());
import {validateLocalPairing} from './pairing.mjs';
