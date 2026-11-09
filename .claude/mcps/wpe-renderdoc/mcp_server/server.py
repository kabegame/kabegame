"""
wpe-renderdoc MCP 服务端。

19 个回放工具的名字、参数、缺省值与说明照旧 renderdoc MCP（ignore/RenderDocMCP/mcp_server/server.py）
原样搬来，后端从「界面里的扩展」改成本 MCP 自己拉起的常驻回放进程（replay.ReplayWorker）。
另加 close_capture、show_in_renderdoc。
第 2 批加 WPE 一侧（mcp_server/wpe/）：ensure_running、自己的测试窗口、配置、日志、状态。抓帧工具在后续批次。
"""

import atexit
import os
import subprocess
import threading
from typing import Any, Literal

from fastmcp import FastMCP

from . import paths
from .replay import (
    CREATE_BREAKAWAY_FROM_JOB,
    CREATE_NEW_PROCESS_GROUP,
    DETACHED_PROCESS,
    ReplayWorker,
    cleanup_stale,
)
from .wpe import ensure as wpe_ensure
from .wpe import log as wpe_log
from .wpe import session as wpe_session

INSTRUCTIONS = """\
读 RenderDoc 抓帧（.rdc）做回放分析，并管理常驻共享的 Wallpaper Engine（WPE）与本会话的测试窗口，\
给 WPE 的对照工作流用。

回放：
- 和旧的 `renderdoc` MCP 的区别：不用开 RenderDoc 界面，也不经界面里的扩展。每个会话的 MCP 自己拉起\
一个没有窗口的常驻回放进程（qrenderdoc --python），IPC 目录按 MCP 进程私有，所以多个会话可以同时打开\
不同的 rdc 分析，互不干扰，也不会替换用户在 RenderDoc 界面里正在看的抓帧。
- 两边工具同名时（get_draw_calls、get_mesh_data、get_pipeline_state 等），读 rdc 优先用这边。
- 用法：open_capture(绝对路径) 后调各个读取工具，用完 close_capture；打开新的会关掉旧的。
- 回放进程意外退出或超时（默认 120 s，环境变量 RENDERDOC_MCP_TIMEOUT）会被结束，下一次调用自动重新\
拉起，结果里带 worker_restarted 和 capture_lost（丢掉的抓帧路径），这时要重新 open_capture。
- show_in_renderdoc 会弹出 RenderDoc 界面、抢焦点，只在用户明确要求在 RenderDoc 里看时用。

WPE（用户正在用、各会话共享的那一个）：
- 常驻、不关不杀：ensure_running 确保 WPE 在跑且已注入 RenderDoc（没在跑就 -silent 普通启动、等桌面壁纸出来\
再注入；在跑没注入就原地注入；已注入不动）。MCP 从不强杀 WPE，也不在退出时关它。
- 只开关自己的窗口：open_wallpaper 开的测试窗口叫 kb-<MCP 进程号>-<序号>，登记在机器级窗口表里；\
close_wallpaper / apply_properties 只对自己的窗口。别的会话的窗口、外来窗口（表里没有的）不碰；\
所属进程已不在的陈旧窗口，ensure_running / status 会顺手关掉。同一时刻不允许两个同尺寸的测试窗口。\
桌面壁纸一律不碰。MCP 退出时关掉自己的窗口。
- 设置：get_settings 只读 config.json。WPE 只在启动时读这个文件，改设置只能 restart_wpe(settings)：\
正常退出 → 改文件 → 启动 → 注入，桌面空几秒；只在没有别的会话的窗口、没有外来窗口、设置界面没开着时做。\
设置不还原，改了哪些键结果里逐项报出。
- 日志：log_mark 取游标，log_since 读之后的新行。log.txt 各会话共用、行里不带窗口名；游标失效（日志被重写）\
会报出来，不静默从头读。
- cleanup_project 只删仓库 ignore/ 下测试工程里 WPE 写的 shaders/blobsSM40。
- 抓帧（连 RenderDoc 目标、触发抓取）的工具在后续批次，现在还没有；要抓帧仍用 wpe-renderdoc skill。
"""

# Initialize FastMCP server
mcp = FastMCP(
    name="WPE RenderDoc MCP Server",
    instructions=INSTRUCTIONS,
)

# 本 MCP 私有的回放工作进程，第一次调用时拉起
worker = ReplayWorker()


@mcp.tool
def get_capture_status() -> dict:
    """
    Check if a capture is currently loaded in RenderDoc.
    Returns the capture status and API type if loaded.
    """
    return worker.call("get_capture_status")


@mcp.tool
def get_draw_calls(
    include_children: bool = True,
    marker_filter: str | None = None,
    exclude_markers: list[str] | None = None,
    event_id_min: int | None = None,
    event_id_max: int | None = None,
    only_actions: bool = False,
    flags_filter: list[str] | None = None,
) -> dict:
    """
    Get the list of all draw calls and actions in the current capture.

    Args:
        include_children: Include child actions in the hierarchy (default: True)
        marker_filter: Only include actions under markers containing this string (partial match)
        exclude_markers: Exclude actions under markers containing these strings (list of partial matches)
        event_id_min: Only include actions with event_id >= this value
        event_id_max: Only include actions with event_id <= this value
        only_actions: If True, exclude marker actions (PushMarker/PopMarker/SetMarker)
        flags_filter: Only include actions with these flags (list of flag names, e.g. ["Drawcall", "Dispatch"])

    Returns a hierarchical tree of actions including markers, draw calls,
    dispatches, and other GPU events.
    """
    params: dict[str, object] = {"include_children": include_children}
    if marker_filter is not None:
        params["marker_filter"] = marker_filter
    if exclude_markers is not None:
        params["exclude_markers"] = exclude_markers
    if event_id_min is not None:
        params["event_id_min"] = event_id_min
    if event_id_max is not None:
        params["event_id_max"] = event_id_max
    if only_actions:
        params["only_actions"] = only_actions
    if flags_filter is not None:
        params["flags_filter"] = flags_filter
    return worker.call("get_draw_calls", params)


@mcp.tool
def get_frame_summary() -> dict:
    """
    Get a summary of the current capture frame.

    Returns statistics about the frame including:
    - API type (D3D11, D3D12, Vulkan, etc.)
    - Total action count
    - Statistics: draw calls, dispatches, clears, copies, presents, markers
    - Top-level markers with event IDs and child counts
    - Resource counts: textures, buffers
    """
    return worker.call("get_frame_summary")


@mcp.tool
def find_draws_by_shader(
    shader_name: str,
    stage: Literal["vertex", "hull", "domain", "geometry", "pixel", "compute"] | None = None,
) -> dict:
    """
    Find all draw calls using a shader with the given name (partial match).

    Args:
        shader_name: Partial name to search for in shader names or entry points
        stage: Optional shader stage to search (if not specified, searches all stages)

    Returns a list of matching draw calls with event IDs and match reasons.
    """
    params: dict[str, object] = {"shader_name": shader_name}
    if stage is not None:
        params["stage"] = stage
    return worker.call("find_draws_by_shader", params)


@mcp.tool
def find_draws_by_texture(texture_name: str) -> dict:
    """
    Find all draw calls using a texture with the given name (partial match).

    Args:
        texture_name: Partial name to search for in texture resource names

    Returns a list of matching draw calls with event IDs and match reasons.
    Searches SRVs, UAVs, and render targets.
    """
    return worker.call("find_draws_by_texture", {"texture_name": texture_name})


@mcp.tool
def find_draws_by_resource(resource_id: str) -> dict:
    """
    Find all draw calls using a specific resource ID (exact match).

    Args:
        resource_id: Resource ID to search for (e.g. "ResourceId::12345" or "12345")

    Returns a list of matching draw calls with event IDs and match reasons.
    Searches shaders, SRVs, UAVs, render targets, and depth targets.
    """
    return worker.call("find_draws_by_resource", {"resource_id": resource_id})


@mcp.tool
def get_draw_call_details(event_id: int) -> dict:
    """
    Get detailed information about a specific draw call.

    Args:
        event_id: The event ID of the draw call to inspect

    Includes vertex/index counts, resource outputs, and other metadata.
    """
    return worker.call("get_draw_call_details", {"event_id": event_id})


@mcp.tool
def get_action_timings(
    event_ids: list[int] | None = None,
    marker_filter: str | None = None,
    exclude_markers: list[str] | None = None,
) -> dict:
    """
    Get GPU timing information for actions (draw calls, dispatches, etc.).

    Args:
        event_ids: Optional list of specific event IDs to get timings for.
                   If not specified, returns timings for all actions.
        marker_filter: Only include actions under markers containing this string (partial match).
        exclude_markers: Exclude actions under markers containing these strings.

    Returns timing data including:
    - available: Whether GPU timing counters are supported
    - unit: Time unit (typically "seconds")
    - timings: List of {event_id, name, duration_seconds, duration_ms}
    - total_duration_ms: Sum of all durations
    - count: Number of timing entries

    Note: GPU timing counters may not be available on all hardware/drivers.
    """
    params: dict[str, object] = {}
    if event_ids is not None:
        params["event_ids"] = event_ids
    if marker_filter is not None:
        params["marker_filter"] = marker_filter
    if exclude_markers is not None:
        params["exclude_markers"] = exclude_markers
    return worker.call("get_action_timings", params)


@mcp.tool
def get_shader_info(
    event_id: int,
    stage: Literal["vertex", "hull", "domain", "geometry", "pixel", "compute"],
) -> dict:
    """
    Get shader information for a specific stage at a given event.

    Args:
        event_id: The event ID to inspect the shader at
        stage: The shader stage (vertex, hull, domain, geometry, pixel, compute)

    Returns shader disassembly, constant buffer values, and resource bindings.
    """
    return worker.call("get_shader_info", {"event_id": event_id, "stage": stage})


@mcp.tool
def get_buffer_contents(
    resource_id: str,
    offset: int = 0,
    length: int = 0,
    event_id: int | None = None,
    output_path: str | None = None,
    max_bytes: int | None = None,
) -> dict:
    """
    Read the contents of a buffer resource.

    Args:
        resource_id: The resource ID of the buffer to read
        offset: Byte offset to start reading from (default: 0)
        length: Number of bytes to read, 0 for entire buffer (default: 0)
        event_id: Move replay to this event first. Dynamic buffers change within a frame;
            without it the read sees whatever event replay was last moved to
        output_path: Absolute path to write the raw bytes to, instead of returning them
        max_bytes: Inline size limit (default: 64 KiB). Larger reads need output_path

    Returns buffer data as base64-encoded bytes along with metadata.
    """
    params: dict = {"resource_id": resource_id, "offset": offset, "length": length}
    if event_id is not None:
        params["event_id"] = event_id
    if output_path is not None:
        params["output_path"] = output_path
    if max_bytes is not None:
        params["max_bytes"] = max_bytes
    return worker.call("get_buffer_contents", params)


@mcp.tool
def get_mesh_data(
    event_id: int,
    stage: Literal["vs_in", "vs_out", "gs_out"] = "vs_in",
    first: int = 0,
    count: int = 0,
    instance: int = 0,
    output_path: str | None = None,
    max_vertices: int | None = None,
) -> dict:
    """
    Decode the vertices of a draw, one column per attribute.

    Args:
        event_id: The event ID of the draw call
        stage: vs_in (vertex buffers), vs_out or gs_out (post-transform data)
        first: First vertex to return, in draw order (default: 0)
        count: Number of vertices, 0 for all (default: 0)
        instance: Instance to read (default: 0)
        output_path: Absolute path to write every selected vertex to as JSON, instead of
            returning them
        max_vertices: Inline limit (default: 64); the result is cut and flagged truncated

    Returns topology, total vertex count, attribute layout, and the values per attribute.
    """
    params: dict = {
        "event_id": event_id,
        "stage": stage,
        "first": first,
        "count": count,
        "instance": instance,
    }
    if output_path is not None:
        params["output_path"] = output_path
    if max_vertices is not None:
        params["max_vertices"] = max_vertices
    return worker.call("get_mesh_data", params)


@mcp.tool
def get_texture_info(resource_id: str) -> dict:
    """
    Get metadata about a texture resource.

    Args:
        resource_id: The resource ID of the texture

    Includes dimensions, format, mip levels, and other properties.
    """
    return worker.call("get_texture_info", {"resource_id": resource_id})


@mcp.tool
def get_texture_data(
    resource_id: str,
    mip: int = 0,
    slice: int = 0,
    sample: int = 0,
    depth_slice: int | None = None,
    event_id: int | None = None,
    max_bytes: int = 65536,
) -> dict:
    """
    Read the pixel data of a small texture resource.

    Args:
        resource_id: The resource ID of the texture to read
        mip: Mip level to retrieve (default: 0)
        slice: Array slice or cube face index (default: 0)
               For cube maps: 0=X+, 1=X-, 2=Y+, 3=Y-, 4=Z+, 5=Z-
        sample: MSAA sample index (default: 0)
        depth_slice: For 3D textures only, extract a specific depth slice (default: None = full volume)
                     When specified, returns only the 2D slice at that depth index
        event_id: Replay to this event first (default: None = whatever event is current).
                  Render target contents depend on the event, so pass it when reading RTs.
        max_bytes: Refuse when the raw data is larger (default: 64 KiB; 0 = no limit).
                   For large textures use save_texture, pick_pixel or get_texture_stats.

    Returns texture pixel data as base64-encoded bytes along with metadata
    including dimensions at the requested mip level and format information.
    """
    params = {
        "resource_id": resource_id,
        "mip": mip,
        "slice": slice,
        "sample": sample,
        "max_bytes": max_bytes,
    }
    if depth_slice is not None:
        params["depth_slice"] = depth_slice
    if event_id is not None:
        params["event_id"] = event_id
    return worker.call("get_texture_data", params)


@mcp.tool
def save_texture(
    resource_id: str,
    output_path: str,
    event_id: int | None = None,
    mip: int = 0,
    slice: int = 0,
    sample: int = 0,
    file_type: Literal["png", "exr", "dds", "hdr", "jpg", "bmp", "tga"] | None = None,
    alpha: Literal["preserve", "discard"] = "preserve",
) -> dict:
    """
    Save a texture subresource (as of an event) to an image file on disk.

    Args:
        resource_id: The resource ID of the texture
        output_path: Absolute path of the file to write (parent directories are created)
        event_id: Replay to this event first (default: None = current event).
                  Pass it for render targets: their contents change from event to event.
        mip: Mip level (default: 0)
        slice: Array slice or cube face index (default: 0)
        sample: MSAA sample index (default: 0)
        file_type: Output format; defaults to the extension of output_path (png if none).
                   Use exr to keep float render targets (RGBA16F etc.) exact; png/jpg clamp to [0, 1].
        alpha: Keep the alpha channel ("preserve") or drop it ("discard").
               Formats without alpha (jpg, bmp, hdr) always discard.

    Returns the written path, dimensions, source format and file size.
    """
    params = {
        "resource_id": resource_id,
        "output_path": output_path,
        "mip": mip,
        "slice": slice,
        "sample": sample,
        "alpha": alpha,
    }
    if event_id is not None:
        params["event_id"] = event_id
    if file_type is not None:
        params["file_type"] = file_type
    return worker.call("save_texture", params)


@mcp.tool
def pick_pixel(
    resource_id: str,
    x: int,
    y: int,
    event_id: int | None = None,
    mip: int = 0,
    slice: int = 0,
    sample: int = 0,
) -> dict:
    """
    Read a single texel of a texture (as of an event).

    Args:
        resource_id: The resource ID of the texture
        x, y: Pixel coordinates at the given mip level, origin top-left
        event_id: Replay to this event first (default: None = current event)
        mip: Mip level (default: 0)
        slice: Array slice or cube face index (default: 0)
        sample: MSAA sample index (default: 0)

    Returns the texel as float / uint / int 4-vectors (use the one matching the format).
    """
    params = {"resource_id": resource_id, "x": x, "y": y, "mip": mip, "slice": slice, "sample": sample}
    if event_id is not None:
        params["event_id"] = event_id
    return worker.call("pick_pixel", params)


@mcp.tool
def get_texture_stats(
    resource_id: str,
    event_id: int | None = None,
    mip: int = 0,
    slice: int = 0,
    sample: int = 0,
) -> dict:
    """
    Get per-channel minimum and maximum of a texture subresource (as of an event).

    Args:
        resource_id: The resource ID of the texture
        event_id: Replay to this event first (default: None = current event)
        mip: Mip level (default: 0)
        slice: Array slice or cube face index (default: 0)
        sample: MSAA sample index (default: 0)

    Useful to check value ranges (e.g. whether an HDR target exceeds 1.0) without
    transferring pixel data.
    """
    params = {"resource_id": resource_id, "mip": mip, "slice": slice, "sample": sample}
    if event_id is not None:
        params["event_id"] = event_id
    return worker.call("get_texture_stats", params)


@mcp.tool
def get_pipeline_state(event_id: int) -> dict:
    """
    Get the full graphics pipeline state at a specific event.

    Args:
        event_id: The event ID to get pipeline state at

    Returns detailed pipeline state including:
    - Bound shaders with entry points for each stage
    - Shader resources (SRVs): textures and buffers with dimensions, format, slot, name
    - UAVs (RWTextures/RWBuffers): resource details with dimensions and format
    - Samplers: addressing modes, filter settings, LOD parameters
    - Constant buffers: slot, size, variable count
    - Render targets and depth target
    - Viewports and input assembly state
    """
    return worker.call("get_pipeline_state", {"event_id": event_id})


@mcp.tool
def list_captures(directory: str, recursive: bool = False) -> dict:
    """
    List all RenderDoc capture files (.rdc) in the specified directory.

    Args:
        directory: The directory path to search for capture files
        recursive: Also search subdirectories (default: False)

    Returns a list of capture files with their metadata including:
    - filename: The capture file name
    - path: Full path to the file
    - size_bytes: File size in bytes
    - modified_time: Last modified timestamp (ISO format)
    """
    return worker.call("list_captures", {"directory": directory, "recursive": recursive})


@mcp.tool
def open_capture(capture_path: str) -> dict:
    """
    Open a RenderDoc capture file (.rdc).

    Args:
        capture_path: Full path to the capture file to open

    Returns success status and information about the opened capture.
    Note: This will close any currently open capture.
    """
    return worker.call("open_capture", {"capture_path": capture_path})


@mcp.tool
def close_capture() -> dict:
    """
    Close the capture opened in this session's replay process.

    Frees the replay's memory; the replay process itself stays up for the next open_capture.

    Returns success status and the path that was closed (null if nothing was open).
    """
    return worker.call("close_capture")


@mcp.tool
def show_in_renderdoc(path: str) -> dict:
    """
    Open a capture file (.rdc) in a new RenderDoc window, for the user to look at.

    This pops up the RenderDoc UI (a new window that takes focus): only use it when the user
    explicitly asks to see the capture in RenderDoc. Analysis goes through the other tools, which
    need no window. It does not touch this session's replay process or the open capture.
    Like opening the file by hand, the new window adds it to the user's RenderDoc recent-files list
    (%APPDATA%\\qrenderdoc\\UI.config, shared with any RenderDoc window the user has open).

    Args:
        path: Absolute path of the .rdc file

    Returns the path and the process id of the new RenderDoc window.
    """
    if not os.path.isabs(path):
        raise ValueError("path must be an absolute path: %s" % path)
    if not os.path.isfile(path):
        raise ValueError("Capture file not found: %s" % path)
    if not path.lower().endswith(".rdc"):
        raise ValueError("Invalid file type. Expected .rdc file: %s" % path)
    qrenderdoc = paths.qrenderdoc()
    # 界面归用户：脱离本 MCP（不继承 stdio，尽量脱离 uv 的作业对象），MCP 退出时不跟着关
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    args = dict(cwd=paths.renderdoc_dir(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, close_fds=True)
    try:
        proc = subprocess.Popen([qrenderdoc, path], creationflags=flags | CREATE_BREAKAWAY_FROM_JOB, **args)
    except OSError:
        # 所在作业不允许脱离时退回普通启动
        proc = subprocess.Popen([qrenderdoc, path], creationflags=flags, **args)
    return {"opened": path, "pid": proc.pid}


# ==================== WPE（第 2 批） ====================


@mcp.tool
def ensure_running() -> dict:
    """
    确保用户的 WPE 在跑、已注入 RenderDoc（只注入，不连抓帧目标）。

    - 没在跑：崩溃标记（faultyShutdown）为 1 就先写 0（免得弹「上次可能崩溃」），WMI 普通启动 -silent，
      等桌面壁纸窗口出现再稳 2 s，然后注入；
    - 在跑没注入：renderdoccmd inject --PID 原地注入，PID 不变；
    - 已注入：不动。
    顺手关掉陈旧窗口（所属 MCP 已不在）。旧 wpe-renderdoc skill 的会话在时拒绝。

    返回做了哪几步（steps）、WPE 的 PID、是否清了标记、关了哪些陈旧窗口、外来窗口有哪些。
    """
    return wpe_ensure.ensure_running()


@mcp.tool
def open_wallpaper(project: str, size: str = "1280x720", wait: float = 20) -> dict:
    """
    在本会话自己的测试窗口里打开一个工程（-playInWindow），先 ensure_running。

    Args:
        project: 工程目录、project.json、工坊 ID、默认工程名（如 shimmering_particles）或 myprojects 里的名字
        size: 客户区尺寸「宽x高」，物理像素。已有同尺寸的测试窗口（别的会话的或外来的）时拒绝，并报出是谁
        wait: 等窗口出现的秒数

    返回窗口名（kb-<MCP 进程号>-<序号>）、hwnd、窗口与客户区矩形（物理像素）、开窗前的日志游标（给 log_since），
    以及前台有没有被它拿走。
    """
    return wpe_session.open_wallpaper(project, size, wait, ensure=wpe_ensure.ensure_running)


@mcp.tool
def close_wallpaper(window: str) -> dict:
    """
    关掉本会话自己的测试窗口（closeWallpaper -location），等窗口消失，再从窗口表删掉。

    Args:
        window: open_wallpaper 返回的窗口名。别的会话的、外来的窗口一律拒绝
    """
    return wpe_session.close_wallpaper(window)


@mcp.tool
def apply_properties(window: str, props: dict[str, Any]) -> dict:
    """
    运行中改本会话自己窗口的壁纸属性（-control applyProperties ... RAW~(json)~END）。

    Args:
        window: 本会话的窗口名
        props: {属性名: 值}，颜色写成 "r g b" 字符串
    """
    return wpe_session.apply_properties(window, props)


@mcp.tool
def windows() -> dict:
    """
    列出桌面壁纸窗口和全部测试窗口：名字、hwnd、窗口与客户区矩形（物理像素）、所属
    （mine 本会话 / other 别的会话 / stale 陈旧 / foreign 外来）。只读，不关任何窗口。
    """
    return wpe_session.list_windows()


@mcp.tool
def get_settings() -> dict:
    """
    只读 WPE 的 config.json：当前用户段 general.user 下清单里的键（fps、postprocessing、msaa、分辨率、
    各类暂停策略等，附取值范围与生效类别）、崩溃标记、选中的壁纸、设置界面是否开着、上次备份以来改过的键。
    WPE 只在启动时读这个文件；设置界面开着时文件可能落后于 WPE 内存里的值，结果里会注明。
    """
    return wpe_ensure.get_settings()


@mcp.tool
def restart_wpe(settings: dict[str, Any] | None = None) -> dict:
    """
    重启 WPE，可顺带改设置：正常退出（托盘「退出」同一条命令）→ 改 config.json → -silent 启动 → 注入。
    桌面会空几秒；所有测试窗口都会被关掉，所以只在这些都满足时才做，否则拒绝并报原因：
    窗口表里没有别的会话的窗口、没有外来窗口、WPE 的设置界面没开着、旧 skill 会话不在、settings 合法。
    20 s 内退不掉就报失败：不强杀、不改文件。设置不还原；第一次改之前在
    .kabegame/debug/wpe-renderdoc-mcp/ 留一份 config 备份。

    Args:
        settings: {键: 值}，键是 get_settings 列出的名字（如 {"fps": 30}）。不给就是一次干净的重启
            （去掉注入的 DLL、重建桌面设备，然后重新注入）

    返回改了哪些键（旧值、新值）、退出与启动的耗时、退出前后 config.json 的哈希核对、崩溃标记、注入状态。
    """
    return wpe_ensure.restart_wpe(settings)


@mcp.tool
def status() -> dict:
    """
    WPE 进程（命令行、创建时刻、完整性级别、是否已注入）、崩溃标记、桌面壁纸窗口、窗口表（含所属与陈旧）、
    外来窗口、设置界面是否开着、旧 skill 会话是否存在。顺手关掉陈旧窗口（结果里的 stale_closed）。
    """
    return wpe_ensure.status()


@mcp.tool
def log_mark() -> dict:
    """WPE log.txt 的当前游标（交给 log_since）。open_wallpaper 的结果里也带一个开窗前的游标。"""
    return wpe_log.mark()


@mcp.tool
def log_since(mark: dict[str, Any], grep: str | None = None, errors: bool = False) -> dict:
    """
    读游标之后 log.txt 新增的完整行。

    Args:
        mark: log_mark / open_wallpaper 返回的游标
        grep: 只要匹配这个正则（区分大小写）的行
        errors: 只要含 error / fail 的行（不区分大小写）

    日志各会话共用、行里不带窗口名，别的会话同时开着窗口时会混进它们的行。日志被重写（文件变小、创建时刻或
    开头变了）时报 rewritten，不从头读；结果里的 next 是下一次用的游标。
    """
    return wpe_log.since(mark, grep=grep, errors=errors)


@mcp.tool
def cleanup_project(path: str) -> dict:
    """
    删掉 WPE 编译着色器时写进测试工程的 shaders/blobsSM40。只限仓库 ignore/ 下的工程目录（路径规范化后判断），
    工程正开在某个测试窗口里时拒绝。

    Args:
        path: 工程目录或它的 project.json 的绝对路径
    """
    return wpe_session.cleanup_project(path)


_exit_lock = threading.Lock()
_exited = False


def _on_exit() -> None:
    """退出钩子：先关本会话的测试窗口（WPE 不动），再停回放进程。可重复调用。"""
    global _exited
    with _exit_lock:
        if _exited:
            return
        _exited = True
    try:
        wpe_session.close_all_mine()
    except Exception:
        pass
    worker.close()


def main():
    """Run the MCP server"""
    # 上次没来得及清理的 IPC 目录（所属 MCP 已不在）
    cleanup_stale()
    # 退出钩子：stdin 关闭时 FastMCP 的 stdio 循环结束、mcp.run() 返回，走 finally；
    # 别的正常退出路径走 atexit。被强行结束时两者都不跑：工作进程握着本进程的句柄，会自己退出并删目录；
    # 本会话的测试窗口变成陈旧窗口，由别的 MCP 的 ensure_running / status 关掉
    atexit.register(_on_exit)
    try:
        mcp.run()
    finally:
        _on_exit()


if __name__ == "__main__":
    main()
