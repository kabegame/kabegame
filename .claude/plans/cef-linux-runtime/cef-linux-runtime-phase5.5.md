# Phase 5.5 — 稳定性与全功能回归

> 父:[phase5](cef-linux-runtime-phase5.md)。贯穿性,作为 Phase 5 的出口判据。
>
> **目标**:验证 "kabegame 在 Linux CEF 下日常功能与未换引擎前一致",并确认长时间运行稳定、退出干净。

## 点 1 — 生命周期 / 资源清理
- **核对**:窗口关闭、应用退出时 CEF 正确 `shutdown`;browser 实例、帧缓冲、softbuffer surface、协议 handler、RequestContext 全部释放;无残留子进程(render/gpu/utility)。
- **核对**:`run` / `run_return` / `run_iteration` 路径一致(Phase 3 落地记录提到 `run_iteration` 较轻量)。

## 点 2 — 长跑 / 内存 / 多次开关窗口
- **任务**:长时间浏览大量图片 + 反复开关 main/wallpaper 窗口,观察内存/句柄/FD 增长、子进程泄漏、`do_message_loop_work` 调度是否退化。

## 点 3 — 全功能逐项回归(对照换引擎前)
按 kabegame 主路径逐项过(CEF vs 旧 WebKitGTK):
- 画廊浏览 / 翻页 / 分页 / 详情(metadata、插件描述 EJS iframe)。
- 爬虫任务(JS 注入执行链、Pixiv 等插件)、任务抽屉、下载计数事件。
- 壁纸设置 / 轮播 / wallpaper 窗口。
- 设置页 / i18n 切换 / 主题 / 插件商店。
- 自动更新弹窗、托盘菜单、最小化到托盘。
- 事件(`images-change`/`album-images-change`/各 emit)前端订阅刷新。

## 点 4 — 退化项归零
- **核对**:原 `free(): invalid pointer`(下拉框)在 CEF 下不复现(本就是换引擎主因)。
- **核对**:无新增崩溃 / 白屏 / IPC 丢失 / 事件不达。

## 验收
- 上述主路径在 Linux CEF 下与换引擎前**行为一致**,无回归。
- 长跑稳定、退出无残留进程。

## 风险
- 插件描述 iframe(`__bridge` postMessage + proxy_fetch)在 CEF 下的跨域/消息行为需专门验。
- 调试 ingest(`cocs/debug/DEBUG_INGEST.md`)在 CEF 后端是否仍可用。

## 锚点
- `cocs/` 各流程文档(画廊/下载/爬虫/更新/插件)逐一对照其"涉及文件"。
