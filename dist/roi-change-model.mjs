export const HOUR=3600000;
export function change(before,after){
 if(!Number.isFinite(before)||!Number.isFinite(after))return {before,after,delta:null,percent:null,text:'暂无数据'};
 const delta=after-before,percent=before===0?null:delta/Math.abs(before)*100;
 const fmt=n=>Number(Math.abs(n).toFixed(2)).toLocaleString('zh-CN');
 return {before,after,delta,percent,text:percent===null?`差额 ${delta>=0?'+':'−'}${fmt(delta)}；环比无法计算（前值为0）`:Math.abs(percent)<.005?'持平 0%':`${percent>0?'上升':'下降'} ${fmt(percent)}%`};
}
export function comparison(record,{from=0,to='all'}={},now=Date.now()){
 const changed=Date.parse(record.changedAt),deadline=Date.parse(record.stoppedAt||record.expiresAt),a=Number(from),b=to==='all'?24:Number(to);
 if(!Number.isFinite(changed)||!Number.isFinite(deadline)||!Number.isInteger(a)||!Number.isInteger(b)||a<0||b>24||a>=b)throw new Error('请选择修改后0至24小时内的有效区间');
 const afterStart=Math.ceil((changed+a*HOUR)/HOUR)*HOUR,afterEnd=Math.floor(Math.min(changed+b*HOUR,now,deadline)/HOUR)*HOUR;
 const count=Math.max(0,Math.floor((afterEnd-afterStart)/HOUR)),beforeEnd=Math.floor(changed/HOUR)*HOUR,beforeStart=beforeEnd-count*HOUR;
 const map=new Map((record.rows||[]).map(r=>[r.time,r]));
 const pairs=Array.from({length:count},(_,i)=>{const beforeTime=beforeStart+i*HOUR,afterTime=afterStart+i*HOUR,before=map.get(beforeTime),after=map.get(afterTime);return {index:i+1,beforeTime,afterTime,before:before?.full?before:null,after:after?.full?after:null,roi:change(before?.full?before.roi:null,after?.full?after.roi:null),spend:change(before?.full?before.spend:null,after?.full?after.spend:null)};});
 function total(side){
  const rows=pairs.map(p=>p[side]);if(!rows.length||rows.some(r=>!r))return {roi:null,spend:null};
  const sum=key=>rows.every(r=>Number.isFinite(r[key]))?rows.reduce((n,r)=>n+r[key],0):null;
  const cost=sum('roiCost'),revenue=sum('revenue'),consistent=rows.every(r=>r.roi==null?r.revenue===0:r.roiCost>0&&Math.abs(r.roi-r.revenue/r.roiCost)<=.011);
  return {roi:consistent&&cost>0&&revenue!==null?revenue/cost:null,spend:sum('spend')};
 }
 const before=total('before'),after=total('after');
 return {pairs,count,beforeStart,beforeEnd,afterStart,afterEnd,roi:change(before.roi,after.roi),spend:change(before.spend,after.spend),observedHours:Math.max(0,(Math.min(now,deadline)-changed)/HOUR)};
}
