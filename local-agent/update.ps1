$ErrorActionPreference = 'Stop'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'ArtCapture'
$AgentRoot = Join-Path $InstallRoot 'agent'
$ConfigPath = Join-Path $AgentRoot 'config.json'
if (!(Test-Path $ConfigPath)) { throw 'Helper not installed. Run the installation command first.' }
$LockPath = Join-Path $InstallRoot 'state\host.lock'
if (Test-Path $LockPath) {
 $Lock = Get-Content -LiteralPath $LockPath -Encoding UTF8 -Raw | ConvertFrom-Json
 $Running = Get-Process -Id $Lock.pid -ErrorAction SilentlyContinue
 if ($Running -and $Running.ProcessName -eq 'node') { throw 'Reload the capture extension to disconnect the helper, then run this update again.' }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'core.mjs'),(Join-Path $PSScriptRoot 'host.mjs'),(Join-Path $PSScriptRoot 'network.mjs') -Destination $AgentRoot -Force
Write-Host 'Helper updated to v0.7.5. Download folder, extension ID and saved progress are preserved.' -ForegroundColor Green
Write-Host 'Refresh the queue and click Check local assistant. No extension ID entry is needed.'
