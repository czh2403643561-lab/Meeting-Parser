[CmdletBinding()]
param(
  [string]$Python = "py",
  [string]$InnoCompiler = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$companionBuildScript = Join-Path $PSScriptRoot "build_companion.ps1"
$issPath = Join-Path $projectRoot "installer\MeetingParserSetup.iss"
$companionDirectory = Join-Path $projectRoot "dist\companion"
$releaseDirectory = Join-Path $projectRoot "dist\release"
$setupPath = Join-Path $releaseDirectory "MeetingParserSetup.exe"

New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null
if (Test-Path -LiteralPath $setupPath) {
  Remove-Item -LiteralPath $setupPath -Force
}

$versionMatch = Select-String -Path $issPath -Pattern '^AppVersion=(.+)$' | Select-Object -First 1
if (-not $versionMatch) {
  throw "未找到安装包版本号。"
}
$setupVersion = $versionMatch.Matches[0].Groups[1].Value.Trim()

& $companionBuildScript -Python $Python
if ($LASTEXITCODE -ne 0) {
  throw "Companion 构建失败。"
}

if ([string]::IsNullOrWhiteSpace($InnoCompiler)) {
  $command = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($command) {
    $InnoCompiler = $command.Source
  } else {
    $candidates = @(
      (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
      (Join-Path ${env:ProgramFiles} "Inno Setup 6\ISCC.exe")
    )
    $InnoCompiler = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
}

if ([string]::IsNullOrWhiteSpace($InnoCompiler) -or -not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
  throw "未找到 Inno Setup 编译器 ISCC.exe。请安装 Inno Setup 6，或通过 -InnoCompiler 指定路径。"
}

& $InnoCompiler "/DCompanionDir=$companionDirectory" "/DReleaseDir=$releaseDirectory" $issPath
if ($LASTEXITCODE -ne 0) {
  throw "MeetingParserSetup.exe 构建失败。"
}

if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
  throw "MeetingParserSetup.exe 构建产物不存在。"
}
if ((Get-Item -LiteralPath $setupPath).Length -le 0) {
  throw "MeetingParserSetup.exe 构建产物为空。"
}

Write-Output "MeetingParserSetup.exe"
Write-Output "Version: $setupVersion"
Write-Output "Path: $setupPath"
