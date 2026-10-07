const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function planCreatedSeconds(plan){
 const raw=plan?.raw?.createTime;
 if((typeof raw!=='number'&&typeof raw!=='string')||String(raw).trim()==='')return NaN;
 const value=Number(raw);
 return Number.isFinite(value)&&value>0&&value<100000000000?value:NaN;
}
export function formatPlanCreatedAt(plan){
 const seconds=planCreatedSeconds(plan);if(!Number.isFinite(seconds))return '—';
 const p=Object.fromEntries(formatter.formatToParts(new Date(seconds*1000)).map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
