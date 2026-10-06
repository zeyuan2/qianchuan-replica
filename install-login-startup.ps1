param()
$ErrorActionPreference='Stop'
$loginScript=Join-Path $PSScriptRoot 'start-at-login.ps1'
if(-not(Test-Path -LiteralPath $loginScript)){throw 'Startup script is missing.'}
$loginDirectory=[Environment]::GetFolderPath('Startup')
if(-not $loginDirectory){throw 'Current-user Startup folder is unavailable.'}
$loginShortcut=Join-Path $loginDirectory 'Qianchuan Workbench.lnk'
$loginShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut($loginShortcut)
if((Test-Path -LiteralPath $loginShortcut) -and ($link.TargetPath -ne $loginShell -or $link.Arguments -notlike ('*'+$loginScript+'*'))){throw 'A different startup item already uses this name.'}
$link.TargetPath=$loginShell
$link.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$loginScript+'"'
$link.WorkingDirectory=$PSScriptRoot
$link.WindowStyle=7
$link.Description='Start Qianchuan workbench, tunnel and health recorder after Windows sign-in.'
$link.Save()
Write-Output $loginShortcut
