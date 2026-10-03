export function parseTunnelToken(input){
 const text=String(input||'').trim(),token=text.replace(/^cloudflared(?:\.exe)?\s+service\s+install\s+/i,'').trim();
 if(token.length<100||token.length>4096||!/^[A-Za-z0-9+/=_-]+$/.test(token))throw new Error('请粘贴Cloudflare复制按钮提供的完整安装命令或Token');
 let value;try{value=JSON.parse(Buffer.from(token,'base64').toString('utf8'));}catch{throw new Error('连接凭据不完整，请使用Cloudflare的复制按钮重新复制');}
 if(value.a!=='11111111111111111111111111111111'||!/^[a-f0-9-]{36}$/i.test(value.t||'')||typeof value.s!=='string'||value.s.length<20)throw new Error('连接凭据不属于当前Cloudflare账户或格式不正确');
 return {token,tunnelId:value.t};
}
