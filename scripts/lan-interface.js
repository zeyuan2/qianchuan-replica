function initializeLanInterface(){
 const icons={search:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>',columns:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>',refresh:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg>',expand:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/></svg>'};
 let saved={};try{saved=JSON.parse(localStorage.getItem('qianchuan:1000000000000000:lan-ui:v1'))||{};}catch{}
 document.body.dataset.tableView=saved.view==='full'?'full':'data';
 document.body.dataset.density=saved.density==='comfortable'?'comfortable':'compact';
 document.body.classList.toggle('overview-collapsed',saved.collapsed===true);
 $('#search-button').innerHTML=icons.search;$('#search').placeholder='搜索计划名称或 ID';
 const clear=document.createElement('button');clear.id='clear-search';clear.type='button';clear.setAttribute('aria-label','清空搜索');clear.textContent='×';clear.hidden=true;clear.onclick=()=>{$('#search').value='';search();};document.querySelector('.search').insertBefore(clear,$('#search-button'));
 $('#search').addEventListener('input',()=>clear.hidden=!$('#search').value);
 $('#columns').innerHTML=icons.columns+'<span>指标设置</span>';$('#fullscreen').innerHTML=icons.expand;
 $('#table-columns').innerHTML=icons.columns+'<span>指标列</span>';document.querySelector('.table-actions').append($('#table-columns'));
 $('#reset').textContent='重置';$('#reset').title='重置搜索和筛选';
 $('#refresh').innerHTML=icons.refresh+'<span>刷新显示</span><span id="updated" class="sr-only">尚未更新</span>';$('#refresh').setAttribute('aria-label','刷新显示');
 document.querySelectorAll('.view-mode button[data-table-view]').forEach(button=>button.onclick=()=>{document.body.dataset.tableView=button.dataset.tableView;applyTableView();saveInterfacePreferences();});
 $('#density-toggle').onclick=()=>{document.body.dataset.density=document.body.dataset.density==='compact'?'comfortable':'compact';applyTableView();saveInterfacePreferences();};
 $('#overview-toggle').onclick=()=>{document.body.classList.toggle('overview-collapsed');applyTableView();saveInterfacePreferences();};
 $('#sync-toggle').onclick=()=>{const expanded=$('#sync-toggle').getAttribute('aria-expanded')==='true';$('#sync-toggle').setAttribute('aria-expanded',String(!expanded));$('#sync-details').hidden=expanded;};
 applyTableView();
}
function saveInterfacePreferences(){try{localStorage.setItem('qianchuan:1000000000000000:lan-ui:v1',JSON.stringify({view:document.body.dataset.tableView,density:document.body.dataset.density,collapsed:document.body.classList.contains('overview-collapsed')}));}catch{}}
function applyTableView(){
 const compact=document.body.dataset.tableView!=='full';
 document.querySelectorAll('.table-scroll thead tr').forEach(row=>[4,5,6,7].forEach(i=>row.children[i]?.classList.add('context-col')));
 document.querySelectorAll('#table-body tr:not(.total-row)').forEach(row=>{[4,5,6,7].forEach(i=>row.children[i]?.classList.add('context-col'));row.classList.toggle('row-selected',Boolean(row.querySelector('[data-select]')?.checked));});
 const summary=document.querySelector('.total-row td:nth-child(2)');if(summary)summary.colSpan=compact?3:7;
 document.querySelectorAll('.view-mode button[data-table-view]').forEach(button=>{const active=button.dataset.tableView===(compact?'data':'full');button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
 const density=$('#density-toggle');if(density){density.textContent=document.body.dataset.density==='comfortable'?'紧凑行高':'舒适行高';density.setAttribute('aria-label',density.textContent);}
 const collapsed=document.body.classList.contains('overview-collapsed'),toggle=$('#overview-toggle');if(toggle){toggle.textContent=collapsed?'展开概览':'收起概览';toggle.setAttribute('aria-expanded',String(!collapsed));}
 const clear=$('#clear-search');if(clear)clear.hidden=!$('#search').value;
 $('#new-plan')?.setAttribute('aria-pressed',String(Boolean(query.onlyNew)));
 document.querySelectorAll('.plan-name').forEach(button=>button.title=button.textContent.trim());
 document.querySelectorAll('.table-scroll th[data-col] button').forEach(button=>button.title=button.textContent.trim());
 document.querySelectorAll('.metric').forEach(card=>{const heading=card.querySelector('h2');if(heading)heading.title=heading.textContent;});
}
function updateInterfaceStatus(data){
 const state=data.monitor||{},pill=$('#connection-pill'),strip=$('#sync-strip'),waiting=!state.bridgeConnected,error=Boolean(state.error)||waiting;
 strip.dataset.state=error?'warning':state.running?'loading':'ready';
 pill.textContent=waiting?'采集连接待恢复':state.running?'正在采集':state.error?'本轮更新失败':'采集连接正常';
 $('#sync-toggle').textContent=error?'查看原因':'采集说明';$('#sync-summary').textContent=error?'保留上次成功数据':'每 5 分钟自动采集';
 $('#next-label').textContent=waiting?'下次检查':'下次采集';
 $('#monitor-warning').classList.toggle('warning',!data.complete);$('#list-match-count').textContent=`当前匹配 ${data.total} 条`;
 $('#source-status').textContent=data.complete?'完整采集 · 操作需登录':'数据待补齐 · 操作需登录';strip.title=state.error?.message||'所有内网访客共享一份采集结果';applyTableView();
}
function showInterfaceError(error){
 const strip=$('#sync-strip');if(!strip)return;strip.dataset.state='warning';$('#connection-pill').textContent='页面同步失败';$('#sync-summary').textContent='已保留上次显示的数据';$('#monitor-message').textContent=error.message;$('#sync-toggle').textContent='查看原因';
 const range=$('#range-message');if(range){range.textContent='查询未更新：'+error.message+(model.from?'；仍显示 '+model.from+' 至 '+model.to:'');range.classList.add('error');}
}

function initializeDateRange(){
 for(const id of ['date-from','date-to']){$('#'+id).hidden=false;$('#'+id).max=getShanghaiDate();$('#'+id).oninput=$('#'+id).onchange=()=>{rangeDraftDirty=true;$('#range-preset').value='custom';$('#range-message').textContent='日期已修改，请点击查询。'+(model.from?'当前仍显示 '+model.from+' 至 '+model.to:'');$('#range-message').classList.remove('error');};}
 $('#date-from').value=appliedRange.from;$('#date-to').value=appliedRange.to;
 $('#range-preset').onchange=()=>{const chosen=datePreset($('#range-preset').value);if(chosen){$('#date-from').value=chosen.from;$('#date-to').value=chosen.to;submitDateRange();}};
 $('#apply-range').onclick=submitDateRange;
}
function getAppliedRange(){
 const current=getShanghaiDate();$('#date-from').max=current;$('#date-to').max=current;
 if(rangeMode!=='custom')appliedRange=datePreset(rangeMode,current);
 if(!rangeDraftDirty){$('#date-from').value=appliedRange.from;$('#date-to').value=appliedRange.to;}
 return appliedRange;
}
function submitDateRange(){
 try{const next=validateDateRange($('#date-from').value,$('#date-to').value);appliedRange=next;rangeMode=$('#range-preset').value;rangeDraftDirty=false;query.page=1;query.onlyNew=false;$('#range-message').classList.remove('error');poller.invalidate();}
 catch(error){$('#range-message').textContent=error.message;$('#range-message').classList.add('error');}
}
function showRangeLoading(value){
 const button=$('#apply-range');if(!button)return;button.disabled=value;button.textContent=value?'查询中…':'查询';
 if(value&&(model.from!==appliedRange.from||model.to!==appliedRange.to)){$('#range-message').textContent='正在查询 '+appliedRange.from+' 至 '+appliedRange.to+'…'+(model.from?' 暂时保留上次结果。':'');$('#range-message').classList.remove('error');}
}
function showAppliedRange(data){
 if(rangeDraftDirty)return;const range=$('#range-message');range.classList.toggle('error',Boolean(data.rangeQuery?.error));range.textContent='当前显示：'+data.from+' 至 '+data.to+(data.rangeQuery?.stale?' · 更新失败，保留该区间上次结果':' · 指标按此区间统计');
 if(data.rangeQuery){$('#sync-summary').textContent=data.rangeQuery.stale?'保留区间上次成功数据':'区间数据每5分钟刷新';$('#next-label').textContent='区间刷新';$('#monitor-message').textContent=data.rangeQuery.error?.message||'当前为所选日期区间的真实查询结果；今日新增计划监测仍在后台运行。';}
}
