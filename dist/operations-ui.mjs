import {ACCOUNT_ID} from './poller.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),j=await r.json();if(!r.ok)throw new Error(j.error?.message||'操作失败');return j;}
export function openPlanOperation(plan,action,{notify,onSuccess,allowWrites=false}){
 const d=document.createElement('dialog');d.className='operation-dialog';d.setAttribute('aria-label','确认计划操作');
 const labels={budget:'编辑每日预算',roi:'编辑综合营销ROI',status:plan.isEnabled?'暂停投放':'启动投放',delete:'删除计划'};
 d.innerHTML=`<header><h2>${labels[action]}</h2><button data-close aria-label="取消操作">×</button></header><p><b>${esc(plan.name)}</b><br>ID：${esc(plan.id)}<br>账户：${ACCOUNT_ID}</p><div class="operation-form"></div><p class="operation-error" role="alert"></p><footer><button data-close>取消</button><button class="primary" id="prepare-operation">核对变更</button></footer>`;
 if(!allowWrites)d.querySelector('header').insertAdjacentHTML('afterend','<p class="readonly-notice">只读预览：核对表单不会提交真实操作。</p>');
 document.body.append(d);d.showModal();const $=s=>d.querySelector(s);let prepared=null,submitting=false;
 const current=action==='budget'?plan.budget:plan.roiTarget;
 $('.operation-form').innerHTML=['budget','roi'].includes(action)?`<label>${action==='budget'?'每日预算（元）':'综合营销ROI目标'}<input id="operation-value" inputmode="decimal" value="${esc(current)}"></label><small>${action==='budget'?'300～999999999.99元，最多两位小数；修改幅度至少100元。':'大于等于0.01且小于10000，最多两位小数。营销服务口径保持不变。'}</small>`:`<p>${action==='delete'?'删除会影响该计划后续投放，请核对计划名称和ID。':labels[action]+'会改变该计划的投放状态。'}</p>`;
 d.addEventListener('click',e=>{if(e.target.closest('[data-close]')&&!submitting)d.close();});
 $('#prepare-operation').onclick=async()=>{
  if(submitting)return;submitting=true;$('#prepare-operation').disabled=true;$('.operation-error').textContent='';
  try{if(!prepared){prepared=await post('/api/operation/prepare',{accountId:ACCOUNT_ID,id:plan.id,action,value:action==='status'?(plan.isEnabled?'pause':'start'):$('#operation-value')?.value});$('.operation-form').innerHTML=`<p class="confirmation-summary">${esc(prepared.description)}</p>${action==='delete'&&prepared.canSubmit?`<label>输入计划ID确认删除<input id="typed-plan-id" autocomplete="off"></label>`:''}<p>${prepared.canSubmit?'确认后会提交到此千川账户。':'当前为只读模式，仅展示变更预览，未向千川提交。'}</p>`;$('#prepare-operation').textContent=prepared.canSubmit?'确认提交':'只读预览，未提交';}
   else {const r=await post('/api/operation/commit',{token:prepared.token,accountId:ACCOUNT_ID,planId:plan.id,confirmed:true,typedPlanId:$('#typed-plan-id')?.value});if(r.success){notify(r.observationWarning||'平台已确认操作成功'+(r.observationId?'，已开始24小时ROI对比':''));d.close();onSuccess();}}
  }catch(error){$('.operation-error').textContent=error.message;if(prepared){$('#prepare-operation').textContent='请关闭后重新查看计划';$('#prepare-operation').dataset.failed='true';}else $('#prepare-operation').textContent='重新核对';}
  finally{submitting=false;$('#prepare-operation').disabled=prepared?.canSubmit===false||$('#prepare-operation').dataset.failed==='true';}
 };
 d.addEventListener('cancel',e=>{if(submitting)e.preventDefault();});d.addEventListener('close',()=>d.remove());
}
