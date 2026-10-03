import {validateMetricSelection} from './metric-config.mjs';

// Old UI-only keys are migrated by their original label, never sent to an API.
export function migrateMetricKeys(keys, oldConfig, liveConfig) {
 const live=new Map(liveConfig.metrics.map(m=>[m.key,m]));
 const labels=new Map(liveConfig.metrics.map(m=>[m.label,m.key]));
 const old=new Map(oldConfig.metrics.map(m=>[m.key,m.label]));
 const mapped=keys.map(k=>live.has(k)?k:labels.get(old.get(k))).filter(Boolean);
 return validateMetricSelection(liveConfig,[...liveConfig.frozen,...mapped]);
}

export function migratePreferences(storage,key,oldConfig,liveConfig) {
 const oldKey=key.replace(/:v3$/,':v2');
 try {
  if(!storage.getItem(key)) {
   const saved=JSON.parse(storage.getItem(oldKey));
   if(Array.isArray(saved))storage.setItem(key,JSON.stringify(migrateMetricKeys(saved,oldConfig,liveConfig)));
  }
  if(!storage.getItem(key+':templates')) {
   const templates=JSON.parse(storage.getItem(oldKey+':templates'));
   if(Array.isArray(templates)) {
    const migrated=templates.flatMap(t=>{try{return typeof t.name==='string'&&Array.isArray(t.keys)?[{name:t.name,keys:migrateMetricKeys(t.keys,oldConfig,liveConfig)}]:[];}catch{return [];}});
    storage.setItem(key+':templates',JSON.stringify(migrated));
   }
  }
 }catch{/* Preferences are optional; the verified server defaults remain available. */}
}
