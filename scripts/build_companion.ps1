[CmdletBinding()]
param(
  [string]$Python = "py"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$workRoot = Join-Path $projectRoot ".build\pyinstaller"
$distRoot = Join-Path $projectRoot "dist\companion"

function Build-CompanionExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Source
  )

  & $Python -3 -m PyInstaller --noconfirm --clean --onefile --windowed --name $Name `
    --paths $projectRoot --distpath $distRoot --workpath $workRoot --specpath $workRoot $Source
  if ($LASTEXITCODE -ne 0) {
    throw "打包失败：$Name"
  }
}

& $Python -3 -m PyInstaller --version
if ($LASTEXITCODE -ne 0) {
  throw "未找到 PyInstaller。开发环境请运行：py -3 -m pip install -r requirements-dev.txt"
}

New-Item -ItemType Directory -Force -Path $workRoot, $distRoot | Out-Null
Build-CompanionExecutable -Name "MeetingParserDownloader" -Source (Join-Path $projectRoot "local_downloader.py")
Build-CompanionExecutable -Name "MeetingParserHost" -Source (Join-Path $projectRoot "companion\native_host.py")

Write-Output "构建完成：$distRoot"
