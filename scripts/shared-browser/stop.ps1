# scripts/shared-browser/stop.ps1
# Cleanly stop the shared Chromium session and remove cdp.json.
#
# Usage: bun scripts/shared-browser/stop.ps1
#   (or) powershell -File scripts/shared-browser/stop.ps1

$CDP_PORT = 9222
$CDP_JSON = "B:\M\gemma-architect-master\.shared-browser\cdp.json"

$pid_to_kill = $null

# Read PID from cdp.json if it exists
if (Test-Path $CDP_JSON) {
    try {
        $data = Get-Content $CDP_JSON -Raw | ConvertFrom-Json
        $pid_to_kill = $data.pid
    } catch {
        Write-Warning "Could not parse cdp.json — will scan by port."
    }
}

# Fallback: scan running Chrome processes for our CDP port
if (-not $pid_to_kill) {
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -like "*remote-debugging-port=$CDP_PORT*" }
    $pid_to_kill = $procs | Select-Object -First 1 -ExpandProperty ProcessId
}

if ($pid_to_kill) {
    Write-Host "Stopping Chrome PID $pid_to_kill..."
    Stop-Process -Id $pid_to_kill -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    # Kill any child Chrome processes that may linger
    $children = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -like "*remote-debugging-port=$CDP_PORT*" }
    foreach ($p in $children) {
        Write-Host "Killing lingering Chrome PID $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Chrome stopped."
} else {
    Write-Host "No Chrome with --remote-debugging-port=$CDP_PORT found — nothing to stop."
}

# Remove cdp.json
if (Test-Path $CDP_JSON) {
    Remove-Item $CDP_JSON -Force
    Write-Host "Removed: $CDP_JSON"
}
