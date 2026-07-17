# 会话上下文存档:多显示器壁纸支持(2026-07-17)

> 用途:恢复工作时的上下文入口。恢复时先读本文件,再按指针读两份计划。

## 任务脉络

给壁纸设置添加**多显示器支持**。已完成三平台原生能力调研 + WallpaperManager 扩展设计,进度到"实现前最后一个决策点待拍板"。

## 产出文件

1. **[.claude/plans/wallpaper-multi-monitor.md](../plans/wallpaper-multi-monitor.md)** — 平台调研(英文)。
   Windows(`IDesktopWallpaper` COM:免管理员/需 STA 线程/`GetMonitorDevicePathAt` 持久 id/`GetMonitorRECT` 判在线/样式全局是硬限制/`DWPOS_SPAN` 与每屏图互斥)、macOS(`NSWorkspace.setDesktopImageURL(_:for:options:)` + `NSScreen.screens`,持久 id 用 CGDisplay UUID **不是 index**,样式可逐屏,坐标左下原点需翻转 Y,Sonoma+ 双屏待真机验证)、Linux(GNOME 硬不支持每屏图只有 spanned;Plasma 逐 containment 全支持;Hyprland/wlroots 靠 wlr-layer-shell,hyprpaper/swww→awww/swaybg 均 per-output,长线可自绘 layer-shell 后端;前端排布图统一 `MonitorGeometry` 左上原点坐标 + identify 浮层)。

2. **[.claude/plans/wallpaper-multiscreen-manager.md](../plans/wallpaper-multiscreen-manager.md)** — 实施计划(中文,本次主产出)。
   核心设计(用户定的):两大顶层形态(multi 关=单逻辑屏 / 开=每屏独立完整设置集:轮播目标/模式/间隔/壁纸/style/transition);trait 加 `is_{multi_screens,image_by_screen,style_by_screen,transition_by_screen}_supported` 能力探针;setter 全部加 `screen: Option<&str>` 尾参(None=全部,对齐 IDesktopWallpaper);Controller 集中级联决策(feature 不支持 → 降级全局级联写);`ScreenInfo` 统一类型;分期 P1 骨架零回归 → P2 Windows → P3 macOS → P4 Plasma → 后续 window 多窗/Wayland。

## 已拍板的决策

- **每屏配置存储**:`SettingValue::Json` 单键 `wallpaperScreenConfig`({screen_id → 惰性条目,字段 Optional 动态回退全局键})。
- **断开屏配置**:保留休眠,重连恢复。
- 每屏轮播间隔独立(用户明确要求"完整的轮播目标")。

## ⚠️ 待拍板(恢复工作时第一件事)

**关闭 multi_screen 时的行为**,二选一:
- **方案 A(我推荐)**:关 = 一套设置,呈现由 style 决定;新增 `span` style 选项(仅 Windows `DWPOS_SPAN` / GNOME `spanned` 原生支持处出现)。默认 fill = 现行为,零回归;"两屏同图"仍有直接入口。与平台原生模型对齐(span 在 Windows"契合度"/GNOME picture-options 里本就和 fill 平级)。
- **方案 B(用户原话字面)**:关 = 强制拼接大屏(span);macOS 无原生 span 回退复制。升级用户默认行为突变。

用户在看完 duplicate vs span 差异图解后说"去忙别的",**尚未选**。

## 恢复后下一步

1. 拍板上述决策 → 更新计划"决策点"一节。
2. 按计划 P1 动工:trait 扩展 + `ScreenInfo` + Controller scoped 入口 + settings Json 键 + capabilities features + IPC(全后端探针 false,行为零回归)。
3. 验证只跑 `deno task check -c kabegame`(勿 build;app 运行中 check 会 os error 32,先杀 kabegame.exe)。

## 环境备注

- 用户显示器:Windows 双屏(main + 副屏),macOS 单屏 13"(多屏逻辑无法本机全验),Linux 用 Hyprland。
- 工作区另有**未完成的 MCP 设置改动**(Settings.vue / mcp.json 五语言 / mcp_server.rs / mcp-settings-tab.md 等)——与本任务无关,提交时不要混入。
