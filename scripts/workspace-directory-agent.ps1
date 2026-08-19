# Workspace Digital Directory Agent (reference template)
#
# This is the same script generated per-deployment by Settings > Integrations > Workspace
# Directory Agent > "Download Install Script" (see buildWorkspaceDirectoryAgentScript() in
# src/pages/settings.js), with the real Supabase URL/anon key and the current shared secret baked
# in. Kept here for review/version-control visibility - don't run THIS copy as-is, since
# $AgentSecret below is a placeholder; download the real one from Settings so it's yours.
#
# Collects basic PC inventory and checks in with the Hypermedia Operations Dashboard every 15
# minutes via a scheduled task. Re-run (the downloaded, real copy) any time to update the install.

param([switch]$Once)

$CheckinUrl = "<SUPABASE_URL>/functions/v1/workspace-directory-checkin"
$AgentSecret = "<GENERATED_IN_SETTINGS>"
$AnonKey = "<SUPABASE_ANON_KEY>"
$TaskName = "WorkspaceDirectoryAgent"

# Self-elevate if not already running as Administrator (needed to register the SYSTEM-level task).
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Once -and -not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

function Get-AnyDeskId {
    $paths = @(
        "$env:ProgramData\AnyDesk\service.conf",
        "$env:ProgramData\AnyDesk\system.conf",
        "$env:APPDATA\AnyDesk\user.conf"
    )
    foreach ($path in $paths) {
        if (Test-Path $path) {
            $content = Get-Content -Path $path -ErrorAction SilentlyContinue
            $match = $content | Select-String -Pattern "ad.anynet.id=(\d+)"
            if ($match) { return $match.Matches[0].Groups[1].Value }
        }
    }
    return $null
}

function Get-PrimaryIPv4 {
    try {
        return Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback' } |
            Select-Object -First 1 -ExpandProperty IPAddress
    } catch { return $null }
}

function Get-InstalledSoftware {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $items = foreach ($key in $keys) {
        Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName } |
            Select-Object @{n='name';e={$_.DisplayName}}, @{n='version';e={$_.DisplayVersion}}
    }
    $items | Sort-Object name -Unique
}

function Invoke-Checkin {
    $os = Get-CimInstance Win32_OperatingSystem
    $payload = @{
        hostname     = $env:COMPUTERNAME
        ip           = Get-PrimaryIPv4
        anydeskId    = Get-AnyDeskId
        os           = $os.Caption
        osVersion    = $os.Version
        loggedInUser = (Get-CimInstance Win32_ComputerSystem).UserName
        software     = @(Get-InstalledSoftware)
        agentVersion = "1.0"
    } | ConvertTo-Json -Depth 4 -Compress

    try {
        Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $payload -ContentType "application/json" `
            -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 20 | Out-Null
        Write-Host "Checked in successfully."
    } catch {
        Write-Warning "Check-in failed: $($_.Exception.Message)"
    }
}

if (-not $Once) {
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Once"
    $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration ([TimeSpan]::MaxValue)
    $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    try {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal | Out-Null
        } else {
            Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Description "Reports this PC's inventory to the Hypermedia Operations Dashboard." | Out-Null
        }
        Write-Host "Scheduled task '$TaskName' installed (runs every 15 minutes)." -ForegroundColor Green
    } catch {
        Write-Warning "Could not register the scheduled task: $($_.Exception.Message)"
    }
}

Invoke-Checkin
