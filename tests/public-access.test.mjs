import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import http from 'node:http';
import {CloudflareAccess} from '../server/cloudflare-access.mjs';
import {createLanServer} from '../lan-server.mjs';
import {parseTunnelToken} from '../server/tunnel-token.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256'};
const now=1790900000000,claims={iss:'https://test-team.cloudflareaccess.com',aud:['test-audience'],type:'app',email:'member2@example.com',exp:now/1000+3600};
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
function token(change={},header={alg:'RS256',kid:'test-key'}){const text=encode(header)+'.'+encode({...claims,...change});return text+'.'+sign('RSA-SHA256',Buffer.from(text),privateKey).toString('base64url');}
const auth=()=>new CloudflareAccess({team:'test-team',audience:'test-audience',emails:['member2@example.com'],clock:()=>now,fetcher:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
test('tunnel setup accepts only complete credentials for this account, never arbitrary commands',()=>{
 const value={a:'11111111111111111111111111111111',t:'00000000-0000-0000-0000-000000000001',s:'test-only-secret-not-real-1234'};
 const credential=Buffer.from(JSON.stringify(value)).toString('base64');assert.equal(parseTunnelToken('cloudflared.exe service install '+credential).token,credential);
 assert.throws(()=>parseTunnelToken('cloudflared.exe service install eyJ...'));
 assert.throws(()=>parseTunnelToken(credential+' & calc.exe'));
 assert.throws(()=>parseTunnelToken(Buffer.from(JSON.stringify({...value,a:'other-account'})).toString('base64')));
});
test('Access verifies signatures, issuer, audience, expiry, token type and exact mailbox',async()=>{
 const a=auth(),request=value=>({headers:{'cf-access-jwt-assertion':value}});
 assert.equal((await a.authenticate(request(token()))).email,claims.email);
 for(const value of [undefined,'invalid',token({email:'member4@example.com'}),token({iss:'https://other.cloudflareaccess.com'}),token({aud:['different-app']}),token({exp:now/1000-1}),token({nbf:now/1000+1000}),token({type:'org'}),token({}, {alg:'none',kid:'test-key'})])await assert.rejects(a.authenticate(request(value)));
 const p=token().split('.');p[1]=encode({...claims,exp:now/1000+999999});await assert.rejects(a.authenticate(request(p.join('.'))));
});
test('public gateway protects pages and APIs, keeps private settings hidden, validates origin, and secures cookies',async()=>{
 const a=auth(),calls=[];const s=createLanServer({host:'127.0.0.1',port:8090,publicOrigin:'https://qc.example.com',authorize:r=>a.authenticate(r),html:Buffer.from('dashboard'),proxy:async(endpoint,options)=>{calls.push({endpoint,options});return {status:200,body:Buffer.from('{}'),cookie:'qc_operator=test; Path=/api/; HttpOnly; SameSite=Strict'};}});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const req=(path,{jwt,method='GET',origin,host='qc.example.com'}={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:s.address().port,path,method,headers:{Host:host,...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),...(origin?{Origin:origin}:{}),'Content-Type':'application/json'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});r.on('error',reject);r.end(method==='POST'?'{}':undefined);});
 try{for(const path of ['/','/lan-api/snapshot','/lan-api/operator/status'])assert.equal((await req(path)).status,401);
 assert.equal((await req('/',{jwt:token()})).status,200);assert.equal((await req('/api/pairing',{jwt:token()})).status,404);assert.equal((await req('/connect.html',{jwt:token()})).status,404);assert.equal((await req('/.runtime/tunnel-token.txt',{jwt:token()})).status,404);
 assert.equal((await req('/lan-api/operation/commit',{jwt:token(),method:'POST',origin:'https://evil.example'})).status,403);assert.equal(calls.length,0);
 const result=await req('/lan-api/operator/status',{jwt:token()});assert.match(result.headers['set-cookie'][0],/Path=\/lan-api\//);assert.match(result.headers['set-cookie'][0],/Secure/);assert.equal(calls[0].options.headers['X-Replica-Client'],'access:member2@example.com');
 }finally{await new Promise(r=>s.close(r));}
});
