---
name: wpe-renderdoc
description: 用 wpe-renderdoc MCP（mcp__wpe-renderdoc__*，代码在 .claude/mcps/wpe-renderdoc/）拿 Wallpaper Engine 的真值：确保用户常驻的 WPE 在跑并注入 RenderDoc、在本会话自己的测试窗口里打开工程、连续抓 N 帧落到 A:\<项目>\<用途>\、截 WPE 日志，再在本会话私有的无界面回放进程里读 .rdc（绘制、管线、顶点、常量、纹理、取像素）。凡是要拿 WPE 的真值做对照都用它，比如抓帧、核对 pass / uniform / 顶点、比较不同 fps 或后处理档位下的行为、运行中改属性再抓、对比场景渲染和 WPE 是否一致，即使用户只说「抓一下 WPE」「看看 WPE 实际怎么画的」「换个壁纸再抓」「这个档位下 WPE 怎么画」。不用让用户在 RenderDoc 界面里手动操作，也不用先退出 WPE。抓到之后批量提取轨迹 / 整帧图 / 统计量、回放对照、比较用 kbp-tools skill。
---

# wpe-renderdoc

拿 WPE 真值一律用 **wpe-renderdoc MCP**（工具名 `mcp__wpe-renderdoc__*`，说明与实现在 `.claude/mcps/wpe-renderdoc/README.md`）。
本 skill 只是它的用法说明；以前的命令行（`driver.py`、`target.py`：要用户先退出 WPE、结束时强杀、一次只能一个会话）已经删掉。

## 分工

| 做什么 | 用什么 |
|---|---|
| 确保 WPE 在跑并注入、开关本会话的测试窗口、运行中改属性、抓帧、截 WPE 日志、改 WPE 设置（重启） | wpe-renderdoc MCP |
| 交互式读一张 `.rdc`（绘制、管线、着色器、常量、顶点、纹理、取像素） | wpe-renderdoc MCP 的回放工具 |
| 生成测试工程、批量从 `.rdc` 提取轨迹 / 整帧图 / 统计量、按 WPE 时间线回放对照、两份源码回归、比较、PrintWindow 采样 | kbp-tools skill（`kbp gen` / `rdc` / `replay` / `regress` / `cmp` / `sample`） |
| 驱动 Kabegame（渲染场景、粒子轨迹与四角、画面哈希、导入测试工程） | kabegame-dev MCP（kabegame-chromium skill） |

抓帧用 MCP，提取、回放、对比用 `kbp`：`kbp rdc` 在自己拉起的无窗口 qrenderdoc 里直接调 MCP 的服务层，不经 MCP、不需要 WPE 在跑。

## 典型流程

**一步抓一张壁纸，接着分析：**

```text
capture_wallpaper(project="shimmering_particles", out="A:\shimmering-particles\default", frames=3, size="1280x720", wait=8)
get_draw_calls() / get_mesh_data(event_id, "gs_out") / get_pipeline_state(event_id) / save_texture(...)
```

`capture_wallpaper` 做完「`ensure_running` → 开本会话的测试窗口 → 等 `wait` 秒让场景加载 → 抓帧 → 关窗 → 截日志 → 在本会话的
回放进程里打开第一张」，中途出错也会关掉自己开的窗口。其余参数：`tag`（文件名前缀）、`log_grep`（日志只要匹配的行，如
`"\[kbp\]"`）、`open_first`（缺省 true）。`project` 可以是工程目录、`project.json`、工坊 ID、默认工程名或 `myprojects` 里的名字。

**一组「工程 × 帧数 × 设置」（比较 fps、后处理档位）：**

```text
capture_sweep(jobs=[{"project": "D:\Codes\kabegame\ignore\p4\proj\p4c-attract", "settings": {"fps": 60}},
                    {"project": "D:\Codes\kabegame\ignore\p4\proj\p4c-attract", "settings": {"fps": 10}}],
              out_root="A:\p4c", log_dir="D:\Codes\kabegame\ignore\p4\out")
```

- `jobs` 每项 `{project, frames?=3, size?="1280x720", wait?=8, settings?, tag?}`；`tag` 缺省是「工程名-键值…[-尺寸]」
  （如 `p4c-attract-fps60`），抓帧放 `out_root\<tag>`。
- 按 `settings` 分组；要改设置时 `restart_wpe`，跑完把它改过的设置改回扫描开始时的值。
- `log_dir` 给了就写 `<tag>-log.txt`（`[kbp]` 行，kbp-tools 的时间线读它）和 `<tag>-errors.txt`。
- 每个 job 是一次 `capture_wallpaper`，但不打开抓帧；要分析时自己 `open_capture`。

**在开着的窗口上分步做（先改属性再抓）：**

```text
open_wallpaper(project, size="1280x720", wait=20)    # 返回窗口名 kb-<MCP 进程号>-<序号>、hwnd、开窗前的日志游标
apply_properties(window, {"color": "1 0 0", "speed": 2})
capture(window, out="A:\<项目>\<用途>", frames=3)     # 另有 tag、timeout、overwrite
log_since(mark, grep="\[kbp\]")                      # mark 用 open_wallpaper 返回的游标
close_wallpaper(window)
```

`open_wallpaper` 的 `wait` 只是等窗口出现，不等场景加载完：抓之前按场景大小自己等一会儿。

**只读已有的抓帧：** `open_capture(绝对路径)` → 各回放工具 → `close_capture()`；`list_captures(目录, recursive)` 列目录。

## `out` 的约定

- 必须给，绝对路径，约定 `A:\<项目>\<用途>\`：项目根下散落的抓帧不算数（少于两级目录拒绝）。
- 不接受仓库里的路径，也不能和抓帧模板目录 `A:\_rdtemp` 重叠。
- 文件名 `<tag>-frame<帧号>.rdc`，`tag` 缺省取 `out` 的末级目录名；`out` 里已有同 tag 的抓帧时拒绝，除非 `overwrite`。
- 帧号是 RenderDoc 帧号；测试工程的 FR 图层读出的脚本帧号 = RenderDoc 帧号 + 1（协议见 kbp-tools 的 `SKILL.md`）。

## 结果怎么看

- `gaps`：帧号不连续的地方，非空就是漏帧。
- `first_frame`：回放第一张的绘制数、各绘制的索引数、后备缓冲尺寸、`backbuffer_ok`。**绘制数和预期对不上就是抓错了内容**，
  文件名和大小看不出这一点。
- `backbuffer`：实际的后备缓冲；和请求的尺寸不同时带 `size_note`（窗口超出屏幕被系统缩小时会这样，另有 `expect_note`）。
- `identified_by`（怎么认出本窗口）、`probes`（探测次数）、`lock_wait_s`（等抓帧锁的时间）、`windows`（可抓窗口数）。

## 常驻共享的规则

- **WPE 是用户正在用、各会话共享的那一个，常驻、不关不杀。** `ensure_running`：在跑且已注入就不动；在跑没注入就原地注入
  （PID 不变）；没在跑就 `-silent` 普通启动、等桌面壁纸出来再注入（崩溃标记为 1 先写 0，免得弹「上次可能崩溃」）。
  注入的 `renderdoc.dll` 一直留在 WPE 里，直到它重启。WPE 以管理员权限运行时打不开进程，只报出来、不提权。
- **只开关自己的窗口。** 测试窗口叫 `kb-<MCP 进程号>-<序号>`，登记在机器级窗口表；`close_wallpaper` / `apply_properties` /
  `capture` 只认本会话的窗口。别的会话的、外来的窗口不碰；所属 MCP 已不在的陈旧窗口，`ensure_running` / `status` 会顺手关掉。
  桌面壁纸一律不碰。MCP 退出时关掉自己的窗口。
- **同尺寸：** 同一时刻不允许两个尺寸相差 8 像素以内的测试窗口（`open_wallpaper` 拒绝并报出是谁），否则抓帧时分不清。
- **抓帧锁、不抢占：** 连 RenderDoc 目标是独占的，机器级 `target.lock` 只覆盖「连接 → 选窗口 → 触发 → 收文件 → 断开」这几秒，
  回放分析在锁外、各会话可以同时做。目标被别的客户端连着（比如 RenderDoc 界面附加了 WPE）时报「目标被别的客户端连着」，不踢人。
- **选窗口：** RenderDoc 一次只抓「活动窗口」（各会话共享）。只有一个可抓窗口、屏幕上也只有本窗口时直接认作本窗口；否则按尺寸认，
  多于一个可抓窗口时先抓 1 帧探测、按缩略图认，认不准就回放核对后备缓冲。探测会让别人的窗口多一次长帧（`probes` 报出）。
- **设置：** `get_settings` 只读 `config.json`。WPE 只在启动时读它，改设置只能 `restart_wpe(settings)`：正常退出 → 改文件 →
  启动 → 注入，桌面空几秒；只在没有别的会话的窗口、没有外来窗口、设置界面没开着时做。**设置不还原**，改了哪些键结果里逐项报出
  （`capture_sweep` 例外，它改的会改回）。
- **日志：** `log_mark` 取游标、`log_since` 读之后的新行。`log.txt` 各会话共用、行里不带窗口名，同时开着别人的窗口时会混进别人的行；
  日志被重写时报 `rewritten`，不静默从头读。
- `cleanup_project(path)` 只删仓库 `ignore/` 下测试工程里 WPE 写的 `shaders/blobsSM40`，工程正开在窗口里时拒绝。
- `status(target?)` 看进程、注入、窗口表、外来窗口、抓帧锁由谁持有；`target=True` 另读 RenderDoc 目标（要拿抓帧锁，约 2 s）。
  `windows()` 列桌面壁纸窗口与全部测试窗口，只读。
- 没有 pause / play / mute：它们只作用于桌面壁纸，抓帧在测试窗口里做，MCP 不碰桌面。

## 无界面回放工具

- `open_capture`、`close_capture`、`list_captures`、`get_capture_status`、`get_frame_summary`、`get_draw_calls`、`get_draw_call_details`、
  `get_action_timings`、`find_draws_by_shader` / `_by_texture` / `_by_resource`、`get_shader_info`、`get_pipeline_state`、
  `get_buffer_contents`、`get_mesh_data`、`get_texture_info`、`get_texture_data`、`get_texture_stats`、`save_texture`、`pick_pixel`。
- 每个会话的 MCP 自己拉起一个没有窗口的常驻回放进程（`qrenderdoc --python`），IPC 目录按 MCP 进程私有：多个会话可以同时分析不同的
  `.rdc`，不需要开 RenderDoc 界面，也不会替换用户在界面里正在看的抓帧。打开新的会关掉旧的。
- 回放进程意外退出或超时（缺省 120 s，环境变量 `RENDERDOC_MCP_TIMEOUT`）会被结束，下一次调用自动重新拉起，结果里带
  `worker_restarted`、`capture_lost`：这时要重新 `open_capture`。
- `show_in_renderdoc(path)` 会弹出 RenderDoc 界面、抢焦点，只在用户明确要求在界面里看时用。
- 一张一张看用这些工具；一批抓帧要提取轨迹、整帧图、统计量时用 `kbp rdc track|frame|stats`（kbp-tools），不要逐张手调。

## 仍成立的坑

- **帧号每次开窗重新计数：** 不同窗口（不同次抓）的 `frame<N>` 不能比较。
- **被抓的帧本身是长帧：** 序列化要时间，这几帧的 dt 不代表正常帧率。
- **开窗后要等加载：** `wait` 按场景大小给，否则抓到的还在加载（`first_frame` 的绘制数会不对）。
- **测试窗口左上角有 RenderDoc 的叠加文字：** 约 340×40 像素，不进 `.rdc`，但 PrintWindow 采样能看到，判读点要避开。
- **回放读到的常量里 `referenced: false` 的是着色器没读的，值是缓冲里的垃圾，** 不能当数据。
- **缩略图不一定等于后备缓冲：** 宽按 8 对齐、最宽 2048（如 900×500 → 896×497），交换链总等于窗口客户区。
- **窗口加上标题栏后超出屏幕会被系统缩小：** 本机开 3840×2160 实际客户区是 3840×2130，看 `size_note` / `expect_note`。
- **桌面壁纸被重建后可能被挂上：** 注入后用户换壁纸或显示器变化，新的桌面设备也会被挂上，桌面左上角出现叠加文字、可抓窗口数多一个；
  WPE 重启后恢复。
- **测试窗口会在开窗几秒后拿到前台：** 用户接受；WPE 的主窗口（浏览界面、安全启动提示）不会弹。
- **RenderDoc 打开着的 `.rdc` 删不掉：** 先 `close_capture`。
- **`A:\_rdtemp` 里的 `wallpaper64_frame*.rdc` 残留：** 回放进程在抓帧中途死掉时可能留下，MCP 拿不到路径所以不删；确认没人在抓之后手动删。

## 排障

| 现象 | 处理 |
|---|---|
| 目标被别的客户端连着 | 多半是用户在 RenderDoc 界面里附加了 WPE，请用户断开；不要抢占 |
| 等抓帧锁超时 | 结果里报出持有者，等它抓完再来 |
| `open_wallpaper` 因同尺寸被拒 | 换一个尺寸（差 8 像素以上） |
| `restart_wpe` / `capture_sweep` 改设置被拒 | 有别的会话的窗口、外来窗口或设置界面开着；等它们关掉，不要替别人关 |
| 注入失败、打不开进程 | WPE 可能以管理员权限运行，只报给用户 |
| `gaps` 非空、`first_frame` 绘制数不对 | 场景还在加载（加大 `wait`）或抓到了别的内容，重抓 |
| `worker_restarted` / `capture_lost` | 回放进程被重启过，重新 `open_capture` |
| `log_since` 报 `rewritten` | WPE 重启过、日志被重写，重新 `log_mark` |
