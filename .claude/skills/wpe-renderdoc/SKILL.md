---
name: wpe-renderdoc
description: 命令行自动抓 Wallpaper Engine 的 RenderDoc 帧：注入启动 WPE、程序切换壁纸或开测试窗口、连续抓 N 帧落到 A:\<项目>\<用途>\、结束后还原设置。凡是要拿 WPE 的真值做对照都用它，比如抓帧、核对 pass / uniform / 顶点、比较不同 fps 或后处理档位下的行为、对比场景渲染和 WPE 是否一致，即使用户只说「抓一下 WPE」「看看 WPE 实际怎么画的」「换个壁纸再抓」。不用让用户在 RenderDoc 界面里手动操作。
---

# wpe-renderdoc

> 抓 WPE 用新的 `wpe-renderdoc` MCP（`.claude/mcps/wpe-renderdoc/`）；完全迁移前本 skill 保留。

用命令行完成「注入启动 WPE → 打开工程 → 连续抓帧 → 还原」，全程不用碰 RenderDoc 界面。抓到的 `.rdc` 再用 RenderDoc MCP 读（`get_mesh_data`、`get_shader_info`、`save_texture`）。

## 用法

都从仓库根运行：`python -X utf8 -I .claude/skills/wpe-renderdoc/driver.py <命令>`，下面简写成 `rd`。

| 命令 | 作用 |
|---|---|
| `rd start [--set 键=值]…` | 注入启动 WPE。`--set` 临时改 `config.json`，如 `fps=60`、`postprocessing=disabled` |
| `rd status` | 会话、目标和可抓窗口数 |
| `rd open <工程> [--wait 秒]` | 切换桌面壁纸。工程可以是目录、`project.json`、工坊 ID 或默认工程名 |
| `rd open <工程> --window 名字 [--size 1920x1080] [--close-desktop]` | 放进独立窗口 |
| `rd close [--window 名字]` | 关窗口；不给名字就关桌面壁纸 |
| `rd control pause\|play\|mute\|unmute` | 发 WPE 的全局控制命令 |
| `rd capture --out A:\<项目>\<用途> [--frames 10] [--tag 前缀]` | 连续抓帧，文件名 `<前缀>-frame<N>.rdc` |
| `rd stop [--relaunch]` | 结束自己启动的 WPE，按字节还原 `config.json`。`--relaunch` 再按普通方式启动，并确认桌面壁纸回来 |

`capture` 的输出要看 `first_frame`。它回放第一张，报绘制数和后备缓冲尺寸：

```json
{"windows": 1, "saved": [...], "gaps": [], "first_frame": {"draws": 10, "sizes": [6, 6, 1, 6, 6, 1, 1, 1, 1, 1], "backbuffers": [[1920, 1080]]}}
```

`gaps` 非空表示帧不连续。绘制数和预期对不上，就是抓错了内容，文件名和大小看不出这一点。

## 常见流程

**抓某张壁纸，比较两个档位：**
```bash
rd start --set postprocessing=disabled
rd open shimmering_particles --wait 6
rd capture --out 'A:\shimmering-particles\disabled' --frames 3
rd stop
rd start --set postprocessing=ultra
rd open shimmering_particles --wait 6
rd capture --out 'A:\shimmering-particles\highres' --frames 3
rd stop --relaunch
```
改设置要重启 WPE，所以每个档位一轮 `start` / `stop`。

**抓自己的测试工程：** 放窗口里，同时能用 PrintWindow 采样：
```bash
rd start
rd close                                      # 只留一个交换链
rd open ignore/p4/proj/p4-0 --window KBT      # 或由采样脚本开窗
rd capture --out 'A:\p4-0\fps10' --frames 10
rd close --window KBT
rd stop --relaunch
```

抓帧放 `A:\<项目>\<用途>\`：只有子目录里的算数，项目根下散落的是草稿。

## 约束

- **WPE 必须先退出。** `start` 发现 WPE 在运行会拒绝。这个工具只结束自己启动的进程，别人启动的要请用户从托盘退出。
- **`stop` 一定要跑。** 配置是 `start` 时备份的（`.kabegame/debug/wpe-renderdoc/`），不跑 `stop` 设置就留在改过的状态。用户在会话期间在 WPE 里改的设置也会被还原。
- **壁纸只在会话内切换。** `open` 要求有会话，这样切换留下的配置痕迹由 `stop` 一起还原。
- **`--relaunch` 之后配置可能差一行。** 壁纸是经 `openWallpaper` 放回去时，WPE 自己会去掉 `general.wallpaperconfig` 下的 `"layout": null`。它运行时改不回来，改了也会被写回，属于已知差异。
- 汇报里写明临时改了哪些设置、结束后是否还原，以及上面这一行差异。

## 为什么这样做

- **这台机器的 RenderDoc 没有 `pymodules`。** Target Control API 只能从 `qrenderdoc --python` 里用（`target.py`）。它是 GUI 程序，看不到 stdout，所以结果写文件；脚本在主界面之前运行，写完 `os._exit(0)` 就不会弹窗。不影响正开着的 RenderDoc。
- **`renderdoccmd capture` 只能注入，不能触发。** 触发靠 `TriggerCapture(n)`，一次连续抓 n 帧。
- **经 WMI 启动 WPE。** 工具的作业对象结束时，作业里的进程会被一起带走，WPE 要跨多条命令存活。
- **启动带 `-silent`。** 否则会弹出浏览界面。
- **`stop` 只能强杀。** WPE 没有退出命令，也不响应 WM_CLOSE（`taskkill` 不带 `/F` 时主进程不退）。界面进程 `wallpaperui` 会跟着自己退，`ui_left` 应为空。
- **不用 `taskkill /T`。** 它按父进程号走树，Windows 的父进程号可能是回收过的旧值，不值得冒碰到无关进程的风险。
- **强杀之后下次启动不自动加载壁纸。** 所以 `--relaunch` 等 12 秒没有桌面窗口，就按备份里选中的壁纸用 `openWallpaper` 放回去。结果看输出的 `wallpaper.by`。

## 踩过的坑

- **多个交换链时会抓错，而且看着完全成功。** 桌面壁纸和测试窗口同时在时，抓到的是桌面。所以 `windows` 大于 1 时 `capture` 直接拒绝，用 `rd close` 关掉多余的，或者 `open` 时带 `--close-desktop`。确实要抓才加 `--any-window`，再按 `first_frame` 核对。
- **`EnumWindows` 看不到桌面壁纸窗口。** 它挂在 WorkerW 下面，不是顶层窗口。判断有没有壁纸看 `rd status` 的 `windows`，`null` 表示没有。
- **会话开始时桌面上有没有壁纸不一定。** 上一次是正常退出的话，壁纸会自己加载，而且比 `start` 返回得晚。要抓窗口时都先 `rd close`，`capture` 前的拒绝是最后一道保险。
- **`open` 发出命令就返回，** 场景还在加载，这时抓到的是上一张，`--wait` 按场景大小给。
- **实时画面左上角有 RenderDoc 的叠加文字，** 约 340×40 像素。它不进 `.rdc`，但 PrintWindow 采样能看到，判读点要避开。
- **被抓的帧本身是长帧，** 序列化要时间，这几帧的 dt 不代表正常帧率。
- **帧号在换壁纸后重新计数，** 不同壁纸的 `frame<N>` 不能比较。
- **`pause` 只管桌面壁纸。** `-playInWindow` 窗口不受影响。`open` 会清掉暂停，所以先 `open` 再 `pause`。
- **桌面壁纸可能不呈现。** 窗口存在、`windows` 是 1，但 `rd status` 的 `presenting` 是 `False`：只在加载时画一帧（帧号 0），之后停住，`capture` 超时。2026-11-07 下午遇到过，`playbackmaximized=run`、`playbackfullscreen=run` 都没用；当时显示器被拔掉了，后来同一条路径恢复正常，很可能就是这个原因。`--window` 不受影响；抓到帧号 0 也要怀疑是这种情况。
- **想抓暂停恢复后的头几帧：** 暂停时触发 `capture`，它等到下一次呈现才开始。抓帧本身造成长帧，爬升过程看不到。
- **RenderDoc 打开着的 `.rdc` 删不掉**（`Device or resource busy`），先让它打开别的文件。

## 排障

| 现象 | 处理 |
|---|---|
| `WPE 正在运行` | 请用户从托盘退出，不要自己结束 |
| `上一次会话没有结束` | 跑 `rd stop` |
| `会话的 WPE 进程已经不在了` | 跑 `rd stop` 还原配置，再 `rd start` |
| `只抓到 n / m 帧` | `windows` 为 `null` 表示没有窗口，先 `rd open`；`presenting` 为 false 见上面的「桌面壁纸可能不呈现」 |
| `有 N 个可抓窗口` | 见上面的多交换链 |
| `config.json 里 X 出现 n 次` | `--set` 只支持文件里恰好出现一次的标量键 |
