// Report injection failures instead of silently abandoning an accepted job.
// Never re-execute the job: a write may already have reached the platform.
export function selectSourceTab(tabs,account){
 const eligible=tabs.filter(t=>{try{const u=new URL(t.url);return u.origin==='https://qianchuan.jinritemai.com'&&u.searchParams.get('aavid')===account&&/^\/(overall-prom|uni-prom)(\/|$)/.test(u.pathname);}catch{return false;}});
 const usable=t=>!t.discarded&&!t.frozen;
 return eligible.find(t=>t.active&&usable(t))||eligible.find(usable)||eligible[0];
}
export async function executeAndReport(execute,job){
 if(!Number.isFinite(job?.expiresAt)||Date.now()>=job.expiresAt)return {error:{code:'JOB_EXPIRED',message:'请求已过期，未执行'}};
 try{return await execute(job);}catch{return {error:{code:job.intent==='write'?'OPERATION_UNCERTAIN':'BROWSER_EXECUTION_FAILED',message:job.intent==='write'?'浏览器执行中断，提交结果不明确；请核实日志，勿重复提交':'千川页面无法执行查询，请刷新原页；仍失败时重新加载连接扩展'}};}
}
