# v4.5.0-preview regression

本版回归 checklist。任何改动可预见的回归路径，要在上线前 check 完毕。

## 后台任务改为快照轮询

整理、隐藏清理、文件夹同步、插件 metadata 迁移与单图下载不再发送高频进度事件。前端收到唤醒
事件后每 500ms 拉取快照，任务结束以快照为准；Android 下载通知由后端 1s ticker 刷新。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 轮询器与启动竞态自动化 | 前端 Vitest | 执行 `deno task test -c kabegame --skip cargo` | 空闲只请求一次；wake 后 500ms 轮询；invalidate 丢弃旧响应；请求不重叠；`starting` 忽略旧停止快照 | `useSnapshotPoller.test.ts`、`organize.test.ts` |
| [x] | 元数据迁移运行态自动化 | Rust 单测 | 执行 `.claude/skills/test-kabegame/driver.sh kabegame-core --lib metadata_migration` | 每行回调计数准确；同插件并发调度只启动一个 runner，最新 pending 续跑一轮 | |
| [ ] | 空闲不持续轮询 | 桌面 WebView / CEF | 启动应用后观察 `get_busy_tasks_snapshot` 与 `get_active_downloads` | 各自首次请求一次；无活动任务时不再请求 | |
| [ ] | 整理快照收尾 | 桌面 | 发起整理并等待完成；再临时取消 finished 监听重试 | 约 1.8s 后显示卡片，约 500ms 更新；结束后卡片消失且停止轮询；丢 finished 只少 toast、不残留卡片 | |
| [ ] | 隐藏清理与文件夹同步 | 桌面 | 分别运行隐藏清理、手动同步文件夹画册 | 进度约 500ms 更新，结束立即收尾；取消/失败 toast 正确 | 文件夹同步仍有 1.5s 可见延迟 |
| [ ] | 插件 metadata 迁移卡片 | 桌面 / Android | 安装带升级迁移且有大量旧 metadata 的插件 | 显示插件图标、名称、百分比和 processed/total；无取消按钮；成功静默，失败 toast | 同插件更新不并发 |
| [ ] | 下载单一镜像 | 桌面 / Android | 运行爬虫并打开任务抽屉，再测试失败图片重试 | 字节进度约 500ms 更新；抽屉与失败重试进度一致；下载清空后轮询停止 | `TaskDrawerContent` 不再监听进度事件 |
| [ ] | Android 下载通知 ticker | Android | 下载多个文件并观察通知，结束后保持空闲 | 通知约 1s 更新；全部进入终态后 ticker 退出；状态/移除仍立即刷新 | |
| [ ] | 五种语言 | 桌面 | 切换中/繁/英/日/韩并触发迁移失败 | 卡片标题与失败提示无裸 i18n key | |
