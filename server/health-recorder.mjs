import net from 'node:net';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HealthStore} from './health-store.mjs';
export function safeCode(error){const code=error?.cause?.code||error?.code||error?.name;if(/TIMEOUT|Timeout|Abort/.test(code||''))return 'TIMEOUT';if(/CERT|TLS|SSL|SIGNATURE/.test(code||''))return 'TLS_FAILED';if(/ENOTFOUND|EAI_AGAIN/.test(code||''))return 'DNS_FAILED';if(code==='ECONNREFUSED')return 'CONNECTION_REFUSED';return 'NETWORK_FAILED';}
export async function probe(name,url,{fetcher=fetch,clock=Date.now,expected=[200],headers,validate}={}){
 const start=clock();try{const r=await fetcher(url,{headers,redirect:'manual',signal:AbortSignal.timeout(8000)});let detail={};if(expected.includes(r.status)&&validate)detail=await validate(r);else await r.body?.cancel();return {name,ok:expected.includes(r.status)&&detail.valid!==false,status:r.status,durationMs:Math.max(0,clock()-start),...detail,code:!expected.includes(r.status)?'HTTP_'+r.status:detail.valid===false?detail.code||'INVALID_RESPONSE':'OK'};}catch(e){return {name,ok:false,status:null,durationMs:Math.max(0,clock()-start),code:safeCode(e)};}
}
// Node fetch may normalize Host. The loopback gateway requires the public Host header.
export function gatewayFetch(url,{headers,signal}={}){return new Promise((resolve,reject)=>{const req=http.get(url,{headers,signal},res=>{let body='';res.on('data',chunk=>{body+=chunk;if(body.length>4096)req.destroy();});res.on('end',()=>resolve(new Response(body,{status:res.statusCode})));});req.on('error',reject);});}
export async function checkServices(config,{fetcher=fetch,clock=Date.now}={}){
 const opts={fetcher,clock};const checks=[probe('web','http://127.0.0.1:5173/api/status',{...opts,validate:async r=>{const j=await r.json();return {valid:!!j.monitor&&!!j.bridge};}}),probe('data','http://127.0.0.1:5173/api/health/data',{...opts,validate:async r=>{const j=await r.json(),age=clock()-Date.parse(j.fetchedAt);return {valid:j.complete===true&&j.planCount===j.total&&Number.isFinite(age)&&age>=-60000&&age<12*60000,code:'DATA_STALE_OR_INCOMPLETE',ageSeconds:Number.isFinite(age)?Math.max(0,Math.round(age/1000)):null,planCount:Number.isInteger(j.planCount)?j.planCount:null};}}),probe('collector','http://127.0.0.1:5173/api/health/data',{...opts,validate:async r=>{const j=await r.json();return {valid:j.bridgeConnected===true&&!j.captureFailed,code:j.bridgeConnected?'CAPTURE_FAILED':'COLLECTOR_DISCONNECTED'};}})];
 if(config){const host=new URL(config.origin).host;checks.push(probe('gateway','http://127.0.0.1:8090/',{...opts,fetcher:gatewayFetch,headers:{Host:host},expected:[401]}),probe('tunnel','http://127.0.0.1:20245/ready',opts),probe('public_entry',config.origin,{...opts,expected:[200,302,303]}),probe('access_keys',`https://${config.team}.cloudflareaccess.com/cdn-cgi/access/certs`,{...opts,validate:async r=>{const j=await r.json();return {valid:Array.isArray(j.keys)&&j.keys.some(k=>k.kty==='RSA')};}}));}
 return Promise.all(checks);
}
export async function readRoute(profile=process.env.APPDATA&&path.join(process.env.APPDATA,'io.github.clash-verge-rev.clash-verge-rev','clash-verge.yaml')){
 try{
  const config=await fs.readFile(profile,'utf8'),secret=config.match(/^secret:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
  const pipes=(await fs.readdir('\\\\.\\pipe\\')).filter(n=>/^verge-mihomo-production-[a-f0-9]+$/.test(n));if(pipes.length!==1)return {state:'unavailable'};
  const data=await new Promise((resolve,reject)=>{const req=http.get({socketPath:'\\\\.\\pipe\\'+pipes[0],path:'/proxies',headers:secret?{Authorization:'Bearer '+secret}:{}},res=>{let value='';res.on('data',chunk=>{value+=chunk;if(value.length>2000000)req.destroy();});res.on('end',()=>{try{if(res.statusCode!==200)throw Error();resolve(JSON.parse(value));}catch{reject(Error());}});});req.setTimeout(2500,()=>req.destroy());req.on('error',reject);});
  const clean=v=>typeof v==='string'?v.replace(/https?:\/\/\S+|[a-z0-9]{25,}/gi,'[redacted]').slice(0,120):null;
  const groups=['千川工作台专线','🇺🇸美国节点','🚀节点选择'].filter(n=>data.proxies?.[n]?.now).map(n=>({group:n,node:clean(data.proxies[n].now)}));return {state:'available',groups};
 }catch{return {state:'unavailable'};}
}
export async function runRecorder(root,{once=false}={}){
 const lock=net.createServer(socket=>socket.end()),lockName=process.platform==='win32'?'\\\\.\\pipe\\qc-health-'+createHash('sha256').update(root).digest('hex').slice(0,16):path.join(root,'.runtime','health-recorder.sock');
 const acquired=await new Promise((resolve,reject)=>{lock.once('error',e=>e.code==='EADDRINUSE'?resolve(false):reject(e));lock.listen(lockName,()=>resolve(true));});if(!acquired)return;
 const runtime=path.join(root,'.runtime'),store=await new HealthStore(path.join(runtime,'health')).init();
 let config;try{const c=JSON.parse(await fs.readFile(path.join(runtime,'public-access.json'),'utf8'));if(new URL(c.origin).protocol!=='https:'||!/^[-a-z0-9]+$/.test(c.team))throw Error();config={origin:new URL('/',c.origin).href,team:c.team};}catch{}
 await fs.writeFile(path.join(runtime,'health.pid'),String(process.pid));let stopped=false,wake;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;wake?.();});
 do{const start=Date.now();try{if(await fs.stat(path.join(runtime,'watchdog.pause')).then(()=>true,()=>false))await store.append('recorder',{at:new Date().toISOString(),event:'maintenance_skipped'});else await store.sample(await checkServices(config),await readRoute());}catch{await store.append('recorder',{at:new Date().toISOString(),event:'recorder_error',code:'CHECK_OR_STORAGE_FAILED'}).catch(()=>{});}if(once)break;await new Promise(r=>{const timer=setTimeout(r,Math.max(1000,60000-(Date.now()-start)));wake=()=>{clearTimeout(timer);r();};if(stopped)wake();});}while(!stopped);
 lock.close();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runRecorder(fileURLToPath(new URL('../',import.meta.url)),{once:process.argv.includes('--once')});
