# Project Status

## 已完成

- 单条 MP4、串行批量下载、Native Messaging 单 Host 架构、腾讯会议解析、文件命名和批量队列未修改。
- GitHub Release 自动发布链路已实现，`v0.6.4` Release asset 为 `MeetingParserSetup.exe`。
- 安装包可用性检查和真实下载状态监听已实现。
- 安装器固定使用 `%LOCALAPPDATA%\MeetingParser`，隐藏目录选择页，并保留明确的安装完成提示。
- 安装完成后生成 `MeetingParserHost.exe`、`com.meetingparser.helper.json`，Chrome/Edge HKCU 注册表均指向该 manifest。
- 升级时继续清理旧文件和旧 Host 进程，不影响 Chrome 或其他程序；浏览器触发的下载中仍由现有更新保护阻止升级。
- `scripts/build_setup.ps1` 构建前清理旧 `MeetingParserSetup.exe`，输出文件名、版本和实际路径。
- Setup、Host、扩展和 `MIN_COMPANION_VERSION` 当前统一兼容版本 `0.6.0`。
- Side Panel 已增加折叠的“页面诊断”入口；content script 已增加不依赖固定 class 的逐字稿主体定位、完整段落合并和安全懒加载滚动。
- 诊断结果已增加段落数量、字符数量、复制全文和导出 TXT；未修改 MP4、批量下载和 Native Host。

## 已真实验证

- `0.6.0` Setup 可以安装，且本机已验证自动安装到 `%LOCALAPPDATA%\MeetingParser`。
- 安装后生成的 Host、manifest、Chrome/Edge 注册表路径正确，旧架构文件不存在。
- 用户已真实验证安装后 Chrome 插件能够识别 Native Host。
- 真实腾讯会议录制页面 DOM 已验证可识别录制页、统计视频元素，并读取逐字稿正文块和预览文本。
- 真实课程页面已确认逐字稿使用可滚动懒加载容器：初始只渲染部分内容，滚动后会增加容器高度并加载新的段落。

## 仍待验证

- 固定 `%LOCALAPPDATA%\MeetingParser` 安装后的浏览器完整流程，以及 Side Panel 最终显示“环境已准备好”。
- 插件内直接下载安装包的完整浏览器验收。
- 干净新电脑上的安装和 Native Host 识别。
- 刷新本地扩展后，需要在真实课程页面确认完整正文最终字数、复制全文和 TXT 导出结果。

## 下一步

- 在 Chrome 扩展管理页刷新本地扩展后，使用真实腾讯会议录制页点击“页面诊断/开始检测”，确认完整正文、复制全文和 TXT 导出；再继续固定 LocalAppData、单条下载和“重新检测”验收。
- 通过后再更新状态；不将当前结果描述为普通用户一键安装全部完成。
