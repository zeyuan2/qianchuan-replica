import {today} from './api.mjs';
import {BridgeError} from './bridge.mjs';
// Account-scoped reader instance; contains read data only, never operator confirmations.
export class BoostListCache {
 constructor({load,clock=Date.now,ttlMs=60000}){Object.assign(this,{load,clock,ttlMs});this.revision=0;this.saved=null;this.flight=null;}
 invalidate(){this.revision++;this.saved=null;}
 decorate(entry,cacheHit,shared=false){return {...structuredClone(entry.value),requests:cacheHit||shared?0:entry.value.requests,cacheHit,shared,cacheAgeSeconds:Math.max(0,Math.floor((this.clock()-entry.startedAt)/1000)),checkedAt:new Date(entry.startedAt).toISOString()};}
 async get(){
  const now=this.clock(),day=today(new Date(now));
  if(this.saved&&this.saved.day===day&&now<this.saved.expiresAt)return this.decorate(this.saved,true);
  const revision=this.revision,shared=this.flight?.revision===revision;
  if(!shared){
   const flight={revision};
   flight.promise=(async()=>{const value=await this.load();
    if(revision!==this.revision)throw new BridgeError('查询期间起量状态已变化，请重新核实','BOOST_CACHE_INVALIDATED',409);
    const deadlines=[...value.rows.values()].filter(r=>r.state==='active').map(r=>Date.parse(r.listEvidence?.endAt)).filter(Number.isFinite);
    const entry={value,startedAt:now,day,expiresAt:Math.min(now+this.ttlMs,...deadlines)};this.saved=entry;return entry;
   })().catch(e=>{if(revision===this.revision)this.saved=null;throw e;}).finally(()=>{if(this.flight===flight)this.flight=null;});
   this.flight=flight;
  }
  const entry=await this.flight.promise;
  if(revision!==this.revision)throw new BridgeError('起量状态已变化，请重新核实','BOOST_CACHE_INVALIDATED',409);
  return this.decorate(entry,false,shared);
 }
}
