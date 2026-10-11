// Audit trail for confirmed account actions that arrive through a gateway.
// Only the whitelisted fields below may enter the log: request tokens,
// passwords and typed plan IDs must never be recorded.
export const AUDITED_ENDPOINTS=new Set(['/api/operation/commit','/api/operation/batch-commit','/api/operation/automation-commit']);
export function auditRecord({endpoint,actor,bodyText,httpStatus,responseText,clock=Date.now}){
 if(!AUDITED_ENDPOINTS.has(endpoint))return null;
 let body=null,result=null;
 try{body=bodyText?JSON.parse(bodyText):{}}catch{body={};}
 try{result=responseText?JSON.parse(responseText):null}catch{result=null;}
 const record={at:new Date(clock()).toISOString(),actor,planId:body?.planId??result?.planId??undefined,batchId:undefined,httpStatus,outcome:result?.success?'success':result?.status||result?.error?.code||'unknown'};
 if(endpoint==='/api/operation/batch-commit')record.batchId=result?.id??undefined;
 if(endpoint==='/api/operation/automation-commit'){record.journalId=body?.id??undefined;record.kind=body?.kind??undefined;record.index=Number.isInteger(body?.index)?body.index:undefined;}
 return record;
}
