export function validateLocalPairing(message,sender){
 let source;try{source=new URL(sender.url||sender.tab?.url||'');}catch{throw new Error('仅允许本机连接设置页发起配对');}
 if(sender.frameId!==0||source.origin!=='http://127.0.0.1:5173'||source.pathname!=='/connect.html'||message.url!==source.origin)throw new Error('仅允许本机连接设置页发起配对');
 if(message.accountId!=='1000000000000000'||!/^\w{48}$/.test(message.token||'')||!/^[a-f0-9]+$/.test(message.token))throw new Error('本机连接信息无效，请刷新设置页');
 return {url:source.origin,token:message.token,enabled:true};
}
