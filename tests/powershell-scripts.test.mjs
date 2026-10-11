import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const scriptNames=async()=>(await fs.readdir(root)).filter(name=>name.endsWith('.ps1')).sort();

test('PowerShell scripts containing non-ASCII text start with a UTF-8 BOM',async()=>{
 const names=await scriptNames();assert.ok(names.length>=8,'expected the deployment scripts in the repository root');
 for(const name of names){
  const body=await fs.readFile(path.join(root,name));
  const hasNonAscii=body.some(byte=>byte>=0x80);
  const hasBom=body[0]===0xef&&body[1]===0xbb&&body[2]===0xbf;
  if(hasNonAscii)assert.ok(hasBom,`${name} contains non-ASCII text and needs a UTF-8 BOM for Windows PowerShell 5.1`);
 }
});
test('every PowerShell script parses cleanly',{skip:process.platform!=='win32'},async()=>{
 const names=await scriptNames();
 const list=names.map(name=>"'"+path.join(root,name).replaceAll("'","''")+"'").join(',');
 const command=`$ErrorActionPreference='Stop';$out=@();foreach($f in @(${list})){$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$errors);$out+=[pscustomobject]@{file=[IO.Path]::GetFileName($f);count=@($errors).Count}};$out|ConvertTo-Json -Compress`;
 const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{encoding:'utf8'}));
 assert.equal(result.length,names.length);
 for(const entry of result)assert.equal(entry.count,0,entry.file);
});
