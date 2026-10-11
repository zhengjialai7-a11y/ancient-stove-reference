$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$PackageRoot = Split-Path -Parent $PSScriptRoot
$InstallRoot = Join-Path $env:LOCALAPPDATA 'ArtCapture'
$RuntimeRoot = Join-Path $InstallRoot 'runtime'
$AgentRoot = Join-Path $InstallRoot 'agent'
Write-Host 'Art Capture v0.7.1 - Windows local uploader'
Write-Host 'First update/reload the extension. Then copy its ID from edge://extensions or chrome://extensions.'
$ExtensionId = (Read-Host 'Paste the extension ID (32 lowercase letters)').Trim()
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Invalid extension ID.' }
if (![Environment]::Is64BitOperatingSystem) { throw 'This build requires 64-bit Windows.' }
$Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$NodeVersion = '22.23.3'
$ArchiveName = "node-v$NodeVersion-win-$Architecture.zip"
$NodeRoot = Join-Path $RuntimeRoot "node-v$NodeVersion-win-$Architecture"
$NodeExe = Join-Path $NodeRoot 'node.exe'
New-Item -ItemType Directory -Force -Path $RuntimeRoot,$AgentRoot | Out-Null
if (!(Test-Path $NodeExe)) {
 Write-Host 'Downloading the portable Node runtime from nodejs.org...'
 $BaseUrl = "https://nodejs.org/dist/v$NodeVersion"
 $Checksums = (Invoke-WebRequest -UseBasicParsing "$BaseUrl/SHASUMS256.txt").Content
 $Line = ($Checksums -split "`n" | Where-Object { $_ -match ([regex]::Escape($ArchiveName) + '$') } | Select-Object -First 1)
 if (!$Line) { throw 'Official runtime checksum was not found.' }
 $ExpectedHash = ($Line -split '\s+')[0]
 $ArchivePath = Join-Path $RuntimeRoot $ArchiveName
 Invoke-WebRequest -UseBasicParsing "$BaseUrl/$ArchiveName" -OutFile $ArchivePath
 if ((Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant() -ne $ExpectedHash.ToLowerInvariant()) { throw 'Runtime checksum mismatch.' }
 Expand-Archive -LiteralPath $ArchivePath -DestinationPath $RuntimeRoot -Force
 Remove-Item -LiteralPath $ArchivePath
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'core.mjs'),(Join-Path $PSScriptRoot 'host.mjs'),(Join-Path $PSScriptRoot 'network.mjs') -Destination $AgentRoot -Force
$Directory = Join-Path $env:USERPROFILE 'Downloads'
$ConfigPath = Join-Path $AgentRoot 'config.json'
if (Test-Path $ConfigPath) { $OldConfig = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json; if ($OldConfig.directory) { $Directory=$OldConfig.directory } }
$Origin = "chrome-extension://$ExtensionId/"
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($ConfigPath,(@{directory=$Directory;allowedOrigins=@($Origin)} | ConvertTo-Json),$Utf8)
$HostCmd = Join-Path $AgentRoot 'host.cmd'
$HostText = "@echo off`r`nchcp 65001 >nul`r`n`"$NodeExe`" --use-system-ca --use-env-proxy `"$(Join-Path $AgentRoot 'host.mjs')`" `"%~1`"`r`n"
[IO.File]::WriteAllText($HostCmd,$HostText,$Utf8)
$ManifestPath = Join-Path $AgentRoot 'com.art_reference.capture.json'
$Manifest = @{name='com.art_reference.capture';description='Art reference native original uploader';path=$HostCmd;type='stdio';allowed_origins=@($Origin)}
[IO.File]::WriteAllText($ManifestPath,($Manifest | ConvertTo-Json),$Utf8)
foreach ($BrowserKey in @('Microsoft\Edge','Google\Chrome')) {
 $RegistryPath = "HKCU:\Software\$BrowserKey\NativeMessagingHosts\com.art_reference.capture"
 New-Item -Path $RegistryPath -Force | Out-Null
 Set-Item -Path $RegistryPath -Value $ManifestPath
}
Write-Host 'Installed. Keep the browser open; you can close the workbench during upload.' -ForegroundColor Green
Write-Host 'Open the collection queue, sign in, then click Check local assistant.'
Start-Process 'https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html?v=0.7.1'
