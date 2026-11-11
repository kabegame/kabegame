# 06 · 验证与收尾

## 总体设计思路

先写证伪判据再上真机。macOS 用 DeskPad 造第二块屏开发 P2–P5；Windows 部分需要真实多屏（含负坐标与混合 DPI）。界面验证经 `kabegame-chromium` skill / `kabegame-dev` MCP 连 dev app（多个壁纸窗口各有 CDP target，按 label 区分）；运行时调用次数、调度时刻用 debug ingest（`cocs/debug/DEBUG_INGEST.md`）插桩，不包 `invoke`。

## 每期的检查

| 期 | 自动 | 真机 |
|---|---|---|
| P1 | `deno task check -c kabegame`；v005 迁移单测（搬键 / 旧键胜出 / 缺键默认 / 幂等）；轮播 `wrapped_position` 等原有单测；新增多目标调度单测（到点时每个活跃目标各切一张、各用自己的路径与位置；`rotate(Some(id))` 只切一个；一个目标选图失败不影响其它；手动切换后计时重置） | 单屏机器上：设图、轮播、改样式 / 过渡、切壁纸模式、关开壁纸、重启恢复，行为与改前一致；Android 轮播 Worker 正常 |
| P2 | 枚举单测（并集计算、主屏排序、Y 翻转） | DeskPad 开 / 关、拖动排布、改分辨率：布局图 2 s 内跟上；id 在 DeskPad 重启后是否不变（**DeskPad 虚拟屏的 UUID 若每次变化，记为已知情况，不影响真实显示器**） |
| P3 | `plan_windows` 单测（multiple / single 下每屏一条、只有主屏 audible）；`pickWallpaperTarget` 单测（一个活跃目标时不弹直接返回、取消返回 null） | 窗口模式 single：两屏同时换图、各走各的路径、各自样式；图库「设为壁纸」「设为轮播」弹出目标选择弹窗，选副屏后只有副屏变，取消后什么都不变；multiple 下同样的操作不弹；鼠标在副屏时点托盘「下一张」只切副屏，在主屏时只切主屏；multiple：两屏同图、只有主屏出声；显示器模式选择器里 span 置灰并显示原因；原生 span 下切到窗口模式自动回落 multiple；拔掉 DeskPad 后其窗口销毁、目标保留，再开恢复原图；网页 / 场景壁纸在副屏可点击；ping 看门狗对每个窗口各自生效；Windows 负坐标屏、混合 DPI 下每个窗口铺满各自的屏、图标仍在上 |
| P4 | — | Windows：single 两屏不同图，不弹 UAC；样式改一处两屏同变；macOS：两屏不同图，fit / stretch / center 生效 |
| P5 | 位置映射单测（span → Windows `22` / GNOME `spanned`；离开 span 后按目标样式写回） | Windows：选 span 后一张图跨两屏、系统个性化里显示「跨区」，样式行只读；切回 multiple 后样式恢复为该目标原来的值；`none` / `fade` 过渡照常。GNOME：`picture-options` 变成 `spanned`。macOS：span 在两种壁纸模式下都置灰并给出原因 |
| P6 | — | GNOME 枚举 id 稳定、布局图画出真实排布；Plasma single 每个 containment 正确对上屏 |

## 证伪判据（先写下）

- 窗口模式：若某个窗口显示的目标与布局图上该屏的目标不同，或拔插后窗口数 ≠ 在线屏数，reconcile 有错，停下排查，不加补丁式修正。
- 原生 span：若 Windows 上写了 `WallpaperStyle = 22` 后画面仍是每屏一份，先查写注册表后的广播与重设顺序（现有 `set_style` 的流程），不改成自己裁图。
- 托盘：若「下一张」切到的不是鼠标所在的屏，先打印光标坐标与各屏矩形核对坐标系（Windows 物理像素、macOS 翻转 Y），不靠偏移修。Windows 上托盘图标默认只在主任务栏，从那里点一定落在主屏——这是预期，不算错。
- 目标选择弹窗：若在只有一个活跃目标时弹出，或选了屏却落到默认屏，说明前端算的活跃目标与后端 `layout()` 不一致，统一成一份规则再继续。
- Windows：若 WorkerW 宿主不覆盖负坐标屏（副屏窗口挂上后不可见），多窗口挂载要按屏找各自的宿主，先枚举实际窗口层级再改。
- 原生 Windows：若 `SetWallpaper(monitorId)` 改到了另一块屏，说明 01 的 id 与 `IDesktopWallpaper` 的 monitorID 不一致，枚举方式要换。
- 轮播：若到点时有活跃目标没换图（且它的路径里有可用图片），或手动切一个目标时别的目标也跟着换，调度器有错。

## 收尾（每期合入时）

- **文档**：新增 `cocs/wallpaper/MULTI_SCREEN.md`（显示器模式、目标与 id、能力矩阵、窗口模式暂不支持 span 的原因、原生 span 只用系统位置、目标选择弹窗、托盘按光标所在屏、热插拔），在 `cocs/README.md` 壁纸节加条目；更新 `cocs/wallpaper/ROTATION_PATHQL.md`（状态挪进目标、多目标调度）、`WINDOW_MOUNT_WEMT.md`（按矩形挂载、多窗口）、`cocs/wpe/WPE_IMPORT.md` 中壁纸窗口单 label 的描述、`cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md` 的特赦 label 列表；`AGENTS.md` 进程表 / 平台说明里「壁纸窗口」改成窗口池。
- **回归**：`versions/latest/regression.md` 按 4.5.1 格式加 case（迁移后单屏行为不变、三种模式 × 两种壁纸模式、拔插、断开屏忘记、目标选择弹窗的弹与不弹、托盘下一张按光标所在屏、删画册 / 删图影响所有目标、CLI `--target`），能在本机测的当场勾选。
- **changelog**：`versions/latest/changelog.md` 一到几行（显示器模式、逐屏壁纸与轮播路径、跨屏拼接）。
- 旧计划 `.claude/plans/wallpaper-multi-monitor.md`、`wallpaper-multiscreen-manager.md` 是否删除由用户决定。
