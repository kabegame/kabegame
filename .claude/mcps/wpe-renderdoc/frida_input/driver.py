"""按帧给 WPE 的一个测试窗口喂光标与左键（play），或逐帧录下真实的光标与左键（record）。

只在「对这个渲染窗口调 ScreenToClient 的那条线程」上动 GetCursorPos / GetKeyState(VK_LBUTTON) / WindowFromPoint，
别的线程（桌面壁纸、别的测试窗口）一概不碰；子进程退出时 Frida 自动卸掉脚本，钩子随之撤销。

用法：python -X utf8 driver.py --pid <WPE pid> --hwnd <渲染窗口 hwnd> --mode play|record
协议（stdin / stdout 都是一行一个 JSON）：
  stdin 第一行  play：{"timeline": [[x, y, down(, n)], …]}   record：{}
  stdin 之后    {"cmd": "state"} / {"cmd": "stop"}（stdin 关闭按 stop 处理）
  stdout        {"event": "ready", "tid": …} / {"event": "error", "message": …}
                {"event": "state", "frame": 已处理的帧数, "played": 时间线是否放完, "mode": …}
                {"event": "stopped", "frames": …, "log": […]}
时间线 x、y 是渲染窗口客户区的归一化坐标（左上原点、y 向下）；第 i 项给目标线程的第 i 次 GetCursorPos，即第 i 帧；
放完之后停在最后一项。log：play 每帧 [帧, 屏幕 x, 屏幕 y, down]，record 每帧 [x, y, down]（归一化，即时间线格式）。
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import threading

import frida

READY_TIMEOUT = 2.0
RECORD_MAX_FRAMES = 200000  # record 的内存上限，超出的帧不再记（帧数照数）

JS = r"""
const user32 = Process.getModuleByName('user32.dll');
const target = ptr('0x%HWND%');
const MODE = '%MODE%';
const timeline = %TIMELINE%;
const MAX = %MAX%;
const ClientToScreen = new NativeFunction(user32.getExportByName('ClientToScreen'), 'int', ['pointer', 'pointer']);
const GetClientRect = new NativeFunction(user32.getExportByName('GetClientRect'), 'int', ['pointer', 'pointer']);
let tid = -1, frame = -1, cur = null;
const log = [];
function geometry() {
  const p = Memory.alloc(8); p.writeS32(0); p.add(4).writeS32(0);
  ClientToScreen(target, p);
  const r = Memory.alloc(16); GetClientRect(target, r);
  return { x: p.readS32(), y: p.add(4).readS32(), w: Math.max(1, r.add(8).readS32()), h: Math.max(1, r.add(12).readS32()) };
}
Interceptor.attach(user32.getExportByName('ScreenToClient'), {
  onEnter(args) { if (tid < 0 && args[0].equals(target)) { tid = this.threadId; send({ ready: tid }); } }
});
Interceptor.attach(user32.getExportByName('GetCursorPos'), {
  onEnter(args) { this.out = args[0]; this.mine = this.threadId === tid; },
  onLeave(ret) {
    if (!this.mine || ret.toInt32() === 0) return;
    frame++;
    const g = geometry();
    if (MODE === 'play') {
      cur = timeline[Math.min(frame, timeline.length - 1)];
      const sx = Math.round(g.x + cur[0] * g.w), sy = Math.round(g.y + cur[1] * g.h);
      this.out.writeS32(sx); this.out.add(4).writeS32(sy);
      if (frame < timeline.length) log.push([frame, sx, sy, cur[2] ? 1 : 0]);
    } else {
      const sx = this.out.readS32(), sy = this.out.add(4).readS32();
      cur = [(sx - g.x) / g.w, (sy - g.y) / g.h, 0];
      if (log.length < MAX) log.push(cur);
    }
  }
});
Interceptor.attach(user32.getExportByName('GetKeyState'), {
  onEnter(args) { this.mine = this.threadId === tid && args[0].toInt32() === 1; },
  onLeave(ret) {
    if (!this.mine || !cur) return;
    if (MODE === 'play') ret.replace(ptr(cur[2] ? 0xff80 : 0));
    else cur[2] = (ret.toUInt32() & 0x8000) ? 1 : 0;
  }
});
if (MODE === 'play') {
  Interceptor.attach(user32.getExportByName('WindowFromPoint'), {
    onEnter() { this.mine = this.threadId === tid; },
    onLeave(ret) { if (this.mine) ret.replace(target); }
  });
}
rpc.exports = {
  state() { return { tid, frame }; },
  drain() { return { tid, frame, log }; },
};
"""


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def expand(timeline: list) -> list:
    """[x, y, down(, n)] → 展开重复帧的 [x, y, down]。"""
    out = []
    for item in timeline:
        n = int(item[3]) if len(item) > 3 else 1
        out.extend([[float(item[0]), float(item[1]), 1 if item[2] else 0]] * n)
    return out


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--hwnd", type=int, required=True)
    ap.add_argument("--mode", choices=("play", "record"), required=True)
    args = ap.parse_args()

    first = sys.stdin.readline()
    try:
        head = json.loads(first) if first.strip() else {}
        timeline = expand(head.get("timeline") or []) if args.mode == "play" else []
        if args.mode == "play" and not timeline:
            raise ValueError("play 需要非空的 timeline")
    except Exception as e:  # 参数不对
        emit({"event": "error", "message": f"第一行不是合法的 JSON 或时间线：{e}"})
        return 2

    try:
        session = frida.attach(args.pid)
    except Exception as e:
        emit({"event": "error", "message": f"attach WPE（pid {args.pid}）失败：{e}"})
        return 1
    detached = threading.Event()
    session.on("detached", lambda reason, crash: detached.set())
    ready = threading.Event()
    errors: list[str] = []

    def on_message(message, data):
        if message.get("type") == "send" and isinstance(message.get("payload"), dict) and "ready" in message["payload"]:
            ready.tid = message["payload"]["ready"]  # type: ignore[attr-defined]
            ready.set()
        elif message.get("type") == "error":
            errors.append(message.get("description", str(message)))

    source = (JS.replace("%HWND%", format(args.hwnd, 'x')).replace("%MODE%", args.mode)
              .replace("%TIMELINE%", json.dumps(timeline)).replace("%MAX%", str(RECORD_MAX_FRAMES)))
    try:
        script = session.create_script(source)
        script.on("message", on_message)
        script.load()
    except Exception as e:
        emit({"event": "error", "message": f"加载 Frida 脚本失败：{e}"})
        return 1

    def shutdown() -> None:
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass

    if not ready.wait(READY_TIMEOUT):
        shutdown()
        emit({"event": "error", "message": f"{READY_TIMEOUT:g} s 内没认出渲染线程（没看到对 hwnd {args.hwnd} 的 "
                                           "ScreenToClient 调用）：窗口不是渲染窗口、或 WPE 暂停了、或没有在渲染"
                                           + ("；脚本错误：" + "；".join(errors) if errors else "")})
        return 1
    emit({"event": "ready", "tid": ready.tid})  # type: ignore[attr-defined]

    commands: "queue.Queue[dict]" = queue.Queue()

    def read_stdin() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                commands.put(json.loads(line))
            except ValueError:
                commands.put({"cmd": "?"})
        commands.put({"cmd": "stop"})  # stdin 关闭

    threading.Thread(target=read_stdin, daemon=True).start()

    while True:
        try:
            cmd = commands.get(timeout=0.2)
        except queue.Empty:
            if detached.is_set():
                emit({"event": "error", "message": "WPE 进程已退出或脚本被分离"})
                return 1
            continue
        name = cmd.get("cmd")
        if name == "state":
            try:
                s = script.exports_sync.state()
            except Exception as e:
                emit({"event": "error", "message": f"读状态失败：{e}"})
                return 1
            frames = s["frame"] + 1
            emit({"event": "state", "mode": args.mode, "frame": frames,
                  "played": frames >= len(timeline) if args.mode == "play" else None})
        elif name == "stop":
            try:
                s = script.exports_sync.drain()
            except Exception as e:
                shutdown()
                emit({"event": "error", "message": f"取结果失败：{e}"})
                return 1
            shutdown()
            emit({"event": "stopped", "mode": args.mode, "frames": s["frame"] + 1, "log": s["log"]})
            return 0


if __name__ == "__main__":
    sys.exit(main())
