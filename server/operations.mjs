import {randomUUID} from 'node:crypto';
import {ACCOUNT_ID} from './api.mjs';
import {planInfo,DETAIL_PATHS} from './details.mjs';
import {BridgeError} from './bridge.mjs';
import {prepareTask} from './tasks.mjs';

export const WRITE_PATHS={budget:'/ad/api/data/v1/creation/batch_update_budget',roi:'/ad/api/pmc/v1/uni-promotion/ad/update_uni_promotion_roi',status:'/ad/api/pmc/v1/batch_update_operation',delete:'/ad/api/pmc/v1/batch_update_operation'};
function numberText(raw,label){const s=String(raw).trim();if(!/^\d+(?:\.\d{1,2})?$/.test(s))throw new BridgeError(label+'必须是最多两位小数的非负数','INVALID_INPUT',400);return Number(s);}
export function buildOperation(action,ad,value){
 const id=String(ad.id);if(ad.marGoal!==1)throw new BridgeError('仅允许商品计划','SCOPE_DENIED',400);
 if(action==='budget'){
  if(!ad.operation?.budgetEditOperation?.editable)throw new BridgeError(ad.operation?.budgetEditOperation?.msg||'此计划不允许修改预算','OPERATION_DENIED',400);
  const amount=numberText(value,'预算'),before=Number(ad.budget)/100000;
  if(amount<300||amount>999999999.99)throw new BridgeError('预算需在300至999999999.99元之间','INVALID_INPUT',400);
  if(amount===before)throw new BridgeError('预算未变化','NO_CHANGE',400);
  if(Math.abs(amount-before)<100)throw new BridgeError('预算修改幅度不能小于100元','INVALID_INPUT',400);
  const rawAmount=Math.round(amount*100000);
  return {action,id,path:WRITE_PATHS.budget,body:{UpdateBudgetInfos:[{ID:id,AdId:id,Value:rawAmount,AdBudget:rawAmount,DeliveryExtra:null}],ForceAsync:false},description:`每日预算：${before} 元 → ${amount} 元`,before,after:amount};
 }
 if(action==='roi'){
  if(!ad.operation?.roi2GoalOperation?.editable)throw new BridgeError(ad.operation?.roi2GoalOperation?.msg||'此计划不允许修改ROI','OPERATION_DENIED',400);
  const roi=numberText(value,'ROI');if(roi<.01||roi>=10000)throw new BridgeError('ROI需大于等于0.01且小于10000','INVALID_INPUT',400);
  if(roi===Number(ad.ecpRoi2Goal))throw new BridgeError('ROI未变化','NO_CHANGE',400);
  return {action,id,path:WRITE_PATHS.roi,body:{UpdateRoi2Infos:[{ID:id,value:roi,DeepExternalAction:ad.deepExternalAction,OverallROICostItems:[...(ad.overallRoiCostItems||[])].sort((a,b)=>a-b)}]},description:`综合营销ROI目标：${ad.ecpRoi2Goal} → ${roi}`,before:ad.ecpRoi2Goal,after:roi};
 }
 if(action==='status'){
  if(!ad.operation?.optStatusOperation?.editable)throw new BridgeError(ad.operation?.optStatusOperation?.msg||'此计划不允许修改投放状态','OPERATION_DENIED',400);
  if(!['pause','start'].includes(value))throw new BridgeError('投放状态无效','INVALID_INPUT',400);
  return {action,id,path:WRITE_PATHS.status,body:{objects:[{objectID:id,type:1}],optType:value==='pause'?2:1},description:value==='pause'?'暂停此计划投放':'启动此计划投放',before:ad.adOptType,after:value};
 }
 if(action==='delete')return {action,id,path:WRITE_PATHS.delete,body:{objects:[{objectID:id,type:1}],optType:3},description:'删除此计划。删除后的恢复能力以千川平台规则为准。',before:ad.modifyTime,after:'deleted'};
 throw new BridgeError('操作类型尚未核验','NOT_VERIFIED',400);
}
export async function prepareOperation(api,q,actorId){
 if(q.accountId!==ACCOUNT_ID)throw new BridgeError('账户不匹配','ACCOUNT_MISMATCH',400);
 if(api.replay)throw new BridgeError('历史样本模式不允许真实操作','REPLAY_READONLY',400);
 const preparedTask=q.action==='task'?await prepareTask(api,q):null;
 const {ad}=preparedTask||await planInfo(api,String(q.id),true),operation=preparedTask?.operation||buildOperation(q.action,ad,q.value);
 if(q.action==='roi'){
  const pairs=api.planCache.get(String(q.id)).extra?.pairs||{};
  const input={adId:String(q.id),adlabScene:1,authorId:String(ad.creativeSetting?.iesCoreUserId||Object.values(pairs).flat()[0]||'0'),deepExternalAction:ad.deepExternalAction,isUniPromShop:Boolean(ad.uniPromShopId),marGoal:1,overallROICostItems:[...(ad.overallRoiCostItems||[])].sort((a,b)=>a-b),ProductID2AwemeUIDList:pairs,whiteListMap:{overallMarketingSuggestRoiGraph:true}};
  const suggestion=await api.call(DETAIL_PATHS.roi,{getSuggestedRoiGoalInputs:[input]});const info=suggestion.data?.getSuggestedRoiGoalOutputs?.[0];
  if(info?.roi2UpperBound&&operation.after>info.roi2UpperBound)throw new BridgeError('当前计划ROI目标不能超过 '+info.roi2UpperBound,'INVALID_INPUT',400);
  if(info?.ecpRoi2Goal&&operation.after>info.ecpRoi2Goal)operation.description+='（高于平台建议值 '+info.ecpRoi2Goal+'）';
 }
 api.confirmations??=new Map();for(const [key,value]of api.confirmations)if(value.expiresAt<Date.now())api.confirmations.delete(key);const token=randomUUID();api.confirmations.set(token,{...operation,actorId,accountId:ACCOUNT_ID,name:ad.name,expiresAt:Date.now()+90000,modifyTime:ad.modifyTime});
 return {token,expiresAt:Date.now()+90000,accountId:ACCOUNT_ID,planId:operation.id,name:ad.name,description:operation.description,before:operation.before,after:operation.after,action:q.action,canSubmit:api.allowWrites};
}
export async function commitOperation(api,q,actorId){
 if(!api.allowWrites)throw new BridgeError('当前为只读模式，未向千川提交','READONLY_MODE',409);
 const action=api.confirmations?.get(q.token);if(!action||action.expiresAt<Date.now())throw new BridgeError('确认已过期，请重新检查当前计划','CONFIRMATION_EXPIRED',409);
 if(action.actorId!==actorId)throw new BridgeError('此确认属于其他登录会话，请重新核对','CONFIRMATION_REQUIRED',403);
 if(q.accountId!==ACCOUNT_ID||q.planId!==action.id||q.confirmed!==true)throw new BridgeError('确认信息不匹配','CONFIRMATION_REQUIRED',400);
 if(action.action==='delete'&&q.typedPlanId!==action.id)throw new BridgeError('请正确输入计划ID以确认删除','CONFIRMATION_REQUIRED',400);
 api.confirmations.delete(q.token);
 const {ad}=await planInfo(api,action.id,true);
 if(ad.modifyTime!==action.modifyTime)throw new BridgeError('计划已在其他页面变更，请重新查看后再操作','PLAN_CHANGED',409);
 if(action.action!=='task')buildOperation(action.action,ad,action.after);
 let response;try{response=await api.call(action.path,action.body,{intent:'write',reqFrom:'replica_product_confirmed_operation'});}catch(error){throw new BridgeError('未能确认提交结果，请先查看千川原页或操作日志，勿直接重复提交。'+error.message,'OPERATION_UNCERTAIN',502);}
 const results=response.data?.results??[];
 if(action.action!=='task'&&(!results.length||results.some(r=>!r.flag)))throw new BridgeError(results.find(r=>!r.flag)?.error?.errorMessage||'提交结果尚未明确，请查看千川原页或操作日志后再决定是否重试','OPERATION_UNCERTAIN',502);
 api.detailCache?.delete(action.id);return {success:true,accountId:ACCOUNT_ID,planId:action.id,action:action.action};
}
