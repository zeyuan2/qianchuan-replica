param([switch]$NoBrowser,[switch]$SkipFirewall)
$ErrorActionPreference='Stop'
$lanRoot=$PSScriptRoot
$lanPort=8088
$lanRuntime=Join-Path $lanRoot '.runtime'
New-Item -ItemType Directory -Path $lanRuntime -Force | Out-Null
& (Join-Path $lanRoot 'start-web.ps1') -NoBrowser | Out-Null
$lanConfig=Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' } | Sort-Object InterfaceIndex | Select-Object -First 1
if (-not $lanConfig) { throw '未找到可用的内网IPv4地址。' }
$lanAddress=[string]($lanConfig.IPv4Address | Select-Object -First 1).IPAddress
$lanPrefix=(Get-NetIPAddress -InterfaceIndex $lanConfig.InterfaceIndex -AddressFamily IPv4 | Where-Object IPAddress -eq $lanAddress | Select-Object -First 1).PrefixLength
$lanBytes=([Net.IPAddress]::Parse($lanAddress)).GetAddressBytes()
for ($lanByte=0; $lanByte -lt 4; $lanByte++) {
    $lanBits=[Math]::Min(8,[Math]::Max(0,$lanPrefix-8*$lanByte))
    $lanMask=(255 -shl (8-$lanBits)) -band 255
    $lanBytes[$lanByte]=$lanBytes[$lanByte] -band $lanMask
}
$lanSubnet=($lanBytes -join '.')+'/'+$lanPrefix
$lanUrl="http://${lanAddress}:$lanPort"
$lanNode=(Get-Command node -ErrorAction Stop).Source
$lanStatus=$null
try { $lanStatus=Invoke-RestMethod -Uri "$lanUrl/healthz" -TimeoutSec 2 } catch {}
if ($lanStatus -and $lanStatus.service -ne 'qianchuan-lan-preview') { throw '8088端口正在被其他服务使用。' }
if (-not $lanStatus) {
    if (Get-NetTCPConnection -LocalPort $lanPort -State Listen -ErrorAction SilentlyContinue) { throw '8088端口已被占用，请先检查已有服务。' }
    $env:LAN_HOST=$lanAddress
    $env:LAN_PORT=[string]$lanPort
    $lanProcess=Start-Process -FilePath $lanNode -ArgumentList @('lan-server.mjs') -WorkingDirectory $lanRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $lanRuntime 'lan.stdout.log') -RedirectStandardError (Join-Path $lanRuntime 'lan.stderr.log') -PassThru
    Set-Content -LiteralPath (Join-Path $lanRuntime 'lan.pid') -Value $lanProcess.Id
    for ($lanAttempt=0; $lanAttempt -lt 20; $lanAttempt++) {
        Start-Sleep -Milliseconds 250
        try { $lanStatus=Invoke-RestMethod -Uri "$lanUrl/healthz" -TimeoutSec 1; break } catch {}
    }
    if (-not $lanStatus) { throw '内网页面启动失败，请查看.runtime中的lan日志。' }
}
$lanFirewallReady=$false
if (-not $SkipFirewall) {
    $lanRule=Get-NetFirewallRule -Name 'Qianchuan-Readonly-LAN-8088' -ErrorAction SilentlyContinue
    if ($lanRule -and $lanRule.Enabled -eq 'True') {
        $lanScope=$lanRule | Get-NetFirewallAddressFilter
        $lanPorts=$lanRule | Get-NetFirewallPortFilter
        $lanApp=$lanRule | Get-NetFirewallApplicationFilter
        $lanFirewallReady=($lanScope.LocalAddress -contains $lanAddress) -and ($lanScope.RemoteAddress -contains $lanSubnet) -and ($lanPorts.LocalPort -contains "$lanPort") -and ($lanApp.Program -eq $lanNode)
    }
    if (-not $lanFirewallReady) {
        $lanArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $lanRoot 'enable-lan-firewall.ps1')+'"'),'-LocalAddress',$lanAddress,'-RemoteSubnet',$lanSubnet,'-InterfaceAlias',('"'+$lanConfig.InterfaceAlias+'"'),'-NodePath',('"'+$lanNode+'"'),'-Port',"$lanPort")
        Write-Output 'Windows防火墙需要管理员确认，仅放行当前内网到TCP 8088的只读页面。'
        try {
            $lanElevated=Start-Process -FilePath 'powershell.exe' -ArgumentList $lanArgs -Verb RunAs -WindowStyle Hidden -PassThru -Wait
            if ($lanElevated.ExitCode -ne 0) { throw '防火墙配置未完成。' }
            $lanFirewallReady=$true
        } catch { Write-Warning ('内网页面已启动，但防火墙放行未完成：'+$_.Exception.Message) }
    }
}
@{url=$lanUrl;address=$lanAddress;subnet=$lanSubnet;interface=$lanConfig.InterfaceAlias;port=$lanPort;firewallReady=$lanFirewallReady} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lanRuntime 'lan-status.json') -Encoding UTF8
Set-Content -LiteralPath (Join-Path $lanRoot '内网访问地址.txt') -Value @("内网只读预览：$lanUrl/","允许访问的本地子网：$lanSubnet",'每5分钟完整采集商品自选计划；请保持采集Chrome已登录且只读扩展连接。','电脑重启后双击“打开内网网页版.cmd”重新启动。','电脑需要保持开机并连接内网；IP变化后以重新生成的地址为准。','数据位置：D:\qianchuan-replica\data') -Encoding UTF8
if (-not $NoBrowser) { Start-Process "$lanUrl/" }
Write-Output "$lanUrl/"
