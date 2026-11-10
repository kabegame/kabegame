"""kbp rdc 的 RenderDoc 侧入口：kbp.py 拉起 `qrenderdoc --python rdc/main.py`，一次处理一个抓帧目录。

- 参数：环境变量 KBP_RDC_JOB 指向 kbp.py 写的 job.json（action、folder、tag、out、params、mcp_dir、skill_dir、
  parent_pid / parent_created、result、log）。
- --python 的脚本在主界面出现之前运行；这个脚本不返回，界面就不会出现。所以任何退出路径都走 os._exit
  （同 .claude/mcps/wpe-renderdoc/renderdoc_worker/worker.py），异常也不能抛回 qrenderdoc，否则它会接着打开主界面。
- 界面程序看不到 stdout：进度写 job.log（kbp.py 转到 stderr），结果写 job.result（先写 .tmp 再 os.replace）。
- 看门线程握着 kbp.py 进程的句柄：kbp.py 没了就直接退出，不留孤儿进程。
- 不写字节码（sys.dont_write_bytecode）：不在 renderdoc_worker 或本 skill 目录里留 __pycache__。

要兼容 RenderDoc 内嵌的 Python 3.8：不用 match、不用运行期求值的 `X | None` 注解。
"""

import sys

sys.dont_write_bytecode = True

import ctypes  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402

JOB_FILE = os.environ.get("KBP_RDC_JOB", "")
SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INFINITE = 0xFFFFFFFF

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
kernel32.WaitForSingleObject.restype = ctypes.c_uint32
kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
kernel32.GetProcessTimes.restype = ctypes.c_int
kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_uint64)] * 4
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

_job = {}
_log = None


def log(message):
    if _log is None:
        return
    try:
        _log.write("%s %s\n" % (time.strftime("%H:%M:%S"), message))
        _log.flush()
    except Exception:
        pass


def write_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    for i in range(50):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == 49:
                raise
            time.sleep(0.02)


def open_parent(pid, created):
    """握住 kbp.py 进程。拿不到（已经没了，或进程号已被复用）返回 None。"""
    handle = kernel32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    if created:
        times = [ctypes.c_uint64() for _ in range(4)]
        if kernel32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]) and times[0].value != int(created):
            kernel32.CloseHandle(handle)
            return None
    return handle


def watchdog(handle):
    kernel32.WaitForSingleObject(handle, INFINITE)
    log("kbp.py 已退出，强制退出")
    os._exit(4)


def layer_of(exc):
    name = type(exc).__name__
    if name == "DataError":
        return "data"
    return "renderdoc"


def main():
    global _job, _log
    if not JOB_FILE or not os.path.isfile(JOB_FILE):
        os._exit(2)
    with open(JOB_FILE, encoding="utf-8") as f:
        _job = json.load(f)
    _log = open(_job["log"], "a", encoding="utf-8")
    # 服务层出错时 traceback.print_exc() 打到 stderr，一并进日志
    sys.stdout = _log
    sys.stderr = _log
    log("启动，Python %s，动作 %s" % (sys.version.split()[0], _job["action"]))

    parent = open_parent(int(_job["parent_pid"]), _job.get("parent_created"))
    if parent is None:
        log("kbp.py 已不在，退出")
        os._exit(3)
    guard = threading.Thread(target=watchdog, args=(parent,), name="kbp-watchdog")
    guard.daemon = True
    guard.start()

    sys.path.insert(0, _job["mcp_dir"])
    sys.path.insert(0, _job["skill_dir"])
    import renderdoc as rd
    from rdc.bridge import LocalBridge
    from rdc import frame, stats, track

    modules = {"track": track, "frame": frame, "stats": stats}
    module = modules.get(_job["action"])
    if module is None:
        raise ValueError("未知的动作 %s" % _job["action"])
    ready = time.time()
    version = getattr(rd, "GetVersionString", lambda: "")()
    log("就绪，RenderDoc %s" % version)
    bridge = LocalBridge()
    try:
        summary = module.run(bridge, _job, log)
    finally:
        start = time.time()
        try:
            bridge.close()
            log("关闭抓帧（%.3f s）" % (time.time() - start))
        except Exception:
            log("关闭抓帧出错：\n" + traceback.format_exc())
    result = {"ok": True, "ready_at": ready, "finished_at": time.time(), "renderdoc": version,
              "python": sys.version.split()[0]}
    result.update(summary)
    write_atomic(_job["result"], result)
    log("完成")


try:
    main()
except BaseException as exc:  # noqa: BLE001 —— 包括 SystemExit：异常不能回到 qrenderdoc
    detail = traceback.format_exc()
    log("出错：\n" + detail)
    try:
        if _job.get("result"):
            write_atomic(_job["result"], {"ok": False, "error": "[%s] %s" % (layer_of(exc), exc), "traceback": detail})
    except Exception:
        pass
    try:
        if _log is not None:
            _log.close()
    except Exception:
        pass
    os._exit(1)
try:
    if _log is not None:
        _log.close()
except Exception:
    pass
os._exit(0)
