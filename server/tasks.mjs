import {BridgeError} from './bridge.mjs';
import {planInfo} from './details.mjs';
export const CREATE_TASK_PATH='/ad/api/pmc/v1/uni-promotion/ad/create-uni-prom-assist-task';
export function buildTaskOperation(ad,input,eligible=new Set()){
 if(ad.marGoal!==1||!Number.isFinite(Number(ad.budget))||Number(ad.budget)<=0)throw new BridgeError('此商品计划的预算或状态无法核验','OPERATION_DENIED',400);
 const kind=input.kind,scene={boost:1,heat:2,search:3}[kind];if(!scene)throw new BridgeError('调控类型无效','INVALID_INPUT',400);
 const name=String(input.name||'').trim(),nameLength=[...name].reduce((n,c)=>n+(c.codePointAt(0)>255?1:.5),0);
 if(!name||nameLength>50||/\p{Extended_Pictographic}/u.test(name))throw new BridgeError('任务名称需为1–50个字且不包含emoji','INVALID_INPUT',400);
 const budgetText=String(input.budget);if(!/^\d+(?:\.\d{1,2})?$/.test(budgetText))throw new BridgeError('调控预算最多两位小数','INVALID_INPUT',400);
 const budget=Number(budgetText),primaryBudget=Number(ad.budget)/100000;
 if(budget<100||budget>primaryBudget)throw new BridgeError(`调控预算需在100至${primaryBudget}元之间`,'INVALID_INPUT',400);
 const body={MarGoal:1,PrimaryAID:String(ad.id),Scene:scene,SmartBidType:kind==='search'?0:7,Budget:Math.round(budget*100000),Name:name};
 if(kind==='search'){
  const roi=Number(input.roi);if(!/^\d+(?:\.\d{1,2})?$/.test(String(input.roi))||roi<.01||roi>100)throw new BridgeError('搜索抢首屏ROI需为0.01–100，最多两位小数','INVALID_INPUT',400);
  body.EcpRoi2Goal=roi;body.ExternalAction=96;body.DeepExternalAction=576;
 }else{
  const hours=Number(input.duration);if(!Number.isFinite(hours)||hours<.5||hours>24||hours%.5!==0)throw new BridgeError('时长需为0.5–24小时且为0.5的整数倍','INVALID_INPUT',400);body.Duration=Math.round(hours*3600);
 }
 if(kind==='heat'){
  const ids=[...new Set(input.materialIds||[])].map(String);if(!ids.length||ids.length>20||ids.some(id=>!eligible.has(id)))throw new BridgeError('请选择1–20个刚刚查询到且允许追投的视频','MATERIAL_NOT_ELIGIBLE',400);
  body.Mids=ids;body.VideoLegoMids=ids;
 }
 return {action:'task',id:String(ad.id),path:CREATE_TASK_PATH,body,before:ad.modifyTime,after:name,description:`新建${{boost:'一键起量',heat:'素材追投',search:'搜索抢首屏'}[kind]}「${name}」，额外调控预算 ${budget} 元${kind==='search'?'，ROI '+input.roi:'，时长 '+input.duration+' 小时'}。`};
}
export async function prepareTask(api,q){
 const {ad}=await planInfo(api,String(q.id),true);const allowed=api.heatEligibility?.get(String(q.id));
 const eligible=allowed&&Date.now()-allowed.time<90000?allowed.ids:new Set();
 return {ad,operation:buildTaskOperation(ad,q.value||{},eligible)};
}
