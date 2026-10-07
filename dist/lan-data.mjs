import {planCreatedSeconds} from './plan-time.mjs';
const norm=s=>String(s).replace(/_/g,'').toLowerCase();
export function getShanghaiDate(date=new Date()){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(v=>[v.type,v.value]));return `${p.year}-${p.month}-${p.day}`;}
export function datePreset(name,anchor=getShanghaiDate()){
 const shift=n=>{const d=new Date(anchor+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 if(name==='today')return {from:anchor,to:anchor};if(name==='yesterday')return {from:shift(-1),to:shift(-1)};
 if(name==='last7')return {from:shift(-6),to:anchor};if(name==='last30')return {from:shift(-29),to:anchor};if(name==='month')return {from:anchor.slice(0,8)+'01',to:anchor};return null;
}
export function validateDateRange(from,to,max=getShanghaiDate()){
 const valid=v=>{try{return /^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}catch{return false;}};
 if(!valid(from)||!valid(to))throw new Error('请选择开始日期和结束日期');if(from>to)throw new Error('开始日期不能晚于结束日期');if(to>max)throw new Error('结束日期不能晚于今天');return {from,to};
}
const cache=new Map();
let pending=new Map();
export function selectSnapshot(snapshot,q){
 if(q.product==='managed')throw new Error('当前自动采集范围是商品自选');
 let plans=[...snapshot.plans];
 if(q.search){const keyword=q.search.toLowerCase();plans=plans.filter(p=>p.name.toLowerCase().includes(keyword)||p.id.includes(keyword));}
 const labels={13:'投放中',2:'新建审核中',15:'修改审核中',16:'审核不通过',4:'手动暂停',11:'计划预算不足',22:'账户预算已花光',10:'账户余额不足',23:'系统暂停',14:'不在投放时段',6:'未到投放时间',24:'在投计划配额超限',19:'商品暂不可用',1:'已删除',3:'已完成',21:'已终止'};
 if(q.status&&q.status!=='all'&&q.status!=='30')plans=plans.filter(p=>p.statusText===labels[q.status]||(String(q.status)==='4'&&p.statusText==='已暂停'&&p.raw?.adOptType===1));
 if(q.service&&q.service!=='all'){const label={1:'千川星选素材投放',2:'含达人佣金出价',3:'基础投放'}[q.service];plans=plans.filter(p=>q.serviceMode==='exclude'?!p.service.includes(label):p.service.includes(label));}
 if(q.costStatus&&q.costStatus!=='all')plans=plans.filter(p=>{const metric=p.metrics[norm('stat_cost_for_roi2')],value=Number(metric?.value??metric?.Value);return q.costStatus==='zero'?value===0:value>0;});
 const events=new Map((snapshot.newPlanEvents||[]).map(e=>[e.id,e]));
 if(q.onlyNew)plans=plans.filter(p=>events.has(p.id));
 const field=q.sortField||'create_time',direction=q.sortType==='asc'?1:-1;
 const value=p=>field==='create_time'?planCreatedSeconds(p):Number(p.metrics[norm(field)]?.value??p.metrics[norm(field)]?.Value);
 plans.sort((a,b)=>{const av=value(a),bv=value(b);if(!Number.isFinite(av)&&!Number.isFinite(bv))return a.id.localeCompare(b.id);if(!Number.isFinite(av))return 1;if(!Number.isFinite(bv))return -1;return (av-bv)*direction||a.id.localeCompare(b.id);});
 const total=plans.length,pageSize=Math.max(1,Number(q.pageSize)||10),page=Math.max(1,Math.min(Number(q.page)||1,Math.max(1,Math.ceil(total/pageSize))));
 return {...snapshot,accountTotal:snapshot.total,cachedCount:snapshot.plans.length,plans:plans.slice((page-1)*pageSize,page*pageSize).map(p=>({...p,newEvent:events.get(p.id)||null})),total,page,pageSize,allowWrites:false,newEventCount:events.size};
}
async function readCached(url,force){
 if(pending.has(url))return pending.get(url);
 const old=cache.get(url);if(old&&!force&&Date.now()-old.checkedAt<5000)return old.value;
 const request=(async()=>{const response=await fetch(url,{headers:old?.etag?{'If-None-Match':old.etag}:{},cache:'no-cache'});if(response.status===304&&old){old.checkedAt=Date.now();return old.value;}const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'读取采集数据失败');cache.set(url,{etag:response.headers.get('ETag'),value:data,checkedAt:Date.now()});return data;})();
 pending.set(url,request);try{return await request;}finally{pending.delete(url);}
}
export async function loadLanData(q){
 validateDateRange(q.from,q.to);
 const current=q.from===getShanghaiDate()&&q.to===q.from,url='/lan-api/snapshot'+(current?'':'?from='+encodeURIComponent(q.from)+'&to='+encodeURIComponent(q.to));
 const packet=await readCached(url,Boolean(q.force));
 if(!packet.snapshot)throw new Error(packet.monitor.error?.message||'正在等待第一轮完整采集');
 const monitor=packet.rangeQuery?{...packet.monitor,lastSuccessAt:packet.snapshot.fetchedAt,nextCaptureAt:packet.rangeQuery.expiresAt,running:false,error:packet.rangeQuery.error||packet.monitor.error}:packet.monitor;
 return {...selectSnapshot(packet.snapshot,q),monitor,rangeQuery:packet.rangeQuery,historical:Boolean(packet.historical)};
}
