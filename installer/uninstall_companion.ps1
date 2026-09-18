[CmdletBinding(SupportsShouldProcess = $true)]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "companion.config.ps1")

$installDirectory = Join-Path $env:LOCALAPPDATA $MeetingParserInstallDirectoryName
$ownedExecutables = @(
  (Join-Path $installDirectory "MeetingParserHost.exe"),
  (Join-Path $installDirectory "MeetingParserNativeHost.exe"),
  (Join-Path $installDirectory "MeetingParserDownloader.exe")
)
$registryKeys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$MeetingParserNativeHostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$MeetingParserNativeHostName"
)

foreach ($ownedExecutable in $ownedExecutables) {
  try {
    $runningProcesses = Get-CimInstance Win32_Process -Filter "Name='$([IO.Path]::GetFileName($ownedExecutable))'" |
      Where-Object { $_.ExecutablePath -eq $ownedExecutable }
  } catch {
    $runningProcesses = @()
  }
  foreach ($process in $runningProcesses) {
    if ($PSCmdlet.ShouldProcess($ownedExecutable, "停止正在运行的本地组件")) {
      Stop-Process -Id $process.ProcessId -Force
    }
  }
}

foreach ($registryKey in $registryKeys) {
  if ((Test-Path -LiteralPath $registryKey) -and $PSCmdlet.ShouldProcess($registryKey, "删除 Native Messaging 注册")) {
    Remove-Item -LiteralPath $registryKey -Force
  }
}

if ((Test-Path -LiteralPath $installDirectory) -and $PSCmdlet.ShouldProcess($installDirectory, "删除 Meeting Parser 本地组件")) {
  Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

if ($WhatIfPreference) {
  Write-Output "模拟卸载完成；未删除文件或注册表。"
} else {
  Write-Output "Meeting Parser 本地组件已卸载。"
}
