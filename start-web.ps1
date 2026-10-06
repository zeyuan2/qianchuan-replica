param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$webRoot=$PSScriptRoot
$webPort=5173
$webUrl="http://127.0.0.1:$webPort"
$webRuntime=Join-Path $webRoot '.runtime'
New-Item -ItemType Directory -Path $webRuntime -Force | Out-Null
$webStatus=$null
try { $webStatus=Invoke-RestMethod -Uri "$webUrl/api/status" -TimeoutSec 2 } catch {}
if ($webStatus -and $webStatus.accountId -ne '1000000000000000') { throw '5173端口已被其他服务占用。' }
if (-not $webStatus) {
    $webNode=(Get-Command node -ErrorAction Stop).Source
    $env:PORT=[string]$webPort
    $env:ALLOW_ACCOUNT_WRITES='0'
    $env:REPLICA_REPLAY='0'
    $webProcess=Start-Process -FilePath $webNode -ArgumentList @('serve.mjs') -WorkingDirectory $webRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $webRuntime 'web.stdout.log') -RedirectStandardError (Join-Path $webRuntime 'web.stderr.log') -PassThru
    Set-Content -LiteralPath (Join-Path $webRuntime 'web.pid') -Value $webProcess.Id
    for ($webAttempt=0; $webAttempt -lt 20; $webAttempt++) {
        Start-Sleep -Milliseconds 250
        try { $webStatus=Invoke-RestMethod -Uri "$webUrl/api/status" -TimeoutSec 1; break } catch {}
    }
    if (-not $webStatus) { throw '网页服务启动失败，请查看.runtime中的日志。' }
}
try { & (Join-Path $webRoot 'start-health.ps1') -NoBrowser | Out-Null } catch { Write-Warning 'Health recorder could not start.' }
$webPreview="$webUrl/connect.html"
if (-not $NoBrowser) { Start-Process $webPreview }
Write-Output $webPreview
