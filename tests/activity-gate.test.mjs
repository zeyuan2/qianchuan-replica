import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityGate} from '../server/activity-gate.mjs';

test('manual request waits for the current check, precedes queued capture, and prevents the next automation item',async()=>{
 const gate=new ActivityGate(),release=gate.tryAcquire('automation'),order=[];
 const capture=gate.run('capture',async()=>order.push('capture'));
 const manual=gate.acquire('manual',{priority:1,timeoutMs:1000});
 assert.equal(gate.owner,'automation');release();const done=await manual;
 assert.equal(gate.owner,'manual');assert.equal(gate.tryAcquire('automation'),null);assert.deepEqual(order,[]);
 order.push('manual');done();await capture;assert.deepEqual(order,['manual','capture']);assert.equal(gate.owner,null);
});

test('cancelled mobile request leaves no queued operation to run after reconnect',async()=>{
 const gate=new ActivityGate(),release=gate.tryAcquire('capture'),controller=new AbortController();let ran=false;
 const queued=gate.acquire('manual',{signal:controller.signal,priority:1}).then(done=>{ran=true;done();});
 const denied=assert.rejects(queued,e=>e.code==='ACTIVITY_WAIT_CANCELLED');controller.abort();await denied;
 release();assert.equal(ran,false);assert.equal(gate.waiters.length,0);const done=gate.tryAcquire('automation');assert.ok(done);done();
});

test('bounded manual wait removes a timed-out request without releasing the current operation',async()=>{
 const gate=new ActivityGate(),release=gate.tryAcquire('automation');
 await assert.rejects(gate.acquire('manual',{priority:1,timeoutMs:10}),e=>e.code==='ACTIVITY_WAIT_TIMEOUT'&&e.status===409);
 assert.equal(gate.owner,'automation');assert.equal(gate.waiters.length,0);release();assert.equal(gate.owner,null);
});

test('already aborted request cannot acquire even an idle gate; equal priorities remain FIFO',async()=>{
 const gate=new ActivityGate(),controller=new AbortController();controller.abort();await assert.rejects(gate.acquire('manual',{signal:controller.signal}),e=>e.code==='ACTIVITY_WAIT_CANCELLED');
 const release=gate.tryAcquire('capture'),a=gate.acquire('first',{priority:1}),b=gate.acquire('second',{priority:1});release();const doneA=await a;assert.equal(gate.owner,'first');doneA();const doneB=await b;assert.equal(gate.owner,'second');doneB();doneB();assert.equal(gate.owner,null);
});
