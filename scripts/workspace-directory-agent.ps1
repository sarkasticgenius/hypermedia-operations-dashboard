# Digital Directory Agent (reference template)
#
# This is the same script generated per-deployment by Settings > Integrations > Digital Directory
# Agent > "Download Install Script" (see buildWorkspaceDirectoryAgentScript() in
# src/pages/settings.js), with the real Supabase URL/anon key and the current shared secret baked
# in. Kept here for review/version-control visibility - don't run THIS copy as-is, since
# $AgentSecret below is a placeholder; download the real one from Settings so it's yours.
#
# Collects PC inventory and checks in with the Hypermedia Operations Dashboard every 6 hours via a
# scheduled task - deliberately infrequent, since several of these PCs run on metered cellular SIM
# data rather than broadband. What gets collected is fetched fresh from the dashboard on every run
# (Settings > Integrations > Digital Directory Agent > Data Collector Script) - this outer shell
# itself never needs to change or be re-installed to pick up a new field. Re-run this script any
# time to update the install (e.g. after rotating the secret).

param([switch]$Once)

$CheckinUrl = "<SUPABASE_URL>/functions/v1/workspace-directory-checkin"
$CollectorUrl = "<SUPABASE_URL>/functions/v1/workspace-directory-collector"
$AgentSecret = "<GENERATED_IN_SETTINGS>"
$AnonKey = "<SUPABASE_ANON_KEY>"
$TaskName = "WorkspaceDirectoryAgent"
$StateDir = "$env:ProgramData\WorkspaceDirectoryAgent"
$PendingResultFile = Join-Path $StateDir "pending-command-result.json"

# Self-elevate if not already running as Administrator (needed to register the SYSTEM-level task).
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Once -and -not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

# Invoke-DefaultCollector's body is identical to defaultCollectorScript() in src/pages/settings.js
# (the same text pre-filled into the Data Collector Script textarea) - see that function for the
# authoritative, always-current copy rather than duplicating ~150 lines of PowerShell here.
function Invoke-DefaultCollector {
    # ... hostname/IP/AnyDesk/TeamViewer/OS/software/volumes/components/antivirus/problems/
    # networkBytesTotal collection - see src/pages/settings.js's defaultCollectorScript() ...
}

function Get-RemoteCollectorScript {
    try {
        $resp = Invoke-RestMethod -Method Get -Uri $CollectorUrl -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15
        if ($resp -and $resp.script) { return $resp.script }
    } catch {
        Write-Warning "Could not fetch remote collector script, using built-in default: $($_.Exception.Message)"
    }
    return $null
}

# Runs an admin-queued command locally and caches its output to report on the NEXT check-in,
# rather than opening a second connection just to report it now.
function Invoke-PendingCommand($command) {
    try {
        $output = Invoke-Expression $command 2>&1 | Out-String
    } catch {
        $output = "ERROR: $($_.Exception.Message)"
    }
    New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
    @{ output = $output.Substring(0, [Math]::Min(8000, $output.Length)); ranAt = (Get-Date).ToString("o") } |
        ConvertTo-Json | Set-Content -Path $PendingResultFile -Encoding utf8
}

function Invoke-Checkin {
    $remoteScript = Get-RemoteCollectorScript
    $data = $null
    if ($remoteScript) {
        try {
            $data = & ([ScriptBlock]::Create($remoteScript))
        } catch {
            Write-Warning "Remote collector script failed, falling back to built-in default: $($_.Exception.Message)"
        }
    }
    if (-not $data) { $data = Invoke-DefaultCollector }

    # A previous cycle's command result, if one is waiting locally - reported on this check-in,
    # then removed so it isn't sent again next time.
    if (Test-Path $PendingResultFile) {
        try {
            $cached = Get-Content -Path $PendingResultFile -Raw | ConvertFrom-Json
            if ($cached.output) { $data.commandOutput = $cached.output }
            Remove-Item -Path $PendingResultFile -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Could not read cached command result: $($_.Exception.Message)" }
    }

    $payload = $data | ConvertTo-Json -Depth 6 -Compress
    try {
        $response = Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $payload -ContentType "application/json" `
            -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30
        Write-Host "Checked in successfully."
        if ($response -and $response.pendingCommand) {
            Write-Host "Running queued command..."
            Invoke-PendingCommand $response.pendingCommand
        }
    } catch {
        Write-Warning "Check-in failed: $($_.Exception.Message)"
    }
}

if (-not $Once) {
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Once"
    $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration ([TimeSpan]::MaxValue)
    $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    try {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal | Out-Null
        } else {
            Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Description "Reports this PC's inventory to the Hypermedia Operations Dashboard." | Out-Null
        }
        Write-Host "Scheduled task '$TaskName' installed (runs every 6 hours)." -ForegroundColor Green
    } catch {
        Write-Warning "Could not register the scheduled task: $($_.Exception.Message)"
    }
}

Invoke-Checkin
