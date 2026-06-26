# Phase 5.1.5 — kabegame 端到端 GPU 验证 + 性能 + 退出清理

> 父:[phase5.1](cef-linux-runtime-phase5.1.md)。路线 A 迁移出口判据。
>
> **目标**:kabegame 真实跑在 **windowed CEF + GPU** 上,确认图库滚动丝滑(项目初衷)、CPU 明显下降、稳定退出。

## 点 1 — 端到端启动
- **任务**:`bun dev -c kabegame`(Linux,windowed 模式)起 GPU CEF 窗口出前端;IPC/protocol/page-load/devtools/事件全通(沿用 Phase 3.3 的 CEF env + sqlite version-script 修复)。
- **门控**:确认 Android/Win/macOS 不触达 CEF、行为不变。

## 点 2 — 性能对照(用数据收口 5.1)
- **任务**:真实图库页测 滚动 FPS、CPU 占用、最大化/4K 表现,三方对照:
  - 软件 OSR(旧 windowed 之前的 5.1 起点);
  - windowed GPU(本路线);
  - 旧 WebKitGTK(换引擎前)。
- **产出**:一张"GPU windowed 是否达成丝滑目标"的结论。

## 点 3 — DPI / 多显示器
- **核对**:CEF Views 下 `scale_factor`/HiDPI 正确;跨屏拖动缩放正常(替代 OSR 的 `screen_info` device scale 路径)。

## 点 4 — 退出 / 资源清理
- **核对**:关窗 + 退出时 `shutdown` 干净;无残留 render/gpu/utility 子进程;GLib pump 线程正常结束;无 GPU validation error。

## 验收
- 图库滚动在 NVIDIA 下**丝滑**、CPU 较软件 OSR 明显下降。
- 文字选择/滚动/点击/IPC/protocol/page-load/devtools/关闭退出全稳。
- 其余平台不受影响。

## 风险
- GPU windowed 在不同 NVIDIA 驱动版本的稳定性。
- 与 5.2(多窗口)、5.3(系统集成)、tray 的交互需在各自阶段补验。

## 锚点
- Phase 3.3 落地记录(CEF env、sqlite version-script)。
- README §9(性能/GPU 结论汇总,完成后更新)。
