import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import {HealthStore,DAY,sanitizeReport,reportWriter} from '../server/health-store.mjs';
import {probe,checkServices,gatewayFetch} from '../server/health-recorder.mjs';
import {createLanServer} from '../lan-server.mjs';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qc-health-test-'));t.after(async()=>{const real=await fs.realpath(dir);assert.equal(path.dirname(real).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());assert.ok(path.basename(real).startsWith('qc-health-test-'));await fs.rm(real,{recursive:true,force:true});});return dir;}
test('loopback gateway probe preserves public Host while expecting the existing authentication gate',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(req.headers.host==='example.test'?401:403);res.end('auth gate');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const result=await probe('gateway','http://127.0.0.1:'+server.address().port,{fetcher:gatewayFetch,headers:{Host:'example.test'},expected:[401]});assert.equal(result.ok,true);assert.equal(result.status,401);
});
test('failure IDs survive restart, recovery duration is recorded and monitoring gaps remain visible',async t=>{
 const dir=await temp(t);let now=Date.parse('2026-10-04T00:00:00Z');const a=await new HealthStore(dir,{clock:()=>now}).init();
 await a.sample([{name:'tunnel',ok:false,code:'HTTP_503'}],{state:'unavailable'});const id=a.active.tunnel.id;now+=60000;await a.sample([{name:'tunnel',ok:false,code:'HTTP_503'}]);
 const b=await new HealthStore(dir,{clock:()=>now}).init();assert.equal(b.active.tunnel.id,id);now+=180000;await b.sample([{name:'tunnel',ok:true,code:'OK'}]);
 const events=(await fs.readFile(path.join(dir,'events-2026-10-04.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.event==='failure').length,1);assert.equal(events.at(-1).durationMs,240000);assert.equal(events.at(-1).id,id);assert.ok(events.some(e=>e.event==='monitoring_gap'));
});
test('retention removes only recognized files older than 14 calendar days, with bounded daily logs',async t=>{
 const dir=await temp(t),now=Date.parse('2026-10-04T00:00:00Z');for(const name of ['client-2026-09-20.jsonl','client-2026-09-21.jsonl','user-data.json','events-old.jsonl'])await fs.writeFile(path.join(dir,name),'keep');
 const s=await new HealthStore(dir,{clock:()=>now,maxBytes:30}).init();await s.prune();assert.ok(!(await fs.readdir(dir)).includes('client-2026-09-20.jsonl'));assert.ok((await fs.readdir(dir)).includes('client-2026-09-21.jsonl'));assert.ok((await fs.readdir(dir)).includes('user-data.json'));assert.equal(await s.append('checks',{huge:'x'.repeat(40)}),false);
});
test('client report allowlist strips credentials, arbitrary messages, URLs, IDs and payloads; reports deduplicate',async t=>{
 const dir=await temp(t),now=Date.parse('2026-10-04T00:00:00Z'),r={id:'QC-20261004-1234ABCD',at:new Date(now).toISOString(),type:'network',area:'snapshot',online:true,device:'desktop',Cookie:'SECRET',token:'SECRET',url:'https://a/?token=SECRET',message:'SECRET',planId:'123',payload:{secret:'SECRET'}};
 assert.equal(JSON.stringify(sanitizeReport(r,now)).includes('SECRET'),false);assert.throws(()=>sanitizeReport({...r,type:'SECRET'},now));assert.throws(()=>sanitizeReport({...r,at:new Date(now-15*DAY).toISOString()},now));
 const write=reportWriter(dir,{clock:()=>now});await write(r);await write(r);const content=await fs.readFile(path.join(dir,'client-2026-10-04.jsonl'),'utf8');assert.equal(content.trim().split('\n').length,1);assert.equal(content.includes('SECRET'),false);
});
test('probes preserve only fixed error codes and detect stale snapshots and disconnected collectors',async()=>{
 const failing=await probe('public_entry','https://example.invalid',{fetcher:async()=>{throw Object.assign(Error('Cookie=SECRET'),{cause:{code:'CERT_HAS_EXPIRED'}});}});assert.equal(failing.code,'TLS_FAILED');assert.equal(JSON.stringify(failing).includes('SECRET'),false);
 const now=Date.parse('2026-10-04T00:00:00Z');const results=await checkServices(null,{clock:()=>now,fetcher:async url=>new Response(JSON.stringify(url.endsWith('/api/status')?{monitor:{},bridge:{}}:{complete:true,planCount:139,total:139,fetchedAt:new Date(now-13*60000).toISOString(),bridgeConnected:false}),{status:200})});assert.equal(results[0].ok,true);assert.equal(results[1].code,'DATA_STALE_OR_INCOMPLETE');assert.equal(results[2].code,'COLLECTOR_DISCONNECTED');
});
test('report route requires same origin and public Access authorization, with payload limits',async t=>{
 const reports=[],server=createLanServer({host:'127.0.0.1',port:8090,publicOrigin:'https://example.test',authorize:async req=>{if(req.headers['x-test-auth']!=='yes')throw Error();return {email:'test@example.test'};},html:Buffer.from('ok'),healthReport:async r=>{reports.push(r);return {accepted:true};}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const send=(origin,auth,body='{}')=>new Promise(resolve=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/lan-api/health/report',method:'POST',headers:{Host:'example.test','Content-Type':'application/json',...(origin?{Origin:origin}:{}),...(auth?{'x-test-auth':'yes'}:{})}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.end(body);});
 assert.equal(await send('https://example.test',false),401);assert.equal(await send('https://other.test',true),403);assert.equal(await send(null,true),403);assert.equal(await send('https://example.test',true,'x'.repeat(5000)),413);assert.equal(await send('https://example.test',true,'{bad'),400);assert.equal(await send('https://example.test',true),200);assert.equal(reports.length,1);
});
test('browser queues offline reports, retries only diagnostic submission and never repeats an account write',async()=>{
 const script=await fs.readFile(new URL('../dist/health-client.js',import.meta.url),'utf8'),events={},storage=new Map(),calls=[],nodes=new Map();let reportOk=false;
 const nativeFetch=async(url,opts)=>{calls.push({url,body:opts?.body});if(url==='/lan-api/health/report'){if(!reportOk)throw Error('offline');return {ok:true,status:200};}return {ok:false,status:502};};
 const ctx={window:null,fetch:nativeFetch,Date,JSON,Map,URL,Number,Array,String,crypto:{randomUUID:()=> '1234abcd-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},AbortSignal,location:{href:'https://test/',origin:'https://test'},navigator:{onLine:false},matchMedia:()=>({matches:false}),localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,addEventListener:(n,f)=>events[n]=f,document:{readyState:'complete',getElementById:id=>nodes.get(id),createElement:()=>({setAttribute(){},append(){},style:{}}),body:{append(node){nodes.set(node.id,node);}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(script,ctx);
 await ctx.fetch('/lan-api/operation/commit',{method:'POST',body:'SECRET_OPERATION'});assert.equal(calls.length,1);assert.match(nodes.get('qc-health-notice').textContent,/QC-\d{8}-/);assert.equal([...storage.values()].join().includes('SECRET_OPERATION'),false);
 ctx.navigator.onLine=true;reportOk=true;events.online();await new Promise(r=>setImmediate(r));assert.equal(calls.filter(c=>c.url==='/lan-api/operation/commit').length,1);assert.equal(calls.filter(c=>c.url==='/lan-api/health/report').length,1);assert.equal(JSON.parse(storage.get('qc-health-pending-v1')).length,0);
});

async function browserNoticeFixture(){
 const code=await fs.readFile(new URL('../dist/health-client.js',import.meta.url),'utf8'),events={},nodes=new Map(),saved=new Map(),calls=[],state={accept:false};let seq=0;
 function element(tag){return {tagName:tag.toUpperCase(),style:{},children:[],_text:'',setAttribute(){},set textContent(v){this._text=v;this.children=[];},get textContent(){return this._text+this.children.map(c=>c.textContent||'').join('');},append(...children){this.children.push(...children);}};}
 const ctx={window:null,fetch:async(url,o)=>{calls.push({url,body:o?.body});if(url==='/lan-api/health/report'&&!state.accept)throw Error('offline');return {ok:true,status:200};},Date,JSON,Map,URL,Number,Array,String,crypto:{randomUUID:()=> (++seq).toString(16).padStart(8,'0')+'-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},AbortSignal,location:{href:'https://test/',origin:'https://test'},navigator:{onLine:false},matchMedia:()=>({matches:false}),localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,addEventListener:(name,fn)=>events[name]=fn,document:{readyState:'complete',getElementById:id=>nodes.get(id),createElement:element,body:{append(node){nodes.set(node.id,node);}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);return {ctx,events,nodes,saved,calls,state,element};
}
test('favicon and preload failures do not become workbench incidents; real resource recovery clears the warning',async()=>{
 const h=await browserNoticeFixture();h.events.error({target:{tagName:'LINK',rel:'icon'}});h.events.error({target:{tagName:'LINK',rel:'preload'}});assert.equal(h.nodes.get('qc-health-notice').hidden,true);
 const script={tagName:'SCRIPT',src:'https://test/lan-main.mjs'},css={tagName:'LINK',rel:'stylesheet',href:'https://test/lan.css',sheet:null};h.events.error({target:script});h.events.error({target:css});assert.equal(h.nodes.get('qc-health-notice').hidden,false);
 h.ctx.QCHealth.ready('2026-10-05T15:08:16Z');assert.equal(h.nodes.get('qc-health-notice').hidden,false);assert.match(h.nodes.get('qc-health-notice').textContent,/23:08:16/);
 css.sheet={};h.events.load({target:css});assert.equal(h.nodes.get('qc-health-notice').hidden,true);const rows=JSON.parse(h.saved.get('qc-health-pending-v1'));assert.deepEqual(rows.map(r=>r.type),['resource','recovered']);
});
test('notice acknowledges delivery and dismisses visually without falsely recording recovery or replaying operations',async()=>{
 const h=await browserNoticeFixture();h.ctx.navigator.onLine=true;h.state.accept=true;h.ctx.QCHealth.failure('operation','http',502);await new Promise(r=>setImmediate(r));const box=h.nodes.get('qc-health-notice');assert.match(box.textContent,/记录已上报/);assert.ok(!box.textContent.includes('排队'));
 const close=box.children[0].children.find(c=>c.tagName==='BUTTON');close.onclick();assert.equal(box.hidden,true);assert.equal(h.calls.filter(c=>c.url.includes('/operation/')).length,0);assert.equal(h.calls.filter(c=>c.body&&JSON.parse(c.body).type==='recovered').length,0);
 h.ctx.QCHealth.failure('snapshot','http',401);assert.match(box.textContent,/登录验证已失效/);assert.equal(box.children[0].children[0].href,'/');
});
