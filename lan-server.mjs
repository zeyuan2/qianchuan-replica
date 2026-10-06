import {reportWriter} from './server/health-store.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

export function createLanServer({host,port,html,assets=new Map(),proxy,publicOrigin=null,authorize=null,healthReport=reportWriter(fileURLToPath(new URL('./.runtime/health/',import.meta.url)))}) {
 if(publicOrigin&&(!publicOrigin.startsWith('https://')||typeof authorize!=='function'))throw new Error('Public access requires HTTPS and identity validation');
 const allowedHosts=new Set([publicOrigin?new URL(publicOrigin).host:`${host}:${port}`]);
 const etag='"'+createHash('sha256').update(html).digest('hex')+'"';
 return http.createServer(async(req,res)=>{
  try{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cache-Control','no-cache');
  if(!allowedHosts.has(req.headers.host)){res.writeHead(403);return res.end('Host not allowed');}
  let url;try{url=new URL(req.url,`http://${host}:${port}`);}catch{res.writeHead(400);return res.end('Bad request');}
  const origin=publicOrigin||`http://${host}:${port}`;
  let identity=null;if(publicOrigin){res.setHeader('Cache-Control','no-store');res.setHeader('Strict-Transport-Security','max-age=31536000');try{identity=await authorize(req);}catch{res.writeHead(401,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:{code:'ACCESS_REQUIRED',message:'登录验证失效，请重新打开网页登录'}}));}}
  if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);return res.end('Origin not allowed');}
  if(url.pathname==='/lan-api/health/report'&&req.method==='POST'){
   if(req.headers.origin!==origin||!String(req.headers['content-type']||'').includes('application/json')){res.writeHead(403);return res.end('Origin or type not allowed');}
   let input='';for await(const part of req){input+=part;if(Buffer.byteLength(input)>4096){res.writeHead(413);return res.end('Too large');}}
   try{let report;try{report=JSON.parse(input);}catch{throw Object.assign(Error(),{status:400});}const result=await healthReport(report);res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(result));}catch(e){res.writeHead([400,429].includes(e.status)?e.status:503,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{code:'HEALTH_REPORT_UNAVAILABLE'}}));}
  }
  const detailRead=url.pathname==='/lan-api/detail'&&req.method==='POST';
  const operatorRoute=new Map([['/lan-api/operator/status','GET'],['/lan-api/operator/login','POST'],['/lan-api/operator/logout','POST'],['/lan-api/operation/prepare','POST'],['/lan-api/operation/commit','POST'],['/lan-api/operation/materials','POST'],['/lan-api/operation/batch-prepare','POST'],['/lan-api/operation/batch-commit','POST'],['/lan-api/operation/batch-status','GET'],['/lan-api/operation/batch-history','GET'],['/lan-api/operation/batch-cancel','POST'],['/lan-api/operation/batch-scan','POST'],['/lan-api/operation/batch-scan-status','GET'],['/lan-api/operation/batch-recheck','POST']]);
  const operatorRequest=operatorRoute.get(url.pathname)===req.method&&Boolean(proxy);
  if(!['GET','HEAD'].includes(req.method)&&!detailRead&&!operatorRequest){res.writeHead(405,{Allow:'GET, HEAD'});return res.end('Method not allowed');}
  if(operatorRequest){
   res.setHeader('Cache-Control','no-store');
   if(req.method==='POST'&&(req.headers.origin!==origin||!String(req.headers['content-type']||'').includes('application/json'))){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'请在本站页面提交操作'}}));}
   let body='';for await(const chunk of req){body+=chunk;if(body.length>(url.pathname.startsWith('/lan-api/operation/batch-')?1048576:20000)){res.writeHead(413);return res.end('Too large');}}
   const data=await proxy(url.pathname.replace('/lan-api/','/api/')+(['/lan-api/operation/batch-status','/lan-api/operation/batch-scan-status'].includes(url.pathname)?'?id='+encodeURIComponent(url.searchParams.get('id')||''):''),{method:req.method,...(req.method==='POST'?{body}:{}),headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:5173',Cookie:req.headers.cookie||'','X-Replica-Client':identity?'access:'+identity.email:req.socket.remoteAddress||'lan'}});
   if(data.cookie)res.setHeader('Set-Cookie',data.cookie.replace('Path=/api/','Path=/lan-api/')+(publicOrigin?'; Secure':''));
   res.writeHead(data.status,{'Content-Type':'application/json; charset=utf-8'});return res.end(data.body);
  }
  if(['/lan-api/roi-observations/list','/lan-api/roi-observations/record'].includes(url.pathname)&&req.method==='GET'&&proxy){const key=url.pathname.endsWith('/list')?'planId':'id',value=url.searchParams.get(key);if(value&&!/^[a-zA-Z0-9-]{1,50}$/.test(value)){res.writeHead(400);return res.end('Invalid query');}const data=await proxy(url.pathname.replace('/lan-api/','/api/')+(value?'?'+key+'='+encodeURIComponent(value):''),{method:'GET'});res.writeHead(data.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(data.body);}
  if(url.pathname==='/lan-api/snapshot'&&['GET','HEAD'].includes(req.method)&&proxy){
   const day=url.searchParams.get('date'),from=url.searchParams.get('from'),to=url.searchParams.get('to'),valid=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'');
   if((day&&!valid(day))||((from||to)&&(!valid(from)||!valid(to)||day))){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'请选择完整且有效的日期区间'}}));}
   const query=from?'?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to):day?'?date='+encodeURIComponent(day):'';
   const data=await proxy('/api/monitor'+query,{method:'GET'});
   const tag='"'+createHash('sha256').update(data.body).digest('hex')+'"';
   if(data.status===200&&req.headers['if-none-match']===tag){res.writeHead(304,{ETag:tag});return res.end();}
   res.writeHead(data.status,{'Content-Type':'application/json; charset=utf-8',ETag:tag});return res.end(req.method==='HEAD'?undefined:data.body);
  }
  if(detailRead&&proxy){
   if(!String(req.headers['content-type']||'').includes('application/json')){res.writeHead(415);return res.end('JSON required');}
   let input='';for await(const chunk of req){input+=chunk;if(input.length>100000){res.writeHead(413);return res.end('Too large');}}
   let q;try{q=JSON.parse(input);}catch{res.writeHead(400);return res.end('Invalid JSON');}
   if(q.accountId!=='1000000000000000'||!/^\d{10,25}$/.test(String(q.id))||!['data','product','aweme','material','control','detail','log'].includes(q.tab)||q.eligible){res.writeHead(400);return res.end('Only known plan queries are supported');}
   const data=await proxy('/api/monitor/detail',{method:'POST',body:JSON.stringify(q),headers:{'Content-Type':'application/json'}});
   res.writeHead(data.status,{'Content-Type':'application/json; charset=utf-8'});return res.end(data.body);
  }
  if(url.pathname==='/healthz'){
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
   return res.end(req.method==='HEAD'?'':JSON.stringify({service:'qianchuan-lan-preview',accountId:'1000000000000000',mode:proxy?'password-protected-monitor':'saved-readonly-snapshot',refreshIntervalMs:300000,host,port,accountOperations:proxy?'password-required':false}));
  }
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(assets.has(url.pathname)){const a=assets.get(url.pathname);res.writeHead(200,{'Content-Type':a.type,'Content-Length':a.body.length});return res.end(req.method==='HEAD'?undefined:a.body);}
  if(!['/','/index.html'].includes(url.pathname)){res.writeHead(404);return res.end('Not found');}
  if(req.headers['if-none-match']===etag){res.writeHead(304,{ETag:etag});return res.end();}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':html.length,ETag:etag});
  res.end(req.method==='HEAD'?undefined:html);
  }catch(error){if(!res.headersSent){const committing=req.url.split('?')[0]==='/lan-api/operation/commit';res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:committing?{code:'OPERATION_UNCERTAIN',message:'提交结果未确认，请先检查千川原页或操作日志，勿直接重复提交'}:{code:'READ_SERVICE_OFFLINE',message:'本机服务暂时无法响应，请稍后刷新'}}));}else res.end();}
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const host=process.env.LAN_HOST||'192.168.1.100',port=Number(process.env.LAN_PORT||8088);
 if(!/^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid LAN address or port');
 const html=await readFile(new URL('./dist/lan.html',import.meta.url)),assets=new Map();
 const files=['health-client.js','lan-main.mjs','batch-boost.mjs','batch-model.mjs','roi-change-ui.mjs','roi-change-model.mjs','roi-change.css','lan-data.mjs','lan-plan-detail.mjs','lan-operations-ui.mjs','lan-task-ui.mjs','operator-ui.mjs','metric-picker.mjs','metric-config.mjs','selection-state.mjs','preferences.mjs','top-metric-catalog.mjs','table-metric-catalog.mjs','operations-ui.mjs','task-ui.mjs','poller.mjs','styles.css','scope.css','metric-picker.css','live.css','lan.css','assets/favicon.svg'];
 for(const file of files){const type=file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8';assets.set('/'+file,{body:await readFile(new URL('./dist/'+file,import.meta.url)),type});}
 const proxy=async(endpoint,options)=>{
  try{const response=await fetch('http://127.0.0.1:5173'+endpoint,{...options,signal:AbortSignal.timeout(65000)});return {status:response.status,body:Buffer.from(await response.arrayBuffer()),cookie:response.headers.get('set-cookie')};}
  catch(error){
   if(options.method==='GET'&&endpoint.startsWith('/api/monitor')){
    const params=new URL(endpoint,'http://local').searchParams,day=params.get('date'),from=params.get('from'),to=params.get('to');let packet;
    try{packet=JSON.parse(await readFile(new URL(from?'./data/monitor/ranges/'+from+'_'+to+'.json':day?'./data/monitor/daily/'+day+'.json':'./data/monitor/latest.json',import.meta.url),'utf8'));}
    catch{if(day||from)return {status:404,body:Buffer.from(JSON.stringify({error:{message:'该日期区间没有已保存的完整记录'}}))};const seed=JSON.parse(await readFile(new URL('./data/snapshots/2026-10-01-preview.json',import.meta.url),'utf8'));packet={accountId:seed.accountId,snapshot:{...seed,total:seed.originalTotal||seed.total,complete:false,source:'recorded'}};}
    if(packet.accountId!=='1000000000000000')throw error;
    return {status:200,body:Buffer.from(JSON.stringify({accountId:packet.accountId,snapshot:{...packet.snapshot,newPlanEvents:packet.events||[]},monitor:{phase:'error',error:{code:'SERVICE_OFFLINE',message:'本机采集服务未运行，当前显示上次保存的数据'},bridgeConnected:false,intervalMs:300000,lastSuccessAt:packet.snapshot.complete?packet.snapshot.fetchedAt:null}}))};
   }
   throw error;
  }
 };
 const server=createLanServer({host,port,html,assets,proxy});
 server.on('error',e=>{console.error(e.message);process.exitCode=1;});
 server.listen(port,host,()=>console.log(`内网只读预览：http://${host}:${port}/`));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit()));
}
