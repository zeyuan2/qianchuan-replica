import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {OUTPUT_FILES,buildLan,main} from '../scripts/build-lan.mjs';

const root=new URL('../',import.meta.url);
const SOURCES=['main.mjs','plan-detail.mjs','operations-ui.mjs','task-ui.mjs','index.html'];

async function tempDirectory(t,prefix){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
 t.after(async()=>{const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());if(path.dirname(real).toLowerCase()!==parent.toLowerCase()||!path.basename(real).startsWith(prefix))throw new Error('Unsafe cleanup');await fs.rm(real,{recursive:true,force:true});});
 return directory;
}
async function assertMatchesCommitted(directory,label){
 for(const name of OUTPUT_FILES){
  const generated=await fs.readFile(path.join(directory,name)),committed=await fs.readFile(new URL('dist/'+name,root));
  assert.equal(Buffer.compare(generated,committed),0,`${label}: ${name}`);
 }
}
test('fresh LAN build matches the committed dist artifacts byte for byte',async()=>{
 const contents=await buildLan();
 assert.deepEqual([...contents.keys()],OUTPUT_FILES);
 for(const name of OUTPUT_FILES)assert.equal(Buffer.compare(Buffer.from(contents.get(name),'utf8'),await fs.readFile(new URL('dist/'+name,root))),0,name);
});
test('a drifted UI target fails the build instead of shipping a half-transformed page',async t=>{
 const directory=await tempDirectory(t,'qc-build-lan-src-');
 for(const name of SOURCES)await fs.copyFile(new URL('dist/'+name,root),path.join(directory,name));
 const mainFile=path.join(directory,'main.mjs');
 await fs.writeFile(mainFile,(await fs.readFile(mainFile,'utf8')).replace('onLoading(value){busy=value;','onLoading(value){busy=value ;'));
 await assert.rejects(buildLan({dist:pathToFileURL(directory+path.sep)}),/replacement target missing/);
});
test('--out builds into the requested directory and rejects unknown arguments',async t=>{
 const directory=await tempDirectory(t,'qc-build-lan-out-');
 const script=fileURLToPath(new URL('scripts/build-lan.mjs',root));
 const output=execFileSync(process.execPath,[script,'--out='+directory],{encoding:'utf8'});
 assert.match(output,/Built LAN monitor UI into/);
 await assertMatchesCommitted(directory,'cli');
 await assert.rejects(main(['--oops']),/unknown argument/);
});
