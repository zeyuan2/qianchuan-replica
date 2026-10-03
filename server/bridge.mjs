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
 status(){return {connected:!this.switching&&Date.now()-this.lastSeen<35000,writeReady:!this.switching&&Date.now()-(this.lastWriteClient||0)<35000,pending:this.pending.size,lastSeen:this.lastSeen||null,history:this.history.slice(-30)};}
 request(spec,{timeout=45000}={}){
  if(this.closed)return Promise.reject(new BridgeError('浏览器连接已关闭'));
  if(this.switching)return Promise.reject(new BridgeError('正在切换采集浏览器，请稍后重试','PAIRING_SWITCHING',409));
  return new Promise((resolve,reject)=>{
   const id=randomUUID(),job={id,...spec,expiresAt:Date.now()+timeout};
   const timer=setTimeout(()=>{this.pending.delete(id);this.queue=this.queue.filter(j=>j.id!==id);reject(new BridgeError('未收到千川浏览器响应，请检查连接和登录状态'));},timeout);
   this.pending.set(id,{resolve,reject,timer,job});this.queue.push(job);this.notify();
  });
 }
 notify(){for(const waiter of [...this.waiters]){const index=this.queue.findIndex(j=>j.intent!=='write'||waiter.writes);if(index<0)continue;this.waiters.splice(this.waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(this.queue.splice(index,1)[0]);}}
 async next(wait=15000,{writes=false}={}){this.lastSeen=Date.now();if(writes)this.lastWriteClient=this.lastSeen;const index=this.queue.findIndex(j=>j.intent!=='write'||writes);if(index>=0)return this.queue.splice(index,1)[0];return new Promise(resolve=>{const entry={resolve,writes};entry.timer=setTimeout(()=>{this.waiters=this.waiters.filter(w=>w!==entry);resolve(null);},Math.min(20000,Math.max(0,wait)));this.waiters.push(entry);});}
 reply(id,result){this.lastSeen=Date.now();const p=this.pending.get(id);if(!p)return false;clearTimeout(p.timer);this.pending.delete(id);this.history.push({time:Date.now(),path:p.job.path,method:p.job.method,accountId:p.job.accountId,httpStatus:result.status,error:result.error?.code||null});if(this.history.length>150)this.history.shift();if(result.error)p.reject(new BridgeError(result.error.message,result.error.code||'UPSTREAM_ERROR',result.error.code==='AUTH_REQUIRED'?401:502));else p.resolve(result);return true;}
 close(){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new BridgeError('服务已停止'));}this.pending.clear();for(const w of this.waiters){clearTimeout(w.timer);w.resolve(null);}this.waiters=[];}
}
