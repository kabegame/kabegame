"""
回放工作进程：在 MCP 自己拉起的 `qrenderdoc --python worker.py` 里常驻。

- 参数走环境变量（mcp_server/replay.py 设置）：
  - WPE_RD_ROOT：本工程目录（.claude/mcps/wpe-renderdoc），用来 import renderdoc_worker；
  - WPE_RD_IPC_DIR：私有 IPC 目录 .kabegame/debug/wpe-renderdoc-mcp/ipc/<MCP 进程号>/；
  - WPE_RD_MCP_PID、WPE_RD_MCP_CREATED：MCP 进程号与它的创建时刻（FILETIME），防进程号复用。
- --python 的脚本在主界面出现之前运行。这个脚本永不返回，界面就不会出现；
  所以任何退出路径都走 os._exit，不能把异常抛回 qrenderdoc（那样它会接着打开主界面）。
- 文件协议沿用旧桥（socket_server.py），但目录私有、不要锁文件：
  请求 request.json、回应 response.json，都由写方先写 .tmp 再 os.replace，一次只有一个请求在途。
  回应额外带 state.capture（当前打开的路径），客户端据此知道重启时丢了哪张抓帧。
- 每轮用 WaitForSingleObject(MCP 句柄, 20 ms) 兼作休眠：MCP 没了就关掉 controller、删 IPC 目录、退出。
  主循环在处理长请求时看不到这一点，另有一个看门线程兜底：MCP 没了 1 s 主循环还没退，就直接退出。
  不能用 os.kill(pid, 0) 探活：Windows 上它会 TerminateProcess 把对方结束掉。
- 界面程序看不到 stdout，输出写同目录的 worker.log。

要兼容 RenderDoc 内嵌的 Python 3.8：不用 match、不用运行期求值的 `X | None` 注解。
"""

import ctypes
import json
import os
import shutil
import sys
import threading
import time
import traceback

IPC_DIR = os.environ.get("WPE_RD_IPC_DIR", "")
REQUEST_FILE = os.path.join(IPC_DIR, "request.json")
RESPONSE_FILE = os.path.join(IPC_DIR, "response.json")
READY_FILE = os.path.join(IPC_DIR, "ready.json")
LOG_FILE = os.path.join(IPC_DIR, "worker.log")

# 内部控制消息：客户端正常关闭时发，不经 RequestHandler
SHUTDOWN_METHOD = "__shutdown__"

SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
WAIT_TIMEOUT = 0x102
INFINITE = 0xFFFFFFFF
POLL_MS = 20
# 看门线程：MCP 没了之后给主循环自己退出（会关 controller）留的时间
WATCHDOG_GRACE = 1.0

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
kernel32.WaitForSingleObject.restype = ctypes.c_uint32
kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
kernel32.GetProcessTimes.restype = ctypes.c_int
kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_uint64)] * 4
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

_log = None


def log(message):
    if _log is None:
        return
    try:
        _log.write("%s [%d] %s\n" % (time.strftime("%H:%M:%S"), os.getpid(), message))
        _log.flush()
    except Exception:
        pass


def open_log():
    global _log
    _log = open(LOG_FILE, "a", encoding="utf-8")
    # 服务层出错时 traceback.print_exc() 打到 stderr，一并进日志
    sys.stdout = _log
    sys.stderr = _log


def close_log():
    global _log
    if _log is not None:
        try:
            _log.close()
        except Exception:
            pass
        _log = None


def retry(fn, attempts=50):
    """Windows 上杀毒或索引程序会短暂占住刚写的文件，替换 / 删除失败就稍后再试。"""
    for i in range(attempts):
        try:
            return fn()
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.02)


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    retry(lambda: os.replace(tmp, path))


def process_created(handle):
    times = [ctypes.c_uint64() for _ in range(4)]
    if not kernel32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
        return None
    return times[0].value


def open_mcp():
    """握住 MCP 进程。拿不到（已经没了，或进程号已被别的进程复用）返回 None。"""
    pid = int(os.environ["WPE_RD_MCP_PID"])
    handle = kernel32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        log("打不开 MCP 进程 %d（错误 %d）" % (pid, ctypes.get_last_error()))
        return None
    expected = os.environ.get("WPE_RD_MCP_CREATED")
    if expected:
        created = process_created(handle)
        if created is not None and created != int(expected):
            log("进程号 %d 的创建时刻 %s 和 MCP 的 %s 不同，MCP 已经不在" % (pid, created, expected))
            kernel32.CloseHandle(handle)
            return None
    return handle


def shutdown(ctx, remove_dir, code=0):
    """关掉 controller；MCP 已经不在时顺手删掉 IPC 目录（没人再用它）。总是 os._exit。"""
    try:
        if ctx is not None:
            ctx.close()
    except Exception:
        log("关闭 controller 出错：\n" + traceback.format_exc())
    if remove_dir:
        log("删除 IPC 目录并退出")
        close_log()
        shutil.rmtree(IPC_DIR, ignore_errors=True)
    else:
        log("退出")
        close_log()
    os._exit(code)


def watchdog(mcp):
    """主循环在长请求里时看不到 MCP 退出（比如几十秒的回放）。MCP 没了 WATCHDOG_GRACE 秒主循环还没退出，
    就从这里直接退出：不碰 controller（主线程可能正在用它），进程退出时系统回收。"""
    kernel32.WaitForSingleObject(mcp, INFINITE)
    time.sleep(WATCHDOG_GRACE)
    log("MCP 已退出 %.1f s，主循环仍在处理请求，强制退出" % WATCHDOG_GRACE)
    close_log()
    shutil.rmtree(IPC_DIR, ignore_errors=True)
    os._exit(0)


def read_request():
    """读出并删掉 request.json。读的瞬间被占用就返回 None，下一轮再读。"""
    try:
        with open(REQUEST_FILE, "r", encoding="utf-8") as f:
            text = f.read()
    except (FileNotFoundError, PermissionError):
        return None
    retry(lambda: os.remove(REQUEST_FILE))
    try:
        return json.loads(text)
    except ValueError as e:
        return {"id": None, "method": None, "_bad": "Bad request: %s" % e}


def answer(request, response, ctx):
    response["state"] = {"capture": ctx.GetCaptureFilename() if ctx.IsCaptureLoaded() else None}
    # 回应不能序列化时照旧桥的做法回错误，不能让对方等到超时
    try:
        payload = json.dumps(response)
    except (TypeError, ValueError) as e:
        traceback.print_exc()
        payload = json.dumps({
            "id": request.get("id"),
            "error": {"code": -32603, "message": "Unserializable response: %s" % e},
            "state": response["state"],
        })
    write_atomic(RESPONSE_FILE, payload)
    return len(payload)


def serve(mcp, handler, ctx):
    while True:
        status = kernel32.WaitForSingleObject(mcp, POLL_MS)
        if status != WAIT_TIMEOUT:
            # 0 = MCP 进程已结束；WAIT_FAILED 也按 MCP 不在处理
            log("MCP 进程已退出（等待结果 0x%x）" % status)
            shutdown(ctx, remove_dir=True)

        if not os.path.exists(REQUEST_FILE):
            continue
        request = read_request()
        if request is None:
            continue

        method = request.get("method")
        if method == SHUTDOWN_METHOD:
            answer(request, {"id": request.get("id"), "result": {"shutdown": True}}, ctx)
            shutdown(ctx, remove_dir=False)

        start = time.time()
        if "_bad" in request:
            response = {"id": None, "error": {"code": -32700, "message": request["_bad"]}}
        else:
            try:
                response = handler.handle(request)
            except Exception as e:
                traceback.print_exc()
                response = {"id": request.get("id"), "error": {"code": -32603, "message": str(e)}}
        size = answer(request, response, ctx)
        log("%s %.3f s %d 字节%s" % (method, time.time() - start, size, " 出错" if "error" in response else ""))


def main():
    if not IPC_DIR or not os.path.isdir(IPC_DIR):
        os._exit(2)
    open_log()
    log("启动，Python %s" % sys.version.split()[0])

    mcp = open_mcp()
    if mcp is None:
        shutdown(None, remove_dir=False, code=3)
    guard = threading.Thread(target=watchdog, args=(mcp,), name="mcp-watchdog")
    guard.daemon = True
    guard.start()

    root = os.environ.get("WPE_RD_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, root)

    import renderdoc as rd
    from renderdoc_worker.context import ReplayContext
    from renderdoc_worker.renderdoc_facade import RenderDocFacade
    from renderdoc_worker.request_handler import RequestHandler

    ctx = ReplayContext()
    handler = RequestHandler(RenderDocFacade(ctx))

    version = getattr(rd, "GetVersionString", lambda: "")()
    commit = getattr(rd, "GetCommitHash", lambda: "")()
    write_atomic(READY_FILE, json.dumps({
        "pid": os.getpid(),
        "mcp_pid": int(os.environ["WPE_RD_MCP_PID"]),
        "python": sys.version,
        "renderdoc": version,
        "commit": commit,
    }))
    log("就绪，RenderDoc %s（%s）" % (version, commit))
    serve(mcp, handler, ctx)


try:
    main()
except BaseException:
    # 包括 SystemExit：异常不能回到 qrenderdoc，否则它会接着打开主界面
    detail = traceback.format_exc()
    log("工作进程出错：\n" + detail)
    try:
        if IPC_DIR and os.path.isdir(IPC_DIR) and not os.path.exists(READY_FILE):
            write_atomic(READY_FILE, json.dumps({"pid": os.getpid(), "error": detail}))
    except Exception:
        pass
    close_log()
    os._exit(1)
os._exit(0)
