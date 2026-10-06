import {ACCOUNT_ID} from './poller.mjs';
import {loadLanData,datePreset,validateDateRange,getShanghaiDate} from './lan-data.mjs';
import {ensureOperator} from './operator-ui.mjs';
import {batchMetric,filterBatchPlans,sortBatchPlans} from './batch-model.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={pending:'等待提交',checking:'核实当前计划',submitting:'正在提交',success:'任务创建已核实',failed:'未成功，可核实后补做',uncertain:'结果未确认，禁止直接重发',skipped:'未提交',ready:'待确认'};
const storageKey=`qianchuan:${ACCOUNT_ID}:last-batch-boost`;
async function request(path,body){const r=await fetch('/lan-api/operation/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})}),j=await r.json();if(!r.ok)throw new Error(j.error?.message||'批量请求未完成，请检查状态后再操作');return j;}
const columns=[['budget','日预算'],['cost','综合成本'],['spend','基础消耗'],['roi','实际ROI'],['orders','净成交订单']];
export function openBatchBoost({from,to,selectedIds=[],notify,onSuccess=()=>{}}){
 const d=document.createElement('dialog');d.className='operation-dialog batch-dialog';d.setAttribute('aria-label','批量计划一键起量');
 const initial={from:from||getShanghaiDate(),to:to||getShanghaiDate()};
 let data=null,selected=new Set(),matched=[],page=1,loading=false,working=false,prepared=null,preparedInput=null,job=null,timer,scanTimer,revision=0,first=true,scan=null,states=new Map(),sortKey='cost',sortDirection='desc';
 d.innerHTML=`<header><div><h2>批量计划一键起量</h2><small>按区间数据筛选，核实起量状态，再逐条提交。</small></div><button data-close aria-label="关闭批量起量">×</button></header><section class="batch-selection"><div class="batch-range"><label>统计开始日期<input id="batch-from" type="date" value="${esc(initial.from)}" max="${getShanghaiDate()}"></label><label>统计结束日期<input id="batch-to" type="date" value="${esc(initial.to)}" max="${getShanghaiDate()}"></label><select id="batch-preset" aria-label="批量统计快捷日期"><option value="custom">自定义</option><option value="today">今天</option><option value="yesterday">昨天</option><option value="last7">近7天</option><option value="last30">近30天</option></select><button id="batch-query" type="button">查询并核实计划</button></div><p id="batch-range-state" role="status"></p><p id="batch-scan-state" role="status"></p><details id="batch-excluded"><summary>查看未结束和待核实的计划</summary><div id="batch-excluded-rows" class="batch-grid"></div></details><div class="batch-filters"><label>计划名称或ID<input id="batch-search" type="search" placeholder="搜索具体计划"></label><label>投放状态<select id="batch-status"><option value="all">全部状态</option></select></label>${[['cost','综合成本（元）'],['spend','基础消耗（元）'],['roi','综合营销ROI'],['orders','净成交订单数'],['budget','当前日预算（元）']].map(([key,label])=>`<fieldset><legend>${label}</legend><input data-bound="${key}Min" type="number" min="0" step="any" placeholder="最低" aria-label="${label}下限"><span>至</span><input data-bound="${key}Max" type="number" min="0" step="any" placeholder="最高" aria-label="${label}上限"></fieldset>`).join('')}</div><div class="batch-selection-bar"><span id="batch-count"></span><button id="batch-pick">勾选本页</button><button id="batch-pick-all">全选当前可选结果</button><button id="batch-prune">移除筛选外已选</button><button id="batch-clear">清空勾选</button></div><div class="batch-grid"><table><thead><tr><th>选择</th><th>计划</th><th>状态</th><th>起量状态</th>${columns.map(([key,label])=>`<th><button data-sort="${key}" aria-label="按${label}排序">${label} ↕</button></th>`).join('')}</tr></thead><tbody id="batch-rows"></tbody></table></div><div id="batch-pages" class="batch-pages"></div><p><small>仅显示已核实无未结束起量任务的计划。统计日期影响成本、消耗、ROI和订单数；起量资格按当前平台任务状态判断。缺失值显示“—”并排在末尾。全选包含所有分页中当前已核实的计划；后台新增可选项不会自动勾选。</small></p><section class="batch-task-inputs"><label>每条计划的额外起量预算（元）<input id="batch-budget" inputmode="decimal" placeholder="至少100元，不能超过任何所选计划日预算"></label><label>起量时长（小时）<input id="batch-duration" type="number" min="0.5" max="24" step="0.5" value="4"></label><label>任务名称前缀<input id="batch-name" maxlength="20" value="批量起量_${getShanghaiDate().replaceAll('-','')}"></label></section><p id="batch-total"></p></section><section id="batch-review" hidden></section><p class="operation-error" role="alert"></p><footer><button id="batch-history" type="button">查看最近批次</button><button id="batch-back" hidden>返回选择</button><button id="batch-cancel-job" hidden>停止后续提交</button><button data-close>关闭</button><button id="batch-primary" class="primary">核对所选计划</button></footer>`;
 document.body.append(d);d.showModal();const $=s=>d.querySelector(s),error=e=>$('.operation-error').textContent=e;
 const currentFilters=()=>({search:$('#batch-search').value,status:$('#batch-status').value,...Object.fromEntries([...d.querySelectorAll('[data-bound]')].map(n=>[n.dataset.bound,n.value]))});
 const scanReady=()=>Boolean(scan&&!scan.error&&scan.phase!=='list'&&['running','completed','paused'].includes(scan.state));
 function render(){
  const eligible=(data?.plans||[]).filter(p=>states.get(p.id)?.state==='eligible');let invalid=false;
  try{matched=sortBatchPlans(filterBatchPlans(eligible,currentFilters()),sortKey,sortDirection);}catch(e){matched=[];invalid=true;error(e.message);}
  const pages=Math.max(1,Math.ceil(matched.length/20));page=Math.min(page,pages);const visible=matched.slice((page-1)*20,page*20),inside=new Set(matched.map(p=>p.id)),hidden=[...selected].filter(id=>!inside.has(id)).length;
  $('#batch-count').textContent=`匹配 ${matched.length} 条 · 已选 ${selected.size} 条`+(hidden?`（${hidden}条不在当前筛选中）`:'');
  const scanned=[...states.values()];$('#batch-scan-state').textContent=scan?`起量状态核实：${scan.done}/${scan.total} · 可选 ${eligible.length} · 未结束已剔除 ${scanned.filter(s=>s.state==='active').length} · 待核实 ${scanned.filter(s=>s.state==='unknown').length} · 列表快筛 ${scan.fastCount||0} · 详情核实 ${scan.detailCount||0}${scan.state==='running'?(scan.phase==='list'?'。正在按页读取调控状态…':'。已确定的计划可先选择，其余后台核实…'):scan.error?'。'+scan.error:''}${scan.cacheHit?' · 已复用'+scan.cacheAgeSeconds+'秒前的列表状态，提交前会再次核实':''}${scan.listWarning?'。'+scan.listWarning:''}`:'';
  const blocked=(data?.plans||[]).filter(p=>states.has(p.id)&&states.get(p.id).state!=='eligible');$('#batch-excluded').hidden=!blocked.length;$('#batch-excluded-rows').innerHTML=blocked.map(p=>{const status=states.get(p.id);return `<p><b>${esc(p.name)}</b> <small>${p.id}</small>：${esc(status.reason||(status.state==='active'?'平台仍有未结束的起量任务':'平台状态或时间不一致，请核实后再选择'))}</p>`;}).join('');
  $('#batch-rows').innerHTML=visible.map(p=>`<tr class="${selected.has(p.id)?'picked':''}"><td><input type="checkbox" data-pick="${esc(p.id)}" ${selected.has(p.id)?'checked':''} ${loading||working||!scanReady()?'disabled':''} aria-label="批量选择计划 ${esc(p.name)}"></td><td>${esc(p.name)}<small>ID：${esc(p.id)}</small></td><td>${esc(p.statusText)}</td><td>${states.get(p.id)?.source==='list-optional'?'列表初筛通过':states.get(p.id)?.taskCount?'起量已结束':'无未结束任务'}</td>${columns.map(([k])=>{const v=k==='budget'?Number(p.budget):batchMetric(p,k);return `<td>${v===null?'—':v.toLocaleString('zh-CN',{maximumFractionDigits:2})}</td>`;}).join('')}</tr>`).join('')||`<tr><td colspan="9">${loading?'正在核实计划，请稍候…':'没有符合筛选条件且可起量的计划'}</td></tr>`;
  $('#batch-pages').innerHTML=`<button data-batch-page="${page-1}" ${page<=1?'disabled':''}>上一页</button><span>${page} / ${pages}</span><button data-batch-page="${page+1}" ${page>=pages?'disabled':''}>下一页</button>`;
  for(const [key,label] of columns){const b=$(`[data-sort="${key}"]`);b.textContent=label+(sortKey===key?(sortDirection==='asc'?' ↑':' ↓'):' ↕');b.parentElement.setAttribute('aria-sort',sortKey===key?(sortDirection==='asc'?'ascending':'descending'):'none');}
  for(const id of ['#batch-pick','#batch-pick-all'])$(id).disabled=loading||working||!scanReady()||!matched.length;
  for(const id of ['#batch-from','#batch-to','#batch-preset'])$(id).disabled=loading||scan?.state==='running';
  $('#batch-primary').disabled=loading||working||invalid||!selected.size||!data?.complete||!scanReady();
  const budget=Number($('#batch-budget').value);$('#batch-total').textContent=`已选 ${selected.size} 条`+(budget>0?` · 额外预算合计 ${(budget*selected.size).toFixed(2)} 元`:'');
 }
 async function pollScan(id,rev){
  try{const value=await request('batch-scan-status?id='+encodeURIComponent(id));if(rev!==revision||!d.open||job)return;scan=value;states=new Map(value.rows.map(r=>[r.id,r]));for(const id of selected)if(states.get(id)?.state!=='eligible')selected.delete(id);if(scanReady()){loading=false;if(first){for(const id of selectedIds)if(states.get(id)?.state==='eligible')selected.add(id);first=false;}}
   if(scan.state==='running')scanTimer=setTimeout(()=>void pollScan(id,rev),2000);
   else{loading=false;$('#batch-query').disabled=false;if(scan.error)error(scan.error);}
   if(!prepared&&!job)render();
  }catch(e){if(rev!==revision||!d.open)return;loading=false;scan={...scan,state:'stopped',error:e.message};$('#batch-query').disabled=false;error(e.message+'；请重新查询起量状态。');if(!prepared&&!job)render();}
 }
 async function load(){
  if(working||loading||scan?.state==='running')return;let range;try{range=validateDateRange($('#batch-from').value,$('#batch-to').value);}catch(e){error(e.message);return;}
  const rev=++revision;clearTimeout(scanTimer);loading=true;scan=null;states.clear();selected.clear();$('#batch-query').disabled=true;$('#batch-range-state').textContent='正在查询统计区间…';error('');render();
  try{if(!await ensureOperator())throw new Error('请先操作登录后核实起量状态');
   const next=await loadLanData({accountId:ACCOUNT_ID,...range,page:1,pageSize:100000,product:'selected',status:'all',sortField:'create_time',sortType:'desc',force:true});if(rev!==revision||!d.open)return;
   if(next.accountId!==ACCOUNT_ID||!next.complete||next.from!==range.from||next.to!==range.to||next.rangeQuery?.stale)throw new Error('该区间未取得完整的最新结果');data=next;page=1;
   $('#batch-status').innerHTML='<option value="all">全部状态</option>'+[...new Set(data.plans.map(p=>p.statusText))].map(s=>`<option>${esc(s)}</option>`).join('');$('#batch-range-state').textContent=`统计区间：${data.from} 至 ${data.to} · ${data.plans.length} 条计划。查询其他区间会清空勾选。`;
   if(!data.plans.length){loading=false;scan={state:'completed',done:0,total:0};$('#batch-query').disabled=false;render();return;}
   scan=await request('batch-scan',{accountId:ACCOUNT_ID,ids:data.plans.map(p=>p.id)});render();void pollScan(scan.id,rev);
  }catch(e){if(rev!==revision)return;loading=false;data=null;$('#batch-query').disabled=false;$('#batch-range-state').textContent='查询失败：'+e.message;error(e.message);render();}
 }
 function showPreview(p,q){
  prepared=p;preparedInput=q;$('.batch-selection').hidden=true;$('#batch-review').hidden=false;$('#batch-back').hidden=false;$('#batch-primary').hidden=false;$('#batch-primary').disabled=false;$('#batch-cancel-job').hidden=true;
  $('#batch-review').innerHTML=`<h3>${q.retryOf?'单独补做':'确认批量创建'}：${p.items.length} 条计划</h3><p class="confirmation-summary">每条额外预算 ${esc(q.budget)} 元，时长 ${esc(q.duration)} 小时；合计 ${p.totalBudget.toFixed(2)} 元。</p><p>确认后逐条核实并创建。成功项不会重发；单条异常暂挂，其余计划继续。登录、连接或限流异常会暂停整批。异常项核实后可单独补做。确认有效期5分钟，队列执行中每条都会重新核对。</p><div class="batch-grid"><ul>${p.items.map(i=>`<li><b>${esc(i.name)}</b><small> ID：${i.id}</small><p>${esc(i.description)}</p></li>`).join('')}</ul></div>`;
  $('#batch-primary').textContent=q.retryOf?'确认单独补做':'确认批量创建';
 }
 function showJob(value){
  clearTimeout(timer);clearTimeout(scanTimer);job=value;prepared=null;$('.batch-selection').hidden=true;$('#batch-review').hidden=false;$('#batch-primary').hidden=true;$('#batch-back').hidden=job.status==='running';$('#batch-cancel-job').hidden=job.status!=='running';$('#batch-cancel-job').disabled=job.cancelRequested;
  $('#batch-review').innerHTML=`<h3>${job.status==='running'?'批量起量正在执行':'批次处理结果'}</h3><p>所选额外预算合计 ${job.totalBudget.toFixed(2)} 元 · 创建已核实 ${job.items.filter(i=>i.status==='success').length} / ${job.items.length} 条</p><p>${esc(job.message||'逐条核实并提交，关闭窗口不会取消，可停止尚未提交的计划。')}</p><div class="batch-grid"><table><thead><tr><th>计划</th><th>额外预算</th><th>结果</th><th>异常处理</th></tr></thead><tbody>${job.items.map(i=>`<tr><td>${esc(i.name)}<small>${i.id}</small></td><td>${i.budget.toFixed(2)}元</td><td>${labels[i.status]||esc(i.status)}${i.error?'<small>'+esc(i.error)+'</small>':''}${i.verification?'<small>'+esc(i.verification.message)+'</small>':''}</td><td>${job.status==='running'||i.status==='success'?'':i.retryJobId?`<button data-open-job="${esc(i.retryJobId)}">查看补做批次</button>`:`<button data-recheck="${i.id}">核实此条结果</button>${i.verification?.canRetry?`${i.status==='uncertain'?`<label><input type="checkbox" data-manual="${i.id}">已在千川原页核实未创建</label>`:''}<button data-retry="${i.id}">单独补做</button>`:''}`}</td></tr>`).join('')}</tbody></table></div>`;
  if(job.status==='running')timer=setTimeout(()=>void pollJob(),2000);else onSuccess();
 }
 async function pollJob(){if(!d.open)return;try{showJob(await request('batch-status?id='+encodeURIComponent(job.id)));}catch(e){error(e.message+'；不要重复创建，请查看最近批次。');}}
 $('#batch-query').onclick=()=>void load();$('#batch-preset').onchange=()=>{if(loading||scan?.state==='running')return;const r=datePreset($('#batch-preset').value);if(r){$('#batch-from').value=r.from;$('#batch-to').value=r.to;void load();}};
 for(const id of ['#batch-from','#batch-to'])$(id).onchange=()=>{if(loading||scan?.state==='running'){$(id).value=id==='#batch-from'?data?.from||initial.from:data?.to||initial.to;return;}$('#batch-preset').value='custom';data=null;states.clear();selected.clear();$('#batch-range-state').textContent='日期已修改，请点击查询。';render();};
 $('#batch-pick').onclick=()=>{matched.slice((page-1)*20,page*20).forEach(p=>selected.add(p.id));render();};$('#batch-pick-all').onclick=()=>{matched.forEach(p=>selected.add(p.id));render();};$('#batch-clear').onclick=()=>{selected.clear();render();};$('#batch-prune').onclick=()=>{const inside=new Set(matched.map(p=>p.id));selected=new Set([...selected].filter(id=>inside.has(id)));render();};
 for(const node of d.querySelectorAll('.batch-filters input,.batch-filters select'))node.addEventListener('input',()=>{page=1;error('');render();});$('#batch-budget').oninput=render;
 d.addEventListener('change',e=>{if(e.target.dataset.pick){const id=e.target.dataset.pick;e.target.checked?selected.add(id):selected.delete(id);render();}});
 d.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-close')&&!working)d.close();
  if(b.dataset.batchPage){page=Number(b.dataset.batchPage);render();}
  if(b.dataset.sort){sortDirection=sortKey===b.dataset.sort&&sortDirection==='desc'?'asc':'desc';sortKey=b.dataset.sort;page=1;render();}
  if(working||job?.status==='running')return;
  if(b.dataset.recheck||b.dataset.retry||b.dataset.openJob){working=true;b.disabled=true;error('');try{
   if(!await ensureOperator())return;
   if(b.dataset.openJob){try{localStorage.setItem(storageKey,b.dataset.openJob);}catch{}showJob(await request('batch-status?id='+encodeURIComponent(b.dataset.openJob)));}
   else if(b.dataset.recheck)showJob(await request('batch-recheck',{id:job.id,planId:b.dataset.recheck}));
   else{const item=job.items.find(i=>i.id===b.dataset.retry),verifiedNotCreated=item.status!=='uncertain'||Boolean($(`[data-manual="${item.id}"]`)?.checked);if(!verifiedNotCreated)throw new Error('请先在千川原页核实未创建，再勾选确认');const q={accountId:ACCOUNT_ID,ids:[item.id],retryOf:job.id,verifiedNotCreated,budget:item.budget,duration:item.duration,namePrefix:'核实后补做'};showPreview(await request('batch-prepare',q),q);}
  }catch(e){error(e.message);}finally{working=false;b.disabled=false;}}
 });
 $('#batch-back').onclick=()=>{prepared=null;job=null;clearTimeout(timer);delete $('#batch-primary').dataset.failed;$('#batch-review').hidden=true;$('.batch-selection').hidden=false;$('#batch-back').hidden=true;$('#batch-primary').hidden=false;$('#batch-primary').textContent='核对所选计划';if(scan?.state==='running'){render();void pollScan(scan.id,revision);}else void load();};
 $('#batch-primary').onclick=async()=>{
  if(working||loading)return;working=true;$('#batch-primary').disabled=true;error('');$('.batch-selection').inert=true;
  try{if(!await ensureOperator())return;
   if(!prepared){if(!data||!selected.size)throw new Error('请先查询并勾选计划');const q={accountId:ACCOUNT_ID,scanId:scan.id,ids:[...selected],budget:$('#batch-budget').value,duration:$('#batch-duration').value,namePrefix:$('#batch-name').value};showPreview(await request('batch-prepare',q),q);}
   else{if(prepared.expiresAt<=Date.now())throw new Error('确认已过期，请返回重新核对');try{localStorage.setItem(storageKey,prepared.token);}catch{}showJob(await request('batch-commit',{accountId:ACCOUNT_ID,token:prepared.token,confirmed:true}));}
  }catch(e){error(e.message);if(prepared){$('#batch-primary').dataset.failed='true';$('#batch-primary').textContent='请查看最近批次或返回重核';}}
  finally{working=false;$('.batch-selection').inert=false;$('#batch-primary').disabled=Boolean($('#batch-primary').dataset.failed);}
 };
 $('#batch-cancel-job').onclick=async()=>{try{showJob(await request('batch-cancel',{id:job.id}));}catch(e){error(e.message);}};
 $('#batch-history').textContent='查看历史批次';
 $('#batch-history').onclick=async()=>{if(working)return;try{if(!await ensureOperator())return;const history=await request('batch-history');if(history.error)error(history.error);clearTimeout(timer);job=null;prepared=null;$('.batch-selection').hidden=true;$('#batch-primary').hidden=true;$('#batch-cancel-job').hidden=true;$('#batch-back').hidden=false;$('#batch-review').hidden=false;$('#batch-review').innerHTML='<h3>最近50个批次 · 当前操作登录</h3><div class="batch-grid">'+(history.batches.map(b=>`<p><button data-open-job="${esc(b.id)}">查看 ${esc(new Date(b.createdAt).toLocaleString('zh-CN'))}</button> ${b.success}/${b.total} 已核实 · ${b.unresolved} 条待处理 ${b.status==='running'?' · 正在执行':''}</p>`).join('')||'<p>没有历史批次</p>')+'</div>';}catch(e){error(e.message);}};
 d.addEventListener('cancel',e=>{if(working)e.preventDefault();});d.addEventListener('close',()=>{revision++;clearTimeout(timer);clearTimeout(scanTimer);d.remove();});void load();
}
