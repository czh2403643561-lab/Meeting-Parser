[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SourceDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "companion.config.ps1")

if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
  $SourceDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) "dist\companion"
}

$source = Resolve-Path -LiteralPath $SourceDirectory -ErrorAction Stop
$requiredFiles = @("MeetingParserDownloader.exe", "MeetingParserNativeHost.exe")
foreach ($file in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
    throw "安装包缺少：$file。请先运行 scripts\build_companion.ps1。"
  }
}

$installDirectory = Join-Path $env:LOCALAPPDATA $MeetingParserInstallDirectoryName
$nativeManifestPath = Join-Path $installDirectory "com.meetingparser.helper.json"
$nativeManifest = @{
  name = $MeetingParserNativeHostName
  description = "Meeting Parser local downloader starter"
  path = (Join-Path $installDirectory "MeetingParserNativeHost.exe")
  type = "stdio"
  allowed_origins = @("chrome-extension://$MeetingParserExtensionId/")
} | ConvertTo-Json -Depth 3

if ($PSCmdlet.ShouldProcess($installDirectory, "安装 Meeting Parser 本地组件")) {
  New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
  foreach ($file in $requiredFiles) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $installDirectory $file) -Force
  }
  Set-Content -LiteralPath $nativeManifestPath -Value $nativeManifest -Encoding utf8

  $registryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$MeetingParserNativeHostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$MeetingParserNativeHostName"
  )
  foreach ($registryKey in $registryKeys) {
    New-Item -Path $registryKey -Force | Out-Null
    Set-Item -Path $registryKey -Value $nativeManifestPath
  }
  Write-Output "本地组件已安装到：$installDirectory"
  Write-Output "请在 Chrome 或 Edge 中重新加载 extension 目录。"
} else {
  Write-Output "模拟安装完成；未写入文件或注册表。"
}
