# Project Status

## 已完成

- 单条 MP4 和串行批量下载核心、Native Host、腾讯会议解析逻辑未修改。
- 新增 `.github/workflows/release.yml`：`v*` 标签构建并发布正式 Release，`workflow_dispatch` 只上传 Actions artifact。
- 修正 Companion 构建脚本，使 workflow 使用 Python 3.12 时不会错误追加 `-3` 参数。
- 扩展新增安装包可用性检查：未发布和网络不可用时不创建 Chrome 失败下载项，并显示普通用户提示。
- 安装包下载改为通过 `chrome.downloads.onChanged` 等待真实完成或中断状态。
- `v0.6.3` GitHub Actions 已成功完成，Release asset 严格命名为 `MeetingParserSetup.exe`。
- `releases/latest/download/MeetingParserSetup.exe` 已验证返回 200、`application/octet-stream`，大小约 10.98 MB。
- Setup、Host、扩展版本和 `MIN_COMPANION_VERSION` 仍保持 0.6.0 兼容。

## 当前

- GitHub Release 发布链路和 latest 直链已真实可用。
- 扩展代码已完成本地语法、现有协议/命名测试，并用 Python 3.12 成功构建 Companion EXE。
- 本轮尚未把“浏览器插件 Side Panel 点击安装本地组件后的最终 UI 提示”写成已验证完成。

## 问题

- 当前浏览器自动化无法操作 `chrome://extensions` 刷新已加载的本地扩展，也无法稳定捕获 `.exe` 下载完成事件。
- 因此尚未完成插件界面层面的“点击安装本地组件 → Chrome 下载完成 → 显示成功提示”闭环验收。
- 工作区中的未跟踪 `MeetingParser/` 安装目录为已有用户文件，本轮未修改、未提交。

## 下一步

- 在 Chrome 扩展管理页手动刷新本地扩展后，点击“安装本地组件”，确认下载完成提示为“安装程序已下载，请运行 MeetingParserSetup.exe”。
- 该浏览器验收通过后，再将状态更新为真实验证完成；Native Host 安装后的完整功能测试另行进行。
