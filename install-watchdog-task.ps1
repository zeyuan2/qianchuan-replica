[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$TaskName='Qianchuan-Workbench-Watchdog')
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$taskRuntime=Join-Path $taskRoot '.runtime'
$taskScript=Join-Path $taskRoot 'watch-services.ps1'
$taskShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if(-not(Test-Path -LiteralPath (Join-Path $taskRuntime 'watchdog-config.json'))){throw 'Initialize the workbench launchers before installing supervision.'}
if(-not(Test-Path -LiteralPath $taskScript)){throw 'Watchdog script is missing.'}
$existing=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if($existing -and (@($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ne $taskShell -or $existing.Actions[0].Arguments -notlike ('*"'+$taskScript+'"*'))){throw 'Task name belongs to a different program; no changes made.'}
$action=New-ScheduledTaskAction -Execute $taskShell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$taskScript+'"') -WorkingDirectory $taskRoot
$principal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$logon=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -Priority 6
$definition=New-ScheduledTask -Action $action -Trigger @($logon,$repeat) -Principal $principal -Settings $settings -Description 'Independent Qianchuan watchdog: login startup, minute retry, single instance. Requires the current user session for Chrome collection.'
if(-not $PSCmdlet.ShouldProcess($TaskName,'Register current-user watchdog task')){return}
if($existing){[IO.File]::WriteAllText((Join-Path $taskRuntime 'watchdog-task.previous.xml'),(Export-ScheduledTask -TaskName $TaskName -TaskPath '\'),[Text.UTF8Encoding]::new($false))}
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -InputObject $definition -Force | Out-Null
$installed=Get-ScheduledTask -TaskName $TaskName -TaskPath '\'
if($installed.Actions[0].Arguments -notlike ('*"'+$taskScript+'"*')){throw 'Installed task verification failed.'}
$marker=@{taskName=$TaskName;taskPath='\';script=$taskScript;installedAt=[DateTimeOffset]::Now.ToString('o');logonType='Interactive';intervalSeconds=60}
$markerTemp=Join-Path $taskRuntime 'watchdog-task.json.tmp'
[IO.File]::WriteAllText($markerTemp,($marker|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $markerTemp -Destination (Join-Path $taskRuntime 'watchdog-task.json') -Force
# Do not terminate the existing watchdog or any business service here. The owner
# can hand off the verified watchdog process, then start this task explicitly.
Write-Output ('Installed '+$TaskName+' for '+$taskUser+'.')
