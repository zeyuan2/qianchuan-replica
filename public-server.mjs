import {readFile,appendFile} from 'node:fs/promises';
import {createLanServer} from './lan-server.mjs';
import {CloudflareAccess} from './server/cloudflare-access.mjs';
import {auditRecord} from './server/public-audit.mjs';
const config=JSON.parse(await readFile(new URL('./.runtime/public-access.json',import.meta.url),'utf8'));
const access=new CloudflareAccess(config),assets=new Map();
const files=['automation-recovery.mjs','plan-time.mjs','health-client.js','lan-main.mjs','batch-boost.mjs','batch-model.mjs','lan-data.mjs','lan-plan-detail.mjs','lan-operations-ui.mjs','lan-task-ui.mjs','operator-ui.mjs','metric-picker.mjs','metric-config.mjs','selection-state.mjs','render-state.mjs','preferences.mjs','top-metric-catalog.mjs','table-metric-catalog.mjs','operations-ui.mjs','task-ui.mjs','poller.mjs','styles.css','scope.css','metric-picker.css','live.css','lan.css','assets/favicon.svg'];
for(const file of files){const body=await readFile(new URL('./dist/'+file,import.meta.url));assets.set('/'+file,{body,type:file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8'});}
const html=await readFile(new URL('./dist/lan.html',import.meta.url));
const proxy=async(endpoint,options)=>{
 const response=await fetch('http://127.0.0.1:5173'+endpoint,{...options,signal:AbortSignal.timeout(65000)}),body=Buffer.from(await response.arrayBuffer());
 // Best-effort audit: a log write failure must not turn a definitive upstream
 // result into a "提交结果未确认" error for the operator.
 const record=auditRecord({endpoint,actor:options.headers['X-Replica-Client'],bodyText:options.body,httpStatus:response.status,responseText:body.toString('utf8')});
 if(record)try{await appendFile(new URL('./.runtime/public-operations.jsonl',import.meta.url),JSON.stringify(record)+'\n');}catch(error){console.error('公共操作日志写入失败（操作结果未受影响）：'+error.message,JSON.stringify(record));}
 return {status:response.status,body,cookie:response.headers.get('set-cookie')};
};
const server=createLanServer({host:'127.0.0.1',port:8090,publicOrigin:config.origin,authorize:req=>access.authenticate(req),html,assets,proxy});
server.listen(8090,'127.0.0.1',()=>console.log('Public gateway ready; verified Cloudflare Access identity required'));
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit()));
