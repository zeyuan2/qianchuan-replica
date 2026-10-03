const ACCOUNT='1000000000000000';
export function allowedWrite(job,now=Date.now()){
 if(job.accountId!==ACCOUNT||job.query?.aavid!==ACCOUNT||job.method!=='POST'||job.intent!=='write'||job.confirmedOperation!==true||!(job.expiresAt>now)||job.expiresAt>now+60000)return false;
 const body=job.body,id=v=>typeof v==='string'&&/^\d{10,25}$/.test(v);
 switch(job.path){
  case '/ad/api/data/v1/creation/batch_update_budget':return body?.UpdateBudgetInfos?.length===1&&body.UpdateBudgetInfos.every(v=>id(v.ID)&&v.ID===v.AdId&&v.Value===v.AdBudget&&Number.isSafeInteger(v.Value)&&v.Value>=30000000);
  case '/ad/api/pmc/v1/uni-promotion/ad/update_uni_promotion_roi':return body?.UpdateRoi2Infos?.length===1&&body.UpdateRoi2Infos.every(v=>id(v.ID)&&Number.isFinite(v.value)&&v.value>=.01&&v.value<10000);
  case '/ad/api/pmc/v1/batch_update_operation':return [1,2,3].includes(body?.optType)&&body?.objects?.length===1&&body.objects.every(v=>id(v.objectID)&&v.type===1);
  case '/ad/api/pmc/v1/uni-promotion/ad/create-uni-prom-assist-task':return Boolean(body&&id(body.PrimaryAID)&&body.MarGoal===1&&[1,2,3].includes(body.Scene)&&Number.isSafeInteger(body.Budget)&&body.Budget>=10000000);
  default:return false;
 }
}
