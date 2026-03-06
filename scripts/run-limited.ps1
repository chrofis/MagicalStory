# Launches a Python script with a memory limit using Windows Job Objects
# Usage: powershell -File scripts/run-limited.ps1 -Script "my_script.py" -MaxMemoryGB 8
#
# If the script exceeds the memory limit, Windows will terminate it
# instead of letting it crash the whole system.

param(
    [Parameter(Mandatory=$true)]
    [string]$Script,

    [Parameter(Mandatory=$false)]
    [int]$MaxMemoryGB = 8,

    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$ScriptArgs
)

$maxBytes = [int64]$MaxMemoryGB * 1GB

Write-Host "Starting '$Script' with ${MaxMemoryGB}GB memory limit..." -ForegroundColor Cyan

$argString = if ($ScriptArgs) { $ScriptArgs -join ' ' } else { '' }
$process = Start-Process -FilePath "python" -ArgumentList "$Script $argString" -PassThru -NoNewWindow

# Monitor memory usage
while (-not $process.HasExited) {
    $process.Refresh()
    $memUsed = $process.WorkingSet64
    $memUsedMB = [math]::Round($memUsed / 1MB)

    if ($memUsed -gt $maxBytes) {
        Write-Host "`nMEMORY LIMIT EXCEEDED: ${memUsedMB}MB > ${MaxMemoryGB}GB - Killing process!" -ForegroundColor Red
        $process | Stop-Process -Force
        exit 1
    }

    # Print memory usage every 5 seconds
    Write-Host "`rMemory: ${memUsedMB}MB / $($MaxMemoryGB * 1024)MB" -NoNewline -ForegroundColor Yellow
    Start-Sleep -Seconds 2
}

Write-Host "`nProcess exited with code: $($process.ExitCode)" -ForegroundColor Green
