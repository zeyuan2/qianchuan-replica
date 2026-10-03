import { ACCOUNT_ID, IntegrationPendingError, createPoller } from './poller.mjs';
import { TOP_METRIC_CONFIG } from './top-metric-catalog.mjs';
import { TABLE_METRIC_CONFIG } from './table-metric-catalog.mjs';
import { openMetricPicker } from './metric-picker.mjs';
import { createSelection } from './selection-state.mjs';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escape = value => String(value).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const money = n => n == null ? '-' : Number(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
const original = 'https://qianchuan.jinritemai.com/overall-prom?aavid=1000000000000000&campaignType=1&dateRange=2026-10-01%2C2026-10-01&uniTab=ad#?marGoal=1&uniVideoTab=1&overallPromViewTab=product&smartBidType=7&dataUpdateTime=2026-10-01+15%3A48&page=1&pageSize=10&sortType=desc&searchOption=1&costItemsOption=1&adStatusFilterType=0&costStatus=-1&customFilterType=-1&bpPage=1&bpPageSize=10&bpSortType=desc&adDetailTab=data&adDetailEffectDiagnosesCompetitive=liveRace&adDetailBreadcrumb=%7B%7D&adDetailCustomCreativeStatusFilterType=0&adDetailCustomCreativePage=1&adDetailCustomCreativePageSize=10&adDetailCustomCreativeSortType=asc&adDrawerDetailTab=data&adDrawerCustomCreativeStatusFilterType=0&adDrawerCustomCreativePage=1&adDrawerCustomCreativePageSize=10&adDrawerCustomCreativeSortType=asc&adDrawerMaterialPage=1&adDrawerMaterialPageSize=10&adDrawerMaterialSearchData=%7B%22option%22%3A1%7D&adDrawerMaterialSortField=stat_cost&adDrawerMaterialSortType=desc&adDrawerMaterialHavingCost=1&sortField=create_time';
$('.original-link').href = original;
const screenshotMetrics = [{label:'综合营销ROI',value:'—',change:''}];
const screenshotPlans = []; // Handoff: historical account rows removed.
let model = {source:'screenshot',metrics:screenshotMetrics,plans:screenshotPlans};
const preferenceKey = `qianchuan:${ACCOUNT_ID}:top-selection:v2`;
const tablePreferenceKey = `qianchuan:${ACCOUNT_ID}:table-selection:v2`;
function readSelection(key,config){try{const saved=JSON.parse(localStorage.getItem(key));if(Array.isArray(saved)&&saved.every(k=>typeof k==='string'))return createSelection(config,saved).keys;}catch{}return [...config.selected];}
let selectedMetrics=readSelection(preferenceKey,TOP_METRIC_CONFIG);
let selectedTableMetrics=readSelection(tablePreferenceKey,TABLE_METRIC_CONFIG);
let sort = {key:null,direction:1}, product='自选', minBudget=0, selected=new Set(), hiddenColumns=new Set();
const defaultTableCatalog=[
 {key:'roi',label:'综合营销ROI',format:'number'},
 {key:'cost',label:'综合成本(元)',format:'money'},
 {key:'consume',label:'整体消耗(元)',format:'money'},
 {key:'amount',label:'净成交金额(元)',format:'money'},
 {key:'netOrders',label:'净成交订单数',format:'number'},
 {key:'netPaidAmount',label:'用户实际支付净成交金额(元)',format:'money'},
 {key:'refundRate1h',label:'1小时内退款率',format:'percent'},
 {key:'settlementRate',label:'净成交金额结算率',format:'percent'},
 {key:'totalOrders',label:'整体成交订单数',format:'number'},
 {key:'totalAmount',label:'整体成交金额(元)',format:'money'},
 {key:'paidAmount',label:'用户实际支付金额(元)',format:'money'},
 {key:'settledAmount7d',label:'7日结算金额(元)',format:'money'},
 {key:'orderCost',label:'综合订单成本(元)',format:'money'},
 {key:'commission',label:'预估达人佣金(元)',format:'money'},
 {key:'totalOrderCost',label:'整体成交订单成本(元)',format:'money'},
];
const columnPreferenceKey=`qianchuan:${ACCOUNT_ID}:table-columns`;
function tableCatalog(){
 return selectedTableMetrics.map(key=>{
  const metric=TABLE_METRIC_CONFIG.metrics.find(m=>m.key===key);
  const known=(model.tableMetricCatalog??defaultTableCatalog).find(m=>m.label.replace(/\(元\)$/,'')===metric.label);
  return known??{key:metric.key,label:metric.label,format:metric.label.includes('率')?'percent':metric.label.includes('订单数')?'number':metric.label.includes('ROI')?'number':'money'};
 });
}
function formatTableValue(value,format){if(value==null)return '-';if(format==='money')return money(value);if(format==='percent')return typeof value==='string'?escape(value):Number(value).toFixed(2)+'%';return escape(value);}
function tableCells(plan){return tableCatalog().map(m=>{const value=plan[m.key];const basis=plan.basis?.[m.key];return `<td data-col="${escape(m.key)}" ${value===undefined?'title="此指标尚未采集到该计划的真实数值"':''}>${formatTableValue(value,m.format)}${basis===undefined?'':`<div class="subtle">基础 ${formatTableValue(basis,m.format)}</div>`} </td>`;}).join('');}
function renderTableHeaders(){const row=$('thead tr');row.querySelectorAll('[data-col]').forEach(el=>el.remove());row.insertAdjacentHTML('beforeend',tableCatalog().map(m=>`<th data-col="${escape(m.key)}"><button data-sort="${escape(m.key)}">${escape(m.label)} ↕</button></th>`).join(''));}

const pendingText = `账户 ${ACCOUNT_ID} 的真实接口尚未接入。交接包已移除历史截图和数值，等待连接新的采集环境。`;
const chart = i => `<svg class="spark" viewBox="0 0 100 30" aria-label="截图趋势示意"><path d="${i===4?'M2 3 7 20 42 20 47 10 52 20 86 20 91 9 97 20':i===0?'M2 20 10 20 16 16 23 18 28 14 40 19 52 20 61 18 66 22 71 7 77 5 87 14 94 19 99 17':'M2 20 13 19 18 17 25 19 31 17 44 16 57 17 63 21 69 8 77 5 86 8 91 18 100 17'}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
function renderMetrics(){
 const visible=selectedMetrics.map(key=>{const metric=TOP_METRIC_CONFIG.metrics.find(m=>m.key===key);return {...metric,...(model.metrics.find(m=>m.label===metric.label)??{})};});
 $('#metrics').innerHTML=visible.map((m,i)=>`<article class="metric"><h2>${escape(m.label)}</h2>${m.value!=null?chart(i):''}<strong>${escape(m.value??'-')}</strong><span class="change ${String(m.change).startsWith('+')?'positive':''}">${escape(m.change??'')}</span></article>`).join('');
}
function metricDialog(){
 openMetricPicker({config:TOP_METRIC_CONFIG,selected:selectedMetrics,storageKey:preferenceKey,notify:toast,onApply(keys){selectedMetrics=keys;try{localStorage.setItem(preferenceKey,JSON.stringify(keys));}catch{}renderMetrics();}});
}
function filteredPlans(){
  const keyword=$('#search').value.trim().toLowerCase(), type=$('#search-type').value;
  if(product!=='自选'||$('#date-from').value!=='2026-10-01'||$('#date-to').value!=='2026-10-01') {
    if(model.source==='screenshot') return [];
  }
  return model.plans.filter(p => (!keyword || (type==='id'?p.id:type==='name'?p.name:p.name+' '+p.id).toLowerCase().includes(keyword))
    && ($('#status').value==='all'||p.status===$('#status').value)
    && ($('#service').value==='all'||p.service===$('#service').value) && p.budget>=minBudget)
    .sort((a,b)=>sort.key?((a[sort.key]??-Infinity)-(b[sort.key]??-Infinity))*sort.direction:0);
}
function renderTable(){
 renderTableHeaders();
 const rows=filteredPlans();
 const total=model.source==='screenshot'?`原截图共132条计划 · 可辨认 ${screenshotPlans.length} 条`: `共 ${model.plans.length} 条计划`;
 $('#table-body').innerHTML=`<tr class="total-row"><td></td><td colspan="7">${total}</td>${tableCells(model.source==='screenshot'?{roi:2.14,cost:35542.62,consume:35542.62,amount:76026.66}:model.totals??{})}</tr>`+ (rows.length?rows.map(p=>`<tr><td><input type="checkbox" data-select="${escape(p.id)}" aria-label="选择计划 ${escape(p.name)}" ${selected.has(p.id)?'checked':''}></td><td><div class="plan-content" style="--thumb-y:-${p.thumbY??840}px"><button class="switch ${p.status==='active'?'enabled':''}" data-action="切换投放状态" data-plan="${p.id}" role="switch" aria-checked="${p.status==='active'}" aria-label="切换计划投放状态"></button><div><button class="plan-name" data-action="计划详情" data-plan="${p.id}">${escape(p.name)}</button><div class="plan-id">ID：${p.id}</div><div class="plan-meta"><span class="thumbnail"></span><button data-action="商品详情" data-plan="${p.id}">商品 ›</button><span class="thumbnail thumb2"></span><button data-action="抖音号" data-plan="${p.id}">抖音号 ›</button><span class="thumbnail thumb3"></span><button data-action="素材" data-plan="${p.id}">素材 ›</button></div></div></div></td><td><span class="status-dot ${p.status==='active'?'green':''}"></span>${p.status==='active'?'投放中':'已暂停'}<span class="guard">♙ 保</span><div class="subtle">${p.status==='paused'?'手动暂停 ':''}<button class="link" data-action="审核建议" data-plan="${p.id}">审核建议</button></div></td><td class="plan-description">每日预算　<b>${p.budget}元</b><br>综合营销ROI目标 ${p.roiTarget.toFixed(2)} <span class="help-badge">❕</span></td><td>${escape(p.service)}</td><td class="stack"><button data-action="一键起量" data-plan="${p.id}">一键起量</button><button data-action="素材追投" data-plan="${p.id}">素材追投</button><button data-action="搜索抢首屏" data-plan="${p.id}">搜索抢首屏</button></td><td class="stack"><button data-action="编辑" data-plan="${p.id}">编辑</button><button data-action="日志" data-plan="${p.id}">日志</button><button data-action="删除" data-plan="${p.id}">删除</button></td><td>乘方投放</td>${tableCells(p)}</tr>`).join(''):`<tr><td colspan="${8+tableCatalog().length}" class="empty-cell">${model.source==='screenshot'?'截图中没有该筛选条件的数据；待接入真实接口后查询':'暂无匹配计划'}</td></tr>`);
 $('#row-count').textContent=`当前显示 ${rows.length} 条`;
 $('#selected-count').textContent=selected.size?`已选择 ${selected.size} 条`:'';
 $('#select-all').checked=rows.length>0&&rows.every(p=>selected.has(p.id));
 $('#select-all').indeterminate=rows.some(p=>selected.has(p.id))&&!$('#select-all').checked;
 for(const el of $$('[data-col]')) el.classList.toggle('column-hidden',hiddenColumns.has(el.dataset.col));
}
function openDialog(title,html){ $('#dialog-title').textContent=title; $('#dialog-content').innerHTML=html; $('#dialog').showModal(); }
let toastTimer;function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3800);}
function columnDialog(){
 openMetricPicker({config:TABLE_METRIC_CONFIG,selected:selectedTableMetrics,storageKey:tablePreferenceKey,notify:toast,onApply(keys){selectedTableMetrics=keys;hiddenColumns.clear();try{localStorage.setItem(tablePreferenceKey,JSON.stringify(keys));localStorage.removeItem(columnPreferenceKey);}catch{}renderTable();}});
}
document.addEventListener('click',event=>{
 const b=event.target.closest('button'); if(!b)return;
 if(b.classList.contains('info')||b.closest('.topbar nav')) openDialog(b.dataset.title??b.textContent,`<p>${pendingText}</p><p>该功能的原有交互和真实接口需从登录后的原页面核实。</p>`);
 if(b.dataset.action){const p=model.plans.find(p=>p.id===b.dataset.plan);openDialog(b.dataset.action,`<p><strong>${escape(p.name)}</strong><br>ID：${p.id}</p><p>每日预算：${p.budget}元<br>综合营销ROI目标：${p.roiTarget.toFixed(2)}</p><p>${pendingText}</p><p>${b.dataset.action==='计划详情'?'完整详情将在接口接入后展示。':'此操作暂未连接原接口，请前往原页面办理。'}</p>`);}
 if(b.dataset.sort){ sort={key:b.dataset.sort,direction:sort.key===b.dataset.sort?-sort.direction:-1};renderTable(); }
 if(b.dataset.product){product=b.dataset.product;$$('[data-product]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-selected',String(t===b));});renderTable();}
 if(b.dataset.view==='直播') openDialog('直播投放',`<p>本次复刻范围为商品投放页面。请在原千川账户查看直播投放数据。</p>`);
});
document.addEventListener('change',event=>{
 const el=event.target;
 if(el.dataset.select){el.checked?selected.add(el.dataset.select):selected.delete(el.dataset.select);renderTable();}
 if(el.dataset.columnToggle){el.checked?hiddenColumns.delete(el.dataset.columnToggle):hiddenColumns.add(el.dataset.columnToggle);try{localStorage.setItem(columnPreferenceKey,JSON.stringify([...hiddenColumns]));}catch{}renderTable();}
});
for(const id of ['status','service','search-type']) $('#'+id).addEventListener('change',renderTable);
$('#search').addEventListener('input',renderTable);$('#search-button').addEventListener('click',renderTable);
$('#select-all').addEventListener('change',e=>{for(const p of filteredPlans())e.target.checked?selected.add(p.id):selected.delete(p.id);renderTable();});
$('#columns').onclick=metricDialog;$('#columns').setAttribute('aria-label','自定义顶部指标');$('#columns').title='自定义顶部指标';$('#table-columns').onclick=columnDialog;
$('#close-recommendations').onclick=()=>$('#recommendations').hidden=true;
$('#new-plan').onclick=()=>openDialog('商品乘方',`<p>账户：${ACCOUNT_ID}</p><p>创建计划的原接口和表单仍待核实。请在原千川账户创建，复刻页接入真实接口后同步。</p>`);
$('#more-filters').onclick=()=>{openDialog('更多筛选',`<label>每日预算下限(元)<input id="min-budget" type="number" min="0" value="${minBudget}"></label><button class="primary" id="apply-filter" type="button">应用筛选</button>`);$('#apply-filter').onclick=()=>{minBudget=Math.max(0,Number($('#min-budget').value)||0);renderTable();$('#dialog').close();};};
$('#reset').onclick=()=>{$('#search').value='';$('#status').value='all';$('#service').value='all';$('#search-type').value='all';minBudget=0;sort={key:null,direction:1};selected.clear();renderTable();};
$('#fullscreen').onclick=async()=>{try{if(document.fullscreenElement) await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('当前浏览器不支持全屏');}};
const poller=createPoller({
 query:()=>({from:$('#date-from').value,to:$('#date-to').value}),
 onData(data,time){model=data;renderMetrics();renderTable();$('#source-status').textContent=`账户 ${ACCOUNT_ID} · 实时数据`;
  $('#updated').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(time)+'更新';},
 onError(error){$('#source-status').textContent=error instanceof IntegrationPendingError?`截图参考数据 · 账户 ${ACCOUNT_ID} 的真实接口待接入`:'更新失败，保留上次数据 · '+error.message;}
});
for(const id of ['date-from','date-to']) $('#'+id).addEventListener('change',()=>{
 if($('#date-from').value>$('#date-to').value){toast('开始日期不能晚于结束日期');return;}
 renderTable();poller.invalidate();
});
$('#refresh').onclick=()=>{void poller.refresh();if(model.source==='screenshot')toast('真实接口待接入，当前截图数据未更新');};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poller.refresh();});
window.addEventListener('pagehide',()=>poller.stop());
window.addEventListener('pageshow',()=>poller.start());
renderMetrics();renderTable();poller.start();
