param(
    [Parameter(Mandatory=$true)][string]$LocalAddress,
    [Parameter(Mandatory=$true)][string]$RemoteSubnet,
    [Parameter(Mandatory=$true)][string]$InterfaceAlias,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [ValidateRange(1024,65535)][int]$Port=8088
)
$ErrorActionPreference='Stop'
$firewallLog=Join-Path $PSScriptRoot '.runtime\lan-firewall-result.json'
try {
    $ipCheck=$null
    if (-not [Net.IPAddress]::TryParse($LocalAddress,[ref]$ipCheck)) { throw 'Invalid local address' }
    if ($RemoteSubnet -notmatch '^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$') { throw 'Invalid remote subnet' }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node executable not found' }
    $ruleName='Qianchuan-Readonly-LAN-8088'
    $rule=Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
        Set-NetFirewallRule -Name $ruleName -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort $Port -LocalAddress $LocalAddress -RemoteAddress $RemoteSubnet -InterfaceAlias $InterfaceAlias -Program $NodePath | Out-Null
    } else {
        New-NetFirewallRule -Name $ruleName -DisplayName 'Qianchuan LAN read-only preview (TCP 8088)' -Description 'Only the saved read-only HTML preview; no Qianchuan account operations or pairing API.' -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort $Port -LocalAddress $LocalAddress -RemoteAddress $RemoteSubnet -InterfaceAlias $InterfaceAlias -Program $NodePath | Out-Null
    }
    @{success=$true;rule=$ruleName;localAddress=$LocalAddress;remoteSubnet=$RemoteSubnet;port=$Port} | ConvertTo-Json | Set-Content -LiteralPath $firewallLog -Encoding UTF8
    exit 0
} catch {
    @{success=$false;message=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $firewallLog -Encoding UTF8
    exit 1
}
