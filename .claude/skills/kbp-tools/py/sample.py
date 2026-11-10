"""画面采样（kbp-tools 点 8）：`kbp sample grab|series|read`，收 `ignore/p3c/wpe-general/sampler_pw.py`、`ignore/p4/run.py`、
`ignore/p3c/step4/accept/w1080.py`、`wread.py`，只做采样，不开关窗口。

- 窗口由 wpe-renderdoc MCP 的 `open_wallpaper` 开（标题 `kb-<MCP 进程号>-<序号>`），这里按标题找（先精确匹配，再唯一前缀），只读不碰：
  不发 WPE 命令、不改设置、不关窗。用到 WPE 进程时动态查（窗口所属进程号与映像名），没有写死的 PID。
- 抓法：`PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT)`，直接得客户区（被遮挡也能抓、不会读到别的窗口）；不支持时退回整窗
  （`PW_RENDERFULLCONTENT`）再按客户区偏移裁。得到的是 BGRA，存成 RGB。
- 左上角有 RenderDoc 的叠加文字（注入了 RenderDoc 的 WPE，约 340×40 像素），网格起点缺省 (10, 50) 避开；测试工程的 FR / CLK 在右下角。
- 格式：
  - `series --grid 步长,x0,y0 --out x.bin`：同 sampler_pw.py：头 `<iiiiii`（cols、rows、步长、x0、y0、0），每个样本 `<dd`（抓的开始、
    结束时刻）+ 网格各点 RGB；
  - `series --changed-only --out <目录>`：`<目录>/frames.bin` 同 run.py：头 `<ii`（宽、高），画面变了（CRC32）才存一条 `<ddI`（开始、
    结束时刻、长度）+ zlib(BGRA)，边采边写；另写 `<目录>/meta.json`；
  - `read` 认这两种，加上 w1080.py 的 `<iii`（宽、高、条数）+ `<dI` + zlib(BGRA)。
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import struct
import time
import zlib

from . import common
from .common import KbpError

PW_CLIENTONLY = 1
PW_RENDERFULLCONTENT = 2
GRID_HEAD = struct.Struct("<iiiiii")
GRID_TIME = struct.Struct("<dd")
FRAMES_HEAD = struct.Struct("<ii")
FRAMES_REC = struct.Struct("<ddI")
W1080_HEAD = struct.Struct("<iii")
W1080_REC = struct.Struct("<dI")
# 测试工程的 FR 图层（场景 1920×1080，y 向上）：中心 (1820, 40)
FR_SCENE = (1820, 40)

_win = None


class _BMI(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
                ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD), ("pad", wt.DWORD * 4)]


def _api():
    global _win
    if _win is not None:
        return _win
    if os.name != "nt":
        raise KbpError("kbp", "sample 只能在 Windows 上用（PrintWindow）")
    user32, gdi32, kernel32 = ctypes.windll.user32, ctypes.windll.gdi32, ctypes.windll.kernel32
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # 每显示器 v2：尺寸是物理像素
    except Exception:
        pass
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateDIBSection.restype = ctypes.c_void_p
    gdi32.CreateDIBSection.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p,
                                       ctypes.c_void_p, ctypes.c_uint]
    gdi32.SelectObject.restype = ctypes.c_void_p
    gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
    user32.GetDC.restype = ctypes.c_void_p
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.PrintWindow.argtypes = [wt.HWND, ctypes.c_void_p, ctypes.c_uint]
    kernel32.OpenProcess.restype = wt.HANDLE
    _win = (user32, gdi32, kernel32)
    return _win


def find_window(title):
    """按标题找可见的顶层窗口：先精确匹配，再唯一前缀匹配。返回 (hwnd, 标题)。"""
    user32, _, _ = _api()
    found = []
    proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(h, _):
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(h, buf, 512)
        if buf.value and user32.IsWindowVisible(h):
            found.append((h, buf.value))
        return True

    user32.EnumWindows(proc_type(cb), 0)
    exact = [x for x in found if x[1] == title]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise KbpError("wpe", "有 %d 个标题为 %r 的窗口，分不清" % (len(exact), title))
    prefix = [x for x in found if x[1].startswith(title)]
    if len(prefix) == 1:
        return prefix[0]
    if prefix:
        raise KbpError("wpe", "标题以 %r 开头的窗口有 %d 个：%s" % (title, len(prefix), [p[1] for p in prefix][:5]))
    raise KbpError("wpe", "找不到标题为 %r 的可见窗口（窗口由 wpe-renderdoc MCP 的 open_wallpaper 开）" % title)


def window_info(hwnd):
    user32, _, kernel32 = _api()
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    client = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(client))
    origin = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    exe = None
    handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if handle:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            exe = os.path.basename(buf.value)
        kernel32.CloseHandle(handle)
    return {"hwnd": int(hwnd), "pid": pid.value, "exe": exe,
            "window": [rect.left, rect.top, rect.right, rect.bottom],
            "client": [origin.x, origin.y, client.right, client.bottom]}


class Grabber(object):
    """一个窗口的 PrintWindow 抓取器：buf 是 BGRA（自上而下）。"""

    def __init__(self, hwnd):
        user32, gdi32, _ = _api()
        self.hwnd = hwnd
        info = window_info(hwnd)
        self.info = info
        self.width, self.height = info["client"][2], info["client"][3]
        if self.width <= 0 or self.height <= 0:
            raise KbpError("wpe", "窗口客户区是空的（%dx%d），是不是最小化了" % (self.width, self.height))
        self.flags = PW_CLIENTONLY | PW_RENDERFULLCONTENT
        self.offset = (0, 0)
        self.bw, self.bh = self.width, self.height
        self._make()
        if not user32.PrintWindow(self.hwnd, self.mem, self.flags):
            # 退回整窗，再按客户区相对窗口的偏移裁
            self.close()
            win = info["window"]
            self.flags = PW_RENDERFULLCONTENT
            self.bw, self.bh = win[2] - win[0], win[3] - win[1]
            self.offset = (info["client"][0] - win[0], info["client"][1] - win[1])
            self._make()
            if not user32.PrintWindow(self.hwnd, self.mem, self.flags):
                raise KbpError("wpe", "PrintWindow 失败（窗口 %s）" % hwnd)

    def _make(self):
        user32, gdi32, _ = _api()
        screen = user32.GetDC(None)
        self.mem = gdi32.CreateCompatibleDC(screen)
        bmi = _BMI()
        bmi.biSize, bmi.biWidth, bmi.biHeight, bmi.biPlanes, bmi.biBitCount = 40, self.bw, -self.bh, 1, 32
        bits = ctypes.c_void_p()
        self.dib = gdi32.CreateDIBSection(screen, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
        user32.ReleaseDC(None, screen)
        gdi32.SelectObject(self.mem, self.dib)
        self.raw = (ctypes.c_ubyte * (self.bw * self.bh * 4)).from_address(bits.value)

    def grab(self):
        user32, _, _ = _api()
        return bool(user32.PrintWindow(self.hwnd, self.mem, self.flags))

    def bgra(self):
        """客户区的 BGRA 字节（自上而下）。"""
        data = bytes(self.raw)
        if self.flags & PW_CLIENTONLY:
            return data
        ox, oy = self.offset
        rows = []
        for y in range(oy, oy + self.height):
            start = (y * self.bw + ox) * 4
            rows.append(data[start:start + self.width * 4])
        return b"".join(rows)

    def close(self):
        _, gdi32, _ = _api()
        if getattr(self, "dib", None):
            gdi32.DeleteObject(self.dib)
            self.dib = None
        if getattr(self, "mem", None):
            gdi32.DeleteDC(self.mem)
            self.mem = None


def _png(path, width, height, bgra):
    from PIL import Image

    Image.frombuffer("RGBA", (width, height), bgra, "raw", "BGRA", 0, 1).convert("RGB").save(path)


def _prepare(path, overwrite):
    path = os.path.abspath(path)
    if os.path.exists(path) and not overwrite:
        raise KbpError("data", "输出已存在（要覆盖加 --overwrite）：%s" % path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    return path


def grab(args):
    out = _prepare(args.out, args.overwrite)
    hwnd, title = find_window(args.title)
    g = Grabber(hwnd)
    try:
        t0 = time.time()
        if not g.grab():
            raise KbpError("wpe", "PrintWindow 失败")
        t1 = time.time()
        data = g.bgra()
    finally:
        g.close()
    _png(out, g.width, g.height, data)
    black = not any(data[i] or data[i + 1] or data[i + 2] for i in range(0, len(data), 4 * 97))
    summary = {"ok": True, "out": out, "title": title, "size": [g.width, g.height], "flags": g.flags,
               "seconds": round(t1 - t0, 4), "window": g.info}
    if black:
        summary["warning"] = "抓到的画面（抽样）全黑：窗口可能还没画出来"
    return summary


def series(args):
    if bool(args.grid) == bool(args.changed_only):
        raise KbpError("kbp", "给 --grid 步长,x0,y0（写网格点）或 --changed-only（画面变了才存整帧）之一")
    hwnd, title = find_window(args.title)
    g = Grabber(hwnd)
    w, h = g.width, g.height
    started = time.time()
    samples = kept = 0
    try:
        if args.grid:
            step, x0, y0 = [int(v) for v in args.grid.split(",")]
            if step <= 0 or not (0 <= x0 < w) or not (0 <= y0 < h):
                raise KbpError("kbp", "--grid 不合理：步长 %d、起点 (%d, %d)，客户区 %dx%d" % (step, x0, y0, w, h))
            out = _prepare(args.out, args.overwrite)
            cols, rows = (w - x0) // step, (h - y0) // step  # 同 sampler_pw.py
            offs = [((y0 + r * step) * w + (x0 + c * step)) * 4 for r in range(rows) for c in range(cols)]
            with open(out, "wb") as f:
                f.write(GRID_HEAD.pack(cols, rows, step, x0, y0, 0))
                end = time.time() + args.seconds
                while time.time() < end:
                    t0 = time.time()
                    g.grab()
                    t1 = time.time()
                    buf = g.bgra()
                    rec = bytearray(len(offs) * 3)
                    i = 0
                    for o in offs:
                        rec[i], rec[i + 1], rec[i + 2] = buf[o + 2], buf[o + 1], buf[o]
                        i += 3
                    f.write(GRID_TIME.pack(t0, t1))
                    f.write(rec)
                    samples += 1
                    if args.interval:
                        time.sleep(args.interval)
            kept = samples
            meta = {"format": "grid", "cols": cols, "rows": rows, "step": step, "x0": x0, "y0": y0}
        else:
            folder = os.path.abspath(args.out)
            frames_path = os.path.join(folder, "frames.bin")
            _prepare(frames_path, args.overwrite)
            out = folder
            last = None
            with open(frames_path, "wb") as f:
                f.write(FRAMES_HEAD.pack(w, h))
                end = time.time() + args.seconds
                while time.time() < end:
                    t0 = time.time()
                    g.grab()
                    t1 = time.time()
                    raw = g.bgra()
                    samples += 1
                    crc = zlib.crc32(raw)
                    if crc != last:
                        last = crc
                        z = zlib.compress(raw, 1)
                        f.write(FRAMES_REC.pack(t0, t1, len(z)))
                        f.write(z)
                        kept += 1
                    time.sleep(args.interval if args.interval is not None else 0.002)
            meta = {"format": "frames", "frames": frames_path}
    finally:
        g.close()
    seconds = time.time() - started
    meta.update(title=title, window=g.info, size=[w, h], samples=samples, kept=kept, seconds=round(seconds, 3),
                rate=round(samples / seconds, 2) if seconds else None)
    if not args.grid:
        common.write_json(os.path.join(out, "meta.json"), meta, indent=1)
    return dict({"ok": True, "out": out}, **meta)


# ==================== read ====================


def _detect(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) >= 24:
        cols, rows, step, x0, y0, zero = GRID_HEAD.unpack(head)
        if zero == 0 and cols > 0 and rows > 0 and step > 0 and x0 >= 0 and y0 >= 0:
            rec = GRID_TIME.size + cols * rows * 3
            if (size - 24) % rec == 0:
                return "grid"
    with open(path, "rb") as f:
        w, h = FRAMES_HEAD.unpack(f.read(8))
        if w > 0 and h > 0:
            pos = 8
            ok = True
            while pos < size:
                f.seek(pos)
                rec = f.read(FRAMES_REC.size)
                if len(rec) < FRAMES_REC.size:
                    ok = False
                    break
                _, _, n = FRAMES_REC.unpack(rec)
                pos += FRAMES_REC.size + n
            if ok and pos == size:
                return "frames"
        f.seek(0)
        w, h, n = W1080_HEAD.unpack(f.read(12))
        if w > 0 and h > 0 and n >= 0:
            return "w1080"
    raise KbpError("data", "认不出 %s 的格式（grid、frames、w1080）" % path)


def iter_frames(path, kind):
    """逐条给 (时刻, 结束时刻或 None, 宽, 高, BGRA 字节)。"""
    with open(path, "rb") as f:
        if kind == "frames":
            w, h = FRAMES_HEAD.unpack(f.read(8))
            while True:
                rec = f.read(FRAMES_REC.size)
                if len(rec) < FRAMES_REC.size:
                    return
                t0, t1, n = FRAMES_REC.unpack(rec)
                yield t0, t1, w, h, zlib.decompress(f.read(n))
        else:
            w, h, count = W1080_HEAD.unpack(f.read(12))
            for _ in range(count):
                t, n = W1080_REC.unpack(f.read(W1080_REC.size))
                yield t, None, w, h, zlib.decompress(f.read(n))


def fr_number(bgra, w, h):
    """测试工程的 FR 帧号：FR 中心 5×5 的平均色，蓝≈255、红绿是整数时帧号 = r + 256·g（同 wread.fr 的判法）。"""
    cx = int(round(FR_SCENE[0] / 1920 * w))
    cy = int(round((1080 - FR_SCENE[1]) / 1080 * h))
    acc = [0.0, 0.0, 0.0]
    n = 0
    for y in range(cy - 2, cy + 3):
        for x in range(cx - 2, cx + 3):
            if 0 <= x < w and 0 <= y < h:
                o = (y * w + x) * 4
                acc[0] += bgra[o + 2]
                acc[1] += bgra[o + 1]
                acc[2] += bgra[o]
                n += 1
    if not n:
        return None
    r, g, b = (v / n for v in acc)
    if b < 250 or abs(r - round(r)) > 0.01 or abs(g - round(g)) > 0.01:
        return None
    return int(round(r)) + 256 * int(round(g))


def read(args):
    path = os.path.abspath(args.file)
    if os.path.isdir(path):
        path = os.path.join(path, "frames.bin")
    if not os.path.isfile(path):
        raise KbpError("data", "找不到 %s" % path)
    kind = _detect(path)
    out = {"ok": True, "file": path, "format": kind}
    if kind == "grid":
        with open(path, "rb") as f:
            cols, rows, step, x0, y0, _ = GRID_HEAD.unpack(f.read(24))
            rec = cols * rows * 3
            times, points = [], []
            want = None
            if args.point:
                px, py = [int(v) for v in args.point.split(",")]
                c, r = (px - x0) // step, (py - y0) // step
                if not (0 <= c < cols and 0 <= r < rows):
                    raise KbpError("kbp", "--point 不在网格里")
                want = (r * cols + c) * 3
            while True:
                t = f.read(GRID_TIME.size)
                if len(t) < GRID_TIME.size:
                    break
                t0, t1 = GRID_TIME.unpack(t)
                data = f.read(rec)
                times.append([t0, t1])
                if want is not None:
                    points.append(list(data[want:want + 3]))
        span = times[-1][0] - times[0][0] if len(times) > 1 else 0
        out.update(cols=cols, rows=rows, step=step, x0=x0, y0=y0, samples=len(times),
                   seconds=round(span, 3), rate=round((len(times) - 1) / span, 2) if span else None,
                   grab_ms=round(1000 * sum(b - a for a, b in times) / len(times), 2) if times else None)
        if want is not None:
            out["point"] = {"xy": args.point, "rgb": points[: args.limit]}
        return out
    frames = []
    pngs = []
    wanted = set(int(i) for i in args.frames.split(",")) if args.frames else None
    png_dir = os.path.abspath(args.png) if args.png else None
    if png_dir:
        os.makedirs(png_dir, exist_ok=True)
    size = None
    for i, (t0, t1, w, h, raw) in enumerate(iter_frames(path, kind)):
        size = [w, h]
        row = {"index": i, "t": t0}
        if args.fr:
            row["fr"] = fr_number(raw, w, h)
        frames.append(row)
        if png_dir and (wanted is None or i in wanted):
            target = os.path.join(png_dir, "frame-%05d.png" % i)
            if os.path.exists(target) and not args.overwrite:
                raise KbpError("data", "输出已存在（要覆盖加 --overwrite）：%s" % target)
            _png(target, w, h, raw)
            pngs.append(target)
    span = frames[-1]["t"] - frames[0]["t"] if len(frames) > 1 else 0
    out.update(size=size, frames=len(frames), seconds=round(span, 3))
    if args.fr:
        numbers = [r["fr"] for r in frames if r["fr"] is not None]
        out["fr"] = {"decoded": len(numbers), "first": numbers[0] if numbers else None,
                     "last": numbers[-1] if numbers else None,
                     "increasing": all(b > a for a, b in zip(numbers, numbers[1:]))}
    if pngs:
        out["png"] = pngs[:20] + (["…"] if len(pngs) > 20 else [])
    if args.out:
        target = _prepare(args.out, args.overwrite)
        common.write_json(target, {"file": path, "format": kind, "size": size, "frames": frames}, indent=1)
        out["out"] = target
    return out


def cli(args):
    if args.action == "grab":
        return grab(args)
    if args.action == "series":
        return series(args)
    if args.action == "read":
        return read(args)
    raise KbpError("kbp", "未知的动作 %s" % args.action)
