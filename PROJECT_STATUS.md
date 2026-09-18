# Project Status

## 已完成

- 单条 MP4 和串行批量下载核心保持原方案，下载目录仍为用户 Downloads。
- 新增代码级 `MeetingParserHost.exe`：通过持久 Native Messaging 连接直接复用安全流式下载实现，不再启动 localhost Downloader 子进程。
- Native Host 仅传输 hello、任务参数和进度 JSON，不回传 MP4 字节；状态不包含完整 URL、Cookie 或 Authorization。
- 扩展后台已改用 `chrome.runtime.connectNative`，单条和批量共用同一提交与状态入口；Native 断线时当前任务标记失败，不自动重复下载。
- 安装器已改为安装 `MeetingParserHost.exe`，升级前只停止本项目明确进程，清理旧 Downloader/旧 Native Host，并禁用通用应用强制关闭流程。
- 安装/更新模式会断开现有 Native 连接，阻止下载进行中更新，并使用低频探测等待安装完成。
- `local_downloader.py` 保留为开发调试 HTTP 服务；其安全校验、重定向脱敏、文件命名和流式下载逻辑由新 Host 复用。
- 已补充 Native Host 协议测试、敏感字段检查、文件命名测试；`scripts/build_setup.ps1` 已成功生成 `dist/release/MeetingParserSetup.exe`。
- README 已区分普通用户 Native Host 流程与开发者 Python 调试流程。

## 当前

- 本轮完成的是代码级 Companion 架构迁移，正式链路尚不能写成“已真实完成”。
- PowerShell 安装脚本、Inno Setup 配置、扩展后台和 Side Panel 已同步到 Host 0.6.0 协议。
- 现有安装目录/注册表可能仍是旧 Companion，需要在真实升级测试中确认覆盖与清理结果。

## 问题

- 尚未在干净 Windows 环境完成“无 Python/PowerShell → 安装 Setup → Chrome/Edge Side Panel → 单条完整下载”的真实端到端验证。
- 尚未完成旧 Companion 正在运行时的真实覆盖升级验证，也未确认浏览器重启、批量暂停/完成防休眠释放等回归。
- 需要确认真实腾讯会议页面的标题提取、单条/批量命名和重名冲突行为未受本轮通信层迁移影响。

## 下一步

- 在真实 Chrome/Edge 中加载 `extension/`，安装新版 Setup 并验证 Native Host hello、单条下载和 3 条批量下载。
- 关闭/杀掉 Host 后重新下载，确认扩展能重新建立 Native 连接；验证下载期间升级会被阻止，空闲升级不会再出现文件占用提示。
- 完成浏览器重启恢复、防休眠、敏感信息和长文件名回归后，再更新状态为真实验证完成。
