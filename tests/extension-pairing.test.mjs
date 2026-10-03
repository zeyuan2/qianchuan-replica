import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLocalPairing} from '../bridge-extension/pairing.mjs';
const request={accountId:'1000000000000000',url:'http://127.0.0.1:5173',token:'a'.repeat(48)};
test('pairing accepts only the top-level local setup page and expected account',()=>{
 const sender={url:'http://127.0.0.1:5173/connect.html',frameId:0};
 assert.equal(validateLocalPairing(request,sender).enabled,true);
 for(const url of ['https://qianchuan.jinritemai.com/overall-prom','http://192.168.1.100:8088/connect.html','http://127.0.0.1:5173/other.html','http://127.0.0.1:6000/connect.html'])assert.throws(()=>validateLocalPairing(request,{...sender,url}));
 assert.throws(()=>validateLocalPairing(request,{...sender,frameId:1}));
 assert.throws(()=>validateLocalPairing({...request,accountId:'other'},sender));
 assert.throws(()=>validateLocalPairing({...request,url:'https://external.example'},sender));
 assert.throws(()=>validateLocalPairing({...request,token:'invalid'},sender));
});
