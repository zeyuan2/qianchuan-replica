export function createSelection(config, initial = config.selected) {
 const valid = new Set(config.metrics.map(m=>m.key));
 const fixed = new Set(config.frozen);
 const limit = config.maxMetricCount ?? Infinity;
 let keys=[];
 function replace(next){
  const normalized=[...new Set(next.filter(k=>valid.has(k)))];
  for(const k of fixed)if(!normalized.includes(k))normalized.push(k);
  if(normalized.length>limit)return false;
  keys=normalized;return true;
 }
 if(!replace(initial))replace(config.selected);
 return {
  get keys(){return [...keys];},
  replace,
  toggle(group, checked){
   const allowed=group.filter(k=>valid.has(k));
   return replace(checked?[...keys,...allowed]:keys.filter(k=>!allowed.includes(k)||fixed.has(k)));
  },
  status(group){const count=group.filter(k=>keys.includes(k)).length;return {checked:group.length>0&&count===group.length,indeterminate:count>0&&count<group.length,count};},
  move(key,to){const from=keys.indexOf(key);if(from<0)return;const next=[...keys];next.splice(from,1);next.splice(Math.max(0,Math.min(next.length,to)),0,key);replace(next);},
  reset(){replace(config.selected);}
 };
}
