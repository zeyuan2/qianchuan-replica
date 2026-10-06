// Synthetic, localhost-only visual acceptance. No bridge, production files, or upstream requests.
import http from 'node:http';
import fs from 'node:fs/promises';
const H=3600000,T=Date.parse('2026-10-03T04:30:00Z');
const record={id:'synthetic',name:'演示计划 · 人工数据',planId:'synthetic',before:3,after:3.5,changedAt:new Date(T).toISOString(),expiresAt:new Date(T+24*H).toISOString(),asOf:new Date(T+12*H).toISOString(),status:'tracking',active:true,updatedAt:new Date(T+12*H).toISOString(),rows:Array.from({length:48},(_,i)=>{const time=Math.floor(T/H)*H+(i-24)*H,after=time>T,roi=2+(i%5)*.25+(after?.3:0),spend=25+(i%7)*5+(after?-3:0);return {time,roi,spend,roiCost:spend*1.3,revenue:roi*spend*1.3,full:true};})};
const assets=new Set(['roi-change-ui.mjs','roi-change-model.mjs','roi-change.css']);
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1:5190');res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET'){res.writeHead(405).end();return;}
 if(url.pathname==='/lan-api/roi-observations/list'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({records:[record]}));return;}
 if(url.pathname==='/lan-api/roi-observations/record'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(record));return;}
 const name=url.pathname.slice(1);if(assets.has(name)){res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(new URL('../dist/'+name,import.meta.url)));return;}
 if(url.pathname!=='/'){res.writeHead(404).end();return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ROI环比 · 人工数据验收</title><body style="font-family:system-ui;background:#f5f7fc;padding:24px"><h1>ROI环比 · 人工数据验收</h1><p>仅人工样本，不连接千川或生产数据。</p><button id="open">打开ROI对比</button><script type="module">import {openRoiChanges} from "/roi-change-ui.mjs";document.getElementById("open").onclick=()=>openRoiChanges();</script></body></html>');
 }catch{res.writeHead(500).end('Preview error');}});
server.listen(5190,'127.0.0.1',()=>console.log('Synthetic ROI preview: http://127.0.0.1:5190/'));
