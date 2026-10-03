import {ACCOUNT_ID,createPoller} from './poller.mjs';
import {TOP_METRIC_CONFIG} from './top-metric-catalog.mjs';
import {TABLE_METRIC_CONFIG} from './table-metric-catalog.mjs';
import {openMetricPicker} from './metric-picker.mjs';
import {validateMetricSelection} from './metric-config.mjs';
import {openPlanDetail} from './plan-detail.mjs';
import {openPlanOperation} from './operations-ui.mjs';
import {migratePreferences} from './preferences.mjs';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize=s=>String(s).replace(/_/g,'').toLowerCase();
const original=`https://qianchuan.jinritemai.com/overall-prom?aavid=${ACCOUNT_ID}#?marGoal=1&overallPromViewTab=product&uniVideoTab=1`;
$('.original-link').href=original;
const dateParts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
const today=`${dateParts.year}-${dateParts.month}-${dateParts.day}`;
$('#date-from').value=today;$('#date-to').value=today;$('#date-from').max=today;$('#date-to').max=today;
let configs={top:TOP_METRIC_CONFIG,table:TABLE_METRIC_CONFIG},loadedConfig=false,selectedTop=[],selectedTable=[];
let model={source:'none',plans:[],metrics:[],total:0,totals:{metrics:{}}};
let query={accountId:ACCOUNT_ID,page:1,pageSize:10,product:'selected',search:'',searchOption:1,status:'all',sortField:'create_time',sortType:'desc'};
let selectedPlans=new Set(),busy=false,toastTimer;
$('#search-type').innerHTML='<option value="all">计划</option>';
$('#status').innerHTML='<option value="all">请筛选计划状态</option>'+[[13,'投放中'],[2,'新建审核中'],[15,'修改审核中'],[16,'审核不通过'],[4,'手动暂停'],[11,'计划预算不足'],[22,'账户预算已花光'],[10,'账户余额不足'],[23,'系统暂停'],[14,'不在投放时段'],[6,'未到投放时间'],[24,'在投计划配额超限'],[19,'商品暂不可用'],[1,'已删除'],[3,'已完成'],[30,'全部（包含已删除）'],[21,'已终止']].map(([v,n])=>`<option value="${v}">${n}</option>`).join('');
$('#service').innerHTML='<option value="all">选择营销服务项</option><option value="3">基础投放</option><option value="1">千川星选素材投放</option><option value="2">含达人佣金出价</option>';
const storage=side=>`qianchuan:${ACCOUNT_ID}:${side}-selection:v3`;
function selection(side){const c=configs[side];try{migratePreferences(localStorage,storage(side),side==='top'?TOP_METRIC_CONFIG:TABLE_METRIC_CONFIG,c);const saved=JSON.parse(localStorage.getItem(storage(side)));if(Array.isArray(saved))return validateMetricSelection(c,saved);}catch{}return [...c.selected];}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4000);}
function metricValue(metrics,key){const m=metrics?.[normalize(key)]||metrics?.[key];return m?{value:m.Value??m.value,text:m.ValueStr??m.valueStr??'-'}:null;}
function chart(points){const valid=points.filter(p=>Number.isFinite(p.value));if(valid.length<2)return '';const vals=valid.map(p=>p.value),lo=Math.min(...vals),hi=Math.max(...vals);const d=valid.map((p,i)=>`${i?'L':'M'}${2+i*96/(valid.length-1)} ${27-(hi===lo?12:(p.value-lo)*24/(hi-lo))}`).join(' ');return `<svg class="spark" viewBox="0 0 100 30" role="img" aria-label="真实数据趋势"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;}
function renderMetrics(){const keys=loadedConfig?selectedTop:configs.top.selected;$('#metrics').innerHTML=keys.map(key=>{const def=configs.top.metrics.find(m=>m.key===key),value=model.metrics.find(m=>m.key===key);return `<article class="metric"><h2>${esc(def?.label||key)}</h2>${value?chart(value.trend||[]):''}<strong>${esc(value?.value??'—')}</strong><span class="change ${String(value?.change).startsWith('+')?'positive':''}">${esc(value?.change??'')}</span></article>`;}).join('');}
function dataCells(plan,showBasis=true){return selectedTable.map(key=>{const v=metricValue(plan.metrics,key),base=showBasis?metricValue(plan.metrics,key+'_primary'):null;return `<td data-col="${esc(key)}">${esc(v?.text??'-')}${base?`<div class="subtle">基础 ${esc(base.text)}</div>`:''}</td>`;}).join('');}
function renderTable(){
 const head=$('thead tr');head.querySelectorAll('[data-col]').forEach(e=>e.remove());
 head.insertAdjacentHTML('beforeend',selectedTable.map(key=>{const m=configs.table.metrics.find(m=>m.key===key);return `<th data-col="${esc(key)}" aria-sort="${query.sortField===key?(query.sortType==='asc'?'ascending':'descending'):'none'}"><button data-sort="${esc(key)}">${esc((m?.label||key)+(/金额|成本|消耗|佣金/.test(m?.label||'')&&!/率/.test(m?.label||'')?'(元)':''))} ${query.sortField===key?(query.sortType==='asc'?'↑':'↓'):'↕'}</button></th>`;}).join(''));
 const rows=model.plans,hasData=model.source!=='none';
 $('#table-body').innerHTML=(hasData?`<tr class="total-row"><td></td><td colspan="7">共 ${model.total} 条计划</td>${dataCells(model.totals,false)}</tr>`:'')+(rows.length?rows.map(p=>`<tr><td><input type="checkbox" data-select="${esc(p.id)}" aria-label="选择计划 ${esc(p.name)}" ${selectedPlans.has(p.id)?'checked':''}></td><td><div class="plan-content"><button type="button" class="switch ${p.isEnabled?'enabled':''}" data-action="status" data-plan="${esc(p.id)}" role="switch" aria-checked="${p.isEnabled}" aria-label="切换计划 ${esc(p.name)} 的状态"></button><div><button class="plan-name" data-action="detail" data-plan="${esc(p.id)}">${esc(p.name)}</button><div class="plan-id">ID：${esc(p.id)}</div><div class="plan-meta"><button data-action="product" data-plan="${esc(p.id)}">商品 ›</button><button data-action="aweme" data-plan="${esc(p.id)}">抖音号 ›</button><button data-action="material" data-plan="${esc(p.id)}">素材 ›</button></div></div></div></td><td><span class="status-dot ${p.status==='active'?'green':''}"></span>${esc(p.statusText)}</td><td class="plan-description">每日预算 <button class="link" data-action="budget" data-plan="${esc(p.id)}">${esc(p.budget)}元</button><br>综合营销ROI目标 <button class="link" data-action="roi" data-plan="${esc(p.id)}">${p.roiTarget==null?'-':Number(p.roiTarget).toFixed(2)}</button></td><td>${esc(p.service)}</td><td class="stack"><button data-action="boost" data-plan="${esc(p.id)}">一键起量</button><button data-action="heat" data-plan="${esc(p.id)}">素材追投</button><button data-action="search" data-plan="${esc(p.id)}">搜索抢首屏</button></td><td class="stack"><button data-action="edit" data-plan="${esc(p.id)}">编辑</button><button data-action="log" data-plan="${esc(p.id)}">日志</button><button data-action="delete" data-plan="${esc(p.id)}">删除</button></td><td>乘方投放</td>${dataCells(p)}</tr>`).join(''):`<tr><td colspan="${8+selectedTable.length}" class="empty-cell">${hasData?'暂无匹配的计划':'连接千川浏览器后显示真实数据'}</td></tr>`);
 $('#row-count').textContent=hasData?`共 ${model.total} 条 · 当前 ${rows.length} 条`:'尚未读取真实数据';$('#selected-count').textContent=selectedPlans.size?`已选择 ${selectedPlans.size} 条`:'';
 $('#select-all').checked=rows.length>0&&rows.every(p=>selectedPlans.has(p.id));$('#select-all').indeterminate=rows.some(p=>selectedPlans.has(p.id))&&!$('#select-all').checked;
 renderPager();
}
function renderPager(){const pages=Math.max(1,Math.ceil(model.total/query.pageSize));$('#pagination').innerHTML=`<button data-page="${query.page-1}" ${query.page<=1||busy?'disabled':''}>上一页</button><span>第 ${query.page} / ${pages} 页</span><button data-page="${query.page+1}" ${query.page>=pages||busy?'disabled':''}>下一页</button><label>每页 <select id="page-size" aria-label="每页条数">${[10,20,50,100].map(n=>`<option ${query.pageSize===n?'selected':''}>${n}</option>`).join('')}</select> 条</label><label>跳至 <input id="page-jump" type="number" min="1" max="${pages}" value="${query.page}" aria-label="跳转页码"></label><button id="jump">跳转</button>`;}
function openDialog(title,html){$('#dialog-title').textContent=title;$('#dialog-content').innerHTML=html;$('#dialog').showModal();}
function metricDialog(side){if(!loadedConfig){toast('请先连接浏览器，读取真实指标配置');return;}openMetricPicker({config:configs[side],selected:side==='top'?selectedTop:selectedTable,storageKey:storage(side),notify:toast,onApply(keys){if(side==='top')selectedTop=keys;else selectedTable=keys;localStorage.setItem(storage(side),JSON.stringify(keys));renderMetrics();renderTable();poller.invalidate();}});}
async function pairingDialog(){const r=await fetch('/api/pairing'),c=await r.json();openDialog('连接千川浏览器',`<p>在 Chrome 中登录账户 <b>${ACCOUNT_ID}</b> 并保持“推商品”页面打开。</p><p>加载交付包里的 <code>bridge-extension</code> 扩展后，将以下本机地址和连接码填入扩展。</p><label>本机地址<input readonly value="${esc(c.url)}"></label><label>连接码<input readonly value="${esc(c.token)}" autocomplete="off"></label><p>登录凭据始终留在千川页面。连接后关闭本窗口并点击刷新。</p>`);}
async function planAction(action,id){const p=model.plans.find(p=>p.id===id);if(!p)return;
 if(['budget','roi','status','delete'].includes(action))return openPlanOperation(p,action,{notify:toast,allowWrites:model.allowWrites,onSuccess:()=>poller.invalidate()});
 if(action==='edit')return openDialog('编辑计划',`<p><b>${esc(p.name)}</b><br>ID：${esc(p.id)}</p><button type="button" class="primary" data-action="budget" data-plan="${esc(p.id)}">编辑预算</button> <button type="button" class="primary" data-action="roi" data-plan="${esc(p.id)}">编辑ROI目标</button>`);
 openPlanDetail(p,{from:$('#date-from').value,to:$('#date-to').value,tab:action==='detail'?'data':['boost','heat','search'].includes(action)?'control':action,controlType:['boost','heat','search'].includes(action)?action:'boost',notify:toast,onAction:planAction,allowWrites:model.allowWrites});
}
const poller=createPoller({
 query:()=>({...query,from:$('#date-from').value,to:$('#date-to').value,...(loadedConfig?{topMetrics:selectedTop,tableMetrics:selectedTable}:{})}),
 onLoading(value){busy=value;$('#refresh').disabled=value;$('#refresh').classList.toggle('loading',value);if(value)$('#source-status').textContent=model.source==='none'?'正在读取目标账户数据…':'正在更新，暂时保留上次数据';renderPager();},
 onData(data){const first=!loadedConfig;configs={top:data.topConfig,table:data.tableConfig};if(first){selectedTop=selection('top');selectedTable=selection('table');loadedConfig=true;}model=data;query.page=data.page;renderMetrics();renderTable();$('#source-status').textContent=`账户 ${ACCOUNT_ID} · ${data.source==='live'?'真实接口':'历史样本（非实时）'} · ${data.allowWrites?'已允许真实操作':'只读模式'} · 数据日期 ${data.from} 至 ${data.to}`;$('#updated').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(data.fetchedAt))+' 更新';$('#last-success').textContent=data.fetchedAt;$('#last-success').dataset.timestamp=data.fetchedAt;if(first&&(JSON.stringify(selectedTop)!==JSON.stringify(configs.top.selected)||JSON.stringify(selectedTable)!==JSON.stringify(configs.table.selected)))queueMicrotask(()=>poller.invalidate());},
 onError(error){const prefix=model.source==='none'?'尚未取得数据':'更新失败，已保留上次数据';$('#source-status').textContent=prefix+' · '+(error.code==='AUTH_REQUIRED'?'登录失效，请在原千川页重新登录':error.message);},
});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
 if(b.closest('.plan-drawer,.operation-dialog,.metric-picker'))return;
 if(b.dataset.sort){query.sortType=query.sortField===b.dataset.sort&&query.sortType==='desc'?'asc':'desc';query.sortField=b.dataset.sort;query.page=1;poller.invalidate();}
 if(b.dataset.page){query.page=Math.max(1,Number(b.dataset.page));poller.invalidate();}
 if(b.dataset.product){query.product=b.dataset.product==='托管'?'managed':'selected';query.page=1;$$('[data-product]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-selected',String(t===b));});poller.invalidate();}
 if(b.dataset.action){e.preventDefault();void planAction(b.dataset.action,b.dataset.plan);}
 if(b.id==='jump'){query.page=Math.max(1,Math.min(Math.max(1,Math.ceil(model.total/query.pageSize)),Number($('#page-jump').value)||1));poller.invalidate();}
});
document.addEventListener('change',e=>{if(e.target.dataset.select){e.target.checked?selectedPlans.add(e.target.dataset.select):selectedPlans.delete(e.target.dataset.select);renderTable();}if(e.target.id==='page-size'){query.pageSize=Number(e.target.value);query.page=1;poller.invalidate();}});
function search(){query.search=$('#search').value.trim();query.searchOption=1;query.page=1;poller.invalidate();}
$('#search').addEventListener('keydown',e=>{if(e.key==='Enter')search();});$('#search-button').onclick=search;
$('#status').onchange=()=>{query.status=$('#status').value;query.page=1;poller.invalidate();};
$('#service').onchange=()=>{query.service=$('#service').value;query.page=1;poller.invalidate();};
$('#select-all').onchange=e=>{model.plans.forEach(p=>e.target.checked?selectedPlans.add(p.id):selectedPlans.delete(p.id));renderTable();};
$('#columns').onclick=()=>metricDialog('top');$('#table-columns').onclick=()=>metricDialog('table');
$('#close-recommendations').onclick=()=>$('#recommendations').hidden=true;
$('#reset').onclick=()=>{$('#search').value='';$('#status').value='all';$('#service').value='all';query={...query,page:1,search:'',status:'all',service:'all',serviceMode:'include',costStatus:'all',sortField:'create_time',sortType:'desc'};selectedPlans.clear();poller.invalidate();};
for(const id of ['date-from','date-to'])$('#'+id).onchange=()=>{if($('#date-from').value>$('#date-to').value){toast('开始日期不能晚于结束日期');return;}query.page=1;poller.invalidate();};
$('#refresh').onclick=()=>void poller.refresh();$('#bridge-connect').onclick=()=>void pairingDialog();
$('#new-plan').onclick=()=>window.open(original,'_blank','noopener');
$('#more-filters').onclick=()=>{openDialog('更多筛选',`<label>消耗情况<select id="cost-filter"><option value="all">全部</option><option value="nonzero">有消耗</option><option value="zero">无消耗</option></select></label><label>营销服务筛选<select id="service-mode"><option value="include">包含</option><option value="exclude">不包含</option></select></label><button type="button" id="apply-extra" class="primary">应用筛选</button>`);$('#cost-filter').value=query.costStatus||'all';$('#service-mode').value=query.serviceMode||'include';$('#apply-extra').onclick=()=>{query.costStatus=$('#cost-filter').value;query.serviceMode=$('#service-mode').value;query.page=1;$('#dialog').close();poller.invalidate();};};
$('#fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poller.refresh();});
window.addEventListener('pagehide',()=>poller.stop());window.addEventListener('pageshow',()=>poller.start());
$('#updated').textContent='尚未更新';$('#balance').textContent='—';
renderMetrics();renderTable();poller.start();
