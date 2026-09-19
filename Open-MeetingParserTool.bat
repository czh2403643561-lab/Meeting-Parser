@echo off
setlocal

set "TOOL=%~dp0dist\companion\MeetingParserTool.exe"
if exist "%TOOL%" goto launch

set "TOOL=%~dp0MeetingParserTool.exe"
if exist "%TOOL%" goto launch

set "TOOL=%LOCALAPPDATA%\MeetingParser\MeetingParserTool.exe"
if exist "%TOOL%" goto launch

echo 未找到 MeetingParserTool.exe。
echo 请先安装工具，或先运行构建脚本生成 dist\companion\MeetingParserTool.exe。
pause
exit /b 1

:launch
start "Meeting Parser 本地工具" "%TOOL%"
exit /b 0
