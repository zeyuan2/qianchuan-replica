import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {buildLan} from '../scripts/build-lan.mjs';

const root=new URL('../',import.meta.url);
const ENTRY=['lan-main.mjs','lan-plan-detail.mjs','lan-operations-ui.mjs','lan-task-ui.mjs'];
function importsOf(text){
 const dependencies=new Set();
 for(const match of text.matchAll(/(?:from|import)\s*['"]\.\/([\w.-]+)['"]/g))if(/\.(?:mjs|js)$/.test(match[1]))dependencies.add(match[1]);
 return dependencies;
}
async function servedFiles(){
 const listOf=text=>{const match=/const files=\[(.*?)\];/s.exec(text);assert.ok(match,'asset list not found');return match[1].split(',').map(entry=>entry.trim().replace(/^['"]|['"]$/g,'')).filter(Boolean);};
 const lan=listOf(await fs.readFile(new URL('lan-server.mjs',root),'utf8')),publicList=listOf(await fs.readFile(new URL('public-server.mjs',root),'utf8'));
 assert.deepEqual(lan,publicList,'LAN and public gateways must serve the same asset set');
 return lan;
}
test('every module reachable from the LAN entries is served and present in dist',async()=>{
 const contents=await buildLan(),servedSet=new Set(await servedFiles());
 for(const name of servedSet)await fs.access(new URL('dist/'+name,root));
 for(const entry of ENTRY)assert.ok(servedSet.has(entry),`${entry} is not served`);
 const seen=new Set(),missing=[],queue=[...ENTRY];
 while(queue.length){
  const name=queue.pop();if(seen.has(name))continue;seen.add(name);
  const text=contents.get(name)??await fs.readFile(new URL('dist/'+name,root),'utf8');
  for(const dependency of importsOf(text)){if(!servedSet.has(dependency))missing.push(`${name} -> ${dependency}`);else if(!seen.has(dependency))queue.push(dependency);}
 }
 assert.deepEqual(missing.sort(),[]);
});
test('the LAN html references only served assets',async()=>{
 const contents=await buildLan(),served=new Set(await servedFiles()),html=contents.get('lan.html');
 for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){
  const reference=match[1];
  const local=/^[\w.-]+\.(?:mjs|js|css|svg)$/.test(reference)||/^assets\/[\w.-]+\.svg$/.test(reference);
  if(local)assert.ok(served.has(reference),`lan.html references unserved ${reference}`);
 }
});
