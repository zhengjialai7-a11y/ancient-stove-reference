$ErrorActionPreference='Stop'
foreach ($BrowserKey in @('Microsoft\Edge','Google\Chrome')) {
 $RegistryPath="HKCU:\Software\$BrowserKey\NativeMessagingHosts\com.art_reference.capture"
 if(Test-Path $RegistryPath){Remove-Item -LiteralPath $RegistryPath}
}
Write-Host 'Native host unregistered. Original images and progress files were retained.'
