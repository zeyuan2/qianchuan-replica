import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Windows tunnel watchdog waits through startup, requires consecutive failures, respects cooldown and clears recovered failures',{skip:process.platform!=='win32'},()=>{
 const script=fileURLToPath(new URL('../tunnel-health.ps1',import.meta.url)).replaceAll("'","''");
 const command=`$ErrorActionPreference='Stop'; . '${script}'
 function Invoke-RestMethod {return $script:probeReply}
 $script:probeReply=@{status=200;readyConnections=0};$zero=Get-TunnelHealth
 $script:probeReply=@{status=200;readyConnections=2};$positive=Get-TunnelHealth
 $script:probeReply=@{status=503;readyConnections=2};$failed=Get-TunnelHealth
 $now=[DateTimeOffset]::Parse('2026-10-09T00:00:00Z')
 $grace=Get-TunnelRecoveryDecision -ProcessId 10 -AgeSeconds 30 -Ready $false -Now $now
 $a=Get-TunnelRecoveryDecision -ProcessId 10 -AgeSeconds 500 -Ready $false -Now $now
 $b=Get-TunnelRecoveryDecision -Previous $a.state -ProcessId 10 -AgeSeconds 520 -Ready $false -Now $now.AddSeconds(20)
 $c=Get-TunnelRecoveryDecision -Previous $b.state -ProcessId 10 -AgeSeconds 540 -Ready $false -Now $now.AddSeconds(40)
 $cool=Get-TunnelRecoveryDecision -Previous $c.state -ProcessId 11 -AgeSeconds 100 -Ready $false -Now $now.AddSeconds(150)
 $ok=Get-TunnelRecoveryDecision -Previous $cool.state -ProcessId 11 -AgeSeconds 120 -Ready $true -Now $now.AddSeconds(170)
 $again=Get-TunnelRecoveryDecision -Previous $ok.state -ProcessId 11 -AgeSeconds 140 -Ready $false -Now $now.AddSeconds(190)
 @{zeroReady=$zero.ready;positiveReady=$positive.ready;failedReady=$failed.ready;grace=$grace.action;first=$a.action;second=$b.action;third=$c.action;cooldown=$cool.action;recovered=$ok.action;failures=$ok.state.failures;nextFailure=$again.state.failures;cooldownPreserved=$again.state.nextRestartAt} | ConvertTo-Json -Compress`;
 const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{encoding:'utf8'}));
 assert.equal(result.zeroReady,false);assert.equal(result.positiveReady,true);assert.equal(result.failedReady,false);
 assert.equal(result.grace,'startup_grace');assert.equal(result.first,'observe');assert.equal(result.second,'observe');assert.equal(result.third,'restart');assert.equal(result.cooldown,'cooldown');assert.equal(result.recovered,'healthy');assert.equal(result.failures,0);assert.equal(result.nextFailure,1);assert.ok(result.cooldownPreserved);
});
