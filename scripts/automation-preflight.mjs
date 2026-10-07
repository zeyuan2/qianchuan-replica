// Read-only production-host inventory. Never enables automation or writes ads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {RULES,localDay,validateEnrollment} from '../server/automation-policy.mjs';

export function validateRequest(request) {
  validateEnrollment({...request,accountId:'1000000000000000'});
  if (request.activate !== false) throw new Error('REQUEST_MUST_NOT_ACTIVATE');
  return request;
}

export function localBase(value) {
  const url=new URL(value);
  if (url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname!=='/' || url.search || url.hash) {
    throw new Error('ONLY_LOOPBACK_HTTP_ORIGIN_ALLOWED');
  }
  return url.origin;
}

function number(value) {
  if (typeof value==='string' && value.trim()!=='' && /^\d+(\.\d+)?$/.test(value)) value=Number(value);
  return typeof value==='number' && Number.isFinite(value) && value>=0 ? value : null;
}

export function inspectHost(request,status,view,now=Date.now()) {
  validateRequest(request);
  const issues=[],snapshot=view?.snapshot;
  const accountId=status?.accountId;
  if (typeof accountId!=='string' || !/^\d{10,25}$/.test(accountId) || accountId==='1000000000000000') issues.push('LIVE_ACCOUNT_NOT_VERIFIED');
  if (status?.replay!==false) issues.push('REPLAY_OR_UNKNOWN');
  if (status?.allowWrites!==true || status?.bridge?.writeReady!==true) issues.push('WRITE_BRIDGE_NOT_READY');
  if (view?.accountId!==accountId || snapshot?.accountId!==accountId) issues.push('ACCOUNT_MISMATCH');
  if (snapshot?.source!=='live' || snapshot?.complete!==true) issues.push('INCOMPLETE_OR_NONLIVE_SNAPSHOT');
  const fetched=Date.parse(snapshot?.fetchedAt);
  if (!Number.isFinite(fetched) || fetched>now || now-fetched>300000) issues.push('STALE_SNAPSHOT');
  if (snapshot?.from!==localDay(now) || snapshot?.to!==localDay(now)) issues.push('NOT_TODAY');
  const rows=Array.isArray(snapshot?.plans)?snapshot.plans:[];
  if (rows.length!==snapshot?.total || new Set(rows.map(p=>p.id)).size!==rows.length) issues.push('PLAN_LIST_INCOMPLETE');
  const plans=request.planIds.map(id=>{
    const matches=rows.filter(p=>p.id===id);
    if (matches.length!==1) return {id,found:false,issues:['PLAN_NOT_UNIQUELY_FOUND']};
    const p=matches[0],problems=[];
    if (p.accountId!==accountId || p.marGoal!==1) problems.push('PLAN_IDENTITY_MISMATCH');
    if (p.status!=='active' || p.isEnabled!==true) problems.push('NOT_CONFIRMED_ACTIVE');
    const roi=number(p.roiTarget),budget=number(p.budget);
    const metric=p.metrics?.statcostforroi2primary;
    const basicSpend=number(metric?.Value??metric?.value);
    if (roi===null || roi<=0 || budget===null || budget<300 || basicSpend===null) problems.push('METRICS_INVALID');
    const createdSeconds=number(p.raw?.createTime);
    const createdAt=createdSeconds && createdSeconds*1000<=now ? new Date(createdSeconds*1000).toISOString():null;
    if (!createdAt) problems.push('CREATION_TIME_UNKNOWN');
    // Generic modifyTime is deliberately not exported as an ROI edit time.
    return {id,found:true,name:typeof p.name==='string'?p.name:'',status:p.status??null,
      configuredRoi:roi,budget,basicSpend,createdAt,issues:problems};
  });
  return {version:RULES.version,checkedAt:new Date(now).toISOString(),mode:'read-only',automationStarted:false,
    accountId:typeof accountId==='string'?accountId:null,sourceChecksPassed:issues.length===0&&plans.every(p=>p.issues.length===0),
    issues,plans,pendingHostIntegration:[
      'Verify approval state/time and ROI edit history from real operation logs; generic modifyTime is insufficient.',
      'Verify past same-day 300->600->900 history and unfinished boost tasks.',
      'Implement exact rolling 24h revenue/cost/basic-spend totals and stable observation persistence.',
      'Integrate serialized scheduler, durable write journal, readback and existing WeChat recipients.',
      'Enable only the requested IDs after successful host checks and return an activation receipt.'
    ]};
}

export async function preflight({request,baseUrl='http://127.0.0.1:5173',fetchImpl=fetch,now=Date.now()}) {
  validateRequest(request);const base=localBase(baseUrl);
  const get=async endpoint=>{
    const response=await fetchImpl(base+endpoint,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`PREFLIGHT_HTTP_${response.status}`);
    return response.json();
  };
  const status=await get('/api/status');
  const view=await get('/api/monitor');
  return inspectHost(request,status,view,now);
}

async function main() {
  const options=Object.fromEntries(process.argv.slice(2).map(v=>{
    const match=/^--(request|base-url|output)=(.+)$/.exec(v);
    if (!match) throw new Error('Usage: node scripts/automation-preflight.mjs --request=FILE [--base-url=http://127.0.0.1:5173] [--output=FILE]');
    return [match[1],match[2]];
  }));
  if (!options.request) throw new Error('REQUEST_FILE_REQUIRED');
  const request=JSON.parse(await fs.readFile(options.request,'utf8'));
  const report=await preflight({request,baseUrl:options['base-url']});
  const output=path.resolve(options.output||'.runtime/automation/preflight.json');
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify({report:output,sourceChecksPassed:report.sourceChecksPassed,automationStarted:false,issues:report.issues}));
  if (!report.sourceChecksPassed) process.exitCode=2;
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
