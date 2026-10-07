// One in-process gate for capture and every local write path. No reentrant locks.
const cancelled=()=>Object.assign(new Error('请求已取消，未开始操作'),{code:'ACTIVITY_WAIT_CANCELLED',status:499});
export class ActivityGate {
 constructor(){this.owner=null;this.waiters=[];}
 grant(owner){const token=Symbol(owner);this.token=token;this.owner=owner;let released=false;return ()=>{if(released)return;released=true;if(this.token!==token)throw Error('LOCK_OWNER_MISMATCH');this.owner=null;this.token=null;this.waiters.shift()?.take();};}
 tryAcquire(owner){return this.owner||this.waiters.length?null:this.grant(owner);}
 acquire(owner,{priority=0,signal,timeoutMs=0}={}){
  if(signal?.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
   let timer,settled=false;
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   const remove=error=>{if(settled)return;settled=true;const index=this.waiters.indexOf(entry);if(index>=0)this.waiters.splice(index,1);cleanup();reject(error);};
   const abort=()=>remove(cancelled());
   const entry={priority,take:()=>{if(settled)return;settled=true;cleanup();resolve(this.grant(owner));}};
   if(!this.owner&&!this.waiters.length){entry.take();return;}
   const ahead=this.waiters.findIndex(waiter=>waiter.priority<priority);
   if(ahead<0)this.waiters.push(entry);else this.waiters.splice(ahead,0,entry);
   signal?.addEventListener('abort',abort,{once:true});
   if(timeoutMs>0)timer=setTimeout(()=>remove(Object.assign(new Error('后台检查仍在进行，本次请求未提交，请稍后重新核对'),{code:'ACTIVITY_WAIT_TIMEOUT',status:409})),timeoutMs);
   if(signal?.aborted)abort();
  });
 }
 async run(owner,work){const release=await this.acquire(owner);try{return await work();}finally{release();}}
}
