(()=>{
 if(location.origin!=='http://127.0.0.1:5173'||location.pathname!=='/connect.html'||window.top!==window)return;
 let attached=false;
 function attach(){
  const slot=document.getElementById('extension-connect-slot');if(!slot||attached)return;attached=true;
  slot.innerHTML='<p class="extension-ready">已检测到千川连接扩展 1.3.0（采集与确认操作）</p><button id="extension-connect" type="button">接通持续采集</button><p id="extension-connect-status" role="status"></p>';
  const button=slot.querySelector('#extension-connect'),status=slot.querySelector('#extension-connect-status');
  button.addEventListener('click',async()=>{
   button.disabled=true;status.textContent='正在配对本机服务…';
   try{
    const response=await fetch('/api/pairing',{cache:'no-store'});if(!response.ok)throw new Error('本机服务不可用');const pairing=await response.json();
    const result=await chrome.runtime.sendMessage({action:'pair-from-local-page',url:pairing.url,token:pairing.token,accountId:pairing.accountId});
    if(!result?.ok)throw new Error(result?.error||'连接未完成，请重新加载扩展');
    status.textContent='本机配对成功。请保持Chrome中的目标账户页面已登录，采集状态会自动更新。';button.textContent='重新连接';
   }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
 }
 attach();if(!attached){const observer=new MutationObserver(()=>{attach();if(attached)observer.disconnect();});observer.observe(document.documentElement,{childList:true,subtree:true});}
})();
