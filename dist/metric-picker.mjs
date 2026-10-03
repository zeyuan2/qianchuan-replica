import {createSelection} from './selection-state.mjs';
import {validateMetricSelection} from './metric-config.mjs';
const escape = value=>String(value).replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
export function openMetricPicker({config, selected, storageKey, onApply, notify}){
 const draft=createSelection(config,selected), fixed=new Set(config.frozen);
 const byKey=new Map(config.metrics.map(m=>[m.key,m]));
 const groups=[...new Set(config.metrics.map(m=>m.group[1]))];
 const roots=[...new Set(config.metrics.map(m=>m.group[0]))];
 const dialog=document.createElement('dialog');dialog.className='metric-picker';dialog.setAttribute('aria-labelledby','picker-title');
 let templates=[];try{const v=JSON.parse(localStorage.getItem(storageKey+':templates'));if(Array.isArray(v))templates=v.filter(t=>typeof t.name==='string'&&Array.isArray(t.keys));}catch{}
 dialog.innerHTML=`<header class="picker-heading"><h2 id="picker-title">自定义列</h2><button data-cancel aria-label="关闭自定义列">×</button></header><div class="picker-body"><aside class="picker-sidebar"><div class="picker-search"><input aria-label="搜索指标" placeholder="请搜索"><span>⌕</span></div><nav aria-label="指标分组"></nav>${templates.length?`<label class="template-loader">本机模板<select aria-label="选择本机模板"><option value="">选择模板</option>${templates.map((t,i)=>`<option value="${i}">${escape(t.name)}</option>`).join('')}</select></label>`:''}</aside><div class="picker-catalog"></div><aside class="picker-selected"><header><b class="picker-count"></b><button data-reset>重置</button></header><p class="reorder-help">拖动调整顺序</p><div class="selected-list" aria-label="已添加指标"></div></aside></div><p class="picker-message" role="status" aria-live="polite"></p><footer class="picker-footer"><label><input type="checkbox" data-save-template> 保存为模板</label><input class="template-name" aria-label="模板名称" placeholder="输入模板名称（本机保存）" maxlength="40" hidden><button data-cancel>取消</button><button class="primary" data-apply>确定</button></footer><p class="sr-only" id="reorder-instructions">按空格开始排序，用上下方向键移动，再按空格完成；Escape取消排序。</p>`;
 document.body.append(dialog);
 const q=s=>dialog.querySelector(s);let search='',dragKey=null,keyboard=null,activeGroup=groups[0];
 function message(text=''){q('.picker-message').textContent=text;}
 function groupKeys(name,root=false){return config.metrics.filter(m=>m.group[root?0:1]===name&&(!search||m.label.toLowerCase().includes(search))).map(m=>m.key);}
 function update(){
  q('.picker-count').textContent=`已添加（${draft.keys.length}${config.maxMetricCount?'/'+config.maxMetricCount:''}）`;
  q('nav').innerHTML=roots.map(root=>`<b>${escape(root)}<span>${draft.status(config.metrics.filter(m=>m.group[0]===root).map(m=>m.key)).count}</span></b>${groups.filter(g=>config.metrics.some(m=>m.group[0]===root&&m.group[1]===g)).map(g=>`<button class="${activeGroup===g?'current-group':''}" data-group="${escape(g)}">${escape(g)}<span>${draft.status(config.metrics.filter(m=>m.group[1]===g).map(m=>m.key)).count}</span></button>`).join('')}`).join('');
  q('.picker-catalog').innerHTML=roots.map(root=>{
   const sections=groups.filter(g=>config.metrics.some(m=>m.group[0]===root&&m.group[1]===g)).map(g=>{
    const metrics=config.metrics.filter(m=>m.group[1]===g&&(!search||m.label.toLowerCase().includes(search)));if(!metrics.length)return '';
    return `<section data-section="${escape(g)}"><label class="group-check"><input type="checkbox" data-all="${escape(g)}">${escape(g)}</label><div class="picker-options">${metrics.map(m=>`<label title="${escape(m.label)}"><input type="checkbox" data-choice="${escape(m.key)}" ${draft.keys.includes(m.key)?'checked':''} ${fixed.has(m.key)?'disabled':''}> <span>${escape(m.label)}</span>${fixed.has(m.key)?'<small title="固定指标">⌑</small>':''}</label>`).join('')}</div></section>`;
   }).join('');return sections?`<h3>${escape(root)}</h3>${sections}`:'';
  }).join('')||'<div class="no-metrics">没有匹配的指标</div>';
  dialog.querySelectorAll('[data-all]').forEach(el=>{const keys=groupKeys(el.dataset.all),status=draft.status(keys);el.checked=status.checked;el.indeterminate=status.indeterminate;el.disabled=keys.every(k=>fixed.has(k));});
  q('.selected-list').innerHTML=draft.keys.map(key=>`<div class="selected-metric ${keyboard?.key===key?'sorting':''}" data-key="${escape(key)}" role="button" tabindex="0" draggable="true" aria-label="排序 ${escape(byKey.get(key).label)}" aria-roledescription="sortable" aria-describedby="reorder-instructions"><span class="drag-handle">⠿</span><span class="selected-label" title="${escape(byKey.get(key).label)}">${escape(byKey.get(key).label)}</span>${fixed.has(key)?'<span class="fixed-mark" title="固定指标">⌑</span>':`<button data-remove="${escape(key)}" aria-label="删除 ${escape(byKey.get(key).label)}">×</button>`}</div>`).join('');
 }
 function toggle(keys,checked){if(!draft.toggle(keys,checked))message(`最多添加 ${config.maxMetricCount} 个指标，请先移除已有指标。`);else message();update();}
 dialog.addEventListener('change',e=>{
  if(e.target.dataset.choice)toggle([e.target.dataset.choice],e.target.checked);
  if(e.target.dataset.all)toggle(groupKeys(e.target.dataset.all),e.target.checked);
  if(e.target.matches('[data-save-template]'))q('.template-name').hidden=!e.target.checked;
  if(e.target.matches('.template-loader select')&&e.target.value!==''){draft.replace(templates[Number(e.target.value)].keys);update();}
 });
 q('.picker-search input').addEventListener('input',e=>{search=e.target.value.trim().toLowerCase();update();});
 dialog.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-cancel'))dialog.close();
  if(b.hasAttribute('data-reset')){draft.reset();keyboard=null;message();update();}
  if(b.dataset.remove)toggle([b.dataset.remove],false);
  if(b.dataset.group){activeGroup=b.dataset.group;update();[...dialog.querySelectorAll('[data-section]')].find(el=>el.dataset.section===activeGroup)?.scrollIntoView({block:'start'});}
  if(b.hasAttribute('data-apply')){
   try{validateMetricSelection(config,draft.keys);}catch(error){message(error.message);return;}
   if(q('[data-save-template]').checked){const name=q('.template-name').value.trim();if(!name){message('请输入模板名称');q('.template-name').focus();return;}const template={name,keys:draft.keys};templates=templates.filter(t=>t.name!==name);templates.push(template);try{localStorage.setItem(storageKey+':templates',JSON.stringify(templates));}catch{message('浏览器无法保存模板，请检查本机存储');return;}}
   onApply(draft.keys);if(q('[data-save-template]').checked)notify('模板已保存在本机');dialog.close();
  }
 });
 const focusKey=key=>[...dialog.querySelectorAll('[data-key]')].find(el=>el.dataset.key===key)?.focus();
 dialog.addEventListener('keydown',e=>{
  const row=e.target.closest('[data-key]');if(!row||e.target.closest('button'))return;const key=row.dataset.key;
  if(e.key===' '){e.preventDefault();keyboard=keyboard?null:{key,original:draft.keys};message(keyboard?'用上下方向键调整顺序，空格完成':'排序完成');update();focusKey(key);}
  if(keyboard&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();draft.move(key,draft.keys.indexOf(key)+(e.key==='ArrowUp'?-1:1));update();focusKey(key);}
 });
 dialog.addEventListener('cancel',e=>{if(keyboard){e.preventDefault();const key=keyboard.key;draft.replace(keyboard.original);keyboard=null;update();focusKey(key);message('已取消本次排序');}});
 dialog.addEventListener('dragstart',e=>{const row=e.target.closest('[data-key]');if(row){dragKey=row.dataset.key;e.dataTransfer.setData('text/plain',dragKey);e.dataTransfer.effectAllowed='move';}});
 dialog.addEventListener('dragover',e=>{if(e.target.closest('[data-key]')){e.preventDefault();e.dataTransfer.dropEffect='move';}});
 dialog.addEventListener('drop',e=>{const row=e.target.closest('[data-key]');if(row&&dragKey){e.preventDefault();draft.move(dragKey,draft.keys.indexOf(row.dataset.key));update();focusKey(dragKey);dragKey=null;}});
 dialog.addEventListener('dragend',()=>dragKey=null);
 dialog.addEventListener('close',()=>dialog.remove());update();dialog.showModal();q('.picker-search input').focus();
}
