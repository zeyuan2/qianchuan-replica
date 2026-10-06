param([switch]$Public,[switch]$Lan)
$ErrorActionPreference='Stop'
$watchRoot=$PSScriptRoot
$watchRuntime=Join-Path $watchRoot '.runtime'
New-Item -ItemType Directory -Path $watchRuntime -Force | Out-Null
$watchConfigPath=Join-Path $watchRuntime 'watchdog-config.json'
$watchConfig=@{public=[bool]$Public;lan=[bool]$Lan}
if(Test-Path -LiteralPath $watchConfigPath){
 $watchOld=Get-Content -LiteralPath $watchConfigPath -Raw | ConvertFrom-Json
 $watchConfig.public=$watchConfig.public -or [bool]$watchOld.public
 $watchConfig.lan=$watchConfig.lan -or [bool]$watchOld.lan
}
[IO.File]::WriteAllText($watchConfigPath,($watchConfig | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
if(Test-Path -LiteralPath (Join-Path $watchRuntime 'watchdog.stop')){Write-Output 'Watchdog intentionally disabled (watchdog.stop).';return}
$watchScript=Join-Path $watchRoot 'watch-services.ps1'
$watchPidPath=Join-Path $watchRuntime 'watchdog.pid'
if(Test-Path -LiteralPath $watchPidPath){
 $watchProcessId=[int](Get-Content -LiteralPath $watchPidPath)
 $watchExisting=Get-CimInstance Win32_Process -Filter "ProcessId=$watchProcessId" -ErrorAction SilentlyContinue
 if($watchExisting -and $watchExisting.CommandLine -like ('*'+$watchScript+'*')){Write-Output 'Watchdog already running.';return}
}
$watchShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$watchChild=Start-Process -FilePath $watchShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$watchScript+'"')) -WorkingDirectory $watchRoot -WindowStyle Hidden -PassThru
for($watchAttempt=0;$watchAttempt -lt 20;$watchAttempt++){
 Start-Sleep -Milliseconds 250
 if(Test-Path -LiteralPath $watchPidPath){
  $watchCurrentId=[int](Get-Content -LiteralPath $watchPidPath)
  $watchCurrent=Get-CimInstance Win32_Process -Filter "ProcessId=$watchCurrentId" -ErrorAction SilentlyContinue
  if($watchCurrent -and $watchCurrent.CommandLine -like ('*'+$watchScript+'*')){Write-Output 'Watchdog running.';return}
 }
}
throw 'Watchdog did not start. Check .runtime/watchdog-events.jsonl.'
