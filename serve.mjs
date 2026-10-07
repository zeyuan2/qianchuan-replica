import {ActivityGate} from './server/activity-gate.mjs';
import {AutomationLive} from './server/automation-live.mjs';
import {AutomationEngine} from './server/automation-engine.mjs';
import {AutomationNotifier} from './server/automation-notify.mjs';
import {collectFullSnapshot} from './server/full-capture.mjs';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BrowserBridge,BridgeError} from './server/bridge.mjs';
import {QianchuanApi,ACCOUNT_ID} from './server/api.mjs';
import {loadDetail} from './server/details.mjs';
import {prepareOperation,commitOperation} from './server/operations.mjs';
import {ProductMonitor,atomicJson} from './server/monitor.mjs';
import {RangeQueryService} from './server/range-query.mjs';
import {OperatorAccess} from './server/operator-access.mjs';
import {BudgetAlerts} from './server/budget-alerts.mjs';
import {parseTunnelToken} from './server/tunnel-token.mjs';
import {readRoiHours} from './server/roi-hours.mjs';
import {BatchBoost} from './server/batch-boost.mjs';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
const port=Number(process.env.PORT||5173);
let savedConnection;try{const c=JSON.parse(await readFile(new URL('./.runtime/connection.json',import.meta.url),'utf8'));if(c.accountId===ACCOUNT_ID&&c.url===`http://127.0.0.1:${port}`)savedConnection=c;}catch{}
const bridge=new BrowserBridge({token:savedConnection?.token}),api=new QianchuanApi(bridge,{replay:process.env.REPLICA_REPLAY==='1',allowWrites:process.env.ALLOW_ACCOUNT_WRITES==='1'});
const localOrigin=`http://127.0.0.1:${port}`;
const operators=await new OperatorAccess({filename:fileURLToPath(new URL('./.runtime/operators.json',import.meta.url))}).init();
Object.defineProperty(api,'allowWrites',{get:()=>!api.replay&&operators.configured&&bridge.status().writeReady});
const activityGate=new ActivityGate();let automation;
let operationBusy=false;
let pairingSwitch=false;
function requireWriteAccess(req){const session=operators.require(req.headers.cookie);if(!api.allowWrites)throw new BridgeError('请在采集电脑重新加载1.3版千川连接扩展，然后刷新连接页','WRITE_BRIDGE_REQUIRED',409);return session;}
const budgetAlerts=await new BudgetAlerts({directory:fileURLToPath(new URL('./.runtime/budget-alerts/',import.meta.url))}).init();
const monitor=await new ProductMonitor({api,directory:fileURLToPath(new URL('./data/monitor/',import.meta.url)),seedFile:fileURLToPath(new URL('./data/snapshots/2026-10-01-preview.json',import.meta.url)),collect:(a,q)=>activityGate.run('capture',()=>collectFullSnapshot(a,q)),onSnapshot:snapshot=>{automation?.kick();return budgetAlerts.run(snapshot);}}).init();
const ranges=new RangeQueryService({api,monitor,directory:fileURLToPath(new URL('./data/monitor/ranges/',import.meta.url))});
const detailCache=new Map();let detailQueue=Promise.resolve(),detailPending=0,detailWindow=Date.now(),detailCount=0;
const batchBoost=await new BatchBoost({api,prepare:(...args)=>activityGate.run('batch-prepare',()=>prepareOperation(...args)),commit:(...args)=>activityGate.run('batch-write',()=>commitOperation(...args)),directory:fileURLToPath(new URL('./.runtime/batch-boost/',import.meta.url)),beforeRead:async()=>{if(monitor.running&&activityGate.owner!=='manual')await monitor.running;},isActorActive:actor=>Boolean(operators.state.sessions[actor]?.expiresAt>Date.now()),onComplete:()=>{detailCache.clear();ranges.invalidate();void monitor.run();}}).init();
let approvedAutomationIds=[];try{const request=JSON.parse(await readFile(new URL('./deployment/automation-enrollment.request.json',import.meta.url),'utf8'));approvedAutomationIds=request.planIds;}catch{}
const automationDirectory=fileURLToPath(new URL('./.runtime/automation/',import.meta.url));
const automationReader=new AutomationLive({api,allowedIds:approvedAutomationIds});
const automationNotifier=await new AutomationNotifier({directory:automationDirectory,alerts:budgetAlerts}).init();
automation=await new AutomationEngine({accountId:ACCOUNT_ID,allowedIds:approvedAutomationIds,directory:automationDirectory,reader:automationReader,gate:activityGate,notifier:automationNotifier,isBusy:()=>operationBusy||Boolean(batchBoost.running)||Boolean(monitor.running),onWrite:async id=>{api.detailCache?.delete(id);detailCache.clear();ranges.invalidate();batchBoost.invalidatePlan(id);}}).init();
function cachedDetail(q){
 if(q.accountId!==ACCOUNT_ID||!api.planCache.has(String(q.id)))throw new BridgeError('计划不属于当前已采集账户','ACCOUNT_MISMATCH',400);
 if(!['data','product','aweme','material','control','detail','log'].includes(q.tab)||q.eligible)throw new BridgeError('内网只开放计划数据查询','SCOPE_DENIED',400);
 if(q.tab==='material'&&!['video','image','atlas','title'].includes(q.materialType))throw new BridgeError('素材类型无效','INVALID_QUERY',400);
 if(q.tab==='control'&&!['boost','heat','search'].includes(q.controlType))throw new BridgeError('调控类型无效','INVALID_QUERY',400);
 const key=JSON.stringify(q),cached=detailCache.get(key);if(cached&&Date.now()-cached.at<300000)return cached.promise;
 if(Date.now()-detailWindow>60000){detailWindow=Date.now();detailCount=0;}
 if(detailPending>=6||detailCount>=10)throw new BridgeError('详情查询较多，请稍后再试；列表自动采集不受影响','RATE_LIMITED',429);
 detailCount++;detailPending++;
 const promise=detailQueue.catch(()=>{}).then(async()=>{if(monitor.running)await monitor.running;return loadDetail(api,q);}).finally(()=>detailPending--);
 detailQueue=promise;detailCache.set(key,{at:Date.now(),promise});promise.catch(()=>detailCache.delete(key));
 if(detailCache.size>300)for(const [k,v]of detailCache)if(Date.now()-v.at>300000)detailCache.delete(k);
 return promise;
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function readJson(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>25000000)throw new BridgeError('请求过大','TOO_LARGE',413);}try{return text?JSON.parse(text):{}}catch{throw new BridgeError('JSON格式错误','BAD_REQUEST',400);}}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,localOrigin),origin=req.headers.origin;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return json(res,403,{error:{message:'Host不允许'}});
  const isBridge=url.pathname.startsWith('/bridge/');
  const bridgeOrigin=isBridge&&(/^chrome-extension:\/\/[a-z]+$/.test(origin||'')||origin==='https://qianchuan.jinritemai.com');
  if(origin&&origin!==localOrigin&&!bridgeOrigin)return json(res,403,{error:{code:'ORIGIN_DENIED',message:'来源不允许'}});
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Replica-Bridge');res.writeHead(204);return res.end();}
  if(isBridge){
   if(pairingSwitch)return json(res,409,{error:{code:'PAIRING_SWITCHING',message:'正在切换采集浏览器，请稍后连接'}});
   if(!bridge.authenticate(req.headers['x-replica-bridge']||url.searchParams.get('token')))return json(res,403,{error:{code:'PAIRING_REQUIRED',message:'连接码不正确'}});
   if(url.pathname==='/bridge/ping'&&req.method==='GET')return json(res,200,{accountId:ACCOUNT_ID,protocolVersion:1});
   if(url.pathname==='/bridge/next'&&req.method==='GET'){const aborted=new AbortController(),close=()=>aborted.abort();res.once('close',close);try{const next=bridge.next(Number(url.searchParams.get('wait')||15000),{writes:url.searchParams.get('client')==='operator-v1',signal:aborted.signal});monitor.bridgeAvailable();const job=await next;if(!res.destroyed)return json(res,200,{job});return;}finally{res.removeListener('close',close);}}
   if(url.pathname==='/bridge/reply'&&req.method==='POST'){const b=await readJson(req);return json(res,200,{accepted:bridge.reply(b.id,b.result)});}
   return json(res,404,{error:{message:'未知连接请求'}});
  }
  if(url.pathname==='/api/status')return json(res,200,{accountId:ACCOUNT_ID,replay:api.replay,allowWrites:api.allowWrites,bridge:bridge.status(),refreshIntervalMs:300000,cycles:api.audit.slice(-20),monitor:monitor.view().monitor});
  if(url.pathname==='/api/external/status'&&req.method==='GET'){
   let configured=false;try{parseTunnelToken(await readFile(new URL('./.runtime/tunnel-token.txt',import.meta.url),'utf8'));configured=true;}catch{}
   let connected=false;try{connected=(await fetch('http://127.0.0.1:20245/ready',{signal:AbortSignal.timeout(1200)})).ok;}catch{}
   return json(res,200,{configured,connected,url:'https://qc.example.com',email:'member2@example.com'});
  }
  if(url.pathname==='/api/external/connect'&&req.method==='POST'){
   if(origin!==localOrigin)throw new BridgeError('请在本机设置页连接','ORIGIN_DENIED',403);
   const q=await readJson(req);let credential;try{credential=parseTunnelToken(q.command);}catch(e){throw new BridgeError(e.message,'INVALID_TUNNEL_TOKEN',400);}
   await writeFile(new URL('./.runtime/tunnel-token.txt',import.meta.url),credential.token,{mode:0o600});
   await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./start-public.ps1',import.meta.url)),'-NoBrowser'],{windowsHide:true,timeout:20000},error=>error?reject(new BridgeError('连接程序未能启动，请查看本机服务日志','TUNNEL_START_FAILED',500)):resolve()));
   return json(res,200,{saved:true,message:'完整连接凭据已保存，正在建立隧道。'});
  }
  if(url.pathname==='/api/budget-alerts/status'&&req.method==='GET')return json(res,200,{...budgetAlerts.status(),preview:budgetAlerts.preview(monitor.packet?.snapshot)});
  if(url.pathname.startsWith('/api/budget-alerts/')&&req.method==='POST'){
   if(origin!==localOrigin)throw new BridgeError('请在采集电脑的通知设置页操作','ORIGIN_DENIED',403);
   if(url.pathname==='/api/budget-alerts/config')return json(res,200,await budgetAlerts.configure(await readJson(req)));
   if(url.pathname==='/api/budget-alerts/test')return json(res,200,await budgetAlerts.test());
  }
  if(url.pathname==='/api/operator/status'&&req.method==='GET'){
   const session=operators.session(req.headers.cookie);if(session)res.setHeader('Set-Cookie',await operators.renew(req.headers.cookie));
   return json(res,200,{accountId:ACCOUNT_ID,configured:operators.configured,authenticated:Boolean(session),writeReady:!api.replay&&bridge.status().writeReady,bridgeConnected:bridge.status().connected,sessionDays:30});
  }
  if(url.pathname.startsWith('/api/operator/')&&req.method==='POST'){
   if(origin!==localOrigin)throw new BridgeError('请从本页面提交','ORIGIN_DENIED',403);
   if(url.pathname==='/api/operator/setup'){const q=await readJson(req);await operators.setPassword(q.password);api.confirmations?.clear();return json(res,200,{configured:true});}
   if(url.pathname==='/api/operator/login'){const q=await readJson(req);res.setHeader('Set-Cookie',await operators.login(q.password,String(req.headers['x-replica-client']||req.socket.remoteAddress)));return json(res,200,{authenticated:true});}
   if(url.pathname==='/api/operator/logout'){res.setHeader('Set-Cookie',await operators.logout(req.headers.cookie));return json(res,200,{authenticated:false});}
  }
  if(url.pathname==='/api/automation/status'&&req.method==='GET')return json(res,200,automation.status());
  if(['/api/automation/inspect','/api/automation/probe-window','/api/automation/stop'].includes(url.pathname)&&req.method==='POST'){
   if(origin!==localOrigin)throw new BridgeError('仅本机自动化控制','ORIGIN_DENIED',403);
   if(url.pathname.endsWith('/stop')){operators.require(req.headers.cookie);await automation.stop();return json(res,200,automation.status());}
   if(automation.config.enabled||automation.running||operationBusy||batchBoost.running||monitor.running)throw new BridgeError('自动化或采集正在运行','AUTOMATION_BUSY',409);
   if(url.pathname.endsWith('/inspect'))return json(res,200,await automation.inspect());
   const release=activityGate.tryAcquire('automation-probe');if(!release)throw new BridgeError('采集或操作正在运行','OPERATION_BUSY',409);try{const q=await readJson(req);return json(res,200,await automationReader.rawWindow(q.id,q.start,q.end));}finally{release();}
  }
  if(url.pathname==='/api/health/data'&&req.method==='GET'){const v=monitor.view();return json(res,200,{complete:v.monitor.complete,planCount:v.monitor.collected,total:v.monitor.total,fetchedAt:v.monitor.lastSuccessAt,bridgeConnected:v.monitor.bridgeConnected,captureFailed:Boolean(v.monitor.error)});}
  if(url.pathname==='/api/monitor'&&req.method==='GET'){
   if(url.searchParams.has('from')||url.searchParams.has('to'))return json(res,200,await ranges.get(url.searchParams.get('from'),url.searchParams.get('to')));
   return json(res,200,await monitor.forDate(url.searchParams.get('date')));
  }
  if(url.pathname==='/api/monitor/refresh'&&req.method==='POST'){
   const last=Date.parse(monitor.status.lastAttemptAt||'');if(monitor.running)return json(res,202,{running:true});
   if(Number.isFinite(last)&&Date.now()-last<30000)return json(res,429,{error:{message:'请等待30秒后再发起采集'}});
   void monitor.run();return json(res,202,{running:true});
  }
  if(url.pathname==='/api/monitor/detail'&&req.method==='POST')return json(res,200,await cachedDetail(await readJson(req)));
  if(url.pathname==='/api/pairing'){
   if(origin&&origin!==localOrigin)return json(res,403,{error:{message:'仅本机页面可读取连接码'}});
   if(req.method==='POST'){
    if(origin!==localOrigin)throw new BridgeError('请从本机连接页面提交','ORIGIN_DENIED',403);
    if(pairingSwitch||operationBusy||monitor.running||detailPending||ranges.pending.size||bridge.pending.size)throw new BridgeError('采集或操作正在处理中，请稍后再连接','BRIDGE_BUSY',409);
    pairingSwitch=true;bridge.switching=true;try{
     const token=randomBytes(24).toString('hex');await atomicJson(fileURLToPath(new URL('./.runtime/connection.json',import.meta.url)),{url:localOrigin,token,accountId:ACCOUNT_ID});bridge.replaceToken(token);
     return json(res,200,{renewed:true,accountId:ACCOUNT_ID});
    }finally{pairingSwitch=false;bridge.switching=false;}
   }
   if(req.method!=='GET')return json(res,405,{error:{message:'不支持此请求方法'}});
   return json(res,200,{url:localOrigin,token:bridge.token,accountId:ACCOUNT_ID});
  }
  if(url.pathname==='/api/roi-observation-source'&&req.method==='POST'){if(origin!==localOrigin)throw new BridgeError('仅本机查询','ORIGIN_DENIED',403);return json(res,200,await readRoiHours(api,await readJson(req),{beforeRead:async()=>{if(monitor.running)await monitor.running;}}));}
  if(url.pathname==='/api/bootstrap'&&req.method==='GET')return json(res,200,await api.bootstrap(url.searchParams.get('force')==='1'));
  if(url.pathname==='/api/dashboard'&&req.method==='POST')return json(res,200,await api.dashboard(await readJson(req)));
  if(url.pathname==='/api/detail'&&req.method==='POST')return json(res,200,await loadDetail(api,await readJson(req)));
  if(url.pathname==='/api/operation/batch-scan-status'&&req.method==='GET')return json(res,200,batchBoost.scanStatus(url.searchParams.get('id'),operators.require(req.headers.cookie).id));
  if(url.pathname==='/api/operation/batch-history'&&req.method==='GET')return json(res,200,batchBoost.history(operators.require(req.headers.cookie).id));
  if(url.pathname==='/api/operation/batch-status'&&req.method==='GET')return json(res,200,batchBoost.get(url.searchParams.get('id'),operators.require(req.headers.cookie).id));
  if(url.pathname==='/api/operation/batch-cancel'&&req.method==='POST'){if(origin!==localOrigin)throw new BridgeError('请从本页面提交','ORIGIN_DENIED',403);const actor=operators.require(req.headers.cookie).id,q=await readJson(req);return json(res,200,await batchBoost.cancel(q.id,actor));}
  if(['/api/operation/prepare','/api/operation/commit','/api/operation/materials','/api/operation/batch-prepare','/api/operation/batch-commit','/api/operation/batch-scan','/api/operation/batch-recheck'].includes(url.pathname)&&req.method==='POST'){
   if(origin!==localOrigin)throw new BridgeError('请从本页面提交','ORIGIN_DENIED',403);
   const session=requireWriteAccess(req),q=await readJson(req);
   if(operationBusy||activityGate.owner||(batchBoost.running&&!url.pathname.endsWith('/batch-commit')))throw new BridgeError('另一项操作或批次正在处理中，请稍后再试','OPERATION_BUSY',409);
   const releaseActivity=activityGate.tryAcquire('manual');if(!releaseActivity)throw new BridgeError('采集或操作正在运行，请稍后重试','OPERATION_BUSY',409);
   operationBusy=true;
   try{
    operators.require(req.headers.cookie);
    if(url.pathname.endsWith('/batch-scan'))return json(res,202,batchBoost.scan(q,session.id));
    if(url.pathname.endsWith('/batch-recheck'))return json(res,200,await batchBoost.recheck(q.id,q.planId,session.id));
    if(url.pathname.endsWith('/batch-prepare'))return json(res,200,await batchBoost.prepare(q,session.id));
    if(url.pathname.endsWith('/batch-commit'))return json(res,200,await batchBoost.start(q,session.id));
    if(url.pathname.endsWith('/materials')){if(q.accountId!==ACCOUNT_ID||q.tab!=='material'||q.materialType!=='video'||q.eligible!==true)throw new BridgeError('素材查询参数无效','INVALID_QUERY',400);return json(res,200,await loadDetail(api,q));}
    if(url.pathname.endsWith('/prepare'))return json(res,200,await prepareOperation(api,q,session.id));
    let result;try{result=await commitOperation(api,q,session.id);}finally{batchBoost.invalidatePlan(q.planId);}detailCache.clear();ranges.invalidate();void monitor.run();return json(res,200,result);
   }finally{operationBusy=false;releaseActivity();}
  }
  if(url.pathname.startsWith('/api/'))return json(res,404,{error:{code:'NOT_FOUND',message:'接口尚未实现'}});
  const pathname=decodeURIComponent(url.pathname),filename=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!filename.startsWith(resolve(root)+sep))throw new BridgeError('路径无效','NOT_FOUND',404);
  const data=await readFile(filename);res.writeHead(200,{'Content-Type':mime[extname(filename)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
 }catch(error){if(!res.headersSent)json(res,error.status|| (error.code==='ENOENT'?404:500),{error:{code:error.code||'INTERNAL_ERROR',message:error.message}});else res.end();}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已被占用。请设置 PORT 后再启动。`:error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',async()=>{
 await mkdir(new URL('./.runtime/',import.meta.url),{recursive:true});
 await writeFile(new URL('./.runtime/connection.json',import.meta.url),JSON.stringify({url:localOrigin,token:bridge.token,accountId:ACCOUNT_ID}));
 console.log(`千川商品复刻：${localOrigin}（${api.replay?'历史样本模式':'真实接口模式'}）`);
 if(!api.replay){monitor.start();automation.start();}
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{monitor.stop();if(automation?.timer)clearInterval(automation.timer);bridge.close();server.close(()=>process.exit());});
