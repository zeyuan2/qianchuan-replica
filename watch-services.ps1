param([switch]$Once,[switch]$InspectOnly,[ValidateRange(5,300)][int]$IntervalSeconds=20)
$ErrorActionPreference='Stop'
$watchRoot=$PSScriptRoot
$watchRuntime=Join-Path $watchRoot '.runtime'
New-Item -ItemType Directory -Path $watchRuntime -Force | Out-Null
$watchLock=$null
try{$watchLock=[IO.File]::Open((Join-Path $watchRuntime 'watchdog.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{exit 0}
$watchHandles=@{}
$watchAttempts=@{}
$watchNext=@{}
$watchHealthy=@{}
$watchLastState=@{}
$watchEncoding=[Text.UTF8Encoding]::new($false)
function Write-WatchEvent($kind,$name,$detail){
 $watchEventPath=Join-Path $watchRuntime 'watchdog-events.jsonl'
 if((Test-Path -LiteralPath $watchEventPath) -and (Get-Item -LiteralPath $watchEventPath).Length -gt 2MB){Move-Item -LiteralPath $watchEventPath -Destination (Join-Path $watchRuntime 'watchdog-events.previous.jsonl') -Force}
 $watchEvent=@{time=[DateTimeOffset]::Now.ToString('o');event=$kind;service=$name;detail=$detail}|ConvertTo-Json -Compress -Depth 4
 [IO.File]::AppendAllText($watchEventPath,$watchEvent+[Environment]::NewLine,$watchEncoding)
}
function Get-WatchProcess($target){
 $watchTargetPid=Join-Path $watchRuntime ($target.name+'.pid')
 if(-not(Test-Path -LiteralPath $watchTargetPid)){return $null}
 $watchId=0;if(-not [int]::TryParse((Get-Content -LiteralPath $watchTargetPid -Raw).Trim(),[ref]$watchId)){return $null}
 $watchInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$watchId" -ErrorAction SilentlyContinue
 if(-not $watchInfo){return $null}
 $watchExpected=Join-Path $watchRoot $target.file
 $watchMatches=$watchInfo.CommandLine -like ('*'+$watchExpected+'*')
 # Support older launchers using relative script names, but only with matching creation time.
 if(-not $watchMatches -and $target.name -ne 'tunnel'){
  $watchDelta=[Math]::Abs(((Get-Item -LiteralPath $watchTargetPid).LastWriteTime-$watchInfo.CreationDate).TotalSeconds)
  $watchMatches=$watchDelta -lt 15 -and $watchInfo.Name -eq 'node.exe' -and $watchInfo.CommandLine -match ('(?:^|\s|["''])'+[regex]::Escape($target.file)+'(?:$|\s|["''])')
 }
 if(-not $watchMatches){return $null}
 return (Get-Process -Id $watchId -ErrorAction SilentlyContinue)
}
try{
 if(-not $InspectOnly){[IO.File]::WriteAllText((Join-Path $watchRuntime 'watchdog.pid'),[string]$PID,$watchEncoding);Write-WatchEvent 'started' 'watchdog' @{pid=$PID;intervalSeconds=$IntervalSeconds}}
 do{
  try{
   if(Test-Path -LiteralPath (Join-Path $watchRuntime 'watchdog.stop')){break}
   if(Test-Path -LiteralPath (Join-Path $watchRuntime 'watchdog.pause')){if($Once){break};Start-Sleep -Seconds $IntervalSeconds;continue}
   $watchConfig=Get-Content -LiteralPath (Join-Path $watchRuntime 'watchdog-config.json') -Raw | ConvertFrom-Json
   $watchTargets=@(@{name='web';port=5173;file='serve.mjs';launcher='start-web.ps1'},@{name='health';port=0;file='server\health-recorder.mjs';launcher='start-health.ps1'})
   if($watchConfig.public){$watchTargets+=@{name='public';port=8090;file='public-server.mjs';launcher='start-public.ps1'};$watchTargets+=@{name='tunnel';port=20245;file='.runtime\cloudflared.exe';launcher='start-public.ps1'}}
   if($watchConfig.lan){$watchTargets+=@{name='lan';port=8088;file='lan-server.mjs';launcher='start-lan.ps1'}}
   $watchRows=@()
   foreach($watchTarget in $watchTargets){
    $watchName=$watchTarget.name
    if($watchHandles.ContainsKey($watchName)){
     $watchTracked=$watchHandles[$watchName]
     if($watchTracked.HasExited){
      $watchExitCode=$null;try{$watchExitCode=$watchTracked.ExitCode}catch{}
      if(-not $InspectOnly){Write-WatchEvent 'process_exited' $watchName @{pid=$watchTracked.Id;exitCode=$watchExitCode}}
      $watchTracked.Dispose();$watchHandles.Remove($watchName);$watchHealthy.Remove($watchName)
     }
    }
    $watchProcess=Get-WatchProcess $watchTarget
    if($watchProcess){
     if($watchName -in @('web','public','lan','tunnel') -and -not $InspectOnly -and $watchProcess.PriorityClass -ne 'AboveNormal'){try{$watchProcess.PriorityClass='AboveNormal';Write-WatchEvent 'priority_applied' $watchName @{priority='AboveNormal'}}catch{if($watchLastState[$watchName] -ne 'running'){Write-WatchEvent 'priority_failed' $watchName @{code='ACCESS_OR_PROCESS_CHANGED'}}}}
     if(-not $watchHandles.ContainsKey($watchName)){$null=$watchProcess.Handle;$watchHandles[$watchName]=$watchProcess}
     if(-not $watchHealthy.ContainsKey($watchName)){$watchHealthy[$watchName]=Get-Date}
     if(((Get-Date)-$watchHealthy[$watchName]).TotalSeconds -gt 300){$watchAttempts[$watchName]=0}
     $watchRows+=@{service=$watchName;state='running';pid=$watchProcess.Id;privateMB=[Math]::Round($watchProcess.PrivateMemorySize64/1MB,1)}
     $watchLastState[$watchName]='running';continue
    }
    $watchOccupied=$null
    if($watchTarget.port -gt 0){$watchOccupied=Get-NetTCPConnection -State Listen -LocalPort $watchTarget.port -ErrorAction SilentlyContinue}
    if($watchOccupied){
     if(-not $InspectOnly -and $watchLastState[$watchName] -ne 'occupied'){Write-WatchEvent 'port_occupied_no_action' $watchName @{port=$watchTarget.port}}
     $watchRows+=@{service=$watchName;state='occupied';port=$watchTarget.port};$watchLastState[$watchName]='occupied';continue
    }
    $watchRows+=@{service=$watchName;state='stopped'}
    if($InspectOnly){continue}
    if($watchNext.ContainsKey($watchName) -and (Get-Date) -lt $watchNext[$watchName]){continue}
    $watchAttempts[$watchName]=1+[int]$watchAttempts[$watchName]
    $watchDelay=[Math]::Min(300,20*[Math]::Pow(2,[Math]::Min(4,$watchAttempts[$watchName]-1)))
    $watchNext[$watchName]=(Get-Date).AddSeconds($watchDelay)
    # Preserve the last process logs before the existing launcher opens fresh log files.
    foreach($watchStream in @('stdout','stderr')){
     $watchLog=Join-Path $watchRuntime ($watchName+'.'+$watchStream+'.log')
     if(Test-Path -LiteralPath $watchLog){Copy-Item -LiteralPath $watchLog -Destination (Join-Path $watchRuntime ($watchName+'.before-recovery.'+$watchStream+'.log')) -Force}
    }
    Write-WatchEvent 'restart_attempt' $watchName @{attempt=$watchAttempts[$watchName];retryDelaySeconds=$watchDelay}
    try{
     if($watchName -eq 'lan'){& (Join-Path $watchRoot $watchTarget.launcher) -NoBrowser -SkipFirewall | Out-Null}
     else{& (Join-Path $watchRoot $watchTarget.launcher) -NoBrowser | Out-Null}
     Write-WatchEvent 'restart_returned' $watchName @{attempt=$watchAttempts[$watchName]}
    }catch{Write-WatchEvent 'restart_failed' $watchName @{message=$_.Exception.Message}}
   }
   $watchStatus=@{time=[DateTimeOffset]::Now.ToString('o');pid=$PID;services=$watchRows}
   if($InspectOnly){$watchStatus|ConvertTo-Json -Depth 5}
   else{
    $watchTemp=Join-Path $watchRuntime 'watchdog-status.tmp'
    [IO.File]::WriteAllText($watchTemp,($watchStatus|ConvertTo-Json -Depth 5),$watchEncoding)
    Move-Item -LiteralPath $watchTemp -Destination (Join-Path $watchRuntime 'watchdog-status.json') -Force
   }
  }catch{if($InspectOnly){throw};Write-WatchEvent 'loop_error' 'watchdog' @{message=$_.Exception.Message}}
  if(-not $Once){Start-Sleep -Seconds $IntervalSeconds}
 }while(-not $Once)
}finally{
 foreach($watchHandle in $watchHandles.Values){$watchHandle.Dispose()}
 if(-not $InspectOnly){Write-WatchEvent 'stopped' 'watchdog' @{pid=$PID}}
 if($watchLock){$watchLock.Dispose()}
}
