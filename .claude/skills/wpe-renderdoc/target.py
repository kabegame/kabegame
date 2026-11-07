# 在 qrenderdoc 内嵌的 Python 里运行，由 driver.py 调用：
#   这台机器的 RenderDoc 没有 pymodules，Target Control API 只能从这里用。
#   qrenderdoc 是 GUI 程序，stdout 不可见，所以结果写 WPE_RD_OUT；--python 的脚本在主界面之前运行，写完 os._exit(0) 就不会弹窗。
import json
import os
import time
import traceback

import renderdoc as rd

CLIENT = 'kabegame-wpe-renderdoc'
params = json.loads(os.environ['WPE_RD_PARAMS'])


def describe_api(use):
    return {name: str(getattr(use, name, None)) for name in ('name', 'presenting', 'supported', 'supportMessage')}


class Session:
    def __init__(self, ident, force):
        self.target = rd.CreateTargetControl('', ident, CLIENT, force)
        if self.target is None:
            raise RuntimeError(f'连不上目标 {ident}')
        self.apis = []
        self.windows = None
        self.captures = []

    def handle(self, msg):
        kind = msg.type
        if kind == rd.TargetControlMessageType.Disconnected:
            raise RuntimeError('目标断开了')
        if kind == rd.TargetControlMessageType.RegisterAPI:
            self.apis.append(describe_api(msg.apiUse))
        elif kind == rd.TargetControlMessageType.CapturableWindowCount:
            self.windows = msg.capturableWindowCount
        elif kind == rd.TargetControlMessageType.NewCapture:
            cap = msg.newCapture
            self.captures.append({'id': cap.captureId, 'frame': cap.frameNumber, 'path': cap.path,
                                  'bytes': cap.byteSize, 'local': cap.local, 'timestamp': cap.timestamp})
        elif kind == rd.TargetControlMessageType.Busy:
            raise RuntimeError(f'目标被 {msg.busy.clientName} 占用')

    def pump(self, seconds, until=None):
        # 文档要求持续调用 ReceiveMessage 保持连接，没有消息时它很快返回 Noop
        end = time.time() + seconds
        while time.time() < end:
            self.handle(self.target.ReceiveMessage(None))
            if until is not None and until():
                return True
        return until is None

    def summary(self):
        return {'pid': self.target.GetPID(), 'target': self.target.GetTarget(), 'api': self.target.GetAPI(),
                'apis': self.apis, 'windows': self.windows}


def find():
    """按 PID 找 ident：同一台机器上可能有别的被注入程序。"""
    deadline = time.time() + params.get('timeout', 30)
    seen = []
    while time.time() < deadline:
        ident = rd.EnumerateRemoteTargets('', 0)
        while ident:
            target = rd.CreateTargetControl('', ident, CLIENT, False)
            if target is not None:
                pid = target.GetPID()
                seen.append({'ident': ident, 'pid': pid, 'target': target.GetTarget()})
                target.Shutdown()
                if pid == params['pid']:
                    return {'ident': ident}
            ident = rd.EnumerateRemoteTargets('', ident)
        time.sleep(0.5)
    return {'error': f'没找到 PID {params["pid"]} 的目标', 'seen': seen[-8:]}


def status():
    session = Session(params['ident'], True)
    session.pump(params.get('settle', 2))
    result = session.summary()
    session.target.Shutdown()
    return result


def capture():
    session = Session(params['ident'], True)
    # 先等 RegisterAPI 和窗口数：还没有 API 时触发不会有结果
    session.pump(params.get('settle', 1.5))
    if session.windows is not None and session.windows > 1 and not params.get('any_window'):
        # 多个交换链时抓到的不一定是想要的窗口，文件照样落盘、看着完全成功，所以这里直接拒绝
        result = session.summary()
        session.target.Shutdown()
        result['error'] = (f'有 {result["windows"]} 个可抓窗口，抓到哪个不确定。'
                           '用 close 关掉多余的，或者 open 时带 --close-desktop；确实要抓就加 --any-window 自己核对')
        return result
    for _ in range(params.get('cycle', 0)):
        session.target.CycleActiveWindow()
    frames = params['frames']
    session.target.TriggerCapture(frames)
    done = session.pump(params.get('timeout', 60), lambda: len(session.captures) >= frames)
    result = session.summary()
    result.update(captures=session.captures, complete=bool(done))
    session.target.Shutdown()
    return result


def inspect():
    """回放一张抓帧，报告绘制数和后备缓冲尺寸：抓错窗口时文件名和大小都看不出来。"""
    cap = rd.OpenCaptureFile()
    code = cap.OpenFile(params['path'], '', None)
    if code != rd.ResultCode.Succeeded:
        return {'error': f'打不开抓帧：{code}'}
    code, controller = cap.OpenCapture(rd.ReplayOptions(), None)
    if code != rd.ResultCode.Succeeded:
        cap.Shutdown()
        return {'error': f'回放失败：{code}'}
    draws = []

    def walk(actions):
        for action in actions:
            if action.flags & rd.ActionFlags.Drawcall:
                draws.append(action.numIndices)
            walk(action.children)

    walk(controller.GetRootActions())
    swap = [[t.width, t.height] for t in controller.GetTextures() if t.creationFlags & rd.TextureCategory.SwapBuffer]
    controller.Shutdown()
    cap.Shutdown()
    return {'draws': len(draws), 'sizes': draws[:24], 'backbuffers': swap}


try:
    output = {'find': find, 'status': status, 'capture': capture, 'inspect': inspect}[os.environ['WPE_RD_ACTION']]()
except Exception:
    output = {'error': traceback.format_exc()}
with open(os.environ['WPE_RD_OUT'], 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=1)
os._exit(0)
