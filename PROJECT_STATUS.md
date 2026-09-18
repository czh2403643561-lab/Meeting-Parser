# Project Status

## 已完成

- 完成项目基础环境初始化
- 完成 Manifest V3 最小媒体嗅探与 MP4 下载插件
- 已捕获腾讯会议真实播放中的直接 MP4
- 已确认 Chrome 内置下载链路在腾讯会议真实 MP4 上仍返回“录制文件.txt / 无法从网站上提取文件”
- 已切换为插件嗅探、后台内存暂存请求上下文、本地 Python 服务流式下载的方案
- 本地服务只监听 127.0.0.1，认证请求头不写入 storage、日志或界面
- 已真实验证单个腾讯会议 MP4 经本地下载器完整落盘并可正常播放
- 已改为 Manifest V3 Side Panel，并持久化非敏感活动任务元数据
- 本地服务已改用 ThreadingHTTPServer，提供真实 bytes、totalBytes、progress 和状态查询
- 已为每个标签页增加 origin + pathname 页面 scope 和 generation 隔离
- MP4 候选已识别屏幕画面/发言人画面，并显示脱敏文件名
- Side Panel 已增加单个下载/批量下载导航、TXT 导入和腾讯会议链接解析
- 已修复同一路径不同 token 的媒体候选稳定去重，并将请求上下文按稳定媒体身份关联
- 已加入 cookies 权限、后台临时 Referer/Cookie/User-Agent 下载上下文和不播放的 metadata preload 准备
- 批量待处理列表已移除重复编号
- 已真实验证单条腾讯会议 MP4 无需手动播放即可完整下载并正常播放
- 已实现后台串行批量队列：专用 worker tab、暂停/继续、失败重试、任务状态恢复和本地下载进度同步
- 已分离批量解析草稿与执行队列，并增加原子启动校验、总进度和安全运行日志
- 浏览器扩展运行文件已移入 `extension/`，与 Python 本地下载器及测试环境隔离
- 已修复批量安全日志导出：UTF-8 文本、时间戳文件名、空日志提示和敏感字段过滤
- 已完成 Side Panel 第一轮 UI/交互整理：单个下载高级信息折叠、批量总览/进度/任务列表/日志分层、操作反馈和会话内折叠状态记忆
- 已增加 16/32/48/128 PNG 扩展图标，并更新 manifest 配置
- 已真实验证 3 条腾讯会议链接的连续批量下载成功
- 已修复本地下载器客户端提前断开时的响应写入处理，保留 ThreadingHTTPServer，并增加空闲 15 分钟自动退出
- 已新增 Windows Companion 打包方案、Native Messaging Host、当前用户 Chrome/Edge 安装与卸载脚本，以及固定扩展 ID
- 已接入插件自动确保本地下载服务可用、批量运行防休眠、TXT 自动解析和批量非敏感状态本地恢复
- 已构建并验证两个 Companion EXE：Native Host 可拉起下载器、健康检查可用、空闲后退出
- 已完成录制标题命名整理：腾讯会议页面优先提取顶部可见标题，单条/批量统一使用 `recordingTitle`
- 已统一 Windows 文件名安全转换规则，保留中文标点并将文件名主体上限调整为 220 字符
- 已增加标题提取、非法字符、长标题和 Python 文件名处理的定向测试
- 已修复 PowerShell 5.1 脚本编码兼容：全部 `.ps1` 统一为 UTF-8 BOM + CRLF，并增加 `.editorconfig`
- 已验证 Windows PowerShell 5.1 / PowerShell 7 的 Companion 构建、安装和卸载模拟流程

## 当前

- 核心下载链路未改动，继续使用 Side Panel + 本地下载服务方案
- 本地 Python 下载器仍保留为开发调试实现；普通用户流程已改为由插件自动启动 Windows Companion
- Companion 与浏览器 Native Messaging 的完整真实端到端流程尚待在重新加载的 Chrome/Edge 扩展中验证，不能视为“一键体验已真实完成”
- 本轮文件命名已完成代码级整理，真实腾讯会议页面的最终文件名仍需现场回归确认
- Companion PowerShell 脚本已具备 Windows PowerShell 5.1 编码兼容性

## 问题

- Chrome 直接下载对该腾讯会议 MP4 的真实验证失败，不能继续作为主下载链路
- 多 MP4 用途显示和页面切换隔离尚待真实腾讯会议页面复测
- 本轮 UI、日志导出、Companion、Native Messaging 和浏览器重启恢复尚未在真实 Chrome/Edge Side Panel 中完成最终回归
- 需验证杀掉 Companion 后插件可自动再次拉起，以及批量暂停/完成时能释放防休眠
- Chrome/Edge 现在应加载 `extension/` 目录，不应加载仓库根目录
- 需确认真实页面顶部标题 DOM 在不同腾讯会议页面变体上的提取结果

## 下一步

- 运行 `scripts\build_companion.ps1` 与 `installer\install_companion.ps1`，重新加载 `extension/`
- 在无手工 Python/PowerShell 的前提下验证单条下载和杀掉 Companion 后的批量自动拉起
- 验证批量运行防休眠、暂停/完成释放，以及浏览器重启后“发现未完成批量任务，点击继续”
- 完成后再运行完整 67 条列表
- 在真实腾讯会议页面验证单条与批量标题命名、中文标点、长标题和重名冲突处理
- 继续完成真实 Chrome/Edge Companion、批量恢复和下载命名回归
