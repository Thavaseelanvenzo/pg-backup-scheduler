# ---------------------------------------------------------------------------
# Local Windows scheduled-task wrapper for pg_backup.js
#
# NOT part of the container/Coolify path. pg_backup.js reads its settings
# from real environment variables only (there is no dotenv dependency), and
# Task Scheduler starts a process with none of them set -- so this wrapper
# loads .env, applies the two local-only overrides, and then runs the
# unmodified backup command.
#
# Registered as the twice-daily 05:15 / 17:15 task "pg-backup-scheduler".
# Run it by hand any time to reproduce exactly what the schedule does:
#     powershell -NoProfile -ExecutionPolicy Bypass -File run_backup_local.ps1
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSCommandPath
Set-Location $ProjectDir

$NodeExe = 'C:\Program Files\nodejs\node.exe'
$PgBinDir = 'C:\Program Files\PostgreSQL\17\bin'
$TaskLog = Join-Path $ProjectDir 'staging\logs\scheduled-task.log'

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TaskLog) | Out-Null

function Write-TaskLog($message) {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $TaskLog -Encoding utf8 -Value "[$stamp UTC] [task] $message"
}

Write-TaskLog 'scheduled run starting'

# --- load .env into the process environment -------------------------------
$EnvFile = Join-Path $ProjectDir '.env'
if (-not (Test-Path $EnvFile)) {
    Write-TaskLog "FATAL: $EnvFile not found; cannot supply credentials"
    exit 2
}

foreach ($line in Get-Content $EnvFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $split = $trimmed.IndexOf('=')
    if ($split -lt 1) { continue }
    $name = $trimmed.Substring(0, $split).Trim()
    $value = $trimmed.Substring($split + 1).Trim()
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

# --- local-only overrides -------------------------------------------------
# .env carries STAGING_DIR=/app/staging, which is the container's volume
# mount and not a valid Windows path. pg_dump also is not on the Task
# Scheduler PATH, so point at it explicitly.
$env:STAGING_DIR = Join-Path $ProjectDir 'staging'
$env:PATH = "$PgBinDir;$env:PATH"

if (-not (Test-Path $NodeExe)) {
    Write-TaskLog "FATAL: node not found at $NodeExe"
    exit 2
}

# --- run the real backup --------------------------------------------------
# stdout/stderr are appended here as well as to the script's own
# staging\logs\backup.log, so a crash before logging starts is still visible.
# NOTE: Tee-Object on Windows PowerShell 5.1 writes UTF-16LE, which turns
# this log into mojibake for every UTF-8 reader. Append line by line with an
# explicit encoding instead, and pass the line through so stdout is intact.
& $NodeExe 'pg_backup.js' 2>&1 | ForEach-Object {
    $line = [string]$_
    Add-Content -Path $TaskLog -Encoding utf8 -Value $line
    $line
}
$code = $LASTEXITCODE

if ($code -eq 0) {
    Write-TaskLog 'scheduled run finished: SUCCESS (uploaded and verified)'
} else {
    Write-TaskLog "scheduled run finished: FAILED (exit $code) -- see backup.log"
}
exit $code
