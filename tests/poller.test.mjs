import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoller,ACCOUNT_ID,REFRESH_INTERVAL_MS} from '../dist/poller.mjs';
const settle=()=>new Promise(r=>setImmediate(r));
function clock(){let now=0,id=0;const tasks=new Map();return {get time(){return now;},setTimeout(fn,ms){tasks.set(++id,{at:now+ms,fn});return id;},clearTimeout(i){tasks.delete(i);},tick(ms){now+=ms;for(const [k,t]of [...tasks])if(t.at<=now){tasks.delete(k);t.fn();}},tasks};}
const data=n=>({accountId:ACCOUNT_ID,source:'live',n});
test('polls 300000ms after completion and does not overlap',async()=>{
 const timer=clock();let n=0;const seen=[];const p=createPoller({timer,now:()=>timer.time,query:()=>({}),load:async()=>data(++n),onData:d=>seen.push(d.n),onError:e=>{throw e;}});
 p.start();await settle();assert.deepEqual(seen,[1]);timer.tick(REFRESH_INTERVAL_MS-1);await settle();assert.equal(n,1);timer.tick(1);await settle();assert.deepEqual(seen,[1,2]);p.stop();
});
test('failed update leaves last successful data and reports login error',async()=>{
 let n=0,last=null,error;const p=createPoller({timer:clock(),query:()=>({}),load:async()=>{if(++n===2){const e=new Error('登录失效');e.code='AUTH_REQUIRED';throw e;}return data(n);},onData:d=>last=d,onError:e=>error=e});
 p.start();await settle();await p.refresh();assert.equal(last.n,1);assert.equal(error.code,'AUTH_REQUIRED');p.stop();
});
test('query invalidation discards an obsolete response',async()=>{
 const resolves=[];let value=1;const seen=[];const p=createPoller({timer:clock(),query:()=>({value}),load:q=>new Promise(resolve=>resolves.push(()=>resolve(data(q.value)))),onData:d=>seen.push(d.n),onError:()=>{}});
 p.start();value=2;p.invalidate();resolves[0]();await settle();assert.deepEqual(seen,[]);resolves[1]();await settle();assert.deepEqual(seen,[2]);p.stop();
});
test('stop and restart cannot publish an old in-flight result',async()=>{
 const resolves=[],seen=[];const p=createPoller({timer:clock(),query:()=>({}),load:()=>new Promise(resolve=>resolves.push(resolve)),onData:d=>seen.push(d.n),onError:()=>{}});
 p.start();p.stop();p.start();resolves[0](data(1));await settle();assert.deepEqual(seen,[]);resolves[1](data(2));await settle();assert.deepEqual(seen,[2]);p.stop();
});
