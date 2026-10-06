import test from 'node:test';
import assert from 'node:assert/strict';
import {BoostListCache} from '../server/boost-cache.mjs';
const base=Date.parse('2026-10-03T06:00:00Z');
const result=end=>({requests:6,total:1,rows:new Map([['plan',{id:'plan',state:end?'active':'eligible',listEvidence:{endAt:end?new Date(end).toISOString():null}}]])});
test('concurrent reads share one load and warm cache returns independent copies without new requests',async()=>{
 let calls=0,release;const cache=new BoostListCache({clock:()=>base,load:async()=>{calls++;await new Promise(r=>release=r);return result();}});
 const a=cache.get(),b=cache.get();release();const [one,two]=await Promise.all([a,b]);assert.equal(calls,1);assert.equal(one.requests,6);assert.equal(two.requests,0);assert.equal(two.shared,true);one.rows.get('plan').state='unknown';const three=await cache.get();assert.equal(three.cacheHit,true);assert.equal(three.rows.get('plan').state,'eligible');
});
test('TTL, task end, day changes and explicit invalidation all force new reads',async()=>{
 let now=base,calls=0,end=base+1000;const cache=new BoostListCache({clock:()=>now,load:async()=>{calls++;return result(end);}});
 await cache.get();now+=1001;end=null;await cache.get();assert.equal(calls,2);now+=60001;await cache.get();assert.equal(calls,3);cache.invalidate();await cache.get();assert.equal(calls,4);
 now=Date.parse('2026-10-03T15:59:59Z');await cache.get();now+=1001;await cache.get();assert.equal(calls,6);
});
test('a read started before an operation is discarded and cannot repopulate cache',async()=>{
 let resolve,calls=0;const cache=new BoostListCache({clock:()=>base,load:async()=>{calls++;if(calls===1)await new Promise(r=>resolve=r);return result();}});
 const stale=cache.get();cache.invalidate();resolve();await assert.rejects(stale,e=>e.code==='BOOST_CACHE_INVALIDATED');assert.equal(cache.saved,null);await cache.get();assert.equal(calls,2);
});
test('failed refresh never falls back to an expired eligible snapshot',async()=>{
 let now=base,fail=false;const cache=new BoostListCache({clock:()=>now,load:async()=>{if(fail)throw new Error('offline');return result();}});await cache.get();now+=60001;fail=true;await assert.rejects(cache.get());assert.equal(cache.saved,null);
});
