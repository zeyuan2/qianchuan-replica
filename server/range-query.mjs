import fs from 'node:fs/promises';
import path from 'node:path';
import {ACCOUNT_ID,period,today} from './api.mjs';
import {BridgeError} from './bridge.mjs';
import {collectFullSnapshot} from './full-capture.mjs';
import {atomicJson} from './monitor.mjs';

export class RangeQueryService {
 constructor({api,monitor,directory,collect=collectFullSnapshot,clock=Date.now,ttl=300000}){Object.assign(this,{api,monitor,directory,collect,clock,ttl});this.cache=new Map();this.pending=new Map();this.tail=Promise.resolve();this.windowStart=0;this.windowCount=0;}
 async get(from,to){
  period(from,to,new Date(this.clock()));
  if(from===today(new Date(this.clock()))&&to===from)return this.monitor.view();
  const key=from+'_'+to,filename=path.join(this.directory,key+'.json');
  let entry=this.cache.get(key);
  if(!entry){try{const saved=JSON.parse(await fs.readFile(filename,'utf8'));if(saved.accountId===ACCOUNT_ID&&saved.snapshot?.complete&&saved.snapshot.from===from&&saved.snapshot.to===to){entry=saved;this.cache.set(key,saved);}}catch{}}
  if(entry&&Date.parse(entry.snapshot.startedAt||entry.snapshot.fetchedAt)>(this.invalidBefore||0)&&this.clock()-Date.parse(entry.snapshot.fetchedAt)<this.ttl)return this.envelope(entry,true);
  if(this.pending.has(key))return this.pending.get(key);
  if(this.clock()-this.windowStart>=60000){this.windowStart=this.clock();this.windowCount=0;}
  if(this.pending.size>=2||this.windowCount>=4){if(entry)return this.envelope(entry,true,{code:'RATE_LIMITED',message:'区间查询较多，暂时显示该区间上次结果'});throw new BridgeError('区间查询较多，请稍后再试','RATE_LIMITED',429);}
  this.windowCount++;
  const promise=this.tail.catch(()=>{}).then(async()=>{
   try{
    if(this.monitor.running)await this.monitor.running;
    if(!this.api.bridge.status().connected)throw new BridgeError('采集浏览器未连接，无法查询新的日期区间','BRIDGE_OFFLINE',503);
    const snapshot=await this.collect(this.api,{from,to});
    if(!snapshot.complete||snapshot.from!==from||snapshot.to!==to||snapshot.accountId!==ACCOUNT_ID)throw new BridgeError('区间响应不完整','INVALID_RESPONSE',502);
    const value={accountId:ACCOUNT_ID,snapshot};await atomicJson(filename,value);this.cache.set(key,value);
    if(this.cache.size>20){for(const oldKey of this.cache.keys()){if(oldKey!==key&&!this.pending.has(oldKey)){this.cache.delete(oldKey);break;}}}
    return this.envelope(value,false);
   }catch(error){if(entry)return this.envelope(entry,true,{code:error.code||'RANGE_QUERY_FAILED',message:error.message});throw error;}
  });
  this.pending.set(key,promise);this.tail=promise;try{return await promise;}finally{this.pending.delete(key);}
 }
 invalidate(){this.invalidBefore=this.clock();}
 envelope(entry,cached,error=null){const state=this.monitor.view();return {accountId:ACCOUNT_ID,snapshot:{...entry.snapshot,newPlanEvents:state.snapshot?.newPlanEvents||[]},monitor:state.monitor,historical:entry.snapshot.to<today(new Date(this.clock())),rangeQuery:{from:entry.snapshot.from,to:entry.snapshot.to,cached,stale:Boolean(error),error,expiresAt:new Date(Date.parse(entry.snapshot.fetchedAt)+this.ttl).toISOString()}};}
}
