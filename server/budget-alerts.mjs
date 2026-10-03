import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ACCOUNT_ID,today} from './api.mjs';
import {atomicJson} from './monitor.mjs';
import {BridgeError} from './bridge.mjs';

export const BUDGET_THRESHOLD=.8;
export function budgetCandidates(snapshot,now=Date.now()){
 const day=today(new Date(now)),at=Date.parse(snapshot?.fetchedAt);
 if(snapshot?.accountId!==ACCOUNT_ID||snapshot?.source!=='live'||!snapshot.complete||snapshot.from!==day||snapshot.to!==day||!Number.isFinite(at)||now-at>600000||at-now>60000||!Array.isArray(snapshot.plans)||snapshot.plans.length!==snapshot.total)throw new BridgeError('仅检查当天10分钟内成功采集的完整数据','ALERT_DATA_NOT_READY',409);
 const matches=[];
 for(const plan of snapshot.plans){
  if(plan.accountId!==ACCOUNT_ID||plan.marGoal!==1)continue;
  const metric=plan.metrics?.statcostforroi2primary,budget=Number(plan.budget),raw=metric?.value??metric?.Value,display=metric?.valueStr??metric?.ValueStr;
  if(raw===null||raw===undefined||raw===''||display==='-'||display==='—')continue;
  const spend=Number(raw);if(!Number.isFinite(budget)||budget<=0||!Number.isFinite(spend)||spend<0)continue;
  const budgetCents=Math.round(budget*100),spendCents=Math.round(spend*100);if(spendCents*5<budgetCents*4)continue;
  matches.push({key:`${day}:${plan.id}:${budgetCents}`,day,id:plan.id,name:plan.name,budget,spend,ratio:spend/budget,remaining:Math.max(0,budget-spend),status:plan.statusText,fetchedAt:snapshot.fetchedAt});
 }
 return matches.sort((a,b)=>b.ratio-a.ratio||a.id.localeCompare(b.id));
}
const clean=v=>String(v??'').replace(/[\r\n\t<>]/g,' ').slice(0,100);
export function budgetMessage(rows,total=rows.length){
 const money=n=>n.toFixed(2),stamp=new Date(rows[0].fetchedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 return {title:`千川预算80%提醒｜${rows.length}条计划`,content:[`账户：${ACCOUNT_ID}`,`数据时间：${stamp}（北京时间）`,'规则：当日基础消耗 ÷ 当前计划预算 ≥ 80%',...rows.map((p,i)=>`\n${i+1}. ${clean(p.name)}\n计划ID：${p.id}\n基础消耗：${money(p.spend)}元 / 预算：${money(p.budget)}元\n已用：${(p.ratio*100).toFixed(1)}% · 剩余：${money(p.remaining)}元\n状态：${clean(p.status)}`),total>rows.length?`\n另有${total-rows.length}条待提醒，将在后续采集轮次继续发送。`:'','\n请检查预算安排。本消息未修改计划。'].filter(Boolean).join('\n')};
}
export async function pushplusSend(token,message,{fetcher=fetch,now=Date.now()}={}){
 let response,data;
 try{response=await fetcher('https://www.pushplus.plus/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,...message,template:'txt',channel:'wechat',timestamp:now+120000}),redirect:'error',signal:AbortSignal.timeout(12000)});data=await response.json();}catch{throw Object.assign(new Error('推送结果未确认，请查看pushplus发送记录；本批不会自动重复发送'),{code:'PUSH_UNCERTAIN',uncertain:true});}
 if(!response.ok||data.code!==200)throw Object.assign(new Error(`pushplus未受理（代码${Number(data.code)||response.status}），请检查Token、微信绑定或发送额度`),{code:'PUSH_REJECTED'});
 if(typeof data.data!=='string'||!data.data)throw Object.assign(new Error('推送平台未返回消息流水号，请检查发送记录'),{code:'PUSH_UNCERTAIN',uncertain:true});
 return {receipt:data.data,status:'accepted'};
}
export class BudgetAlerts {
 constructor({directory,send=pushplusSend,clock=Date.now}){Object.assign(this,{directory,send,clock});this.config={enabled:false,token:''};this.state={entries:{},history:[],lastCheckedAt:null,error:null};this.running=null;}
 async init(){for(const name of ['config','state']){try{this[name]=JSON.parse(await fs.readFile(path.join(this.directory,name+'.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}let interrupted=false;for(const entry of Object.values(this.state.entries))if(entry.status==='sending'){entry.status='uncertain';interrupted=true;}if(interrupted){this.state.error='上次推送中断，结果未确认；请检查pushplus发送记录，本批不会自动重发';await this.save();}return this;}
 save(){return atomicJson(path.join(this.directory,'state.json'),this.state);}
 recipients(){return [...(this.config.token?[{id:'primary',token:this.config.token}]:[]),...(this.config.recipients||[])];}
 entryKey(recipient,key){return recipient.id==='primary'?key:`${recipient.id}|${key}`;}
 status(){return {enabled:this.config.enabled,configured:Boolean(this.config.token),recipientCount:this.recipients().length,thresholdPercent:80,channel:'pushplus-wechat',running:Boolean(this.running),lastCheckedAt:this.state.lastCheckedAt,error:this.state.error,history:this.state.history.slice(-15).reverse()};}
 async configure(q){
  if(this.running||this.configuring)throw new BridgeError('推送或配置正在处理，请稍后保存设置','ALERT_BUSY',409);
  const token=String(q.token||this.config.token||'').trim();if(token&&!/^[A-Za-z0-9_-]{16,256}$/.test(token))throw new BridgeError('Token格式无效，请完整复制pushplus用户Token','INVALID_TOKEN',400);
  if(q.enabled===true&&(!token||q.acceptThirdParty!==true))throw new BridgeError('请填写Token并确认通过pushplus发送计划提醒','ALERT_CONFIGURATION_REQUIRED',400);
  const recipients=(this.config.recipients||[]).filter(r=>r.token!==token),added=String(q.addToken||'').trim();
  if(added){if(!/^[A-Za-z0-9_-]{16,256}$/.test(added))throw new BridgeError('新增Token格式无效','INVALID_TOKEN',400);if(q.acceptThirdParty!==true)throw new BridgeError('请确认通过pushplus发送计划提醒','ALERT_CONFIGURATION_REQUIRED',400);if(added!==token&&!recipients.some(r=>r.token===added))recipients.push({id:randomUUID(),token:added});}
  const changed=token!==this.config.token;this.configuring=true;try{const next={enabled:q.enabled===true,token,recipients};await atomicJson(path.join(this.directory,'config.json'),next);this.config=next;
  if(changed){for(const key of Object.keys(this.state.entries))if(!key.includes('|'))delete this.state.entries[key];this.state.history=this.state.history.filter(r=>r.recipientId&&r.recipientId!=='primary');this.state.error=null;await this.save();}return this.status();}finally{this.configuring=false;}
 }
 preview(snapshot){try{const rows=budgetCandidates(snapshot,this.clock());return {ready:true,count:rows.length,rows:rows.map(p=>{const states=this.recipients().map(r=>this.state.entries[this.entryKey(r,p.key)]?.status||'pending');return {...p,pushStatus:['uncertain','rejected','sending','pending'].find(s=>states.includes(s))||(states.length?'accepted':'pending')};})};}catch(e){return {ready:false,count:0,rows:[],message:e.message};}}
 run(snapshot){if(this.configuring)return Promise.resolve(this.status());if(this.running)return this.running;this.running=this.process(snapshot).finally(()=>{this.running=null;});return this.running;}
 async process(snapshot){
  this.state.lastCheckedAt=new Date(this.clock()).toISOString();
  if(!this.config.enabled||!this.config.token)return this.status();
  let rows;try{rows=budgetCandidates(snapshot,this.clock());}catch(e){this.state.error=e.message;await this.save();return this.status();}
  const day=today(new Date(this.clock()));for(const[key,entry]of Object.entries(this.state.entries))if(this.clock()-Date.parse(entry.at)>7*86400000)delete this.state.entries[key];
  for(const recipient of this.recipients()){
  const key=p=>this.entryKey(recipient,p.key);
  const pending=rows.filter(p=>{const entry=this.state.entries[key(p)];return !entry||(entry.status==='rejected'&&entry.attempts<3&&this.clock()-Date.parse(entry.at)>=300000);});
  if(!pending.length)continue;
  const batch=pending.slice(0,15),message=budgetMessage(batch,pending.length),at=new Date(this.clock()).toISOString(),id=randomUUID();
  for(const p of batch)this.state.entries[key(p)]={status:'sending',at,attempts:(this.state.entries[key(p)]?.attempts||0)+1};
  await this.save();
  let record={id,at,day,recipientId:recipient.id,count:batch.length,status:'uncertain'};
  try{const result=await this.send(recipient.token,message,{now:this.clock()});record={...record,status:'accepted',receipt:result.receipt};}
  catch(e){record.status=e.uncertain?'uncertain':'rejected';record.error=e.message;this.state.error=e.message;}
  for(const p of batch)this.state.entries[key(p)]={...this.state.entries[key(p)],status:record.status,receipt:record.receipt};
  this.state.history.push(record);this.state.history=this.state.history.slice(-100);await this.save();
  }
  this.state.error=this.recipients().map(r=>this.state.history.findLast(h=>(h.recipientId||'primary')===r.id)).find(h=>h?.status==='uncertain'||h?.status==='rejected')?.error||null;await this.save();return this.status();
 }
 async test(){
  if(!this.config.token)throw new BridgeError('请先保存pushplus Token','ALERT_CONFIGURATION_REQUIRED',400);
  if(this.running||this.configuring||this.clock()-(this.lastTest||0)<60000)throw new BridgeError('请稍后再测试，测试消息间隔至少60秒','ALERT_BUSY',429);
  this.lastTest=this.clock();const job=(async()=>{const result=await this.send(this.config.token,{title:'千川预算提醒连接测试',content:'这是连接测试。正式规则：当日基础消耗达到当前计划预算80%时提醒；每5分钟检查，同日同计划同预算去重。此测试未修改任何计划。'},{now:this.clock()});return {accepted:true,message:'推送平台已受理，请在微信中确认是否收到。',receipt:result.receipt};})();this.running=job;try{return await job;}finally{this.running=null;}
 }
}
