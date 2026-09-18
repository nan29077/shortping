$ErrorActionPreference = 'Stop'
$shortpingRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $shortpingRoot
$shortpingPort = 3033
if (Get-NetTCPConnection -LocalPort $shortpingPort -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Port $shortpingPort is already in use. Check http://localhost:$shortpingPort before starting another server."
    exit 0
}
New-Item -ItemType Directory -Force (Join-Path $shortpingRoot 'data') | Out-Null
$shortpingNode = (Get-Command node).Source
$shortpingProcess = Start-Process -FilePath $shortpingNode -ArgumentList '--env-file-if-exists=.env', 'server/index.mjs' -WorkingDirectory $shortpingRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $shortpingRoot 'data/server.log') -RedirectStandardError (Join-Path $shortpingRoot 'data/server-error.log') -PassThru
$shortpingProcess.Id | Set-Content -LiteralPath (Join-Path $shortpingRoot 'data/server.pid')
Write-Host "Shortping started. PID: $($shortpingProcess.Id). URL: http://localhost:$shortpingPort"
