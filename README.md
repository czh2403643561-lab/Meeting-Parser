# Meeting-Parser

个人使用的浏览器媒体资源嗅探与下载工具。它在用户已经正常登录并播放视频时发现真实 MP4，并保存到 Downloads 文件夹。

## 普通用户使用

首次使用只需完成一次本地组件安装。安装完成后，日常使用不需要打开 PowerShell、Python 或任何本地服务窗口：

1. 安装并启用扩展，在 Chrome 或 Edge 中打开腾讯会议录制页面。
2. 首次打开插件时，点击“安装本地组件”；浏览器会下载 `MeetingParserSetup.exe`。
3. 双击运行安装程序，完成一次安装；插件会自动检测并显示“环境已准备好”。
4. 正常登录并打开腾讯会议录制页面，播放视频，然后点击“下载 MP4”或“开始批量下载”。

插件会在需要时静默启动本地下载组件；组件空闲一段时间后会自行退出，下次下载会再次启动。批量下载运行时仅阻止系统因空闲进入睡眠，不会保持屏幕常亮。

## 开发者运行方式

开发者构建发布安装程序需要先安装 Inno Setup 6：

```powershell
.\scripts\build_setup.ps1
```

输出文件为 `dist/release/MeetingParserSetup.exe`。安装程序会把组件放入 `%LOCALAPPDATA%\MeetingParser\`，并注册 Chrome 与 Edge 的当前用户 Native Messaging 项。

如需单独构建 Companion：

```powershell
.\scripts\build_companion.ps1
```

开发调试安装/卸载仍可使用 PowerShell 脚本：

```powershell
.\installer\install_companion.ps1
.\installer\uninstall_companion.ps1
```

这些脚本仅供开发者使用，普通用户不需要运行。

开发调试可直接运行 Python 下载器：

```powershell
py local_downloader.py
```

它仅监听 `127.0.0.1:8765`，下载仍保存到用户 Downloads 文件夹。这个命令仅用于开发调试，不是普通用户的日常步骤。

## 隐私与范围

- 浏览器只把当前下载需要的请求上下文临时转给本地组件；Cookie、Authorization、签名媒体 URL 和原始请求头不会保存到浏览器本地存储、运行日志或界面。
- 批量恢复仅保存腾讯会议页面链接、任务状态、文件名、进度、错误信息和下载偏好；浏览器重启后会提示用户继续未完成任务。
- HLS/DASH 仅识别和展示，不下载分片、不合并媒体；不处理登录、账号密码、Token 或 DRM。
