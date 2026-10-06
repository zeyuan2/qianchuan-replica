/* Only fixed categories are reported. Never collect URLs, headers, messages or business payloads. */
(()=>{
 const nativeFetch=window.fetch.bind(window),key='qc-health-pending-v1',active=new Map(),failedAssets=new Map();let queue=[],flushing=false,timer,loaded=false,lastDataAt=null;
 const now=()=>new Date().toISOString(),date=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10).replaceAll('-','');
 const id=()=>`QC-${date()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
 const device=()=>matchMedia('(max-width: 700px)').matches?'mobile':'desktop';
 const clean=()=>{queue=queue.filter(r=>Date.now()-Date.parse(r.at)<14*86400000).slice(-50);try{localStorage.setItem(key,JSON.stringify(queue));}catch{}};
 try{queue=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(queue))queue=[];queue=queue.filter(r=>r&&/^QC-\d{8}-[A-F0-9]{8}$/.test(r.id));}catch{queue=[];}
 // Recreate only the approved fields when restoring browser storage.
 queue=queue.map(r=>({id:r.id,at:r.at,type:r.type,area:r.area,status:r.status,online:r.online===true,device:r.device}));clean();
 function render(){
  let box=document.getElementById('qc-health-notice');if(!box){box=document.createElement('aside');box.id='qc-health-notice';box.setAttribute('role','status');box.style.cssText='position:fixed;bottom:16px;left:16px;z-index:10000;box-sizing:border-box;max-width:min(460px,90vw);padding:12px 16px;border:1px solid #debd77;border-radius:8px;background:#fff9e9;color:#553e15;font:13px/1.6 system-ui;box-shadow:0 4px 18px #0002';document.body?.append(box);}
  const last=[...active.values()].filter(r=>!r.dismissed).at(-1);box.hidden=!last;if(!last)return;
  const label={network:'连接失败',http:last.status===401?'登录验证已失效':last.status===403?'访问被拒绝':'请求失败',javascript:'检测到一次页面异常',resource:'部分页面资源加载失败',offline:'网络已断开',startup:'页面加载超时'}[last.type]||'页面异常';
  const stamp=t=>new Date(t).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  const current=loaded?`最近成功显示的数据：${lastDataAt?stamp(lastDataAt):'已载入'}。`:'';
  const delivery=queue.some(r=>r.id===last.id)?'记录待补报。':'记录已上报。';
  box.textContent=`${label} · 编号 ${last.id} · 发生于 ${stamp(last.at)}。${current}${delivery}`;
  const actions=document.createElement('div');actions.style.cssText='display:flex;gap:12px;margin-top:8px';
  const retry=document.createElement('a');retry.href='/';retry.textContent=last.status===401||last.status===403?'重新登录':'重新打开工作台';retry.style.cssText='color:#294cc5;text-decoration:underline';actions.append(retry);
  const close=document.createElement('button');close.type='button';close.textContent='关闭本次提示';close.style.cssText='border:0;background:transparent;color:#553e15;cursor:pointer';close.onclick=()=>{last.dismissed=true;render();};actions.append(close);box.append(actions);
 }

 function enqueue(record){const {id,at,type,area,status}=record;queue.push({id,at,type,area,status,online:navigator.onLine,device:device()});clean();void flush();}
 async function flush(){if(flushing||!navigator.onLine)return;flushing=true;try{while(queue.length){const item=queue[0],r=await nativeFetch('/lan-api/health/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item),signal:AbortSignal.timeout(5000)});if(!r.ok){if(r.status===400){queue.shift();clean();continue;}break;}queue.shift();clean();}}catch{}finally{flushing=false;render();}}
 function failure(area,type='network',status=null){if(!['snapshot','detail','operation','asset','page','other'].includes(area))area='other';if(!['network','http','javascript','resource','offline','startup'].includes(type))type='network';const k=area+':'+type;if(active.has(k)){const existing=active.get(k);existing.dismissed=false;render();return existing.id;}const record={id:id(),at:now(),type,area,status:Number.isInteger(status)?status:null};active.set(k,record);enqueue(record);render();return record.id;}
 function recovered(area,types=['network','http']){for(const [k,r] of active)if(r.area===area&&types.includes(r.type)){enqueue({...r,type:'recovered',status:null,at:now()});active.delete(k);}render();}
 function verifyAssets(){for(const [element,kind] of failedAssets)if((kind==='script'&&loaded)||(kind==='style'&&(element.sheet||element.disabled)))failedAssets.delete(element);if(!failedAssets.size)recovered('asset',['resource']);}
 function ready(fetchedAt){loaded=true;if(Number.isFinite(Date.parse(fetchedAt)))lastDataAt=fetchedAt;clearTimeout(timer);recovered('page',['startup']);recovered('snapshot');verifyAssets();render();}
 function assetKind(element){if(element?.tagName==='LINK'&&String(element.rel||'').toLowerCase().split(/\s+/).includes('stylesheet')){try{const u=new URL(element.href,location.href);if(u.origin===location.origin&&['/styles.css','/scope.css','/metric-picker.css','/live.css','/lan.css','/roi-change.css'].includes(u.pathname))return 'style';}catch{}}if(element?.tagName==='SCRIPT'){try{const u=new URL(element.src,location.href);if(u.origin===location.origin&&['/lan-main.mjs','/health-client.js'].includes(u.pathname))return 'script';}catch{}}return null;}

 function areaOf(input){try{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);if(u.origin!==location.origin)return null;const p=u.pathname;if(p==='/lan-api/snapshot')return 'snapshot';if(p==='/lan-api/detail')return 'detail';if(p.startsWith('/lan-api/operation/'))return 'operation';return null;}catch{return null;}}
 window.fetch=async(...args)=>{const area=areaOf(args[0]);try{const r=await nativeFetch(...args);if(area){if(r.status>=500||r.status===401||r.status===403)failure(area,'http',r.status);else if(r.ok)recovered(area);}return r;}catch(e){if(area&&e.name!=='AbortError')failure(area,'network');throw e;}};
 window.QCHealth={failure,ready};
 addEventListener('offline',()=>failure('page','offline'));addEventListener('online',()=>{recovered('page',['offline']);void flush();});
 addEventListener('error',e=>{const kind=assetKind(e.target);if(kind){failedAssets.set(e.target,kind);failure('asset','resource');}else if(e.target===window)failure('page','javascript');},true);
 addEventListener('load',e=>{if(failedAssets.delete(e.target))verifyAssets();},true);
 addEventListener('unhandledrejection',()=>failure('page','javascript'));
 const boot=()=>{render();void flush();if(!loaded)timer=setTimeout(()=>failure('page','startup'),30000);};
 if(document.readyState==='loading')addEventListener('DOMContentLoaded',boot,{once:true});else boot();
 setInterval(()=>void flush(),60000);
})();
