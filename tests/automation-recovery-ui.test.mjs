import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=(await fs.readFile(new URL('../dist/automation-recovery.mjs',import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\nglobalThis.open=openAutomationRecovery;';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(failCommit=false){
 const calls=[],content={innerHTML:''},error={textContent:''};let dialog;
 const job={id:'synthetic',planId:'1000000000000100',name:'<script>synthetic</script>',held:true,status:'partial',steps:[{index:0,field:'roi',before:2.5,target:2.7,status:'confirmed'},{index:1,field:'budget',before:300,target:600,status:'not-submitted'}],review:{at:Date.now(),current:{roi:2.7,budget:300,status:'投放中'},unknown:false,canResolve:true,retryStep:1}};
 const document={body:{append(){}},createElement(){dialog={style:{},listeners:{},setAttribute(){},showModal(){this.open=true;},querySelector:selector=>selector==='[data-content]'?content:error,querySelectorAll:()=>[],addEventListener(type,fn){this.listeners[type]=fn;},close(){this.listeners.close?.();},remove(){}};return dialog;}};
 const context={document,ACCOUNT_ID:'1000000000000000',ensureOperator:async()=>true,fetch:async(url,options)=>{calls.push({url,body:options.body?JSON.parse(options.body):null});if(url.endsWith('commit')&&failCommit)throw Error('network outcome unknown');return {ok:true,json:async()=>url.endsWith('history')?{plans:[],jobs:[job]}:url.endsWith('prepare')?{token:'synthetic-once',kind:'step',description:'只补预算300到600'}:job};},Date};vm.createContext(context);vm.runInContext(source,context);
 return {context,calls,content,error,click:async(dataset={},attrs=[])=>{const button={dataset,hasAttribute:name=>attrs.includes(name)};dialog.listeners.click({target:{closest:()=>button}});await settle();},get dialog(){return dialog;}};
}
test('recovery UI requires review then confirmation and never submits merely opening or preparing',async()=>{
 const f=fixture();await f.context.open();assert.ok(f.dialog.open);assert.match(f.content.innerHTML,/&lt;script&gt;/);assert.equal(f.calls.filter(c=>c.url.endsWith('commit')).length,0);
 await f.click({review:'synthetic'});assert.match(f.content.innerHTML,/核对单步补做/);await f.click({prepare:'step',job:'synthetic',index:'1'});assert.match(f.content.innerHTML,/请确认本次处理/);assert.equal(f.calls.filter(c=>c.url.endsWith('commit')).length,0);
 await f.click({},['data-confirm']);await f.click({},['data-confirm']);assert.equal(f.calls.filter(c=>c.url.endsWith('commit')).length,1);
});
test('ambiguous recovery response consumes the UI confirmation and requires another review instead of retrying',async()=>{
 const f=fixture(true);await f.context.open();await f.click({review:'synthetic'});await f.click({prepare:'step',job:'synthetic',index:'1'});await f.click({},['data-confirm']);assert.match(f.content.innerHTML,/不会自动重复提交/);assert.match(f.error.textContent,/unknown/);await f.click({},['data-confirm']);assert.equal(f.calls.filter(c=>c.url.endsWith('commit')).length,1);
});
