import {createPublicKey,verify} from 'node:crypto';

const denied=()=>Object.assign(new Error('请使用获准的邮箱通过网页入口登录'),{status:401,code:'ACCESS_REQUIRED'});
export class CloudflareAccess {
 constructor({team,audience,emails,fetcher=fetch,clock=Date.now}){
  if(!/^[a-z0-9-]+$/.test(team)||!audience||!emails?.length)throw new Error('Missing public Access configuration');
  Object.assign(this,{audience,fetcher,clock});this.issuer=`https://${team}.cloudflareaccess.com`;this.emails=new Set(emails.map(e=>e.toLowerCase()));this.keys=[];this.loadedAt=0;this.loading=null;
 }
 async refresh(){if(this.loading)return this.loading;this.loading=(async()=>{const r=await this.fetcher(this.issuer+'/cdn-cgi/access/certs',{signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok)throw denied();const data=await r.json();if(!Array.isArray(data.keys))throw denied();this.keys=data.keys.filter(k=>k.kty==='RSA'&&(!k.alg||k.alg==='RS256'));this.loadedAt=this.clock();})();try{await this.loading;}finally{this.loading=null;}}
 async authenticate(req){
  const token=req.headers['cf-access-jwt-assertion'];if(typeof token!=='string'||token.length>20000)throw denied();
  const parts=token.split('.');if(parts.length!==3||parts.some(p=>!p||!/^[\w-]+$/.test(p)))throw denied();
  let header,payload;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));payload=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw denied();}
  const now=this.clock()/1000;
  if(header.alg!=='RS256'||typeof header.kid!=='string'||payload.iss!==this.issuer||payload.type!=='app'||!Array.isArray(payload.aud)||!payload.aud.includes(this.audience)||!Number.isFinite(payload.exp)||payload.exp<=now||(payload.nbf!==undefined&&(!Number.isFinite(payload.nbf)||payload.nbf>now+30))||typeof payload.email!=='string'||!this.emails.has(payload.email.toLowerCase()))throw denied();
  if(!this.loadedAt||this.clock()-this.loadedAt>3600000)await this.refresh();
  let jwk=this.keys.find(k=>k.kid===header.kid);
  if(!jwk&&this.clock()-this.loadedAt>60000){await this.refresh();jwk=this.keys.find(k=>k.kid===header.kid);}
  if(!jwk)throw denied();
  try{const key=createPublicKey({key:jwk,format:'jwk'});if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))throw denied();}catch{throw denied();}
  return {email:payload.email.toLowerCase()};
 }
}
