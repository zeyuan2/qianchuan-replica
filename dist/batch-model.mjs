export const BATCH_METRICS={cost:'statcostforoverallroi2',spend:'statcostforroi2primary',roi:'totalprepayandpaysettleoverallroi21h',orders:'totalordersettlecountforroi21h'};
export function batchMetric(plan,key){const v=plan.metrics?.[BATCH_METRICS[key]],raw=v?.value??v?.Value,text=v?.valueStr??v?.ValueStr;if(raw==null||raw===''||text==='-'||text==='—')return null;const number=Number(raw);return Number.isFinite(number)?number:null;}
export function filterBatchPlans(plans,filters={}){
 const ranges={};for(const key of ['cost','spend','roi','orders','budget']){const min=filters[key+'Min'],max=filters[key+'Max'];ranges[key]={min:min===''||min==null?null:Number(min),max:max===''||max==null?null:Number(max)};const r=ranges[key];if([r.min,r.max].some(v=>v!==null&&(!Number.isFinite(v)||v<0))||(r.min!==null&&r.max!==null&&r.min>r.max))throw new Error('指标范围无效：下限不能超过上限，数值不能为负');}
 const keyword=(filters.search||'').trim().toLowerCase();
 return plans.filter(p=>{if(keyword&&!p.id.includes(keyword)&&!p.name.toLowerCase().includes(keyword))return false;if(filters.status&&filters.status!=='all'&&p.statusText!==filters.status)return false;for(const[key,r]of Object.entries(ranges)){const v=key==='budget'?Number(p.budget):batchMetric(p,key);if(r.min===null&&r.max===null)continue;if(v===null||!Number.isFinite(v)||(r.min!==null&&v<r.min)||(r.max!==null&&v>r.max))return false;}return true;});
}
export function sortBatchPlans(plans,key='',direction='desc'){
 if(!['cost','spend','roi','orders','budget'].includes(key))return [...plans];
 const value=p=>key==='budget'?(Number.isFinite(Number(p.budget))?Number(p.budget):null):batchMetric(p,key);
 return plans.map((p,index)=>({p,index,v:value(p)})).sort((a,b)=>a.v===null?(b.v===null?a.index-b.index:1):b.v===null?-1:(a.v-b.v)*(direction==='asc'?1:-1)||a.index-b.index).map(x=>x.p);
}
