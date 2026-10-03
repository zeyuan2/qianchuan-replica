// Handoff-only fixtures. No captured responses or real account records are read.
import fs from 'node:fs/promises';
import {TOP_METRIC_CONFIG as top} from '../dist/top-metric-catalog.mjs';
import {TABLE_METRIC_CONFIG as table} from '../dist/table-metric-catalog.mjs';
import {ACCOUNT_ID} from '../server/api.mjs';
const directory=new URL('../fixtures/',import.meta.url);
await fs.mkdir(directory,{recursive:true});
const write=(name,data)=>fs.writeFile(new URL(name+'.response.json',directory),JSON.stringify({status_code:0,message:'SYNTHETIC TEST DATA',data},null,2)+'\n');
function config(c,id,isTop){return {ModuleInfo:{ModuleId:id,...(isTop?{MinMetricNumber:3,MaxMetricNumber:14}:{}),DataSetInfo:{Identifier:isTop?'synthetic_overview':'synthetic_table',DataSetGroupInfos:[{GroupNameZh:'人工测试指标',MetricOrDimension:c.metrics.map(m=>({Name:m.key,NameZh:m.label,FrozenDefault:!isTop&&c.frozen.includes(m.key),AsDefault:c.selected.includes(m.key)}))}]},SelectInfos:c.selected.map(k=>({SelectMetricsOrDimension:k,IsFrozen:!isTop&&c.frozen.includes(k)}))}};}
await write('035-getUserConfAndDataSet',config(top,'7580267836992405542',true));
await write('037-getUserConfAndDataSet',config(table,'7580269471328141358',false));
const metrics=Object.fromEntries(top.metrics.map((m,i)=>[m.key,{Value:i+1,ValueStr:String(i+1)}]));
await write('045-statQuery',{StatsData:{Totals:metrics,Rows:[],TotalCount:1}});
await write('046-statQuery',{StatsData:{Totals:metrics,Rows:[{Dimensions:{stat_time_hour:{Value:'12:00',ValueStr:'12:00'}},Metrics:metrics}],TotalCount:1}});
const ads=Array.from({length:10},(_,i)=>({id:String(1000000000000100n+BigInt(i)),advId:ACCOUNT_ID,marGoal:1,name:`人工样例计划 ${i+1}`,adDeliveryName:'投放中',adOptType:0,budget:'30000000',ecpRoi2Goal:2,budgetMode:1,modifyTime:'1',createTime:'1',overallRoiCostItems:[],operation:{budgetEditOperation:{editable:true},roi2GoalOperation:{editable:true},optStatusOperation:{editable:true}}}));
const stats=Object.fromEntries(ads.map(a=>[a.id,{metrics:{statCostForRoi2Primary:{value:240,valueStr:'240.00'}}}]));
await write('049-list-required',{adInfos:ads,adStatsMap:stats,pagination:{page:1,pageSize:10},sessionId:'synthetic-query-session'});
await write('050-list-summary',{totalNum:132,totalMetrics:{metrics:{statCostForRoi2Primary:{value:2400,valueStr:'2400.00'}}}});
await write('051-list-optional',{adGoodsMap:{},adId2PairsMap:{},adShowMaterialInfoMap:{}});
await fs.writeFile(new URL('README.md',directory),'# 人工测试样例\n\n由 scripts/generate-synthetic-fixtures.mjs 从指标定义和人工常量生成，不含原机器接口响应或业务数据。132 仅为分页测试场景中的假定总数；样例第一页10条。文件名沿用测试和回放加载器所需名称。模块ID和指标键是接口结构，不是登录凭据。\n');
console.log('Synthetic fixtures generated.');
