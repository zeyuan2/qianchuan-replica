param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$publicRoot=$PSScriptRoot
$publicRuntime=Join-Path $publicRoot '.runtime'
& (Join-Path $publicRoot 'start-web.ps1') -NoBrowser | Out-Null
$publicConfig=Get-Content -LiteralPath (Join-Path $publicRuntime 'public-access.json') -Raw | ConvertFrom-Json
$publicListener=Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue
if ($publicListener) {
 $publicProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $($publicListener.OwningProcess)"
 if ($publicListener.LocalAddress -ne '127.0.0.1' -or $publicProcess.CommandLine -notmatch [regex]::Escape((Join-Path $publicRoot 'public-server.mjs'))) { throw '8090端口已被其他程序占用' }
} else {
 $publicNode=(Get-Command node).Source
 $publicProcess=Start-Process -FilePath $publicNode -ArgumentList @((Join-Path $publicRoot 'public-server.mjs')) -WorkingDirectory $publicRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $publicRuntime 'public.stdout.log') -RedirectStandardError (Join-Path $publicRuntime 'public.stderr.log') -PassThru
 Set-Content -LiteralPath (Join-Path $publicRuntime 'public.pid') -Value $publicProcess.Id
 Start-Sleep -Milliseconds 700
 if (-not (Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue)) { throw '外网网关启动失败，请检查public.stderr.log' }
}
$tunnelExe=Join-Path $publicRuntime 'cloudflared.exe'
$tunnelTokenFile=Join-Path $publicRuntime 'tunnel-token.txt'
if (-not (Test-Path -LiteralPath $tunnelExe) -or -not (Test-Path -LiteralPath $tunnelTokenFile)) { throw '隧道程序或连接凭据尚未配置' }
$tunnelActive=$false
if (Test-Path -LiteralPath (Join-Path $publicRuntime 'tunnel.pid')) {
 $tunnelProcessId=[int](Get-Content -LiteralPath (Join-Path $publicRuntime 'tunnel.pid'))
 $tunnelExisting=Get-CimInstance Win32_Process -Filter "ProcessId = $tunnelProcessId"
 $tunnelActive=$tunnelExisting -and $tunnelExisting.ExecutablePath -eq $tunnelExe -and $tunnelExisting.CommandLine -match [regex]::Escape($tunnelTokenFile)
}
if (-not $tunnelActive) {
 $tunnelProcess=Start-Process -FilePath $tunnelExe -ArgumentList @('--no-autoupdate','tunnel','--protocol','auto','--metrics','127.0.0.1:20245','run','--token-file',$tunnelTokenFile) -WorkingDirectory $publicRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $publicRuntime 'tunnel.stdout.log') -RedirectStandardError (Join-Path $publicRuntime 'tunnel.stderr.log') -PassThru
 Set-Content -LiteralPath (Join-Path $publicRuntime 'tunnel.pid') -Value $tunnelProcess.Id
}
if (-not $NoBrowser) { Start-Process $publicConfig.origin }
Write-Output $publicConfig.origin
