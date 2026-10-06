param([ValidateRange(1,10)][int]$Attempts=6,[ValidateRange(1,60)][int]$RetrySeconds=10)
$ErrorActionPreference='Stop'
$loginRoot=$PSScriptRoot
$loginRuntime=Join-Path $loginRoot '.runtime'
New-Item -ItemType Directory -Path $loginRuntime -Force | Out-Null
$loginLock=$null
try{$loginLock=[IO.File]::Open((Join-Path $loginRuntime 'startup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{return}
function Write-StartupEvent($event,$step,$attempt){
 $file=Join-Path $loginRuntime 'startup-events.jsonl'
 if((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 1MB){Copy-Item -LiteralPath $file -Destination (Join-Path $loginRuntime 'startup-events.previous.jsonl') -Force;[IO.File]::WriteAllText($file,'')}
 $row=@{at=[DateTimeOffset]::Now.ToString('o');event=$event;step=$step;attempt=$attempt}|ConvertTo-Json -Compress
 [IO.File]::AppendAllText($file,$row+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
}
try{
 if((Test-Path -LiteralPath (Join-Path $loginRuntime 'watchdog.stop')) -or (Test-Path -LiteralPath (Join-Path $loginRuntime 'watchdog.pause'))){Write-StartupEvent 'intentionally_skipped' 'all' 0;return}
 $publicEnabled=Test-Path -LiteralPath (Join-Path $loginRuntime 'public-access.json')
 $lanEnabled=$false
 try{$prior=Get-Content -LiteralPath (Join-Path $loginRuntime 'watchdog-config.json') -Raw | ConvertFrom-Json;$lanEnabled=[bool]$prior.lan}catch{}
 $steps=@('web');if($publicEnabled){$steps+='public'};if($lanEnabled){$steps+='lan'};$steps+='watchdog'
 for($attempt=1;$attempt -le $Attempts;$attempt++){
  $failed=$false
  foreach($step in $steps){
   try{
    switch($step){
     'web' { & (Join-Path $loginRoot 'start-web.ps1') -NoBrowser | Out-Null }
     'public' { & (Join-Path $loginRoot 'start-public.ps1') -NoBrowser | Out-Null }
     'lan' { & (Join-Path $loginRoot 'start-lan.ps1') -NoBrowser -SkipFirewall | Out-Null }
     'watchdog' { & (Join-Path $loginRoot 'start-watchdog.ps1') -Public:$publicEnabled -Lan:$lanEnabled | Out-Null }
    }
    Write-StartupEvent 'ready' $step $attempt
   }catch{$failed=$true;Write-StartupEvent 'launch_failed' $step $attempt}
  }
  if(-not $failed){Write-StartupEvent 'complete' 'all' $attempt;return}
  if($attempt -lt $Attempts){Start-Sleep -Seconds $RetrySeconds}
 }
 Write-StartupEvent 'needs_attention' 'all' $Attempts
}finally{if($loginLock){$loginLock.Dispose()}}
