import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const DAY=86400000;
export const dayOf=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
export const incidentId=(now=Date.now())=>'QC-'+dayOf(now).replaceAll('-','')+'-'+randomUUID().slice(0,8).toUpperCase();
export class HealthStore {
 constructor(directory,{clock=Date.now,maxBytes=10*1024*1024}={}){Object.assign(this,{directory:path.resolve(directory),clock,maxBytes});this.queue=Promise.resolve();this.active={};}
 async init(){await fs.mkdir(this.directory,{recursive:true});try{const state=JSON.parse(await fs.readFile(path.join(this.directory,'latest.json'),'utf8'));this.active=state.active||{};this.lastTick=state.at;}catch{}return this;}
 async append(kind,value){if(!['checks','events','client','recorder'].includes(kind))throw Error('Invalid log kind');const file=path.join(this.directory,kind+'-'+dayOf(this.clock())+'.jsonl');await fs.mkdir(this.directory,{recursive:true});let size=0;try{size=(await fs.stat(file)).size;}catch{}const line=JSON.stringify(value)+'\n';if(size+Buffer.byteLength(line)>this.maxBytes)return false;await fs.appendFile(file,line);return true;}
 run(work){const job=this.queue.catch(()=>{}).then(work);this.queue=job;return job;}
 sample(checks,route){return this.run(async()=>{
  const now=this.clock(),at=new Date(now).toISOString();
  if(this.lastTick&&now-Date.parse(this.lastTick)>150000)await this.append('events',{at,event:'monitoring_gap',previousAt:this.lastTick});
  for(const c of checks){const old=this.active[c.name];if(!c.ok){if(!old){this.active[c.name]={id:incidentId(now),name:c.name,startedAt:at,code:c.code};await this.append('events',{at,event:'failure',...this.active[c.name]});}}else if(old){await this.append('events',{at,event:'recovered',...old,recoveredAt:at,durationMs:Math.max(0,now-Date.parse(old.startedAt))});delete this.active[c.name];}}
  const state={at,checks,route,active:this.active};await this.append('checks',state);const temp=path.join(this.directory,'latest.tmp');await fs.writeFile(temp,JSON.stringify(state,null,2));await fs.rename(temp,path.join(this.directory,'latest.json'));this.lastTick=at;await this.prune();return state;
 });}
 async prune(){const cutoff=dayOf(this.clock()-13*DAY);for(const entry of await fs.readdir(this.directory,{withFileTypes:true})){const match=/^(checks|events|client|recorder)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry.name);if(entry.isFile()&&match&&match[2]<cutoff){const file=path.resolve(this.directory,entry.name);if(path.dirname(file)!==this.directory)throw Error('Cleanup outside health directory');await fs.unlink(file);}}}
}
const TYPES=new Set(['network','http','javascript','resource','offline','startup','recovered']);
const AREAS=new Set(['snapshot','detail','operation','asset','page','other']);
export function sanitizeReport(value,now=Date.now()){
 if(!value||typeof value!=='object'||!/^QC-\d{8}-[A-F0-9]{8}$/.test(value.id)||!TYPES.has(value.type)||!AREAS.has(value.area))throw Object.assign(Error('Invalid health report'),{status:400});
 const occurred=Date.parse(value.at);if(!Number.isFinite(occurred)||occurred>now+5*60000||occurred<now-14*DAY)throw Object.assign(Error('Invalid report time'),{status:400});
 return {id:value.id,at:new Date(occurred).toISOString(),receivedAt:new Date(now).toISOString(),type:value.type,area:value.area,status:Number.isInteger(value.status)&&value.status>=100&&value.status<=599?value.status:null,online:value.online===true,device:['mobile','desktop','unknown'].includes(value.device)?value.device:'unknown'};
}
export function reportWriter(directory,{clock=Date.now}={}){
 const store=new HealthStore(directory,{clock});let minute=0,count=0;const seen=new Map();
 return async input=>{const record=sanitizeReport(input,clock()),slot=Math.floor(clock()/60000);if(slot!==minute){minute=slot;count=0;for(const [k,at] of seen)if(clock()-at>DAY)seen.delete(k);}if(++count>120)throw Object.assign(Error('Report rate limited'),{status:429});const key=record.id+':'+record.type;if(seen.has(key))return {accepted:true,id:record.id};const written=await store.run(()=>store.append('client',record));if(!written)throw Object.assign(Error('Daily report capacity reached'),{status:429});seen.set(key,clock());return {accepted:true,id:record.id};};
}
