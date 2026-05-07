# scripts/shared-browser/start.ps1
# Launch a persistent headed Chromium at http://localhost:5175/ with CDP on port 9222.
# Idempotent: if 9222 already answers, writes cdp.json and exits without spawning a new Chrome.
#
# Usage: bun scripts/shared-browser/start.ps1
#   (or) powershell -File scripts/shared-browser/start.ps1
#
# Output: B:\M\gemma-architect-master\.shared-browser\cdp.json
#   { "endpoint": "<webSocketDebuggerUrl>", "started_at": "<ISO>", "pid": <int> }
#
# After start, any Playwright runner (gemma-verify, agent teams) can connect via
# chromium.connectOverCDP(endpoint) instead of launching their own browser.

param(
    [switch]$Force  # Kill existing Chrome and relaunch even if 9222 is already up
)

$CDP_PORT = 9222
$DEV_URL  = "http://localhost:5175/"
$PROFILE  = "B:\M\gemma-architect-master\.shared-browser\profile"
$CDP_JSON = "B:\M\gemma-architect-master\.shared-browser\cdp.json"

# --- Locate Playwright bundled Chromium ---
$MS_PW = "$env:LOCALAPPDATA\ms-playwright"
$CHROME = Get-ChildItem "$MS_PW\chromium-*\chrome-win64\chrome.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $CHROME) {
    Write-Error "Playwright Chromium not found under $MS_PW. Run: bunx playwright install chromium"
    exit 1
}
Write-Host "Chromium: $CHROME"

# --- Check idempotency ---
if (-not $Force) {
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 3 -ErrorAction Stop
        $ws   = $resp.webSocketDebuggerUrl
        if ($ws) {
            # Already up — refresh cdp.json and exit
            $pid_check = (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
                Where-Object { $_.CommandLine -like "*remote-debugging-port=$CDP_PORT*" } |
                Select-Object -First 1).ProcessId
            $data = @{
                endpoint   = $ws
                started_at = (Get-Date -Format "o")
                pid        = [int]($pid_check ?? 0)
            } | ConvertTo-Json -Compress
            New-Item -ItemType Directory -Path (Split-Path $CDP_JSON) -Force | Out-Null
            $data | Set-Content -Path $CDP_JSON -Encoding utf8
            Write-Host "Already up — cdp.json updated: $CDP_JSON"
            Write-Host "endpoint: $ws"
            exit 0
        }
    } catch { }
}

# --- Kill any stale Chrome holding the CDP port ---
$stale = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*remote-debugging-port=$CDP_PORT*" }
foreach ($p in $stale) {
    Write-Host "Killing stale Chrome PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

# --- Ensure profile directory exists ---
New-Item -ItemType Directory -Path $PROFILE -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $CDP_JSON) -Force | Out-Null

# --- Launch Chromium ---
$args = @(
    "--remote-debugging-port=$CDP_PORT",
    "--user-data-dir=$PROFILE",
    "--no-default-browser-check",
    "--disable-features=CalculateNativeWinOcclusion",
    $DEV_URL
)
Write-Host "Launching Chromium..."
$proc = Start-Process -FilePath $CHROME -ArgumentList $args -PassThru
Write-Host "Chrome PID: $($proc.Id)"

# --- Poll for CDP readiness (max 15s) ---
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$ws = $null
while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 2 -ErrorAction Stop
        $ws   = $resp.webSocketDebuggerUrl
        if ($ws) { break }
    } catch { }
}

if (-not $ws) {
    Write-Error "Chrome did not expose CDP on port $CDP_PORT within 15 seconds. PID=$($proc.Id)"
    exit 1
}

# --- Write cdp.json ---
$data = @{
    endpoint   = $ws
    started_at = (Get-Date -Format "o")
    pid        = [int]$proc.Id
} | ConvertTo-Json -Compress
$data | Set-Content -Path $CDP_JSON -Encoding utf8

Write-Host ""
Write-Host "Shared browser is up."
Write-Host "  endpoint : $ws"
Write-Host "  pid      : $($proc.Id)"
Write-Host "  cdp.json : $CDP_JSON"
Write-Host "  profile  : $PROFILE"
