[CmdletBinding()]
param(
  [string]$Python = "py"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$workRoot = Join-Path $projectRoot ".build\pyinstaller"
$distRoot = Join-Path $projectRoot "dist\companion"
$pythonArguments = @()
if ($Python -match '(^|[\\/])py(?:\.exe)?$') {
  $pythonArguments = @("-3")
}

function Build-CompanionExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Source,
    [string[]]$AdditionalArguments = @()
  )

  $pyInstallerArguments = @(
    "--noconfirm", "--clean", "--onefile", "--windowed", "--name", $Name,
    "--paths", $projectRoot, "--distpath", $distRoot, "--workpath", $workRoot, "--specpath", $workRoot
  ) + $AdditionalArguments + @($Source)
  & $Python @pythonArguments -m PyInstaller @pyInstallerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "打包失败：$Name"
  }
}

& $Python @pythonArguments -m PyInstaller --version
if ($LASTEXITCODE -ne 0) {
  throw "未找到 PyInstaller。开发环境请运行：py -3 -m pip install -r requirements-dev.txt"
}

New-Item -ItemType Directory -Force -Path $workRoot, $distRoot | Out-Null
Build-CompanionExecutable -Name "MeetingParserDownloader" -Source (Join-Path $projectRoot "local_downloader.py")
Build-CompanionExecutable -Name "MeetingParserHost" -Source (Join-Path $projectRoot "companion\native_host.py")
$ffmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
$ffprobeCommand = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
if (-not $ffmpegCommand -or -not $ffprobeCommand) {
  throw "未找到 FFmpeg/ffprobe。请先准备本地 FFmpeg 组件后再构建 MeetingParserTool.exe。"
}
$toolBinaryArguments = @(
  "--add-binary", "$($ffmpegCommand.Source);ffmpeg",
  "--add-binary", "$($ffprobeCommand.Source);ffmpeg"
)
$ffmpegDirectory = Split-Path -Parent $ffmpegCommand.Source
Get-ChildItem -LiteralPath $ffmpegDirectory -Filter "*.dll" -File | ForEach-Object {
  $toolBinaryArguments += @("--add-binary", "$($_.FullName);ffmpeg")
}
Build-CompanionExecutable -Name "MeetingParserTool" -Source (Join-Path $projectRoot "companion\desktop_tool.py") -AdditionalArguments $toolBinaryArguments

Write-Output "构建完成：$distRoot"
