# scripts/shared-browser/start.ps1
# Launch a persistent headed Chromium at the configured dev URL with CDP on the configured port.
# Idempotent: if CDP_PORT already answers, writes cdp.json and exits without spawning a new Chrome.
#
# Usage: powershell -File scripts/shared-browser/start.ps1
#
# Output: B:\M\gemma-architect-master\.shared-browser\cdp.json
#   { "endpoint": "<webSocketDebuggerUrl>", "started_at": "<ISO>", "pid": <int> }

param([switch]$Force)

$CDP_PORT      = if ($env:CDP_PORT) { [int]$env:CDP_PORT } else { 9222 }
$DEV_PORT      = if ($env:DEV_PORT) { $env:DEV_PORT } else { '5847' }
$DEV_URL       = "http://localhost:$DEV_PORT/"
$ChromeDataDir = "B:\M\gemma-architect-master\.shared-browser\profile"
$CDP_JSON      = "B:\M\gemma-architect-master\.shared-browser\cdp.json"

# --- Locate Playwright bundled Chromium ---
$MS_PW    = "$env:LOCALAPPDATA\ms-playwright"
$ChromeExe = $null
$candidates = Get-ChildItem "$MS_PW\chromium-*\chrome-win64\chrome.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
if ($candidates) {
    $ChromeExe = $candidates[0].FullName
}
if (-not $ChromeExe) {
    Write-Error "Playwright Chromium not found under $MS_PW. Run: bunx playwright install chromium"
    exit 1
}
Write-Host "Chromium: $ChromeExe"

# --- Check idempotency ---
if (-not $Force) {
    $alreadyUp = $false
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 3 -ErrorAction Stop
        $wsUrl = $resp.webSocketDebuggerUrl
        if ($wsUrl) { $alreadyUp = $true }
    } catch { }

    if ($alreadyUp) {
        $pidProc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
            Where-Object { $_.CommandLine -like "*remote-debugging-port=$CDP_PORT*" } |
            Select-Object -First 1
        $pidVal = if ($pidProc) { [int]$pidProc.ProcessId } else { 0 }
        $data = '{"endpoint":"' + $wsUrl + '","started_at":"' + (Get-Date -Format "o") + '","pid":' + $pidVal + '}'
        New-Item -ItemType Directory -Path (Split-Path $CDP_JSON) -Force | Out-Null
        [System.IO.File]::WriteAllText($CDP_JSON, $data, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Already up - cdp.json updated: $CDP_JSON"
        Write-Host "endpoint: $wsUrl"
        exit 0
    }
}

# --- Kill any stale Chrome holding the CDP port ---
$staleProcs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*remote-debugging-port=$CDP_PORT*" }
foreach ($p in $staleProcs) {
    Write-Host "Killing stale Chrome PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

# --- Ensure directories exist ---
New-Item -ItemType Directory -Path $ChromeDataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $CDP_JSON) -Force | Out-Null

# --- Launch Chromium ---
$chromeArgs = @(
    "--remote-debugging-port=$CDP_PORT",
    "--user-data-dir=$ChromeDataDir",
    "--no-default-browser-check",
    "--disable-features=CalculateNativeWinOcclusion",
    $DEV_URL
)
Write-Host "Launching Chromium..."
$proc = Start-Process -FilePath $ChromeExe -ArgumentList $chromeArgs -PassThru
Write-Host "Chrome PID: $($proc.Id)"

# --- Poll for CDP readiness (max 15s) ---
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$wsUrl = $null
while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 2 -ErrorAction Stop
        if ($resp.webSocketDebuggerUrl) {
            $wsUrl = $resp.webSocketDebuggerUrl
            break
        }
    } catch { }
}

if (-not $wsUrl) {
    Write-Error "Chrome did not expose CDP on port $CDP_PORT within 15 seconds. PID=$($proc.Id)"
    exit 1
}

# --- Write cdp.json (no BOM — PS5.1 Set-Content -Encoding utf8 adds BOM) ---
$data = '{"endpoint":"' + $wsUrl + '","started_at":"' + (Get-Date -Format "o") + '","pid":' + $proc.Id + '}'
[System.IO.File]::WriteAllText($CDP_JSON, $data, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "Shared browser is up."
Write-Host "  endpoint : $wsUrl"
Write-Host "  pid      : $($proc.Id)"
Write-Host "  cdp.json : $CDP_JSON"
Write-Host "  profile  : $ChromeDataDir"

# --- Start periodic tab sweep (every 10 min) — one instance only ---
$SweepScript = Join-Path $PSScriptRoot "..\shared-browser-watch.mjs"
$SweepScript = [System.IO.Path]::GetFullPath($SweepScript)
if (Test-Path $SweepScript) {
    # Kill any stale watcher instances before starting a fresh one.
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -like "*shared-browser-watch*"
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath "node" -ArgumentList $SweepScript -WindowStyle Hidden
    Write-Host "  tab-sweep: started (10 min interval)"
} else {
    Write-Host "  tab-sweep: script not found at $SweepScript (skipped)"
}
