# gemma-master-autofwd-task.ps1 -- manage the Windows Scheduled Task that keeps
# the gemma-master-autofwd daemon alive across reboots and terminal closes.
#
# Usage:
#   powershell -File scripts\gemma-master-autofwd-task.ps1 install
#   powershell -File scripts\gemma-master-autofwd-task.ps1 uninstall
#   powershell -File scripts\gemma-master-autofwd-task.ps1 status
#   powershell -File scripts\gemma-master-autofwd-task.ps1 restart

param(
  [Parameter(Mandatory)][ValidateSet('install','uninstall','status','restart')]
  [string]$Action
)

$TASK_NAME   = "gemma-master-autofwd"
$SERVING_DIR = "B:\M\gemma-architect-master"
$SCRIPT_PATH = "$SERVING_DIR\scripts\gemma-master-autofwd.mjs"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $NODE_EXE = $nodeCmd.Source
} else {
  $NODE_EXE = "C:\nvm4w\nodejs\node.exe"
}

function Install-Task {
  if (-not (Test-Path $SCRIPT_PATH)) {
    Write-Error "Script not found: $SCRIPT_PATH -- is gemma-architect-master checked out?"
    exit 1
  }

  $action  = New-ScheduledTaskAction `
    -Execute $NODE_EXE `
    -Argument "`"$SCRIPT_PATH`"" `
    -WorkingDirectory $SERVING_DIR

  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit 0 `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

  Register-ScheduledTask `
    -TaskName $TASK_NAME `
    -Action   $action `
    -Trigger  $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Force | Out-Null

  if ($LASTEXITCODE -ne 0 -and -not $?) {
    Write-Error "Registration failed. Try running from an elevated prompt."
    exit 1
  }

  Write-Host "INSTALLED: task '$TASK_NAME' registered (at-logon, current user)"
  Write-Host "  node:   $NODE_EXE"
  Write-Host "  script: $SCRIPT_PATH"
  Write-Host "  cwd:    $SERVING_DIR"
  Write-Host ""
  Write-Host "Start immediately: Start-ScheduledTask -TaskName '$TASK_NAME'"
}

function Uninstall-Task {
  if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask  -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Write-Host "UNINSTALLED: task '$TASK_NAME' removed"
  } else {
    Write-Host "NOT FOUND: task '$TASK_NAME' was not registered"
  }
}

function Get-TaskStatus {
  $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "STATUS: not installed"
    return
  }

  $info = Get-ScheduledTaskInfo -TaskName $TASK_NAME
  Write-Host "STATUS: $($task.State)"
  Write-Host "  Last run:    $($info.LastRunTime)"
  Write-Host "  Last result: $($info.LastTaskResult) (0 = still running / success)"
  Write-Host "  Next run:    $($info.NextRunTime)"

  $hb = "$SERVING_DIR\state\gemma-master-autofwd.heartbeat"
  if (Test-Path $hb) {
    $age = [int]((Get-Date) - (Get-Item $hb).LastWriteTime).TotalSeconds
    if ($age -lt 60) {
      Write-Host "  Heartbeat:   FRESH ($($age)s)"
    } else {
      Write-Host "  Heartbeat:   STALE ($($age)s) -- daemon may be down"
    }
  } else {
    Write-Host "  Heartbeat:   not found (daemon not yet started)"
  }
}

function Restart-Task {
  Stop-ScheduledTask  -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TASK_NAME
  Write-Host "RESTARTED: '$TASK_NAME'"
  Start-Sleep 3
  Get-TaskStatus
}

switch ($Action) {
  'install'   { Install-Task }
  'uninstall' { Uninstall-Task }
  'status'    { Get-TaskStatus }
  'restart'   { Restart-Task }
}
