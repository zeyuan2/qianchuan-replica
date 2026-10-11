import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicProxy} from '../server/public-proxy.mjs';

const encode=value=>new TextEncoder().encode(value).buffer;
const fakeResponse=({status=200,body='{}',cookie=null}={})=>({status,headers:{get:name=>name==='set-cookie'?cookie:null},arrayBuffer:async()=>encode(body)});
const calls=()=>{const seen={options:null,logs:[]};const fetcher=async(url,options)=>{seen.url=url;seen.options=options;return seen.response||fakeResponse();};const log=async record=>{seen.logs.push(record);};return {seen,fetcher,log};};

test('a header-less GET (snapshot polling shape) proxies without touching request options blindly',async()=>{
 const {seen,fetcher,log}=calls();seen.response=fakeResponse({status:200,body:'{"snapshot":{"total":171}}'});
 const proxy=createPublicProxy({fetcher,log});
 const result=await proxy('/api/monitor?from=2026-10-12&to=2026-10-12',{method:'GET'});
 assert.equal(result.status,200);
 assert.equal(result.body.toString('utf8'),'{"snapshot":{"total":171}}');
 assert.equal(seen.options.method,'GET');
 assert.equal(seen.options.headers,undefined);
 assert.deepEqual(seen.logs,[]);
});

test('a HEAD request without options at all still resolves',async()=>{
 const {fetcher,log}=calls();
 const proxy=createPublicProxy({fetcher,log});
 const result=await proxy('/api/monitor');
 assert.equal(result.status,200);
});

test('audited operations keep recording actor and outcome',async()=>{
 const {seen,fetcher,log}=calls();seen.response=fakeResponse({status:200,body:'{"success":true,"planId":"1001"}'});
 const proxy=createPublicProxy({fetcher,log});
 await proxy('/api/operation/commit',{method:'POST',body:JSON.stringify({planId:'1001'}),headers:{'X-Replica-Client':'access:ops@example.com'}});
 assert.equal(seen.logs.length,1);
 const record=seen.logs[0];
 assert.equal(record.actor,'access:ops@example.com');
 assert.equal(record.planId,'1001');
 assert.equal(record.outcome,'success');
 assert.equal(record.httpStatus,200);
});

test('an audit write failure is swallowed so the confirmed result still reaches the operator',async()=>{
 const {fetcher}=calls();
 const proxy=createPublicProxy({fetcher,log:async()=>{throw new Error('disk full');}});
 const result=await proxy('/api/operation/commit',{method:'POST',body:'{"planId":"1001"}',headers:{'X-Replica-Client':'access:ops@example.com'}});
 assert.equal(result.status,200);
});

test('an upstream failure still propagates so the gateway can answer 502',async()=>{
 const proxy=createPublicProxy({fetcher:async()=>{throw new Error('connect ECONNREFUSED');}});
 await assert.rejects(proxy('/api/monitor',{method:'GET'}),/ECONNREFUSED/);
});
