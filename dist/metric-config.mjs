// Schema observed in the official Qianchuan getUserConfAndDataSet consumer.
// Actual available metrics depend on the account, module, filters and whitelist.
export function parseMetricConfiguration(response,{honorLockDefault=true}={}) {
 const module=response?.data?.ModuleInfo;
 if(!module?.DataSetInfo?.Identifier)throw new Error('指标配置响应不完整');
 const metrics=[],groups=[];
 function visit(group,path=[]) {
  const hierarchy=[...path,group.GroupNameZh??group.GroupKey??''];
  for(const metric of group.MetricOrDimension??[]) {
   if(!metric.Name)continue;
   metrics.push({key:String(metric.Name),label:metric.NameZh??metric.Name,group:hierarchy,
    frozen:Boolean(metric.FrozenDefault),locked:honorLockDefault&&Boolean(metric.LockDefault),defaultSelected:Boolean(metric.AsDefault),
    description:metric.ExplainDesc??metric.explainDesc??metric.Tags?.find(t=>String(t.Type)==='3')?.Value});
  }
  for(const child of group.Groups??[])visit(child,hierarchy);
 }
 for(const group of module.DataSetInfo.DataSetGroupInfos??[]){groups.push(group.GroupNameZh??group.GroupKey);visit(group);}
 const known=new Set(metrics.map(m=>m.key));
 const selected=Array.isArray(module.SelectInfos)&&module.SelectInfos.length?
  module.SelectInfos.map(s=>String(s.SelectMetricsOrDimension)).filter(key=>known.has(key)):
  metrics.filter(m=>m.frozen||m.locked||m.defaultSelected).map(m=>m.key);
 const frozen=new Set([...metrics.filter(m=>m.frozen||m.locked).map(m=>m.key),...(module.SelectInfos??[]).filter(s=>s.IsFrozen).map(s=>String(s.SelectMetricsOrDimension))]);
 return {dataSetKey:module.DataSetInfo.Identifier,metrics,groups,
  selected:[...new Set(honorLockDefault?[...frozen,...selected]:[...selected,...frozen])],frozen:[...frozen],
  minMetricCount:module.MinMetricNumber==null?undefined:Number(module.MinMetricNumber),
  maxMetricCount:module.MaxMetricNumber==null?undefined:Number(module.MaxMetricNumber)};
}
export function validateMetricSelection(config,selected) {
 const unique=[...new Set(selected)];
 const known=new Set(config.metrics.map(m=>m.key));
 if(unique.some(key=>!known.has(key)))throw new Error('包含未授权或不属于此模块的指标');
 if(config.frozen.some(key=>!unique.includes(key)))throw new Error('固定指标不能取消');
 if(Number.isFinite(config.minMetricCount)&&unique.length<config.minMetricCount)throw new Error(`至少选择${config.minMetricCount}个指标`);
 if(Number.isFinite(config.maxMetricCount)&&unique.length>config.maxMetricCount)throw new Error(`最多选择${config.maxMetricCount}个指标`);
 return unique;
}
