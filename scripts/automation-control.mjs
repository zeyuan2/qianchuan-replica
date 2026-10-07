import fs from 'node:fs/promises';
import {localBase} from './automation-preflight.mjs';
const command=process.argv[2]||'status';
if(command==='stop'){
 const directory=new URL('../.runtime/automation/',import.meta.url);await fs.mkdir(directory,{recursive:true});await fs.writeFile(new URL('STOP',directory),'Operator requested stop at '+new Date().toISOString()+'\n');
 console.log('已写入停止标志。调度器将停止发起新操作；正在提交的结果仍需核对。');
}else if(command==='status'){
 const base=localBase(process.env.AUTOMATION_BASE_URL||'http://127.0.0.1:5173');const response=await fetch(base+'/api/automation/status',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('STATUS_HTTP_'+response.status);
 const status=await response.json();console.log(JSON.stringify(status,null,2));
}else throw Error('Usage: node scripts/automation-control.mjs [status|stop]');
