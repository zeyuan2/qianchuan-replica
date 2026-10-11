import test from 'node:test';
import assert from 'node:assert/strict';
import {AUDITED_ENDPOINTS,auditRecord} from '../server/public-audit.mjs';

test('confirmed plan operations log the plan, actor and upstream outcome without secrets',()=>{
 const record=auditRecord({endpoint:'/api/operation/commit',actor:'access:member2@example.com',bodyText:JSON.stringify({token:'secret-token',accountId:'1000000000000000',planId:'1000000000000100',confirmed:true,typedPlanId:'1000000000000100'}),httpStatus:200,responseText:JSON.stringify({success:true,accountId:'1000000000000000',planId:'1000000000000100',action:'budget'}),clock:()=>1790900000000});
 assert.equal(record.planId,'1000000000000100');assert.equal(record.actor,'access:member2@example.com');assert.equal(record.outcome,'success');assert.equal(record.batchId,undefined);assert.equal(record.journalId,undefined);
 const text=JSON.stringify(record);for(const secret of ['secret-token','typedPlanId','confirmed'])assert.ok(!text.includes(secret),secret);
});
test('batch commits record the batch id and upstream rejections still land in the log',()=>{
 const accepted=auditRecord({endpoint:'/api/operation/batch-commit',actor:'lan',bodyText:JSON.stringify({accountId:'1000000000000000',token:'t',confirmed:true}),httpStatus:200,responseText:JSON.stringify({id:'batch-1',status:'running'})});
 assert.equal(accepted.batchId,'batch-1');assert.equal(accepted.outcome,'running');assert.equal(accepted.planId,undefined);
 const rejected=auditRecord({endpoint:'/api/operation/batch-commit',actor:'lan',bodyText:'{}',httpStatus:409,responseText:JSON.stringify({error:{code:'CONFIRMATION_EXPIRED'}})});
 assert.equal(rejected.outcome,'CONFIRMATION_EXPIRED');assert.equal(rejected.httpStatus,409);
});
test('automation recovery commits log the journal, step and resulting status',()=>{
 const record=auditRecord({endpoint:'/api/operation/automation-commit',actor:'access:member5@example.com',bodyText:JSON.stringify({accountId:'1000000000000000',id:'job-1',kind:'step',index:1,token:'preview-token',confirmed:true}),httpStatus:200,responseText:JSON.stringify({id:'job-1',planId:'1000000000000100',status:'partial',steps:[]})});
 assert.equal(record.planId,'1000000000000100');assert.equal(record.journalId,'job-1');assert.equal(record.kind,'step');assert.equal(record.index,1);assert.equal(record.outcome,'partial');assert.equal(record.batchId,undefined);
 assert.ok(!JSON.stringify(record).includes('preview-token'));
});
test('endpoints outside the audited set produce no record',()=>{
 assert.equal(auditRecord({endpoint:'/api/operation/prepare',actor:'lan',bodyText:'{}',httpStatus:200,responseText:'{}'}),null);
 assert.equal(auditRecord({endpoint:'/api/monitor',actor:'lan',bodyText:'{}',httpStatus:200,responseText:'{}'}),null);
 assert.ok(AUDITED_ENDPOINTS.has('/api/operation/automation-commit'));
});
test('malformed bodies and non-JSON responses never break the record',()=>{
 const record=auditRecord({endpoint:'/api/operation/commit',actor:undefined,bodyText:'not json',httpStatus:502,responseText:'<html>bad gateway</html>'});
 assert.equal(record.outcome,'unknown');assert.equal(record.planId,undefined);assert.equal(record.actor,undefined);assert.equal(record.batchId,undefined);
 assert.match(record.at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
 assert.equal(JSON.stringify(JSON.parse(JSON.stringify(record))),JSON.stringify(record));
});
