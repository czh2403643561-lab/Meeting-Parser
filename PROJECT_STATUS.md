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
- Side Panel 的折叠区域已提供“提取逐字稿”入口和实时解析状态；content script 以 `#minutes-scroll-container` 为唯一逐字稿作用域，在其真实滚动子容器内读取 `pid-*-content`，自动滚动虚拟列表、按段落顺序去重合并，并恢复用户原滚动位置。
- 逐字稿结果已提供段落数量、字符数量、复制全文和导出 TXT；未修改 MP4、批量下载和 Native Host。
- 批量任务已增加“视频下载 / 逐字稿提取”类型；逐字稿任务复用单条提取逻辑，严格串行执行，支持任务状态、字数、失败原因和运行日志。
- 批量逐字稿支持默认分级导出和统一 TXT 导出，标题文件名会处理 Windows 非法字符，并显示输出目录或文件。

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
- 刷新本地扩展后，需要在真实课程页面确认 Side Panel 的自动滚动采集能得到完整正文、最终字数明显超过原先约 2100 字，并验收复制全文和 TXT 导出结果。
- 批量逐字稿仍待使用 3 个真实腾讯会议链接验收：页面自动加载、完整正文、分级/统一导出、失败原因和最终输出位置。

## 下一步

- 在 Chrome 扩展管理页刷新本地扩展后，使用真实腾讯会议录制页点击“页面诊断/提取逐字稿”，确认实时进度、完整正文、复制全文和 TXT 导出；再继续固定 LocalAppData、单条下载和“重新检测”验收。
- 准备 3 个真实腾讯会议链接，在批量页分别验收逐字稿分级导出和统一导出；确认视频下载模式仍保持原流程。
- 通过后再更新状态；不将当前结果描述为普通用户一键安装全部完成。
