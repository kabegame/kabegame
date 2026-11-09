"""
回放工作进程的客户端。

第一次调用时拉起常驻的 `qrenderdoc --python renderdoc_worker/worker.py`，之后经私有 IPC 目录
（.kabegame/debug/wpe-renderdoc-mcp/ipc/<MCP 进程号>/）交换请求：
- 一次一个请求（threading.Lock）；请求先写 .tmp 再 os.replace，工作进程的回应同样如此，不要锁文件；
- 超时（默认 120 s，RENDERDOC_MCP_TIMEOUT 可调）或工作进程已退出：结束自己拉起的这个进程，
  下次调用重新拉起，并在结果里带 worker_restarted、capture_lost，不静默吞掉；
- 结束进程前核对进程号、映像与命令行，只结束本 MCP 拉起的工作进程。
- 进程探活用 OpenProcess + WaitForSingleObject。不能用 os.kill(pid, 0)：Windows 上它会结束对方进程。
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from typing import Any

from . import paths

READY_TIMEOUT = 30.0
POLL_INTERVAL = 0.01
# close() 里等工作进程自己退出的时间，超过就结束它
SHUTDOWN_GRACE = 1.5
SHUTDOWN_METHOD = "__shutdown__"

# ==================== Win32 ====================

SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
ERROR_ACCESS_DENIED = 5
WAIT_TIMEOUT = 0x102
PROCESS_COMMAND_LINE_INFORMATION = 60
STARTF_USESHOWWINDOW = 0x1
SW_HIDE = 0
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_ntdll = ctypes.WinDLL("ntdll")

_kernel32.OpenProcess.restype = ctypes.c_void_p
_kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
_kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
_kernel32.WaitForSingleObject.restype = ctypes.c_uint32
_kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
_kernel32.GetProcessTimes.restype = ctypes.c_int
_kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_uint64)] * 4
_kernel32.GetCurrentProcess.restype = ctypes.c_void_p
_kernel32.GetProcessId.restype = ctypes.c_uint32
_kernel32.GetProcessId.argtypes = [ctypes.c_void_p]
_kernel32.QueryFullProcessImageNameW.restype = ctypes.c_int
_kernel32.QueryFullProcessImageNameW.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32)]
_ntdll.NtQueryInformationProcess.restype = ctypes.c_long
_ntdll.NtQueryInformationProcess.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]


class _UnicodeString(ctypes.Structure):
    _fields_ = [("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort), ("Buffer", ctypes.c_void_p)]


def process_created(handle: int) -> int | None:
    """进程创建时刻（FILETIME 整数），配合进程号认出同一个进程。"""
    times = [ctypes.c_uint64() for _ in range(4)]
    if not _kernel32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
        return None
    return times[0].value


def current_process_created() -> int | None:
    return process_created(_kernel32.GetCurrentProcess())


def process_image(handle: int) -> str | None:
    size = ctypes.c_uint32(32768)
    buf = ctypes.create_unicode_buffer(size.value)
    if not _kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
        return None
    return buf.value


def process_command_line(handle: int) -> str | None:
    """经 NtQueryInformationProcess(ProcessCommandLineInformation) 读命令行，只要查询权限。"""
    size = ctypes.c_uint32(0)
    _ntdll.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, None, 0, ctypes.byref(size))
    if not size.value:
        return None
    buf = ctypes.create_string_buffer(size.value)
    status = _ntdll.NtQueryInformationProcess(
        handle, PROCESS_COMMAND_LINE_INFORMATION, buf, size.value, ctypes.byref(size))
    if status != 0:
        return None
    text = _UnicodeString.from_buffer(buf)
    return ctypes.wstring_at(text.Buffer, text.Length // 2)


def open_process(pid: int) -> int | None:
    return _kernel32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid) or None


def process_alive(pid: int, created: int | None = None) -> bool:
    """进程号还在、且（给了创建时刻时）是同一个进程。打不开但拒绝访问的算在。"""
    handle = open_process(pid)
    if handle is None:
        return ctypes.get_last_error() == ERROR_ACCESS_DENIED
    try:
        if _kernel32.WaitForSingleObject(handle, 0) != WAIT_TIMEOUT:
            return False
        return created is None or process_created(handle) == created
    finally:
        _kernel32.CloseHandle(handle)


def describe_process(pid: int) -> dict[str, Any]:
    """进程号、映像、命令行、创建时刻，给核对与报告用。"""
    handle = open_process(pid)
    if handle is None:
        return {"pid": pid, "alive": False}
    try:
        alive = _kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        return {"pid": pid, "alive": alive, "image": process_image(handle),
                "command_line": process_command_line(handle), "created": process_created(handle)}
    finally:
        _kernel32.CloseHandle(handle)


def is_worker_command(command: str) -> bool:
    """命令行是不是「qrenderdoc --python 本工程的 worker.py」。"""
    command = os.path.normcase(command.replace('"', ""))
    return ("--python" in command and "qrenderdoc" in command
            and os.path.normcase(os.path.normpath(paths.WORKER_SCRIPT)) in command)


def is_our_worker(handle: int, pid: int) -> tuple[bool, str]:
    """核对：句柄对应的进程号、映像是 qrenderdoc.exe、命令行里带本工程的 worker.py。"""
    actual = _kernel32.GetProcessId(handle)
    image = process_image(handle) or ""
    command = process_command_line(handle) or ""
    ok = (actual == pid and os.path.basename(image).lower() == "qrenderdoc.exe"
          and is_worker_command(command))
    return ok, f"进程 {actual}（期望 {pid}）：{image} {command}"


# ==================== IPC 目录 ====================


def _retry(fn, attempts: int = 50):
    """杀毒或索引程序会短暂占住刚写的文件，替换 / 删除失败就稍后再试。"""
    for i in range(attempts):
        try:
            return fn()
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.02)


def _write_atomic(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    _retry(lambda: os.replace(tmp, path))


def _remove(path: str) -> None:
    try:
        _retry(lambda: os.remove(path))
    except FileNotFoundError:
        pass


def _read_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, PermissionError, json.JSONDecodeError):
        return None


def cleanup_stale(ipc_root: str = paths.IPC_ROOT) -> list[str]:
    """删掉 ipc/ 下所属 MCP 进程已不在的目录。只删这个目录下名字是进程号的子目录。"""
    removed: list[str] = []
    if not os.path.isdir(ipc_root):
        return removed
    for name in os.listdir(ipc_root):
        path = os.path.join(ipc_root, name)
        if not name.isdigit() or not os.path.isdir(path) or int(name) == os.getpid():
            continue
        owner = _read_json(os.path.join(path, "owner.json")) or {}
        if process_alive(int(name), owner.get("created")):
            continue
        shutil.rmtree(path, ignore_errors=True)
        removed.append(path)
    return removed


# ==================== 客户端 ====================


class ReplayWorkerError(Exception):
    """调用工作进程失败（错误回应、超时、进程退出、拉不起来）"""


class ReplayWorker:
    """本 MCP 进程私有的回放工作进程。"""

    def __init__(self, ipc_root: str = paths.IPC_ROOT, timeout: float | None = None):
        self.mcp_pid = os.getpid()
        self.ipc_dir = os.path.join(ipc_root, str(self.mcp_pid))
        if timeout is None:
            timeout = float(os.environ.get("RENDERDOC_MCP_TIMEOUT", "120"))
        self.timeout = timeout
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self.ready: dict[str, Any] | None = None
        # 工作进程里当前打开的抓帧：来自每次回应的 state.capture
        self._capture: str | None = None
        # 上一个工作进程是怎么没的；下次拉起成功后报出来
        self._lost: dict[str, Any] | None = None
        self._closed = False

    def _file(self, name: str) -> str:
        return os.path.join(self.ipc_dir, name)

    # ---------- 调用 ----------

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        with self._lock:
            if self._closed:
                raise ReplayWorkerError("MCP 正在退出，工作进程已关闭")
            notice = self._ensure_worker()
            try:
                result = self._request(method, params or {})
            except ReplayWorkerError as e:
                if notice:
                    raise ReplayWorkerError(f"{e}（{self._describe(notice)}）") from None
                raise
            if notice:
                if isinstance(result, dict):
                    result = {**result, **notice}
                else:
                    result = {"result": result, **notice}
            return result

    @staticmethod
    def _describe(notice: dict[str, Any]) -> str:
        lost = notice.get("capture_lost")
        text = f"工作进程已重新拉起：{notice.get('restart_reason')}"
        if lost:
            text += f"；之前打开的 {lost} 已丢失，需要重新 open_capture"
        return text

    def _ensure_worker(self) -> dict[str, Any] | None:
        """工作进程在就直接用；不在就拉起。之前的进程没了的话，返回要带进结果的说明。"""
        if self._proc is not None:
            code = self._proc.poll()
            if code is None:
                return None
            # 两次调用之间进程自己没了（被结束、崩溃）
            self._lost = {"reason": f"工作进程 {self._proc.pid} 已退出（退出码 {code}）",
                          "capture": self._capture}
            self._proc = None
        notice = None
        if self._lost is not None:
            notice = {"worker_restarted": True, "capture_lost": self._lost["capture"],
                      "restart_reason": self._lost["reason"]}
        self._spawn()
        self._lost = None
        self._capture = None
        return notice

    def _request(self, method: str, params: dict[str, Any]) -> Any:
        proc = self._proc
        assert proc is not None
        request_id = uuid.uuid4().hex
        response_file = self._file("response.json")
        _remove(response_file)
        _write_atomic(self._file("request.json"),
                      json.dumps({"id": request_id, "method": method, "params": params}))
        deadline = time.monotonic() + self.timeout
        while True:
            response = _read_json(response_file)
            if response is not None:
                _remove(response_file)
                # id 为 None 的是工作进程读不懂请求时的回应，也算这次的
                if response.get("id") in (request_id, None):
                    state = response.get("state")
                    if isinstance(state, dict):
                        self._capture = state.get("capture")
                    if "error" in response:
                        error = response["error"]
                        raise ReplayWorkerError(f"[{error.get('code')}] {error.get('message')}")
                    return response.get("result")
            code = proc.poll()
            if code is not None:
                self._lost = {"reason": f"工作进程 {proc.pid} 在处理 {method} 时退出（退出码 {code}）",
                              "capture": self._capture}
                self._proc = None
                raise ReplayWorkerError(
                    f"{self._lost['reason']}。下次调用会重新拉起"
                    + (f"，打开的 {self._capture} 已丢失" if self._capture else ""))
            if time.monotonic() > deadline:
                reason = f"{method} 超过 {self.timeout:g} s 没有回应，已结束工作进程 {proc.pid}"
                self._lost = {"reason": reason, "capture": self._capture}
                self._proc = None
                self._terminate(proc)
                raise ReplayWorkerError(
                    f"Request timed out：{reason}。下次调用会重新拉起"
                    + (f"，打开的 {self._capture} 已丢失" if self._capture else ""))
            time.sleep(POLL_INTERVAL)

    # ---------- 拉起与结束 ----------

    def _spawn(self) -> None:
        qrenderdoc = paths.qrenderdoc()
        if not os.path.isfile(qrenderdoc):
            raise ReplayWorkerError(f"找不到 {qrenderdoc}（可用环境变量 RENDERDOC_DIR 指定 RenderDoc 安装目录）")
        os.makedirs(self.ipc_dir, exist_ok=True)
        created = current_process_created()
        _write_atomic(self._file("owner.json"), json.dumps({"pid": self.mcp_pid, "created": created}))
        for name in ("request.json", "response.json", "ready.json"):
            _remove(self._file(name))
            _remove(self._file(name + ".tmp"))

        # 内嵌 Python 不该看到 uv 环境里的 PYTHON* 变量
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PYTHON")}
        env.update(WPE_RD_ROOT=paths.PROJECT_DIR, WPE_RD_IPC_DIR=self.ipc_dir,
                   WPE_RD_MCP_PID=str(self.mcp_pid), WPE_RD_MCP_CREATED=str(created or ""))
        # 脚本不返回，主界面本来就不会出现；万一出现（比如脚本没起来），首个窗口也按隐藏处理
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= STARTF_USESHOWWINDOW
        startup.wShowWindow = SW_HIDE
        # 不继承 MCP 的 stdio 管道；工作目录不放在 IPC 目录里，否则它退出前删不掉这个目录
        proc = subprocess.Popen(
            [qrenderdoc, "--python", paths.WORKER_SCRIPT],
            env=env, cwd=paths.renderdoc_dir(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, startupinfo=startup, creationflags=CREATE_NO_WINDOW)

        deadline = time.monotonic() + READY_TIMEOUT
        while True:
            ready = _read_json(self._file("ready.json"))
            if ready is not None and ready.get("pid") == proc.pid:
                if "error" in ready:
                    self._terminate(proc)
                    raise ReplayWorkerError(f"工作进程启动出错：\n{ready['error']}")
                self._proc = proc
                self.ready = ready
                return
            code = proc.poll()
            if code is not None:
                raise ReplayWorkerError(f"工作进程启动后立即退出（退出码 {code}）。{self._log_tail()}")
            if time.monotonic() > deadline:
                self._terminate(proc)
                raise ReplayWorkerError(f"工作进程 {READY_TIMEOUT:g} s 内没有就绪，已结束。{self._log_tail()}")
            time.sleep(POLL_INTERVAL)

    def _log_tail(self, lines: int = 20) -> str:
        try:
            with open(self._file("worker.log"), "r", encoding="utf-8", errors="replace") as f:
                tail = f.read().splitlines()[-lines:]
        except OSError:
            return "没有 worker.log"
        return "worker.log 末尾：\n" + "\n".join(tail)

    def _terminate(self, proc: subprocess.Popen) -> None:
        """结束自己拉起的工作进程：先核对进程号、映像和命令行。"""
        if proc.poll() is not None:
            return
        handle = int(proc._handle)  # Popen 一直握着这个句柄，进程号不会被复用
        ok, detail = is_our_worker(handle, proc.pid)
        if not ok:
            raise ReplayWorkerError(f"拒绝结束：{detail} 不是本 MCP 拉起的工作进程")
        proc.kill()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            pass

    @property
    def worker_pid(self) -> int | None:
        if self._proc is not None and self._proc.poll() is None:
            return self._proc.pid
        return None

    def close(self) -> None:
        """MCP 退出时调用：让工作进程退出（不退就结束它），删 IPC 目录。可重复调用。"""
        if self._closed:
            return
        self._closed = True
        locked = self._lock.acquire(timeout=5)
        try:
            proc, self._proc = self._proc, None
            if proc is not None and proc.poll() is None:
                try:
                    _remove(self._file("response.json"))
                    _write_atomic(self._file("request.json"),
                                  json.dumps({"id": "shutdown", "method": SHUTDOWN_METHOD, "params": {}}))
                    proc.wait(SHUTDOWN_GRACE)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                try:
                    self._terminate(proc)
                except ReplayWorkerError:
                    pass
            shutil.rmtree(self.ipc_dir, ignore_errors=True)
        finally:
            if locked:
                self._lock.release()
