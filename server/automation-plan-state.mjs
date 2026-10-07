// Codes verified from this platform's list/basic responses. Unknown codes stay
// unknown; labels are display-only and never grant permission or audit approval.
export const DELIVERY_CODES=Object.freeze({DELIVERING:0,PAUSED:5,GROUP_BUDGET_EXHAUSTED:7,GROUP_BUDGET_WARNING:8,SYSTEM_PAUSED:52});
export function classifyAutomationPlan(list,basic){
 const permissions={budget:list?.operation?.budgetEditOperation?.editable===true&&basic?.operation?.budgetEditOperation?.editable===true,roi:list?.operation?.roi2GoalOperation?.editable===true&&basic?.operation?.roi2GoalOperation?.editable===true};
 const result={active:false,auditPassed:false,deliveryCode:list?.adDeliveryType,basicDeliveryCode:basic?.adDeliveryType,operationCode:list?.adOptType,permissions,auditEvidence:'delivery-code',reason:null};
 if(!Number.isInteger(list?.adDeliveryType)||!Number.isInteger(list?.adOptType)||!Number.isInteger(basic?.adDeliveryType)||basic?.adOptType!==list.adOptType)return {...result,reason:'PLATFORM_STATE_UNVERIFIED'};
 if(list.adOptType!==0)return {...result,reason:'PLAN_PAUSED'};
 const approved=[DELIVERY_CODES.DELIVERING,DELIVERY_CODES.GROUP_BUDGET_WARNING,DELIVERY_CODES.GROUP_BUDGET_EXHAUSTED];
 if(!approved.includes(list.adDeliveryType)||!approved.includes(basic.adDeliveryType))return {...result,reason:'AUDIT_OR_DELIVERY_STATE_UNVERIFIED'};
 return {...result,active:true,auditPassed:true,deliveryBlocked:[list.adDeliveryType,basic.adDeliveryType].includes(DELIVERY_CODES.GROUP_BUDGET_EXHAUSTED),warning:list.adDeliveryType===DELIVERY_CODES.GROUP_BUDGET_WARNING?'GROUP_BUDGET_WARNING':list.adDeliveryType===DELIVERY_CODES.GROUP_BUDGET_EXHAUSTED?'GROUP_BUDGET_EXHAUSTED':null};
}
export function actionPermitted(plan,action){
 if(!plan.permissions)return true; // Pure-policy callers can provide independently verified state.
 if(action.kind==='boost')return plan.active&&plan.auditPassed&&!plan.deliveryBlocked; // prepareTask performs task-specific checks.
 return (action.roi===undefined||action.roi===plan.roi||plan.permissions.roi===true)&&(action.budget===undefined||action.budget===plan.budget||plan.permissions.budget===true);
}
