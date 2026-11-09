"""
抓帧控制：在常驻回放工作进程（qrenderdoc --python）里连 RenderDoc 注入在 WPE 里的目标（Target Control）。

照 ignore/wpe-mcp/exp/target2.py 改写成常驻进程里的函数（旧 skill 的 target.py 不动）。连接用完即断，不长期占着：
- 连接一律不抢占（forceConnection=False）。目标的连接是独占的，别的客户端连着时，不抢占的连接会被拒：
  CreateTargetControl 照样返回对象，但 GetBusyClient() 非空、第一条消息就是 Disconnected。报出对方名字，不踢人。
- 新连接一上来，目标会把它这辈子抓过的每一张都再发一遍 NewCapture（captureId 从 0 递增，文件可能早已被移走）。
  所以先「静置」收完这批旧消息、记下它们的 captureId，触发之后只认新的 captureId。
- RenderDoc 一次只抓「活动窗口」。活动窗口是目标进程里各会话共享的状态：第一个注册的窗口默认活动，
  CycleActiveWindow 轮到下一个，跨连接保留。可抓窗口多于一个时，先抓 1 帧探测，看缩略图尺寸认是不是自己的窗口，
  不是就删掉探测文件、切换、再探，最多探「窗口数」次；认出来以后再抓 N 帧。
- 每一张抓帧都核对缩略图尺寸。缩略图认不出（没有缩略图、按尺寸规则和别的窗口撞了）时，另开一个回放核对后备缓冲尺寸。
  按尺寸认都带容差（缩略图宽要按 8 对齐，交换链也不保证等于请求的尺寸）；只有一个可抓窗口、屏幕上只有本窗口时不看尺寸。
- 删文件前核对：路径就是本次连接里新的 NewCapture 报的，在抓帧模板目录里，文件名以模板名开头、以 .rdc 结尾。

要兼容 RenderDoc 内嵌的 Python 3.8：不用 match、不用运行期求值的 `X | None` 注解。
"""

import os
import time

import renderdoc as rd

DEFAULT_CLIENT = "kabegame-wpe-renderdoc-mcp"

# 缩略图规则（RenderDoc 1.47，第 3 批实测）：宽 = min(后备缓冲宽, THUMB_MAX_WIDTH) 向下对齐到 THUMB_ALIGN 的倍数，
# 高 = 宽 × 后备缓冲高 ÷ 后备缓冲宽（向下取整）。如 900×500 → 896×497、3840×2130 → 2048×1136。
THUMB_MAX_WIDTH = 2048
THUMB_ALIGN = 8
# 认窗口的容差（缺省值；MCP 每次请求都会传，以 MCP 那边 session.SIZE_TOL / capture.THUMB_TOL 为准）：
#   SIZE_TOL：后备缓冲和窗口客户区之间（窗口像素）；THUMB_TOL：缩略图和按规则预测的缩略图之间（缩略图像素）
SIZE_TOL = 8
THUMB_TOL = 2


def _ok(status):
    """OpenFile / OpenCapture 的返回值：1.32 起是 ResultDetails（有 OK()），更早是枚举。"""
    ok = getattr(status, "OK", None)
    if callable(ok):
        return bool(ok())
    codes = getattr(rd, "ResultCode", None) or getattr(rd, "ReplayStatus")
    return status == codes.Succeeded


def _message(status):
    message = getattr(status, "Message", None)
    if callable(message):
        return message()
    return str(status)


def _api(use):
    return {"name": str(getattr(use, "name", "")), "presenting": bool(getattr(use, "presenting", False)),
            "supported": bool(getattr(use, "supported", False)),
            "supportMessage": str(getattr(use, "supportMessage", ""))}


class TargetBusy(Exception):
    """目标被别的客户端连着"""


class TargetGone(Exception):
    """目标断开了（WPE 退出，或连接被别人抢占）"""


class Connection(object):
    """一个不抢占的 Target Control 连接。用完一定 close()。"""

    def __init__(self, ident, client):
        self.ident = ident
        self.client = client
        self.apis = []
        self.windows = None
        self.backlog = {}      # 连上时目标重发的旧抓帧：captureId → 路径
        self.new = []          # 本次连接里新抓的
        self.messages = 0
        self.last_backlog = None
        # 静置结束前收到的 NewCapture 都算旧的
        self.accepting_new = False
        t0 = time.time()
        self.target = rd.CreateTargetControl("", int(ident), client, False)
        self.connect_s = round(time.time() - t0, 3)
        if self.target is None:
            raise TargetGone("连不上目标 %s（目标不在了，或拒绝连接）" % ident)
        busy = ""
        getter = getattr(self.target, "GetBusyClient", None)
        if callable(getter):
            busy = getter() or ""
        if busy:
            self.close()
            raise TargetBusy(busy)

    def close(self):
        target, self.target = self.target, None
        if target is not None:
            try:
                target.Shutdown()
            except Exception:
                pass

    def handle(self, msg):
        kind = msg.type
        self.messages += 1
        T = rd.TargetControlMessageType
        if kind == T.Disconnected:
            # 被别的客户端占着时，不抢占的连接第一条消息就是 Disconnected
            getter = getattr(self.target, "GetBusyClient", None)
            busy = getter() if callable(getter) else ""
            if busy:
                raise TargetBusy(busy)
            raise TargetGone("目标断开了（WPE 退出，或连接被别的客户端抢占）")
        if kind == T.Busy:
            raise TargetBusy(getattr(msg.busy, "clientName", "") or "")
        if kind == T.RegisterAPI:
            self.apis.append(_api(msg.apiUse))
        elif kind == T.CapturableWindowCount:
            self.windows = int(msg.capturableWindowCount)
        elif kind == T.NewCapture:
            cap = msg.newCapture
            item = {"id": int(cap.captureId), "frame": int(cap.frameNumber), "path": cap.path,
                    "bytes": int(cap.byteSize), "local": bool(cap.local), "timestamp": int(cap.timestamp),
                    "thumb": [int(getattr(cap, "thumbWidth", 0) or 0), int(getattr(cap, "thumbHeight", 0) or 0)]}
            if not self.accepting_new or item["id"] in self.backlog:
                self.backlog[item["id"]] = item["path"]
                self.last_backlog = time.time()
            else:
                self.new.append(item)

    def pump(self, seconds, until=None):
        """持续 ReceiveMessage（文档要求这样保持连接；没有消息时它很快返回 Noop）。until 为真就提前返回 True。"""
        end = time.time() + seconds
        while time.time() < end:
            self.handle(self.target.ReceiveMessage(None))
            if until is not None and until():
                return True
        return until is None

    def settle(self, minimum=0.4, quiet=0.3, maximum=5.0):
        """连上后静置：等窗口数到了、旧抓帧重发完（quiet 秒内没有新的旧抓帧），最少 minimum 秒，最多 maximum 秒。"""
        t0 = time.time()

        def done():
            now = time.time()
            if now - t0 < minimum or self.windows is None:
                return False
            return self.last_backlog is None or now - self.last_backlog >= quiet

        self.pump(maximum, done)
        self.accepting_new = True
        return round(time.time() - t0, 3)

    def summary(self):
        target = self.target
        # 没有可抓窗口时目标不发 CapturableWindowCount（实测），按 0 报
        return {"ident": self.ident, "pid": target.GetPID() if target else None,
                "target": target.GetTarget() if target else None, "api": target.GetAPI() if target else None,
                "apis": self.apis, "windows": self.windows or 0, "windows_reported": self.windows is not None,
                "backlog": len(self.backlog)}

    def wait_new(self, count, timeout):
        """触发之后等到本次连接里新抓的有 count 张。"""
        return self.pump(timeout, lambda: len(self.new) >= count)


# ==================== 尺寸与核对 ====================


def predicted_thumb(size):
    """按上面的规则预测尺寸 size 的后备缓冲抓出来的缩略图。"""
    w, h = int(size[0]), int(size[1])
    tw = min(w, THUMB_MAX_WIDTH) // THUMB_ALIGN * THUMB_ALIGN
    if w <= 0 or tw <= 0:
        return [0, 0]
    return [tw, h * tw // w]


def _dist(a, b):
    """两个尺寸的差：宽、高两边差的较大者。"""
    return max(abs(int(a[0]) - int(b[0])), abs(int(a[1]) - int(b[1])))


def _sz(s):
    return "%dx%d" % (int(s[0]), int(s[1]))


def judge(thumb, expect, others, thumb_tol=THUMB_TOL):
    """按缩略图认：('mine' | 'other' | 'unsure', 说明)。
    和本窗口、别的可能被抓到的窗口（others）各自的预测缩略图比，差在 thumb_tol 以内的算候选：
    只有一个候选就按它认；没有候选或有两个以上候选，都交给回放（unsure）。"""
    if not thumb or thumb[0] <= 0 or thumb[1] <= 0:
        return "unsure", "没有缩略图"
    near = []
    for size, mine in [(expect, True)] + [(o, False) for o in others]:
        d = _dist(thumb, predicted_thumb(size))
        if d <= thumb_tol:
            near.append((d, list(size), mine))
    if not near:
        return "unsure", "缩略图 %s 和哪个窗口的预测都对不上（本窗口 %s 预测 %s）" % (
            _sz(thumb), _sz(expect), _sz(predicted_thumb(expect)))
    if len(near) > 1:
        return "unsure", "缩略图 %s 在误差 %d 内可能来自 %s" % (_sz(thumb), thumb_tol, [_sz(s) for _, s, _ in near])
    d, size, mine = near[0]
    if mine:
        return "mine", "缩略图 %s 对得上本窗口 %s（预测 %s，差 %d）" % (
            _sz(thumb), _sz(expect), _sz(predicted_thumb(expect)), d)
    return "other", "缩略图 %s 是 %s 的窗口（预测 %s，差 %d）" % (
        _sz(thumb), _sz(size), _sz(predicted_thumb(size)), d)


def judge_backbuffer(backbuffers, expect, others, size_tol=SIZE_TOL):
    """按回放的后备缓冲认：('mine' | 'other' | 'ambiguous', 说明)。
    差在 size_tol 以内的窗口里取最接近的；本窗口和别的窗口一样近时分不清（ambiguous）。"""
    if not backbuffers:
        return "ambiguous", "回放里没有后备缓冲"
    bb = backbuffers[0]
    near = []
    for size, mine in [(expect, True)] + [(o, False) for o in others]:
        d = _dist(bb, size)
        if d <= size_tol:
            near.append((d, list(size), mine))
    if not near:
        return "other", "后备缓冲 %s 和本窗口 %s 差 %d，超出误差 %d" % (_sz(bb), _sz(expect), _dist(bb, expect), size_tol)
    best = min(n[0] for n in near)
    tops = [n for n in near if n[0] == best]
    kinds = set(n[2] for n in tops)
    if len(kinds) > 1:
        return "ambiguous", "后备缓冲 %s 和本窗口与别的窗口 %s 一样近，分不清" % (
            _sz(bb), [_sz(n[1]) for n in tops if not n[2]])
    if True in kinds:
        return "mine", "后备缓冲 %s 对得上本窗口 %s（差 %d）" % (_sz(bb), _sz(expect), best)
    return "other", "后备缓冲 %s 是 %s 的窗口（差 %d）" % (_sz(bb), _sz(tops[0][1]), best)


def inspect(path):
    """另开一个回放读一张抓帧：绘制数、各绘制的索引数、绘制目标尺寸、后备缓冲尺寸。不碰当前打开的抓帧。"""
    if not os.path.isfile(path):
        raise ValueError("抓帧文件不在：%s" % path)
    t0 = time.time()
    cap = rd.OpenCaptureFile()
    try:
        status = cap.OpenFile(path, "", None)
        if not _ok(status):
            raise RuntimeError("OpenFile: %s" % _message(status))
        status, controller = cap.OpenCapture(rd.ReplayOptions(), None)
        if not _ok(status):
            raise RuntimeError("OpenCapture: %s" % _message(status))
        try:
            draws = []
            targets = set()

            def walk(actions):
                for action in actions:
                    if action.flags & rd.ActionFlags.Drawcall:
                        draws.append(int(action.numIndices))
                        for out in action.outputs:
                            if out != rd.ResourceId.Null():
                                targets.add(str(out))
                    walk(action.children)

            walk(controller.GetRootActions())
            textures = controller.GetTextures()
            swap = [[int(t.width), int(t.height)] for t in textures
                    if t.creationFlags & rd.TextureCategory.SwapBuffer]
            target_sizes = sorted(set((int(t.width), int(t.height)) for t in textures
                                      if str(t.resourceId) in targets))
            api = str(controller.GetAPIProperties().pipelineType)
        finally:
            controller.Shutdown()
    finally:
        cap.Shutdown()
    return {"path": path, "api": api, "draws": len(draws), "indices": draws[:32],
            "draw_target_sizes": [list(s) for s in target_sizes], "backbuffers": swap,
            "took_s": round(time.time() - t0, 3)}


def _safe_delete(item, template):
    """删本次连接里新抓的文件：路径必须是 NewCapture 报的、在模板目录里、文件名以模板名开头且以 .rdc 结尾。"""
    path = item.get("path") or ""
    folder = os.path.normcase(os.path.abspath(os.path.dirname(template)))
    prefix = os.path.basename(template).lower()
    norm = os.path.normcase(os.path.abspath(path))
    name = os.path.basename(norm)
    if os.path.dirname(norm) != folder or not name.startswith(prefix) or not name.endswith(".rdc"):
        return {"path": path, "deleted": False, "reason": "不在抓帧模板目录里或文件名不对，不删"}
    if not os.path.isfile(path):
        return {"path": path, "deleted": False, "reason": "文件不在"}
    for i in range(50):
        try:
            os.remove(path)
            return {"path": path, "deleted": True}
        except PermissionError:
            if i == 49:
                return {"path": path, "deleted": False, "reason": "删不掉（被占用）"}
            time.sleep(0.05)
    return {"path": path, "deleted": False}


def _verify(item, expect, others, size_tol=SIZE_TOL, thumb_tol=THUMB_TOL):
    """核对一张：先看缩略图，认不准就回放核对后备缓冲尺寸。返回 'mine' / 'other' / 'ambiguous'（回放后仍分不清）。"""
    verdict, why = judge(item["thumb"], expect, others, thumb_tol)
    item["judge"] = verdict
    item["why"] = why
    if verdict == "unsure":
        try:
            info = inspect(item["path"])
            item["replay"] = {"backbuffers": info["backbuffers"], "draws": info["draws"]}
            verdict, why2 = judge_backbuffer(info["backbuffers"], expect, others, size_tol)
            item["why"] = why + "；回放核对：" + why2
        except Exception as e:
            verdict = "ambiguous"
            item["why"] = why + "；回放核对失败：%s" % e
        item["judge"] = verdict
    return verdict


# ==================== 请求 ====================


def target_find(pid, timeout=10.0, client=DEFAULT_CLIENT):
    """按进程号在 EnumerateRemoteTargets 里找目标号。连接不抢占，查完即断。
    有目标被别的客户端连着时读不到它的进程号（被拒的连接拿不到握手信息），不再重试，报出对方名字。
    RenderDoc 报的客户端名会把 '-' 换成 '_'。"""
    deadline = time.time() + float(timeout)
    seen = []
    busy = {}
    while True:
        ident = rd.EnumerateRemoteTargets("", 0)
        while ident:
            try:
                conn = Connection(ident, client)
            except TargetBusy as e:
                busy[ident] = str(e)
                ident = rd.EnumerateRemoteTargets("", ident)
                continue
            except TargetGone:
                ident = rd.EnumerateRemoteTargets("", ident)
                continue
            try:
                found = conn.target.GetPID()
                seen.append({"ident": ident, "pid": found, "target": conn.target.GetTarget()})
            finally:
                conn.close()
            if found == int(pid):
                return {"ident": ident, "pid": found, "seen": seen}
            ident = rd.EnumerateRemoteTargets("", ident)
        if busy or time.time() >= deadline:
            break
        time.sleep(0.5)
    result = {"ident": None, "seen": seen[-8:]}
    if busy:
        result["error_kind"] = "busy"
        result["busy"] = [{"ident": k, "busy_client": v} for k, v in sorted(busy.items())]
        result["error"] = "目标被别的客户端连着（%s），读不到它的进程号，没有抢占" % "，".join(
            "%s：%s" % (k, v or "对方没报名字") for k, v in sorted(busy.items()))
    else:
        result["error_kind"] = "not_found"
        result["error"] = "没找到进程 %s 的 RenderDoc 目标" % pid
    return result


def target_status(ident, client=DEFAULT_CLIENT, settle=1.5):
    """API、是否在呈现、可抓窗口数。连接不抢占，读完即断。"""
    try:
        conn = Connection(ident, client)
    except TargetBusy as e:
        return {"ok": False, "error_kind": "busy", "busy_client": str(e),
                "error": "目标被别的客户端连着（%s），没有抢占" % (str(e) or "对方没报名字")}
    except TargetGone as e:
        return {"ok": False, "error_kind": "gone", "error": str(e)}
    try:
        conn.settle(minimum=float(settle), maximum=float(settle) + 3)
        result = conn.summary()
        result["ok"] = True
        result["connect_s"] = conn.connect_s
        return result
    except TargetBusy as e:
        return {"ok": False, "error_kind": "busy", "busy_client": str(e),
                "error": "目标被别的客户端连着（%s），没有抢占" % (str(e) or "对方没报名字")}
    except TargetGone as e:
        return {"ok": False, "error_kind": "gone", "error": str(e)}
    finally:
        conn.close()


def target_capture(ident, frames, expect_size, template, others=None, timeout=60.0, client=DEFAULT_CLIENT,
                   probe_timeout=30.0, desktop=None, test_windows=None, size_tol=SIZE_TOL, thumb_tol=THUMB_TOL):
    """
    不抢占地连目标 → 认出自己的窗口 → 触发 frames 帧 → 逐张核对 → 断开。

    expect_size：本窗口尺寸 [宽, 高]；others：别的测试窗口尺寸；template：注入时的抓帧模板（删文件时核对）。
    desktop / test_windows：桌面壁纸窗口尺寸、屏幕上的测试窗口数（含本窗口）。桌面设备正常不被挂上（注入前就建好了），
    只有可抓窗口数多于测试窗口数时（Q13：桌面壁纸被重建、挂上了），才把桌面尺寸也算作可能被抓到的。
    认窗口：
    - 可抓窗口只有一个、屏幕上的测试窗口只有本窗口（所以桌面也没被挂上）：直接认作本窗口，不看尺寸；
      只核对这一次的 N 张缩略图彼此相同；
    - 其他情况按尺寸认，带容差（size_tol / thumb_tol），多于一个可抓窗口时先探测。
    总是返回 dict：ok 为假时带 error / error_kind，本次新抓的文件已删（deleted 里列出）。
    """
    expect = [int(expect_size[0]), int(expect_size[1])]
    others = [[int(o[0]), int(o[1])] for o in (others or [])]
    desktop = [[int(o[0]), int(o[1])] for o in (desktop or [])]
    frames = int(frames)
    size_tol = int(size_tol)
    thumb_tol = int(thumb_tol)
    t_all = time.time()
    result = {"ok": False, "ident": ident, "expect": expect, "others": others, "frames_requested": frames,
              "size_tol": size_tol, "thumb_tol": thumb_tol, "probes": [], "captures": [], "deleted": []}
    try:
        conn = Connection(ident, client)
    except TargetBusy as e:
        result.update(error_kind="busy", busy_client=str(e),
                      error="目标被别的客户端连着（%s），没有抢占" % (str(e) or "对方没报名字"))
        return result
    except TargetGone as e:
        result.update(error_kind="gone", error=str(e))
        return result
    result["connect_s"] = conn.connect_s

    def fail(kind, message):
        result.update(ok=False, error_kind=kind, error=message)

    try:
        result["settle_s"] = conn.settle()
        result.update(conn.summary())
        windows = conn.windows or 0
        if windows <= 0:
            fail("no_window", "目标没有可抓窗口（窗口还没建好设备，或已经关了）")
            return result
        if desktop and test_windows is not None and windows > int(test_windows):
            result["desktop_hooked"] = True
            others = others + [d for d in desktop if d not in others]
        result["rivals"] = others
        # 唯一可抓窗口、屏幕上只有本窗口：不看尺寸（交换链尺寸不一定等于请求的尺寸，缩略图还要对齐）
        single = windows == 1 and test_windows is not None and int(test_windows) == 1
        result["single"] = single

        # 1. 认窗口：只有一个可抓窗口时直接抓，靠逐张核对兜底；多于一个时探测
        if windows > 1:
            found = False
            for i in range(windows):
                if i > 0:
                    conn.target.CycleActiveWindow()
                    result["cycles"] = result.get("cycles", 0) + 1
                start = len(conn.new)
                conn.target.TriggerCapture(1)
                if not conn.wait_new(start + 1, probe_timeout):
                    fail("timeout", "探测第 %d 次：%g s 内没抓到帧（窗口没在呈现？）" % (i + 1, probe_timeout))
                    return result
                item = conn.new[start]
                verdict = _verify(item, expect, others, size_tol, thumb_tol)
                probe = {"n": i + 1, "frame": item["frame"], "thumb": item["thumb"], "judge": verdict,
                         "why": item["why"]}
                if "replay" in item:
                    probe["replay"] = item["replay"]
                # 探测文件一律删掉（认对了的那张也删：它和后面的 N 帧不连续）
                gone = _safe_delete(item, template)
                item["deleted"] = gone.get("deleted")
                probe["path"] = item["path"]
                probe["deleted"] = gone.get("deleted")
                if not gone.get("deleted"):
                    probe["delete_note"] = gone.get("reason")
                result["probes"].append(probe)
                if verdict == "ambiguous":
                    fail("ambiguous", "探测第 %d 次分不清是不是本窗口（%s）：%s" % (i + 1, _sz(expect), item["why"]))
                    return result
                if verdict == "mine":
                    found = True
                    break
            if not found:
                fail("not_found", "探了 %d 个可抓窗口都不是 %dx%d 的本窗口" % (windows, expect[0], expect[1]))
                return result

        # 2. 抓 N 帧
        start = len(conn.new)
        t0 = time.time()
        conn.target.TriggerCapture(frames)
        complete = conn.wait_new(start + frames, float(timeout))
        caps = conn.new[start:]
        result["capture_s"] = round(time.time() - t0, 3)
        result["captures"] = caps
        if not complete:
            presenting = any(a.get("presenting") for a in conn.apis)
            fail("timeout", "%g s 内只抓到 %d / %d 帧%s" % (
                float(timeout), len(caps), frames, "" if presenting else "（presenting 为假：窗口在，但没在画）"))
            return result

        # 3. 逐张核对；同一次触发的 N 帧来自同一个活动窗口，缩略图认不准时只回放第一张
        wrong = []
        decided = None
        for item in caps:
            if single:
                # 唯一可抓窗口：不看尺寸，只要求这 N 张来自同一个窗口（缩略图彼此相同）
                same = item["thumb"] == caps[0]["thumb"]
                item["judge"] = "mine" if same else "other"
                item["why"] = ("唯一可抓窗口、屏幕上只有本窗口，不看尺寸" if same
                               else "缩略图和第一张不同（%s 对 %s）" % (_sz(item["thumb"]), _sz(caps[0]["thumb"])))
            elif decided is not None and item["thumb"] == caps[0]["thumb"]:
                item["judge"] = decided
                item["why"] = "缩略图与第一张相同"
            else:
                decided = _verify(item, expect, others, size_tol, thumb_tol)
            if item["judge"] == "ambiguous":
                fail("ambiguous", "分不清抓到的是不是本窗口（%s）：%s" % (_sz(expect), item["why"]))
                return result
            if item["judge"] != "mine":
                wrong.append(item)
        if wrong:
            fail("mismatch", "抓到的帧不是本窗口（%dx%d）的：%s" % (
                expect[0], expect[1], [(w["frame"], w["thumb"], w["why"]) for w in wrong]))
            return result
        result["ok"] = True
        return result
    except TargetBusy as e:
        fail("busy", "目标被别的客户端连着（%s），没有抢占" % (str(e) or "对方没报名字"))
        result["busy_client"] = str(e)
        return result
    except TargetGone as e:
        fail("gone", str(e))
        return result
    except Exception as e:
        fail("error", "%s: %s" % (type(e).__name__, e))
        return result
    finally:
        conn.close()
        # 没成功：本次连接里新抓的、还没删的文件都删掉，模板目录里不留本次的文件
        if not result.get("ok"):
            for item in conn.new:
                if not item.get("deleted"):
                    gone = _safe_delete(item, template)
                    item["deleted"] = gone.get("deleted")
                    result["deleted"].append(gone)
        result["took_s"] = round(time.time() - t_all, 3)
