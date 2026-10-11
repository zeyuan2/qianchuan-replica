import test from 'node:test';
import assert from 'node:assert/strict';
import {tableRenderKey} from '../dist/render-state.mjs';

const base=()=>({model:{fetchedAt:'2026-10-12T00:00:00.000Z',page:1,pageSize:10,total:132,plans:Array.from({length:10},(_,index)=>({id:String(index)})),newEventCount:0},query:{search:'',product:'selected',status:'all',service:'all',serviceMode:'include',costStatus:'all',sortField:'create_time',sortType:'desc',onlyNew:false},top:['a','b'],table:['c','d']});
function key(mutation={}){const state=base();Object.assign(state.model,mutation.model);Object.assign(state.query,mutation.query);return tableRenderKey(state.model,state.query,mutation.top??state.top,mutation.table??state.table);}
test('identical state produces an identical render key',()=>{
 assert.equal(key(),key());
 assert.equal(key({top:['a','b']}),key());
});
test('every input that changes the table or metric cards changes the key',()=>{
 const mutations=[{model:{fetchedAt:'2026-10-12T00:05:00.000Z'}},{model:{page:2}},{model:{pageSize:20}},{model:{total:133}},{model:{plans:Array.from({length:11},(_,index)=>({id:String(index)}))}},{model:{newEventCount:1}},{query:{search:'abc'}},{query:{product:'managed'}},{query:{status:'13'}},{query:{service:'3'}},{query:{serviceMode:'exclude'}},{query:{costStatus:'zero'}},{query:{sortField:'statcostforroi2'}},{query:{sortType:'asc'}},{query:{onlyNew:true}},{top:['b','a']},{top:['a']},{table:['d','c']}];
 for(const mutation of mutations)assert.notEqual(key(mutation),key(),JSON.stringify(mutation));
});
test('missing or partial state still produces a stable key instead of throwing',()=>{
 const empty=tableRenderKey(undefined,undefined,undefined,undefined);
 assert.equal(empty,tableRenderKey({},{},[],[]));
 assert.match(empty,/^\[/);
});
