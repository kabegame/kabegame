# wpe-renderdoc MCP

读 RenderDoc 抓帧（`.rdc`）做回放分析的 MCP，给 Wallpaper Engine 的对照工作流用。计划见
`.claude/plans/tools/wpe-renderdoc-mcp.md`（总计划）与 `wpe-renderdoc-mcp-p1.md`（第 1 批）。

## 来源

- 上游：[halby24/RenderDocMCP](https://github.com/halby24/RenderDocMCP) `11b6b743a4c02c94eb8a1125a1e025dbd021352a`（MIT，见 `LICENSE`）。
- 从仓库里的 `ignore/RenderDocMCP`（上游加本地改动）拷来，原处不动，旧的 `renderdoc` MCP 继续用它。
- **以后不跟上游。** 上游的新功能要手工合进来。

### 拷来时已有的本地改动（相对上游 `11b6b74`）

`git -C ignore/RenderDocMCP diff --stat`：

```text
 mcp_server/bridge/client.py                      |   51 +-
 mcp_server/server.py                             |  181 +++-
 renderdoc_extension/renderdoc_facade.py          |   64 +-
 renderdoc_extension/request_handler.py           |   97 ++-
 renderdoc_extension/services/__init__.py         |    2 +
 renderdoc_extension/services/capture_manager.py  |   16 +-
 renderdoc_extension/services/pipeline_service.py | 1016 +++++++++++++---------
 renderdoc_extension/services/resource_service.py |  340 +++++++-
 renderdoc_extension/services/search_service.py   |   59 +-
 renderdoc_extension/socket_server.py             |   18 +-
 renderdoc_extension/utils/serializers.py         |   44 +-
 11 files changed, 1337 insertions(+), 551 deletions(-)
```

另有两个新文件：`renderdoc_extension/services/mesh_service.py`（`get_mesh_data`）、`scripts/replay_check.py`（脱离界面跑服务层的检查脚本，没拷过来）。
大致内容：`get_mesh_data`、`save_texture`、`pick_pixel`、`get_texture_stats`；`get_buffer_contents` / `get_texture_data` 的 `event_id` 与大小上限；`list_captures` 的 `recursive`；
常量缓冲按类型解码、标出着色器没读的常量；RenderDoc 1.32+ 的管线状态接口；IPC 回应原子替换、不能序列化时回错误、请求串行。

### 本目录相对 `ignore/RenderDocMCP` 的改动

- `renderdoc_worker/services/`、`renderdoc_worker/utils/`：原样拷来，逐字节相同（`pipeline_service.py` 在源处就是 CRLF）。
- `renderdoc_worker/renderdoc_facade.py`：只改 `_invoke`，直接把 controller 交给回调。
- `renderdoc_worker/request_handler.py`：加 `close_capture`。
- 新增 `renderdoc_worker/context.py`（ctx 垫片）、`renderdoc_worker/worker.py`（常驻循环）。
- `mcp_server/server.py`：19 个工具的名字、参数、缺省值与说明不变，后端改调 `mcp_server/replay.py`；另加 `close_capture`、`show_in_renderdoc`。
- 新增 `mcp_server/replay.py`（工作进程客户端）、`mcp_server/paths.py`。
- 不拷：界面扩展部分（`renderdoc_extension/__init__.py`、`socket_server.py`、`extension.json`）、`scripts/install_extension.py`、`mcp_server/bridge/`、`mcp_server/config.py`。

## 结构

```text
mcp_server/          MCP 服务端（uv 的 Python ≥ 3.10）
  server.py          工具注册
  replay.py          工作进程客户端：拉起、请求、超时与退出后重启、退出时关闭
  paths.py           仓库根、状态目录、qrenderdoc / WPE 位置
  wpe/               第 2 批：常驻共享的 WPE（ensure_running、restart_wpe）、本会话的测试窗口与机器级窗口表、
                     config.json 读写、log.txt 游标（计划见 wpe-renderdoc-mcp-p2.md）
renderdoc_worker/    在 qrenderdoc --python 里跑（RenderDoc 内嵌的 Python 3.8）
  worker.py          常驻循环
  context.py         ctx 垫片：服务层用到的 CaptureContext 子集，背后是裸 ReplayController
  request_handler.py renderdoc_facade.py services/ utils/
```

## 工作方式

- 第一次调用工具时，MCP 拉起 `qrenderdoc --python renderdoc_worker/worker.py`。`--python` 的脚本在主界面出现之前运行，
  脚本不返回，界面就不会出现，所以这个进程没有窗口，也不碰用户开着的 RenderDoc。
- 每个 MCP 进程一个私有 IPC 目录 `.kabegame/debug/wpe-renderdoc-mcp/ipc/<MCP 进程号>/`：
  `request.json` / `response.json`（都先写 `.tmp` 再 `os.replace`）、`ready.json`、`owner.json`、`worker.log`。
- 工作进程握着 MCP 进程的句柄，MCP 没了就自己退出并删掉这个目录；MCP 正常退出时也会关掉它、删目录。
  MCP 启动时删掉所属进程已不在的残留目录。
- 超时（默认 120 s，`RENDERDOC_MCP_TIMEOUT`）或工作进程退出：结束这个进程，下次调用重新拉起，
  结果里带 `worker_restarted`、`capture_lost`、`restart_reason`。
- RenderDoc 安装目录取环境变量 `RENDERDOC_DIR`，缺省 `C:\Program Files\RenderDoc`。

入口在仓库根的 `.mcp.json`：

```json
"wpe-renderdoc": { "command": "uv", "args": ["--directory", ".claude/mcps/wpe-renderdoc", "run", "wpe-renderdoc-mcp"] }
```
