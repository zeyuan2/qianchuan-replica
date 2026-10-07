// One in-process gate for capture and every local write path. No reentrant locks.
export class ActivityGate {
 constructor(){this.owner=null;this.waiters=[];}
 grant(owner){const token=Symbol(owner);this.token=token;this.owner=owner;let released=false;return ()=>{if(released)return;released=true;if(this.token!==token)throw Error('LOCK_OWNER_MISMATCH');this.owner=null;this.token=null;this.waiters.shift()?.();};}
 tryAcquire(owner){return this.owner||this.waiters.length?null:this.grant(owner);}
 acquire(owner){return new Promise(resolve=>{const take=()=>resolve(this.grant(owner));if(this.owner)this.waiters.push(take);else take();});}
 async run(owner,work){const release=await this.acquire(owner);try{return await work();}finally{release();}}
}
