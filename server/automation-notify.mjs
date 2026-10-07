import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './monitor.mjs';
import {localDay} from './automation-policy.mjs';
const clean=v=>String(v??'').replace(/[<>\r\n\t]/g,' ').slice(0,100);
export const REASONS={COLD_BUDGET_AHEAD:'已先追加预算，并记录待补ROI目标',COLD_ROI_CATCH_UP:'已到补调时间，执行待补ROI',WINDOW_DATA_BUDGET_ONLY:'比较窗口数据不足，保持ROI，仅按预算规则追加',DEFERRED_ROI_NEEDS_REVIEW:'待补ROI与平台现状不一致，请核实',PLATFORM_STATE_UNVERIFIED:'平台状态码前后不一致，本轮跳过',AUDIT_OR_DELIVERY_STATE_UNVERIFIED:'审核或投放状态尚未核实，本轮跳过',PLAN_PAUSED:'计划已暂停，本轮跳过',GROUP_BUDGET_EXHAUSTED:'计划组预算耗尽，本次不新建起量任务',PLATFORM_OPERATION_DENIED:'平台不允许本次预算或ROI修改',EXACT_WINDOW_PRECISION_UNSUPPORTED:'平台只提供整小时消耗；精确时间比较不可用，保持ROI，预算可按规则追加',WRITE_CONFIRMED:'操作已在平台回读确认',PILOT_WRITE_UNRESOLVED:'首条动作尚未核实，暂不放开其他计划写入',SLOT_SKIPPED_BUSY:'时段遇到其他操作，本次跳过且不补发',APPROVAL_TIME_UNKNOWN:'尚未核实审核通过日期',PLAN_PAUSED_OR_UNAPPROVED:'计划暂停、未审核通过或状态无法确认',BOOST_ACTIVE_OR_UNKNOWN:'已有未结束起量任务或状态不明',BOOST_HISTORY_UNKNOWN:'历史预算档位尚未核实',HISTORY_NOT_VERIFIED:'ROI或预算操作日志不完整/无法解析',EXACT_WINDOW_PRECISION_UNVERIFIED:'精确时间窗口不可用，保持ROI，预算可按规则追加',NO_VERIFIED_ROLLBACK_TARGET:'没有可靠的历史回调目标，停止继续加码',PREVIOUS_WRITE_UNRESOLVED:'上次写入结果未确认，已停止后续操作',SLOT_EXPIRED:'错过调度时段，本次不补发',STATE_READ_FAILED:'真实状态读取失败，本轮跳过',WRITE_UNCERTAIN:'提交结果或日志回读不明确，不重试写入',WRITE_REJECTED:'平台拒绝或提交前校验失败',STABLE_OBSERVATION_NOT_INITIALIZED:'稳定期缺少可靠修改时间/基准，先积累证据',STARTED:'指定计划自动化调度已启动（不代表已执行调价）',PILOT_VERIFIED:'首个符合规则的真实动作已回读确认，解除首条验证门控'};
export class AutomationNotifier {
 constructor({directory,alerts,clock=Date.now}){Object.assign(this,{directory,alerts,clock});this.state={entries:{},history:[]};this.queue=Promise.resolve();}
 async init(){
  try{
   const saved=JSON.parse(await fs.readFile(path.join(this.directory,'notifications.json'),'utf8'));
   if(!saved||!saved.entries||typeof saved.entries!=='object'||Array.isArray(saved.entries)||!Array.isArray(saved.history)||Object.values(saved.entries).some(e=>!e||!['sending','accepted','rejected','uncertain'].includes(e.status)))throw Object.assign(Error('invalid notification state'),{code:'NOTIFICATION_LEDGER_INVALID'});
   this.state=saved;
  }catch(e){if(e.code!=='ENOENT'){this.disabled=true;this.state.error='NOTIFICATION_LEDGER_INVALID';return this;}}
  for(const e of Object.values(this.state.entries))if(e.status==='sending')e.status='uncertain';
  try{await this.save();}catch{this.disabled=true;this.state.error='NOTIFICATION_LEDGER_WRITE_FAILED';}return this;
 }
 save(){return atomicJson(path.join(this.directory,'notifications.json'),this.state);}
 send(events){const job=this.queue.catch(()=>{}).then(()=>this.deliver(events));this.queue=job;return job;}
 async deliver(events){
  if(!events.length||this.disabled)return;const recipients=this.alerts.recipients();if(!this.alerts.config.enabled||!recipients.length){this.state.error='NOTIFICATIONS_DISABLED_OR_UNCONFIGURED';await this.save();return;}
  this.state.error=null;
  for(const recipient of recipients){const now=this.clock();const pending=events.filter(e=>{const old=this.state.entries[recipient.id+'|'+e.key];return !old||old.status==='rejected'&&old.attempts<3&&now-old.at>=300000;});if(!pending.length)continue;
   const batch=pending.slice(0,12);for(const e of batch){const key=recipient.id+'|'+e.key;this.state.entries[key]={status:'sending',at:now,attempts:(this.state.entries[key]?.attempts||0)+1};}await this.save();
   const message={title:'千川计划自动化｜状态通知',content:[new Date(now).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),...batch.map(e=>`${clean(e.id||'调度器')} ${clean(e.name)}\n${clean(REASONS[e.reason]||e.reason)}${e.detail?'\n'+clean(e.detail):''}`)].join('\n\n')};
   let result;try{const reply=await this.alerts.send(recipient.token,message,{now});result={status:'accepted',receipt:reply.receipt};}catch(e){result={status:e.uncertain?'uncertain':'rejected',code:e.code||'PUSH_FAILED'};}
   for(const e of batch){const key=recipient.id+'|'+e.key;this.state.entries[key]={...this.state.entries[key],...result};}this.state.history.push({at:now,recipientId:recipient.id,count:batch.length,...result});this.state.history=this.state.history.slice(-200);await this.save();
  }
 }
 event(plan,reason,detail='',unique=''){return {id:plan?.id,name:plan?.name,reason,detail,key:[plan?.id||'scheduler',localDay(this.clock()),reason,unique].join(':')};}
 status(){return {recipientCount:this.alerts.recipients().length,error:this.state.error||null,recent:this.state.history.slice(-10)};}
}
