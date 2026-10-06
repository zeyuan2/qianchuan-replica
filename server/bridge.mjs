import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

export class BridgeError extends Error {
 constructor(message,code='BRIDGE_OFFLINE',status=503){super(message);this.code=code;this.status=status;}
}
export class BrowserBridge {
 constructor({token}={}){this.token=typeof token==='string'&&/^[a-f0-9]{48}$/.test(token)?token:randomBytes(24).toString('hex');this.queue=[];this.pending=new Map();this.waiters=[];this.lastSeen=0;this.history=[];this.closed=false;}
 authenticate(value){const actual=Buffer.from(value||''),expected=Buffer.from(this.token);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
 replaceToken(token){
  if(this.pending.size)throw new BridgeError('请求正在处理中，请稍后再切换采集浏览器','BRIDGE_BUSY',409);
  if(!/^[a-f0-9]{48}$/.test(token))throw new BridgeError('连接码格式无效','INVALID_PAIRING',400);
  this.token=token;this.lastSeen=0;this.lastWriteClient=0;
  for(const waiter of this.waiters){clearTimeout(waiter.timer);waiter.resolve(null);}this.waiters=[];
 }
 status(){return {connected:!this.switching&&Date.now()-this.lastSeen<35000,writeReady:!this.switching&&Date.now()-(this.lastWriteClient||0)<35000,pending:this.pending.size,lastSeen:this.lastSeen||null,lastReplyAt:this.lastReplyAt||null,lastTimeoutAt:this.lastTimeoutAt||null,history:this.history.slice(-30)};}
 request(spec,{timeout=45000}={}){
  if(this.closed)return Promise.reject(new BridgeError('浏览器连接已关闭'));
  if(this.switching)return Promise.reject(new BridgeError('正在切换采集浏览器，请稍后重试','PAIRING_SWITCHING',409));
  return new Promise((resolve,reject)=>{
   const id=randomUUID(),job={id,...spec,expiresAt:Date.now()+timeout};
   const timer=setTimeout(()=>{const pending=this.pending.get(id);this.lastTimeoutAt=Date.now();this.history.push({time:this.lastTimeoutAt,path:job.path,method:job.method,accountId:job.accountId,error:pending?.deliveredAt?'BRIDGE_NO_REPLY':'BRIDGE_NOT_PICKED_UP'});if(this.history.length>150)this.history.shift();this.pending.delete(id);this.queue=this.queue.filter(j=>j.id!==id);reject(new BridgeError(pending?.deliveredAt?'浏览器已接收请求但未返回结果，请刷新千川原页或重新加载连接扩展':'采集请求未被浏览器接收，请检查扩展连接',pending?.deliveredAt?'BRIDGE_NO_REPLY':'BRIDGE_NOT_PICKED_UP'));},timeout);
   this.pending.set(id,{resolve,reject,timer,job});this.queue.push(job);this.notify();
  });
 }
 take(index){const job=this.queue.splice(index,1)[0];const pending=this.pending.get(job.id);if(pending)pending.deliveredAt=Date.now();return job;}
 notify(){for(const waiter of [...this.waiters]){if(waiter.signal?.aborted){waiter.resolve(null);continue;}const index=this.queue.findIndex(j=>j.intent!=='write'||waiter.writes);if(index<0)continue;waiter.resolve(this.take(index));}}
 async next(wait=15000,{writes=false,signal}={}){
  if(signal?.aborted)return null;this.lastSeen=Date.now();if(writes)this.lastWriteClient=this.lastSeen;
  const index=this.queue.findIndex(j=>j.intent!=='write'||writes);if(index>=0)return this.take(index);
  return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(entry.timer);this.waiters=this.waiters.filter(w=>w!==entry);signal?.removeEventListener('abort',abort);resolve(value);};const abort=()=>finish(null),entry={resolve:finish,writes,signal};entry.timer=setTimeout(()=>finish(null),Math.min(20000,Math.max(0,wait)));this.waiters.push(entry);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
 }
 reply(id,result){this.lastSeen=Date.now();this.lastReplyAt=this.lastSeen;const p=this.pending.get(id);if(!p)return false;clearTimeout(p.timer);this.pending.delete(id);this.history.push({time:Date.now(),path:p.job.path,method:p.job.method,accountId:p.job.accountId,httpStatus:result.status,error:result.error?.code||null});if(this.history.length>150)this.history.shift();if(result.error)p.reject(new BridgeError(result.error.message,result.error.code||'UPSTREAM_ERROR',result.error.code==='AUTH_REQUIRED'?401:502));else p.resolve(result);return true;}
 close(){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new BridgeError('服务已停止'));}this.pending.clear();for(const w of this.waiters){clearTimeout(w.timer);w.resolve(null);}this.waiters=[];}
}
