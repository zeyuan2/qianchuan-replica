# Pure recovery policy plus a bounded loopback health probe. No account actions.
function Get-TunnelHealth {
 param([int]$TimeoutSeconds=2)
 try {
  $reply=Invoke-RestMethod -Uri 'http://127.0.0.1:20245/ready' -TimeoutSec $TimeoutSeconds -ErrorAction Stop
  $connections=0
  $valid=[int]::TryParse([string]$reply.readyConnections,[ref]$connections)
  return @{ready=($reply.status -eq 200 -and $valid -and $connections -gt 0);status=[int]$reply.status;connections=$connections}
 } catch {
  $status=0;try{$status=[int]$_.Exception.Response.StatusCode}catch{}
  return @{ready=$false;status=$status;connections=0}
 }
}
function Get-TunnelRecoveryDecision {
 param($Previous,[int]$ProcessId,[double]$AgeSeconds,[bool]$Ready,[DateTimeOffset]$Now=[DateTimeOffset]::Now)
 $failures=0
 if($Previous -and $Previous.pid -eq $ProcessId){[void][int]::TryParse([string]$Previous.failures,[ref]$failures)}
 $first=$null;$next=$null
 try{if($Previous -and $Previous.pid -eq $ProcessId -and $Previous.firstFailureAt){$first=[DateTimeOffset]::Parse([string]$Previous.firstFailureAt)}}catch{}
 try{if($Previous -and $Previous.nextRestartAt){$next=[DateTimeOffset]::Parse([string]$Previous.nextRestartAt)}}catch{}
 $state=@{pid=$ProcessId;failures=[Math]::Max(0,$failures);firstFailureAt=$null;nextRestartAt=if($next){$next.ToString('o')}else{$null};checkedAt=$Now.ToString('o')}
 if($Ready){$state.failures=0;return @{action='healthy';state=$state}}
 if($AgeSeconds -lt 90){$state.failures=0;return @{action='startup_grace';state=$state}}
 if(-not $first){$first=$Now};$state.firstFailureAt=$first.ToString('o');$state.failures=[Math]::Min(1000,$state.failures+1)
 if($next -and $Now -lt $next){return @{action='cooldown';state=$state}}
 if($state.failures -ge 3 -and ($Now-$first).TotalSeconds -ge 40){$state.nextRestartAt=$Now.AddMinutes(5).ToString('o');$state.failures=0;$state.firstFailureAt=$null;return @{action='restart';state=$state}}
 return @{action='observe';state=$state}
}
