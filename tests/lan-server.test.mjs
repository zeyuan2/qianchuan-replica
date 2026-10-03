import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLanServer} from '../lan-server.mjs';

test('LAN share serves only the snapshot and health, with no account API or file access',async()=>{
 const expectedHost='192.168.1.100:8088';
 const server=createLanServer({host:'192.168.1.100',port:8088,html:Buffer.from('<!doctype html><title>只读快照</title>')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const request=(path,method='GET',host=expectedHost,extra={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:host,...extra}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();
 });
 try{
  const page=await request('/');assert.equal(page.status,200);assert.match(page.body,/只读快照/);
  assert.equal((await request('/','HEAD')).body,'');
  assert.equal((await request('/','GET',expectedHost,{'If-None-Match':page.headers.etag})).status,304);
  for(const path of ['/api/pairing','/api/dashboard','/bridge/next','/.runtime/connection.json','/data/snapshots/2026-10-01-preview.json','/../serve.mjs'])assert.equal((await request(path)).status,404);
  assert.equal((await request('/api/operation/commit','POST')).status,405);
  assert.equal((await request('/','GET','example.com:8088')).status,403);
  const health=JSON.parse((await request('/healthz')).body);assert.equal(health.accountOperations,false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('LAN operator proxy allows only named routes, rejects cross-origin writes and scopes cookies',async()=>{
 const calls=[],proxy=async(endpoint,options)=>{calls.push({endpoint,options});return {status:401,body:Buffer.from('{"error":{"code":"OPERATOR_LOGIN_REQUIRED"}}'),cookie:'qc_operator=test-only; Path=/api/; HttpOnly; SameSite=Strict'};};
 const server=createLanServer({host:'127.0.0.1',port:8088,html:Buffer.from('monitor'),proxy});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(path,origin)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{Host:'127.0.0.1:8088','Content-Type':'application/json',Cookie:'qc_operator=test-only',...(origin?{Origin:origin}:{})}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,cookie:res.headers['set-cookie']}));});req.on('error',reject);req.end('{}');});
 try{
  for(const origin of [undefined,'http://external.example'])assert.equal((await request('/lan-api/operation/commit',origin)).status,403);assert.equal(calls.length,0);
  const result=await request('/lan-api/operation/commit','http://127.0.0.1:8088');assert.equal(result.status,401);assert.match(result.cookie[0],/Path=\/lan-api\//);assert.equal(calls[0].endpoint,'/api/operation/commit');assert.equal(calls[0].options.headers.Origin,'http://127.0.0.1:5173');
  assert.equal((await request('/lan-api/operator/setup','http://127.0.0.1:8088')).status,405);assert.equal(calls.length,1);
 }finally{await new Promise(r=>server.close(r));}
});

test('LAN monitor exposes snapshots and constrained detail reads but no private account routes',async()=>{
 const calls=[];const proxy=async(endpoint,options)=>{calls.push({endpoint,options});return {status:200,body:Buffer.from(JSON.stringify({snapshot:{total:132}}))};};
 const server=createLanServer({host:'127.0.0.1',port:8088,html:Buffer.from('monitor'),proxy});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(path,method='GET',body,origin)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'127.0.0.1:8088','Content-Type':'application/json',...(origin?{Origin:origin}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 try{
  assert.equal((await request('/lan-api/snapshot')).status,200);assert.equal(calls[0].endpoint,'/api/monitor');
  assert.equal((await request('/api/pairing')).status,404);
  assert.equal((await request('/api/operation/commit','POST',{confirmed:true})).status,405);
  assert.equal((await request('/lan-api/detail','POST',{accountId:'1000000000000000',id:'1000000000000100',tab:'data'})).status,200);assert.equal(calls[1].endpoint,'/api/monitor/detail');
  assert.equal((await request('/lan-api/detail','POST',{accountId:'other',id:'1000000000000100',tab:'data'})).status,400);
  assert.equal((await request('/lan-api/snapshot','GET',undefined,'https://external.example')).status,403);
  assert.equal(calls.length,2);
 }finally{await new Promise(r=>server.close(r));}
});
