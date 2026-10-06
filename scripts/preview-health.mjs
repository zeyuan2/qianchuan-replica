// Local synthetic acceptance: no account APIs and no production diagnostic files.
import http from 'node:http';
import fs from 'node:fs/promises';
let accept=false,reports=0;
const server=http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.url==='/health-client.js'){res.setHeader('Content-Type','text/javascript');return res.end(await fs.readFile(new URL('../dist/health-client.js',import.meta.url)));}
 if(req.url.startsWith('/lan.css')){res.writeHead(accept?200:503,{'Content-Type':'text/css'});return res.end(accept?'body {color:#20324f}':'');}
 if(req.url==='/lan-api/snapshot'){res.writeHead(503,{'Content-Type':'application/json'});return res.end('{}');}
 if(req.url==='/lan-api/health/report'){req.resume();if(accept)reports++;res.writeHead(accept?200:503,{'Content-Type':'application/json'});return res.end('{}');}
 if(req.url==='/test/recover'&&req.method==='POST'){accept=true;return res.end('ok');}
 if(req.url==='/test/status'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({reports}));}
 if(req.url!=='/'){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>故障记录 · 隔离验收</title><body style="font:16px system-ui;padding:36px;background:#f5f7fc;color:#20324f"><h1>故障记录 · 隔离验收</h1><p>只模拟页面请求失败和日志补报，不连接真实账户。</p><button id="fail">模拟请求失败</button> <button id="asset">模拟样式失败</button> <button id="recover">恢复连接并补报</button><p id="status">等待测试</p><script src="/health-client.js"></script><script>QCHealth.ready(new Date().toISOString());let testStyle;document.getElementById('asset').onclick=()=>{testStyle=document.createElement('link');testStyle.rel='stylesheet';testStyle.href='/lan.css';document.head.append(testStyle);};document.getElementById('fail').onclick=async()=>{await fetch('/lan-api/snapshot');document.getElementById('status').textContent='模拟日志接收端暂时不可用，错误记录已在浏览器排队。';};document.getElementById('recover').onclick=async()=>{await fetch('/test/recover',{method:'POST'});if(testStyle)testStyle.href='/lan.css?recovered=1';QCHealth.ready(new Date().toISOString());dispatchEvent(new Event('online'));setTimeout(async()=>{const j=await (await fetch('/test/status')).json();document.getElementById('status').textContent='接收端已收到 '+j.reports+' 条记录（失败及恢复）。';},500);};</script>`);
});
server.listen(5191,'127.0.0.1',()=>console.log('Synthetic health preview: http://127.0.0.1:5191/'));
