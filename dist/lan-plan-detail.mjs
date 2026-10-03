import {ensureOperator} from './operator-ui.mjs';
import {ACCOUNT_ID} from './poller.mjs';
import {openMetricPicker} from './metric-picker.mjs';
import {openTaskForm} from './lan-task-ui.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s).replace(/_/g,'').toLowerCase();
const tabs={data:'数据',product:'商品',aweme:'抖音号',material:'素材',control:'调控',detail:'详情',log:'日志'};
const types={video:'视频',image:'图片',atlas:'图文',title:'标题'};
const controls={boost:'一键起量',heat:'素材追投',search:'搜索抢首屏'};
const text=(m,k)=>m?.[norm(k)]?.valueStr??m?.[norm(k)]?.ValueStr??'-';
async function request(q){const r=await fetch('/lan-api/detail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(q)}),j=await r.json();if(!r.ok)throw new Error(j.error?.message||'请求失败');return j;}
export function openPlanDetail(plan,{from,to,tab='data',controlType='boost',notify,onAction,allowWrites=false}){
 const dialog=document.createElement('dialog');dialog.className='plan-drawer';dialog.setAttribute('aria-label','商品计划详情');
 dialog.innerHTML=`<header class="plan-drawer-header"><div><h2>${esc(plan.name)}</h2><p>${esc(plan.statusText)} · ID：${esc(plan.id)} · 每日预算 ${esc(plan.budget)} 元 · 综合营销ROI目标 ${Number(plan.roiTarget||0).toFixed(2)}</p></div><button data-close aria-label="关闭计划详情">×</button></header><nav class="detail-tabs" role="tablist">${Object.entries(tabs).map(([k,v])=>`<button role="tab" data-tab="${k}">${v}</button>`).join('')}</nav><div class="detail-toolbar"><div id="material-types"></div><label>当前周期 <input type="date" id="detail-from" value="${esc(from)}" aria-label="详情开始日期"> ~ <input type="date" id="detail-to" value="${esc(to)}" aria-label="详情结束日期"></label><button id="detail-refresh">查询</button><button id="detail-metrics">自定义指标</button></div><p class="detail-status" role="status"></p><section class="detail-body"></section><footer class="detail-pager"></footer>`;
 document.body.append(dialog);dialog.showModal();
 const $=s=>dialog.querySelector(s);let query={accountId:ACCOUNT_ID,id:plan.id,tab,materialType:'video',controlType,from,to,page:1,pageSize:10},result=null,revision=0,busy=false;
 const metricCell=(row,key)=>`<td>${esc(text(row.metrics,key))}</td>`;
 function updateHeader(){dialog.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===query.tab);b.setAttribute('aria-selected',String(b.dataset.tab===query.tab));});$('#material-types').innerHTML=query.tab==='material'?Object.entries(types).map(([k,v])=>`<button data-material="${k}" class="${query.materialType===k?'active':''}">${v}</button>`).join(''):query.tab==='control'?Object.entries(controls).map(([k,v])=>`<button data-control="${k}" class="${query.controlType===k?'active':''}">${v}</button>`).join('')+`<button id="create-task" class="primary">新建任务</button>`:'';$('#detail-metrics').hidden=!result?.config;}
 function render(){
  if(!result)return;const d=result,keys=d.metrics||[],definitions=d.config?.metrics||[];
  if(query.tab==='detail'){
   const a=d.info;$('.detail-body').innerHTML=`<dl class="plan-settings">${[['营销目标','商品营销'],['计划名称',a.name],['投放状态',a.adDeliveryName],['广告类型','通投广告'],['优化目标',a.deepExternalActionName],['日预算',Number(a.budget)/100000+' 元'],['综合营销ROI目标',a.ecpRoi2Goal],['自选素材',a.creativeSetting?.materialSelectionType??'详见素材页'],['新增抖音号自动投',a.autoAwemeMaterial?'开启':'未开启']].map(([k,v])=>`<dt>${k}</dt><dd>${esc(v??'-')}</dd>`).join('')}</dl>`;$('.detail-pager').innerHTML='';return;
  }
  if(query.tab==='log'){
   $('.detail-body').innerHTML=`<div class="detail-table"><table><thead><tr><th>操作时间</th><th>操作类型</th><th>操作内容</th><th>操作人</th><th>操作来源</th><th>操作IP</th></tr></thead><tbody>${d.rows.map(r=>`<tr><td>${esc(r.createTime)}</td><td>${esc(r.contentTitle)}</td><td class="log-content">${esc((r.contentLog||[]).join('\n'))}</td><td>${esc(r.operatorName||r.operator)}</td><td>${esc(r.operateSource)}</td><td>${esc(r.optIp)}</td></tr>`).join('')||'<tr><td colspan="6">当前日期范围暂无日志</td></tr>'}</tbody></table></div>`;
  }else{
   const showRows=query.tab==='data'?d.rows.slice((query.page-1)*query.pageSize,query.page*query.pageSize):d.rows;
   const fixedLabel=query.tab==='data'?'时间':query.tab==='product'?'商品':query.tab==='aweme'?'抖音号':query.tab==='control'?'任务名称':types[query.materialType];
   const extra=query.tab==='product'?'<th>审核状态</th><th>关联抖音号</th>':query.tab==='aweme'?'<th>关联商品</th>':query.tab==='material'?'<th>投放状态</th><th>创建时间</th>':query.tab==='control'?'<th>调控状态</th><th>调控预算（元）</th><th>调控时长（小时）</th><th>创建时间</th>':'';
   const header=keys.map(k=>`<th>${esc(definitions.find(m=>m.key===k)?.label||k)}</th>`).join('');
   let cards='';if(query.tab==='data')cards=`<div class="detail-metrics">${keys.slice(0,10).map(k=>`<article><span>${esc(definitions.find(m=>m.key===k)?.label||k)}</span><strong>${esc(text(d.totals,k))}</strong></article>`).join('')}</div>`;
   $('.detail-body').innerHTML=cards+`<div class="detail-table"><table><thead><tr><th>${fixedLabel}</th>${extra}${header}</tr></thead><tbody>${showRows.map(r=>`<tr><td><div class="detail-identity">${r.image&&/^https:\/\//.test(r.image)?`<img loading="lazy" src="${esc(r.image)}" alt="">`:''}<div>${esc(r.name)}${query.tab!=='data'?`<small>ID：${esc(r.displayId||r.id)}</small>`:''}</div></div></td>${query.tab==='product'?`<td>${esc(({0:'未审核',1:'审核通过',2:'审核不通过'})[r.statusCode]||'-')}<small>${esc(r.statusReason)}</small></td><td>${esc(r.related||'-')}</td>`:query.tab==='aweme'?`<td>${esc(r.related||'-')}</td>`:query.tab==='material'?`<td>${esc(r.statusText||'-')}</td><td>${esc(r.createdAt||'-')}</td>`:query.tab==='control'?`<td>${esc(r.statusText||'-')}</td><td>${esc(r.budget)}</td><td>${query.controlType==='search'?'-':esc(r.duration)}</td><td>${esc(r.createdAt)}</td>`:''}${keys.map(k=>metricCell(r,k)).join('')}</tr>`).join('')||`<tr><td colspan="${keys.length+4}">暂无数据</td></tr>`}</tbody></table></div>`;
  }
  const max=Math.max(1,Math.ceil(d.total/query.pageSize));$('.detail-pager').innerHTML=`<span>共 ${d.total} 条</span><button data-detail-page="${query.page-1}" ${query.page<=1?'disabled':''}>上一页</button><span>${query.page} / ${max}</span><button data-detail-page="${query.page+1}" ${query.page>=max?'disabled':''}>下一页</button>`;
 }
 async function load(reset=false){const rev=++revision;busy=true;if(reset){result=null;$('.detail-body').innerHTML='<p class="empty-cell">正在读取计划数据…</p>';}updateHeader();$('.detail-status').textContent='正在查询…';try{const d=await request({...query});if(rev!==revision||!dialog.open)return;result=d;query.metrics=d.metrics;updateHeader();render();$('.detail-status').textContent=`账户 ${ACCOUNT_ID} · ${d.from} 至 ${d.to} · 更新于 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})}`;}catch(e){if(rev===revision)$('.detail-status').textContent=(result?'更新失败，保留上次结果：':'读取失败：')+e.message;}finally{if(rev===revision)busy=false;}}
 dialog.addEventListener('click',e=>{e.stopPropagation();const b=e.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-close'))dialog.close();
  if(b.dataset.tab){query.tab=b.dataset.tab;query.page=1;delete query.metrics;void load(true);}
  if(b.dataset.material){query.materialType=b.dataset.material;query.page=1;delete query.metrics;void load(true);}
  if(b.dataset.control){query.controlType=b.dataset.control;query.page=1;delete query.metrics;void load(true);}
  if(b.id==='create-task')void ensureOperator().then(ok=>{if(ok)openTaskForm(plan,{kind:query.controlType,notify,allowWrites:true,onSuccess:()=>load()});}).catch(e=>notify(e.message));
  if(b.dataset.detailPage){query.page=Number(b.dataset.detailPage);if(query.tab==='data')render();else void load();}
 });
 $('#detail-refresh').onclick=()=>{query.from=$('#detail-from').value;query.to=$('#detail-to').value;query.page=1;void load();};
 $('#detail-metrics').onclick=()=>{if(!result?.config)return;openMetricPicker({config:result.config,selected:query.metrics,storageKey:`qianchuan:${ACCOUNT_ID}:detail:${result.kind}`,notify,onApply(keys){query.metrics=keys;query.page=1;void load();}});};
 dialog.addEventListener('close',()=>{revision++;dialog.remove();});void load(true);
}
