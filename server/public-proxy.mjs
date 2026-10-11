// Public-gateway proxy factory. Kept as a module (not inlined in public-server.mjs)
// so every request shape that flows through the gateway stays covered by tests —
// header-less reads (snapshot polling) must never touch request options blindly.
import {auditRecord} from './public-audit.mjs';
export function createPublicProxy({fetcher=fetch,audit=auditRecord,log=null}={}){
 return async(endpoint,options={})=>{
  const response=await fetcher('http://127.0.0.1:5173'+endpoint,{...options,signal:AbortSignal.timeout(65000)}),body=Buffer.from(await response.arrayBuffer());
  // Best-effort audit: a log write failure must not turn a definitive upstream
  // result into a "提交结果未确认" error for the operator.
  const record=audit({endpoint,actor:options.headers?.['X-Replica-Client'],bodyText:options.body,httpStatus:response.status,responseText:body.toString('utf8')});
  if(record&&log)try{await log(record);}catch(error){console.error('公共操作日志写入失败（操作结果未受影响）：'+error.message,JSON.stringify(record));}
  return {status:response.status,body,cookie:response.headers.get('set-cookie')};
 };
}
