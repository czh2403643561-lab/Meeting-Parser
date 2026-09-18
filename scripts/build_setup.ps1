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

New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null
& $InnoCompiler "/DCompanionDir=$companionDirectory" "/DReleaseDir=$releaseDirectory" $issPath
if ($LASTEXITCODE -ne 0) {
  throw "MeetingParserSetup.exe 构建失败。"
}

Write-Output "安装程序构建完成：$(Join-Path $releaseDirectory 'MeetingParserSetup.exe')"
