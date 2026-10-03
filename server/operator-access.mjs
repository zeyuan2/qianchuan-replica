import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {atomicJson} from './monitor.mjs';
import {BridgeError} from './bridge.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const SESSION_MS=30*86400000;
export class OperatorAccess {
 constructor({filename,clock=Date.now}){this.filename=filename;this.clock=clock;this.state={sessions:{}};this.attempts=new Map();this.saves=Promise.resolve();}
 async init(){try{const value=JSON.parse(await fs.readFile(this.filename,'utf8'));if(value.salt&&value.passwordHash)this.state=value;}catch(error){if(error.code!=='ENOENT')throw error;}return this;}
 get configured(){return Boolean(this.state.passwordHash);}
 save(){const state=structuredClone(this.state);this.saves=this.saves.catch(()=>{}).then(()=>atomicJson(this.filename,state));return this.saves;}
 async setPassword(password){
  if(typeof password!=='string'||password.length<6||password.length>128)throw new BridgeError('操作密码需为6至128个字符','INVALID_PASSWORD',400);
  const salt=randomBytes(24).toString('hex');this.state={salt,passwordHash:scryptSync(password,salt,64).toString('hex'),sessions:{}};this.attempts.clear();await this.save();
 }
 token(cookie=''){return String(cookie).split(';').map(s=>s.trim()).find(s=>s.startsWith('qc_operator='))?.slice(12)||'';}
 session(cookie){const token=this.token(cookie);if(!/^[a-f0-9]{64}$/.test(token))return null;const id=hash(token),session=this.state.sessions[id];return session&&session.expiresAt>this.clock()?{id,...session}:null;}
 require(cookie){const session=this.session(cookie);if(!session)throw new BridgeError(this.configured?'请输入操作密码后再提交':'请先在采集电脑设置操作密码','OPERATOR_LOGIN_REQUIRED',401);return session;}
 cookie(token,maxAge=SESSION_MS/1000){return `qc_operator=${token}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;}
 async login(password,client='local'){
  if(!this.configured)throw new BridgeError('请先在采集电脑设置操作密码','OPERATOR_NOT_CONFIGURED',409);
  const now=this.clock();for(const[k,v]of this.attempts)if(v.until<=now)this.attempts.delete(k);
  const attempt=this.attempts.get(client)||{count:0,until:now+600000};
  if(attempt.count>=5)throw new BridgeError('密码尝试过多，请10分钟后再试','LOGIN_RATE_LIMITED',429);
  attempt.count++;this.attempts.set(client,attempt);
  if(typeof password!=='string'||password.length>128||!timingSafeEqual(scryptSync(password,this.state.salt,64),Buffer.from(this.state.passwordHash,'hex')))throw new BridgeError('操作密码不正确','INVALID_PASSWORD',401);
  this.attempts.delete(client);for(const[id,s]of Object.entries(this.state.sessions))if(s.expiresAt<=now)delete this.state.sessions[id];
  const token=randomBytes(32).toString('hex'),id=hash(token);this.state.sessions[id]={createdAt:now,expiresAt:now+SESSION_MS};await this.save();return this.cookie(token);
 }
 async renew(cookie){const session=this.session(cookie);if(!session)return null;this.state.sessions[session.id].expiresAt=this.clock()+SESSION_MS;await this.save();return this.cookie(this.token(cookie));}
 async logout(cookie){const session=this.session(cookie);if(session){delete this.state.sessions[session.id];await this.save();}return this.cookie('',0);}
}
