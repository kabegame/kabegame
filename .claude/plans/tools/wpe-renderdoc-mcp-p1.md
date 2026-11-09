# wpe-renderdoc MCP 第 1 批：vendor 与无界面回放进程

> 总计划：[wpe-renderdoc-mcp.md](wpe-renderdoc-mcp.md) 步骤 1。本批不碰 WPE，只做「读 `.rdc`」这一半，用现有抓帧验收。抓帧控制（`target_*`）挪到第 3 批，和抓帧锁一起做。

## 总体设计思路

把 `ignore/RenderDocMCP`（上游 halby24/RenderDocMCP `11b6b74`，加本地改动）拷进 `.claude/mcps/wpe-renderdoc/`。拷来后它的读帧服务不再挂在 RenderDoc 界面的扩展里，改在一个由 MCP 自己拉起、常驻的 `qrenderdoc --python worker.py` 里运行。原处不动，旧 MCP 继续用它。

`--python` 的脚本在主界面出现之前运行，脚本不返回，界面就永远不会出现。所以这个工作进程没有窗口，也不碰用户开着的 RenderDoc。

服务层（`services/`、`utils/`）原样拷贝，一行不改。原因是它们只通过两个接口接触外界：
- `ctx`：用到 `IsCaptureLoaded`、`GetAction`、`GetResourceName`、`GetCaptureFilename`、`LoadCapture` 五个方法；
- 门面的 `_invoke`：在界面里是 `ctx.Replay().BlockInvoke`。

工作进程提供一个 `ctx` 垫片，背后是一个裸的 `ReplayController`，`_invoke` 直接把 controller 交给回调。垫片要做到和界面的语义一致，尤其两处：
- **资源名：** 取 `controller.GetResources()` 的 `name`。现在 `scripts/replay_check.py` 的垫片返回空串，`find_draws_by_texture` 会因此找不到东西。
- **`LoadCapture`：** 关掉旧的 controller，再打开新的。

这样同一份服务代码，在旧的界面桥和新的工作进程里算出同一个结果。验收的核心就是验证这一点。

MCP 服务端和工作进程之间仍走文件交换，沿用旧桥的协议，但做三处改动：
- **目录私有：** 按 MCP 进程分开，`.kabegame/debug/wpe-renderdoc-mcp/ipc/<MCP 进程号>/`，不再是全机共用的 `%TEMP%\renderdoc_mcp`；
- **不要锁文件：** 请求和回应都先写 `.tmp` 再 `os.replace`，一次只有一个请求在途；
- **工作进程跟着 MCP 走：** 工作进程握住 MCP 进程的句柄，MCP 没了就自己退出。RenderDoc 内嵌的是 Python 3.8，带 `_ctypes`，可以用 `OpenProcess` + `WaitForSingleObject`。

每个 Claude 会话的 MCP 有自己的工作进程，所以多个会话可以同时打开不同的 rdc 分析，互不干扰。

工具对外保持旧 MCP 的 19 个名字、参数和说明不变，另加两个：
- `close_capture`；
- `show_in_renderdoc(path)`：用户明确要看时，另起一个 RenderDoc 界面打开文件，会弹窗。

旧 MCP 的界面扩展部分不 vendor：`renderdoc_extension/__init__.py`、`socket_server.py`、`extension.json`、`scripts/install_extension.py`。

## 现状锚点

**a. 旧桥的 IPC 是全机一个目录，靠锁文件**（`ignore/RenderDocMCP/mcp_server/bridge/client.py:17`）
```python
IPC_DIR = os.path.join(tempfile.gettempdir(), "renderdoc_mcp")   # 现状：全机共用，两个会话会互相覆盖
REQUEST_FILE = os.path.join(IPC_DIR, "request.json")
LOCK_FILE = os.path.join(IPC_DIR, "lock")                        # 现状：写请求时先建锁文件，写完删
```

**b. 门面经界面的回放线程调用**（`renderdoc_extension/renderdoc_facade.py:47`）
```python
    def _invoke(self, callback):
        self.ctx.Replay().BlockInvoke(callback)   # 现状：要界面的 CaptureContext
```

**c. 打开抓帧走界面的 `LoadCapture`**（`renderdoc_extension/services/capture_manager.py:118`）
```python
            self.ctx.LoadCapture(
                capture_path, opts, capture_path,
                False,          # temporary
                True,           # local
            )                   # 现状：界面替换掉用户正在看的那个
```

**d. 现有垫片只补了三个服务用到的部分**（`scripts/replay_check.py:25`）
```python
class Ctx:
    def IsCaptureLoaded(self): return True
    def GetAction(self, event_id): return self.actions.get(event_id)
    def GetResourceName(self, resource_id): return ""     # 现状：资源名为空，和界面不同
    # 现状：没有 GetCaptureFilename、LoadCapture、Replay
```

**e. 旧桥的现成输出**（`ignore/p4/rdc_track.py:1`；`ignore/p4/tracks/rd-*.json`）
```python
# 从一组 .rdc 提取轨迹。走 RenderDocMCP 的桥接，要求 RenderDoc 开着并启用了扩展。
# 用法：python -X utf8 -I rdc_track.py <抓帧目录> <标签> [工程名]        写 tracks/rd-<标签>.json
```
`tracks/` 下有 `rd-fps60.json`、`rd-fps10.json`、`rd-p4a2.json`、`rd-p4b-color-fps60.json` 等。它们是旧界面桥对 `A:\` 下抓帧的输出，用作对照真值。

**f. RenderDoc 内嵌 Python**（`C:\Program Files\RenderDoc\`）：`python38.dll`、`python38.zip`、`_ctypes.pyd`、`_socket.pyd`；没有 `pymodules`，`import renderdoc` 只能在 `qrenderdoc --python` 里用。

## 点 1 — 拷贝与工程骨架（`.claude/mcps/wpe-renderdoc/`）

- **新增** 目录：
```text
.claude/mcps/wpe-renderdoc/
  pyproject.toml  uv.lock  LICENSE  README.md  .gitignore
  mcp_server/                 # uv 的 Python（≥3.10）
    __init__.py
    server.py                 # 工具注册（点 4）
    replay.py                 # 工作进程客户端（点 3）
    paths.py                  # 仓库根、状态目录、qrenderdoc 位置
  renderdoc_worker/           # 在 qrenderdoc --python 里跑（Python 3.8）
    worker.py                 # 常驻循环（点 2）
    context.py                # ctx 垫片（点 2）
    request_handler.py        # 从 renderdoc_extension/ 拷来，加 close_capture
    renderdoc_facade.py       # 拷来，_invoke 改为直接调用
    services/  utils/         # 原样拷来，不改
```
- **新增** `pyproject.toml`：项目名 `wpe-renderdoc-mcp`，入口 `wpe-renderdoc-mcp = "mcp_server.server:main"`，依赖同旧的（`fastmcp>=2,<3`、`pydantic>=2`）。用 `uv lock` 重新生成 `uv.lock`。
- **新增** `LICENSE`：上游 MIT 原文。
- **新增** `README.md`：
  - 来源：上游 `11b6b74`；
  - 本地改动清单：`git -C ignore/RenderDocMCP diff --stat` 与两个新文件；
  - 以后不跟上游。
- **修改** 根 `.gitignore`：加 `/.claude/mcps/*/.venv/`，`__pycache__/` 没被忽略的话一并加上。
  > 说明：用 `git check-ignore -v` 验证。
- `services/`、`utils/` 和 `ignore/RenderDocMCP/renderdoc_extension/` 下的对应文件逐字节相同，验收时 `diff -r` 核对。

## 点 2 — 工作进程（`renderdoc_worker/`）

- **新增** `context.py`：垫片，照界面 `CaptureContext` 的语义实现服务层用到的方法：
```python
class ReplayContext:
    """服务层用到的 CaptureContext 子集，背后是一个裸 ReplayController。"""
    def IsCaptureLoaded(self): ...      # 有 controller 才为真
    def GetCaptureFilename(self): ...   # 当前打开的路径
    def GetAction(self, event_id): ...  # 打开时遍历 GetRootActions 建表
    def GetResourceName(self, resource_id): ...   # 取 controller.GetResources() 的 name，和界面一致
    def LoadCapture(self, path, opts, orig, temporary, local): ...   # 关掉旧的再打开；失败抛异常
    def Replay(self): ...               # 返回带 BlockInvoke(cb) 的对象，cb(controller) 直接调用
    def close(self): ...                # Shutdown controller 与 CaptureFile
```
  > 说明：开工前先 `grep -rn "ctx\." services/` 核对一遍方法清单，有遗漏就补上并写进实施记录。
- **新增** `worker.py`：
  - 启动参数走环境变量：IPC 目录、MCP 进程号；
  - 启动时用 `ctypes` `OpenProcess(SYNCHRONIZE)` 握住 MCP 进程，每轮 `WaitForSingleObject(h, 0)`，MCP 没了就关掉 controller、`os._exit(0)`。
    > 注意：**不能用 `os.kill(pid, 0)` 探活**。Windows 上它会 `TerminateProcess` 把对方结束掉。
  - 循环每 20 ms 看一次 `request.json`：读出、删掉、分派给 `RequestHandler`，回应写 `response.json.tmp` 再 `os.replace`。回应不能序列化时照旧桥的做法回错误，不能让对方等到超时。
  - 输出写同目录的 `worker.log`（界面程序看不到 stdout）；
  - 起来后写 `ready.json`（进程号、Python 版本、RenderDoc 版本）。
- **修改** 拷来的 `renderdoc_facade.py`：`_invoke` 改成 `callback(self.ctx.controller)`，其余不动。
- **修改** 拷来的 `request_handler.py`：加 `close_capture`，其余不动。

## 点 3 — 工作进程客户端（`mcp_server/replay.py`）

- **新增** `ReplayWorker`：
```python
class ReplayWorker:
    def call(self, method: str, params: dict) -> Any: ...
    # · 第一次调用时拉起：Popen([qrenderdoc, "--python", worker.py], env=…)，等 ready.json（超时 30 s）
    # · 一次一个请求（threading.Lock）；请求先写 .tmp 再 os.replace
    # · 超时（默认 120 s，RENDERDOC_MCP_TIMEOUT 可调）或进程已退出：结束自己拉起的这个进程，
    #   下次调用重新拉起；结果里带 worker_restarted、capture_lost，不静默吞掉
    def close(self) -> None: ...   # MCP 退出时调用：结束工作进程、删 IPC 目录
```
- **新增** 启动时清理：`ipc/` 下进程号已不存在的目录删掉。只删这个目录下的。
- qrenderdoc 位置取环境变量 `RENDERDOC_DIR`，缺省 `C:\Program Files\RenderDoc`，同旧 skill。

## 点 4 — 工具（`mcp_server/server.py`）

- **新增** 19 个工具：名字、参数、类型、缺省值和说明都照旧 `server.py` 原样搬，后端改调 `ReplayWorker.call`。
  > 说明：验收时程序化比较新旧两边的工具 schema，除新增的两个外必须一致。
- **新增** `close_capture()`、`show_in_renderdoc(path)`。后者另起 `qrenderdoc.exe <path>`，说明里写「会弹出界面，只在用户要求看时用」。
- **新增** FastMCP 的 `instructions`：
  - 和旧 `renderdoc` 的区别：不用开 RenderDoc 界面；每个会话有自己的回放进程，可以同时分析；
  - 两边工具同名时，读 rdc 优先用这边；
  - 抓帧工具在后续批次。
- **新增** 退出钩子：stdin 关闭、`atexit` 时 `ReplayWorker.close()`。

## 点 5 — 入口（`.mcp.json`）

- **修改** 新增一项，旧的 `renderdoc` 保留：
```json
"wpe-renderdoc": { "command": "uv", "args": ["--directory", ".claude/mcps/wpe-renderdoc", "run", "wpe-renderdoc-mcp"] }
```
  加完由用户 `/mcp` 重连。依赖装在这个目录自己的 `.venv`，不碰根目录 `node_modules`。

## 验收

脚本和输出放 `ignore/wpe-mcp/p1/`。驱动 MCP 用 `mcp` 包的 stdio 客户端写个小脚本（`uv run` 在新工程目录里跑），不要经 Claude Code。

1. **和旧界面桥逐字节一致：**
   - 照 `ignore/p4/rdc_track.py` 写一个只换客户端的版本，经新 MCP 对它当时用的同一批抓帧重提。
   - 至少 3 个标签，`json.load` 后与 `ignore/p4/tracks/rd-<标签>.json` 完全相同。
   - 标签对应的抓帧目录查 `.claude/plans/wpe-import/3-scene/phase4/` 里的实施记录，或 `rdc_track.py` 的调用处。A 盘上已经不在的标签跳过，并写明。
2. **全部工具冒烟，和直接调 API 交叉核对：** 3 张抓帧，每个工具至少调一次，不报错：
   - `A:\bedroom\highres\` 下一张（HDR、泛光）；
   - `A:\p4b\<任一>\` 下一张（粒子、几何着色器）；
   - `A:\wpe-mcp\exp-inject-running\kbt-frame506.rdc`。

   另写一个在 qrenderdoc 里直接调 API 的参照脚本，独立算出下面几项，与工具结果比较：
   - 动作数与 eventId 清单；
   - 资源名（不能为空，等于 `GetResources()` 的 name）；
   - 一张纹理的尺寸与格式；
   - 一个像素的 `PickPixel`；
   - 一段缓冲的字节。
3. **工具 schema：** 新旧 19 个工具的名字、参数、缺省值、说明一致。
4. **生命周期：**
   - MCP 进程退出后，工作进程 2 s 内退出，IPC 目录被删；
   - 工作进程被结束后，下一次调用自动拉起，结果带 `worker_restarted`；
   - 超时后同样恢复。
5. **并发：** 起两个 MCP 进程，各开一张不同的 rdc，交错调用 50 次。每次结果都与各自单独顺序调用时相同；两个 IPC 目录互不相干。
6. **不弹窗、不碰用户的 RenderDoc：**
   - 全程开 `python -X utf8 -I ignore/wpe-mcp/exp/exp.py watch --seconds <N> --out <文件>`：没有新的可见顶层窗口，前台窗口不被我们切走（`show_in_renderdoc` 单独测、单独说明）；
   - `%TEMP%\renderdoc_mcp` 的修改时间不变。
7. **范围：** `git status` 只有 `.claude/mcps/wpe-renderdoc/`、`.mcp.json`、`.gitignore` 和 `ignore/wpe-mcp/p1/`（后者被忽略）。`ignore/RenderDocMCP`、`.claude/skills/wpe-renderdoc/` 没有改动。
8. **端到端**（Claude 做）：用户 `/mcp` 重连后，在 Claude Code 里经 `mcp__wpe-renderdoc__*` 打开一张 rdc，调 `get_draw_calls`、`get_mesh_data`，与第 2 条的结果相同。

## 约束（给实施方）

- **本批不碰 WPE：** 不发 `-control`、不注入、不读写 WPE 的配置与注册表。
- **不碰用户的 RenderDoc：**
  - 不调旧的 `renderdoc` MCP 工具，不往 `%TEMP%\renderdoc_mcp` 写；
  - 不结束任何不是自己拉起的 qrenderdoc。用户开着的 qrenderdoc 有 PID 24528、237204 等。
  - 自己拉起的工作进程要结束时，先核对 PID 和命令行。
- **Python：** 脚本一律落文件，用 `python -X utf8 -I <脚本>` 跑；新工程里用 `uv run`。不要 `python -c`。
- **依赖：** 不要 `deno install`。
- **只读打开 A 盘的 `.rdc`：** 不改、不删、不移动。输出只写 `ignore/wpe-mcp/p1/`。
- **git：** 不提交、不 `git add`。
- **注释用中文，** 和仓库一致。
- **汇报：** 改了哪些文件；每条验收的证据（命令、输出摘要、对照结果）；和本计划不同的地方及原因；没做完的。

## 实施记录

2026-11-09 22:15–22:58，子代理实施。点 1–5 做完，验收 1–7 都过；第 8 条要用户先 `/mcp` 重连，没做。测试脚本与输出都在 `ignore/wpe-mcp/p1/`（`accept_all.sh` 一次跑完 1–5，输出在 `out/accept/`）。

### 做了什么

- **点 1：** `.claude/mcps/wpe-renderdoc/` 按计划的目录建好。
  - `services/`、`utils/`、`LICENSE` 从 `ignore/RenderDocMCP` 拷来，`diff -r -x __pycache__` 逐字节相同；
  - `uv.lock` 先拷旧的再 `uv lock`：只有项目条目从 `renderdoc-mcp 1.0.0` 换成 `wpe-renderdoc-mcp 0.1.0`，91 个依赖版本不变（fastmcp 2.14.2、mcp 1.25.0、pydantic 2.12.5）；
  - 根 `.gitignore` 加 `/.claude/mcps/*/.venv/`；`__pycache__/` 根上已有（第 98 行），没再加。`git check-ignore -v` 核对过，`README.md`、`uv.lock` 不被忽略。
- **点 2：** `context.py`、`worker.py` 新增；`renderdoc_facade.py` 只改 `_invoke`；`request_handler.py` 只加 `close_capture`。
  - 开工前 `grep -rn "ctx\." services/`：服务层用到 `IsCaptureLoaded`、`GetAction`、`GetResourceName`、`GetCaptureFilename`、`LoadCapture` 五个，`Replay` 只有门面用。和计划的清单一致，没有遗漏。
- **点 3：** `mcp_server/replay.py`、`paths.py`。启动清理在 `main()` 里。
- **点 4：** `server.py` 的 19 个工具从旧文件原样拷来，只把 `bridge.call(` 换成 `worker.call(`；另加 `close_capture`、`show_in_renderdoc`、`instructions`、退出钩子。
- **点 5：** `.mcp.json` 加了 `wpe-renderdoc`，旧 `renderdoc` 保留。

### 和计划不同的地方

1. **工作进程多两个环境变量：**
   - `WPE_RD_ROOT`（工程目录）：`qrenderdoc --python` 执行脚本时不一定有 `__file__`；
   - `WPE_RD_MCP_CREATED`（MCP 进程的创建时刻）：打开句柄时核对，防进程号复用。
2. **工作进程加了看门线程。** 主循环在处理长请求时看不到 MCP 退出。看门线程 `WaitForSingleObject(MCP, INFINITE)`，MCP 没了 1 s 主循环还没退，就直接 `os._exit`（不碰 controller）。实测（验收 4 的 F）：MCP 在一个约 17 s 的请求中途被结束，工作进程 1.08 s 后退出。
3. **MCP 没了时工作进程自己删 IPC 目录。** 计划只写了 `ReplayWorker.close()` 删。MCP 被强行结束时 `close()` 不会跑，所以工作进程退出前删；`close()` 与启动清理照计划保留。
4. **正常关闭先发内部消息 `__shutdown__`。** 工作进程收到后关 controller、退出；1.5 s 不退才结束它（结束前核对进程号、映像 `qrenderdoc.exe` 与命令行里的 `worker.py`）。
5. **回应多带 `state.capture`（当前打开的路径）。** 客户端据此在重启时报 `capture_lost`；结果里另加 `restart_reason`。
6. **IPC 目录多一个 `owner.json`**（MCP 进程号与创建时刻）。启动清理据此判断目录所属进程是不是还是原来那个。
7. **拉起工作进程的方式：**
   - `STARTUPINFO` 设成 `SW_HIDE`，加 `CREATE_NO_WINDOW`；
   - stdio 全接 `DEVNULL`，不继承 MCP 的管道；
   - 工作目录设为 RenderDoc 安装目录（设成 IPC 目录的话，退出前删不掉这个目录）；
   - 去掉 `PYTHON*` 环境变量。
8. **`ReplayContext` 两处细节照界面实现，依据是对 qrenderdoc 源码的记忆，本机核对不了。** 能核对的已经核对：从 `renderdoc.chm` 解出的 API 文档（`ignore/wpe-mcp/p1/chm/`）写明 `GetAction` 在 eventId 不是动作时返回 None，`GetResourceName` 没有自定义名字时取抓帧里的名字。两处细节是：
   - `GetResourceName`：空 id 返回 `"No Resource"`，表里没有的 id 返回 `"Unknown Resource <n>"`。服务层调用前都过滤了空 id，三张抓帧上也没遇到表外的 id，所以这两个分支没被走到。正常分支的证据见验收 2；
   - `LoadCapture`：打开后 `SetFrameEvent(最后一个动作)`，照界面加载完选中最后一个动作。只影响没带 `event_id` 的读取，没有和界面直接对照过。
9. **`pyproject.toml`：** 版本 `0.1.0`；去掉了 uv 已弃用的 `dev-dependencies = []`。
10. **验收用的 MCP 客户端：** 大部分脚本用自写的最小 stdio 客户端 `rawmcp.py`（换行分隔的 JSON-RPC），命令同 `.mcp.json`。
    - 原因：`mcp` 包的 `stdio_client` 退出时会连进程树一起结束，盖住 MCP 自己的退出钩子，生命周期没法测；
    - 另用 `mcp` 包的 `ClientSession` + `stdio_client` 跑了一遍 `sdk_client.py`：列工具、`open_capture`、`get_draw_calls`、两次 `get_mesh_data`（含 `gs_out`）、`get_capture_status`，结果与 `rawmcp.py` 一致；`serverInfo` 与 `instructions` 都到了客户端。
11. **`pipeline_service.py` 在源处就是 CRLF，拷贝保持原样。** 仓库 `.gitattributes` 是 `* text=auto eol=lf`，提交时会被转成 LF。之后检出的文件和 `ignore/RenderDocMCP` 的只差换行，`diff --strip-trailing-cr` 相同。
12. **工作进程会写 `renderdoc_worker/**/__pycache__/*.cpython-38.pyc`**，已被忽略。

### 验收证据

**1. 和旧界面桥逐字节一致：过。**
- `rdc_track_mcp.py`：`ignore/p4/rdc_track.py` 只换客户端（`diff` 只差注释、`import`、`McpBridge` 类、输出目录与收尾的 `close`）；
- `rdc_track_b_mcp.py`：`rdc_track_b.py` 同样处理，补一个带几何着色器的标签。

| 标签 | 抓帧目录 | 工程 | 帧 | 结果 |
|---|---|---|---|---|
| fps60 | `A:\p4-0\fps60` | p4-0 | 10 | 相同 |
| fps10 | `A:\p4-0\fps10` | p4-0 | 10 | 相同 |
| p4a2 | `A:\p4a\p4a2` | p4a2 | 4 | 相同 |
| s60 | `A:\p4-0\sweep\fps60` | p4-0 | 8 | 相同 |
| before | `A:\p4-0\pause\before` | p4-0 | 3 | 相同 |
| after | `A:\p4-0\pause\after` | p4-0 | 6 | 相同 |
| p4c-trail-fps60（`_b`） | `A:\p4b\p4c-trail-fps60` | p4c-trail | 3 | 相同 |

- `cmp_tracks.py`：`json.load` 后 `==` 全为 True，逐层比较没有差异；`cmp` 下 7 个文件逐字节相同。
- 选的标签在 A 盘上都在，没有跳过；A 盘上还有别的标签没跑。
- `rdc_track.py` 最后改于 11-07 19:51，晚于 fps60 等轨迹的生成时间（14:15–16:09）。结果仍然相同，说明后来的改动不影响这些输出。

**2. 全部工具冒烟，与直接调 API 交叉核对：过。**
- 脚本 `smoke.py`，参照脚本 `ref_api.py`（在 `qrenderdoc --python` 里直接调 API，不经 services/）；
- 三张抓帧上各调 20 个工具（除 `show_in_renderdoc`），都不报错；
- 每张核对 8 项，全部相同。

| 抓帧 | 选中的绘制 | 动作 / 绘制 | 资源名 | 纹理 | 像素 | 缓冲 |
|---|---|---|---|---|---|---|
| `A:\bedroom\highres\highres-frame1452.rdc`（HDR、泛光） | 21 | 65 / 55 | 33 个 | RT 3840×2160 `R16G16B16A16_FLOAT` | (1920,1080) = 0.70166… | `ResourceId::3523` 64 字节 |
| `A:\p4b\p4c-trail-fps60\p4c-trail-fps60-frame920.rdc`（粒子、GS） | 68 | 19 / 16 | 1 个 | RT 1920×1080 `R8G8B8A8_UNORM` | (960,540) | `ResourceId::798` 64 字节 |
| `A:\wpe-mcp\exp-inject-running\kbt-frame506.rdc` | 20 | 4 / 1 | 1 个 | RT 1280×720 | (640,360) | `ResourceId::74` 64 字节 |

- 8 项核对的内容：
  - `get_frame_summary.total_actions` 等于参照的动作数；
  - `get_draw_calls` 展开后的 eventId 清单等于参照的先序遍历；
  - 纹理数、缓冲数相等；
  - 工具给出的 `resource_name` 都非空，且等于 `GetResources()` 的 name；
  - `get_texture_info` 的尺寸、mip、数组、格式、MSAA、字节数相等；
  - `pick_pixel` 的 float / uint / int 相等；
  - `get_buffer_contents` 的 base64 相等。
- p4c-trail 那张走到了 `get_shader_info(geometry)` 与 `get_mesh_data(gs_out)`（`TriangleList`，6 个顶点）。
- **旁证：** 11-01 旧界面桥对 `highres-frame1452` 的输出（`ignore/p3b/compare/wpe-highres-1452.json`）里有 33 个 `resource_name`。逐个与 `GetResources().name` 比较，33 个都相同（`names_vs_ui.py`），说明界面的 `GetResourceName` 在这类抓帧上就是它。
- 用时（highres）：第一次调用含拉起工作进程 1.8 s，`open_capture` 0.65 s，其余多在 30–130 ms，`save_texture` 0.71 s。

**3. 工具 schema：过。**
- `schema_cmp.py`：子进程里加 `-B` 导入旧 `server.py`（不写字节码），经 fastmcp 内存客户端列工具；新的同样列一遍，再经 stdio 列一遍；
- 19 个共有工具的 `description`、`inputSchema`、`outputSchema`、`annotations`、`_meta` 全部相同；
- 新增的只有 `close_capture`、`show_in_renderdoc`；内存与 stdio 两种列法也相同。

**4. 生命周期：过**（`lifecycle.py`，A–G）。

| 项 | 做法 | 结果 |
|---|---|---|
| A 关 stdin | 正常断开 | MCP 0.23 s 退出；它退出前工作进程已收到 `__shutdown__` 退出，目录已删 |
| B 强行结束 MCP | 结束 MCP 的 python（核对过命令行） | 工作进程 0.08 s 自己退出并删目录 |
| C 结束工作进程 | 核对命令行后结束 qrenderdoc | 下一次 `get_capture_status` 自动拉起，返回 `{"loaded": false, "worker_restarted": true, "capture_lost": "A:\…\kbt-frame506.rdc", "restart_reason": "工作进程 … 已退出（退出码 1）"}`；重新打开后正常 |
| D 超时 | `RENDERDOC_MCP_TIMEOUT=3`，挂起工作进程 | 3.28 s 报 `Request timed out：get_frame_summary 超过 3 s 没有回应，已结束工作进程 …，打开的 … 已丢失`；下一次调用带 `worker_restarted`、`capture_lost`，恢复后正常 |
| E 启动清理 | 伪造进程号不存在的 `ipc/4000000001/`，另放一个名字不是进程号的目录 | 新 MCP 启动时前者被删，后者保留 |
| F 长请求中途结束 MCP | `list_captures` 递归 `C:\Windows\WinSxS`（约 17 s） | 看门线程 1.08 s 后退出，目录已删 |
| G 结束 uv.exe | 结束 `.mcp.json` 拉起的 uv | 客户端还握着管道时 MCP 不退（3 s 内未退，和别的 stdio MCP 一样）；客户端放开管道后 0.26 s 退出，工作进程与目录随之没了 |

- 每次结束前都核对了进程号与命令行，只动自己拉起的进程。跑完没有残留的工作进程和 IPC 目录。
- 工作进程会拉起一个 `renderdoccmd crashhandle` 子进程。工作进程正常退出或被结束后，它都随之退出，查过没有残留。

**5. 并发：过**（`concurrency.py`）。
- A 开 `highres-frame1452`，B 开 `p4c-trail-fps60-frame920`，每边 50 次调用，覆盖 9 种工具；没用 GPU 计时，它每次的值都不同；
- 基准是各自单独开一个 MCP 顺序调一遍。和基准比：
  - 交错（A1 B1 A2 B2 …）：两边 0 处不同；
  - 两个线程同时调（重叠 1.97 s）：两边 0 处不同；
- IPC 目录分别是 `ipc/455224/`、`ipc/469608/`，各自只有 `owner.json`、`ready.json`、`worker.log`；
- 两份 `worker.log` 各记 101 个请求（1 + 50 + 50），没有对方的；关掉后两个目录都没了。

**6. 不弹窗、不碰用户的 RenderDoc：过**（`show_in_renderdoc` 单独说明，见下）。
- 观察器 `exp.py watch` 开了两段：
  - `watch-1-dev.ndjson`：22:23 起 40 分钟，覆盖开发期的全部试跑；
  - `watch-2-accept.ndjson`：22:41 起 12 分钟，覆盖 `accept_all.sh`、`sdk_client.py` 与 G。
- 两段都没有我们的新窗口，前台也没切换过（`show_in_renderdoc` 那几秒除外，见下）：
  - watch-1 开始后 1.06 s 有一条 `new-window`，是 `wetype_renderer.exe`（用户输入法的候选窗），不是我们的；
  - watch-1 在 t≈1717 s（22:54）录到的 qrenderdoc 窗口与前台切换，就是 `show_in_renderdoc` 的单独测试；
  - watch-2 只有 `begin` 和 `end`。
- 工作进程在跑时 `EnumWindows` 找不到属于它的任何顶层窗口，可见与不可见的都没有（`worker_windows.py`），所以没有窗口，也没有任务栏图标（顺带答了 Q6 的这一问）。
- `ready.json`：内嵌 Python 3.8.20，RenderDoc 1.47（`b0e1370`）。
- `%TEMP%\renderdoc_mcp` 前后都是 `2026-11-09 22:02:14.886`、0 个子项，没变。
- 用户的 qrenderdoc 24528、237204 及其 crashhandle（66540、435876），还有 WPE 的 crashhandle 463808，前后一致；旧 `renderdoc-mcp` 的 python 进程没碰。
- `%APPDATA%\qrenderdoc\UI.config`、`analytics.json` 在全部工作进程试跑期间都停在 22:02:03（开工前的修改），所以工作进程不写 RenderDoc 的界面配置。

**`show_in_renderdoc` 单独测**（`show_test.py`，观察器 `watch-3-show.ndjson`，22:53:54–22:55:24）：
- 相对路径、不存在的文件：直接报错（`path must be an absolute path`、`Capture file not found`），不起进程；
- 正常调用：返回 `{"opened": …, "pid": 455228}`，命令行 `qrenderdoc.exe A:\…\kbt-frame506.rdc`；
  - 2.2 s 后出现可见窗口 `RenderDoc v1.47`，加载完标题变成 `kbt-frame506.rdc - RenderDoc v1.47`；
  - 观察器录到一条 `new-window` 和一次前台切到它（预期内）；
  - 关掉 MCP 后它仍在，界面归用户，不跟着 MCP 走；
- 测完核对进程号与命令行（`qrenderdoc.exe <这张 rdc>`，不带 `--python`）后结束了它。它的 crashhandle 随之退出，前台回到 VS Code。
- **副作用（这个工具本身的）：** 这个界面实例在 22:54:00 写了 `UI.config` 与 `analytics.json`。
  - `RecentCaptureFiles` 末尾多了 `A:/wpe-mcp/exp-inject-running/kbt-frame506.rdc`；
  - 文件从 6512 字节变成 6502 字节，看来最旧的一条被挤掉了；
  - 开工前没备份 `UI.config`，被挤掉的是哪条说不出来。用户开着的界面退出时会用它们内存里的列表再写一次。

**7. 范围：过。**
- `git status --short` 里本批的改动只有：
  - ` M .gitignore`
  - ` M .mcp.json`
  - `?? .claude/mcps/`
  - 本计划文件（本来就未跟踪）
- 其余条目开工前就有（plans、`todo.md`、`third/*` 等子模块）；`ignore/wpe-mcp/p1/` 被忽略。
- `snap_tree.py` 前后快照，逐文件比大小、sha256、mtime：
  - `ignore/RenderDocMCP` 69 个文件无改动，`.git/HEAD`、`.git/index` 与 `.venv` 文件数也不变；
  - `.claude/skills/wpe-renderdoc/` 3 个文件无改动。
- `git --no-optional-locks -C ignore/RenderDocMCP status --short` 与开工前相同。

### 没做的、疑问

- **验收 8 没做：** 要用户先 `/mcp` 重连。
- **计划外的两次违规：** 开工初期误敲了一次 `python -X utf8 -I -`（heredoc 是空的，进了交互提示又读到 EOF 退出）和一次 `python -X utf8 -I -c "pass"`。都没执行任何代码，之后没再用。
- **没单独测：** 回应不能序列化时回错误这条，代码照旧桥写了。要触发得在服务层里造不能序列化的结果，没做。
- **`show_in_renderdoc` 会改用户的 RenderDoc 配置：** 新开的界面会把这张抓帧记进最近文件列表（`%APPDATA%\qrenderdoc\UI.config`，用户开着的界面也用这个文件），还会写 `analytics.json`。
  - 单独测时已经发生一次，见验收 6；
  - 要不要在工具说明里写明，或者换个做法（比如另给一份配置目录），请定。

### Claude 独立验收（2026-11-09 22:56–23:10）

- **范围：** `git status` 里本批只有 `.mcp.json`（新增 `wpe-renderdoc`，旧 `renderdoc` 保留）、`.gitignore`（`/.claude/mcps/*/.venv/`）和 `.claude/mcps/`；`git check-ignore` 确认 `.venv/`、`__pycache__/` 被忽略。`services/`、`utils/` 与 `ignore/RenderDocMCP/renderdoc_extension/` 下的 `diff -r` 逐字节相同。
- **重跑验收 1–5：** 先把 `ignore/wpe-mcp/p1/tracks/` 的旧输出移到 `tracks-old-run/`，再跑 `accept_all.sh`（输出 `out/verify/accept_all.log`、`out/accept/*.txt`）：
  - 7 组轨迹与 11-07、11-08 旧界面桥写的 `ignore/p4/tracks/rd-*.json` 全部相同；
  - 3 张抓帧和直接调 API 的 8 项核对全部一致；
  - schema 19 个共有、新增 2 个；
  - 生命周期 A–G 正常，C 报出 `capture_lost` 为 `kbt-frame506.rdc`；
  - 并发交错和同时调用都是 0 处不同；
  - 工作进程没有窗口，crashhandle 子进程随它退出。
- **变异检查**（改完马上还原，已核对文件与备份相同、没有残留标记）：
  - M1 `GetResourceName` 返回空串：冒烟报 3 张抓帧 `resource_names.nonempty` 不一致，被发现；
  - M2 回应不带当前抓帧：生命周期 C 的 `capture_lost` 变成 `null`，但脚本没报错。
  - **测试缺口：** `smoke.py`、`lifecycle.py` 出错时退出码仍是 0，只打印结果，要人看输出判断。第 2 批起验收脚本要带断言、失败返回非 0。
- **不弹窗：** 整个重跑和变异期间开着观察器（`out/verify/watch.ndjson`），没有新的可见顶层窗口，前台没变。
- **代码审读：** `replay.py` 只结束自己 `Popen` 的进程，结束前用句柄核对进程号、映像和命令行；残留目录只删名字是进程号、所属进程已不在的；`worker.py` 所有退出路径都走 `os._exit`，异常不会回到 qrenderdoc 去打开界面。
- **`show_in_renderdoc`：** 保留，工具说明里写明会把文件加进用户 RenderDoc 的最近文件列表（和用户自己打开文件效果相同）。单测时被挤掉的那条旧记录无法恢复，已报用户。
- **验收 8（端到端）：** 用户 `/mcp` 重连后，在 Claude Code 里经 `mcp__wpe-renderdoc__open_capture` 打开 `A:\p4b\p4c-trail-fps60\p4c-trail-fps60-frame920.rdc`，`get_draw_calls(flags_filter=["Drawcall"])` 的前 5 个绘制、`get_mesh_data(68, "gs_out")` 的 6 个顶点 3 列，与验收 2 的冒烟记录相同（`ignore/wpe-mcp/p1/out/e2e/cmp.py`）。后变换缓冲的资源号不同（`…352` 对 `…534`），是回放时临时建的缓冲，每次回放编号不同。本会话的 MCP（PID 386936）拉起了自己的回放进程 469356；用户的 RenderDoc 界面 24528、237204 不受影响。
