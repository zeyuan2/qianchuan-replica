import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPlanCreatedAt,planCreatedSeconds} from '../dist/plan-time.mjs';
import {selectSnapshot} from '../dist/lan-data.mjs';
test('plan creation times use Shanghai time and reject missing/invalid epoch values',()=>{
 assert.equal(formatPlanCreatedAt({raw:{createTime:Date.parse('2026-10-07T07:21:07Z')/1000}}),'2026-10-07 15:21:07');
 assert.equal(formatPlanCreatedAt({raw:{createTime:String(Date.parse('2026-10-06T16:00:00Z')/1000)}}),'2026-10-07 00:00:00');
 for(const createTime of [null,undefined,'',0,-1,'bad',Infinity,true,Date.now()]){assert.ok(Number.isNaN(planCreatedSeconds({raw:{createTime}})));assert.equal(formatPlanCreatedAt({raw:{createTime}}),'—');}
});
test('creation sort covers all filtered pages, stabilizes ties and keeps missing times last in both directions',()=>{
 const plans=Array.from({length:25},(_,i)=>({id:String(i).padStart(2,'0'),name:i%2?'other':'selected',metrics:{},raw:{createTime:1700000000+i}}));plans.push({id:'empty',name:'selected',metrics:{},raw:{createTime:null}},{id:'tied',name:'selected',metrics:{},raw:{createTime:1700000000}});
 const snap={plans,total:plans.length},query={sortField:'create_time',pageSize:10};
 const asc=selectSnapshot(snap,{...query,sortType:'asc',page:1});assert.deepEqual(asc.plans.slice(0,3).map(p=>p.id),['00','tied','01']);
 const desc=selectSnapshot(snap,{...query,sortType:'desc',page:2});assert.equal(desc.plans[0].id,'14');
 for(const sortType of ['asc','desc']){const page=selectSnapshot(snap,{...query,sortType,search:'selected',page:2});assert.equal(page.total,15);assert.equal(page.plans.at(-1).id,'empty');}
});
