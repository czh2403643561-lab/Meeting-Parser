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

## 当前

- 浏览器直接下载方案真实验证失败，当前使用 Side Panel + 本地 Python 下载器方案
- Side Panel 的关闭/重新打开恢复逻辑与真实腾讯会议完整文件结果待复测
- 批量模式当前只解析并保存待处理链接，不执行自动下载
- 无需手动播放的单条下载准备流程实现完成，待真实腾讯会议复测

## 问题

- Chrome 直接下载对该腾讯会议 MP4 的真实验证失败，不能继续作为主下载链路
- 多 MP4 用途显示和页面切换隔离尚待真实腾讯会议页面复测
- 页面切换后的真实腾讯会议 A/B 页面隔离仍需浏览器实测确认
- 自动构造 Cookie + Referer 上下文及 metadata preload 尚未在真实腾讯会议页面验证，不应视为已解决

## 下一步

- 运行 `python local_downloader.py`，重新加载扩展并刷新腾讯会议页面
- 点击工具栏图标打开 Side Panel，播放并下载 MP4，然后关闭/重新打开面板确认进度恢复
- 确认 Downloads 中是完整 MP4，并记录本地服务返回的失败原因或成功结果
- 在同一标签页从腾讯会议 A 导航到 B，确认 A 的候选资源完全消失
- 在批量页导入 TXT 或粘贴链接，确认 accepted/duplicate/invalid 统计与待处理列表
- 不播放视频时确认同一 recording MP4 只出现一张卡，并能自动准备上下文后下载
