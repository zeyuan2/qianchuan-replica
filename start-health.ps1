param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$healthRoot=$PSScriptRoot
$healthRuntime=Join-Path $healthRoot '.runtime'
$healthScript=Join-Path $healthRoot 'server\health-recorder.mjs'
New-Item -ItemType Directory -Path $healthRuntime -Force | Out-Null
$healthPidFile=Join-Path $healthRuntime 'health.pid'
if(Test-Path -LiteralPath $healthPidFile){
 $healthProcessId=0
 if([int]::TryParse((Get-Content -LiteralPath $healthPidFile -Raw).Trim(),[ref]$healthProcessId)){
  $healthExisting=Get-CimInstance Win32_Process -Filter "ProcessId=$healthProcessId" -ErrorAction SilentlyContinue
  if($healthExisting -and $healthExisting.CommandLine -like ('*'+$healthScript+'*')){Write-Output 'Health recorder already running.';return}
 }
}
$healthNode=(Get-Command node -ErrorAction Stop).Source
$healthProcess=Start-Process -FilePath $healthNode -ArgumentList @(('"'+$healthScript+'"')) -WorkingDirectory $healthRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $healthRuntime 'health.stdout.log') -RedirectStandardError (Join-Path $healthRuntime 'health.stderr.log') -PassThru
Set-Content -LiteralPath $healthPidFile -Value $healthProcess.Id
Write-Output 'Health recorder started.'
