"""
服务层用到的 CaptureContext 子集，背后是一个裸 ReplayController。

服务层（services/）只经两个接口接触外界：这个 ctx，和门面的 _invoke。
这里照 qrenderdoc 界面 CaptureContext 的语义实现服务层用到的方法：
- IsCaptureLoaded / GetCaptureFilename：有 controller 才算打开；
- GetAction：打开时遍历 GetRootActions 建表，只有动作的 eventId 才有，其余返回 None（同界面文档）；
- GetResourceName：取 controller.GetResources() 的 name。界面在没有自定义名字时返回的就是它
  （调试名，或按类型与 id 自动生成的名字）；空 id 为 "No Resource"，表里没有的 id 为
  "Unknown Resource <n>"，同界面源码。界面里用户手动改的名字（SetResourceCustomName）这里没有；
- LoadCapture：先关掉旧的，再打开新的；失败抛异常，此时不再有打开的抓帧。
  打开后照界面的做法停在最后一个动作上，没传 event_id 的读取看到的状态和界面一致；
- Replay：返回带 BlockInvoke(cb) 的对象，cb(controller) 在当前线程直接调用。

要兼容 RenderDoc 内嵌的 Python 3.8：不用 match、不用运行期求值的 `X | None` 注解。
"""

import renderdoc as rd


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


class _Replay(object):
    """界面 ReplayManager 的替身：BlockInvoke 直接在当前线程调用。"""

    def __init__(self, ctx):
        self._ctx = ctx

    def BlockInvoke(self, callback):
        callback(self._ctx.controller)


class ReplayContext(object):
    """服务层用到的 CaptureContext 子集，背后是一个裸 ReplayController。"""

    def __init__(self):
        self.controller = None
        self._cap = None
        self._path = None
        self._actions = {}
        self._names = {}
        self._replay = _Replay(self)

    # ==================== 服务层用到的 CaptureContext 方法 ====================

    def IsCaptureLoaded(self):
        return self.controller is not None

    def GetCaptureFilename(self):
        if self.controller is None:
            return ""
        return self._path

    def GetAction(self, event_id):
        return self._actions.get(event_id)

    def GetResourceName(self, resource_id):
        if resource_id == rd.ResourceId.Null():
            return "No Resource"
        name = self._names.get(str(resource_id))
        if name is not None:
            return name
        return "Unknown Resource %s" % str(resource_id).split("::")[-1]

    def LoadCapture(self, path, opts, orig, temporary, local):
        # temporary / local 只对界面有意义（关闭时是否提示保存、是否远程回放），这里只读本地文件
        self.close()
        cap = rd.OpenCaptureFile()
        try:
            status = cap.OpenFile(path, "", None)
            if not _ok(status):
                raise RuntimeError("OpenFile: %s" % _message(status))
            status, controller = cap.OpenCapture(opts, None)
            if not _ok(status):
                raise RuntimeError("OpenCapture: %s" % _message(status))
        except Exception:
            cap.Shutdown()
            raise

        actions = {}

        def walk(items):
            for action in items:
                actions[action.eventId] = action
                walk(action.children)

        roots = controller.GetRootActions()
        walk(roots)
        names = {}
        for res in controller.GetResources():
            names[str(res.resourceId)] = res.name

        self._cap = cap
        self.controller = controller
        self._path = orig or path
        self._actions = actions
        self._names = names

        # 界面加载完成后选中最后一个动作（最后一个根动作一路取最后一个子动作），回放停在那里
        last = roots[-1] if len(roots) else None
        while last is not None and len(last.children):
            last = last.children[-1]
        if last is not None:
            controller.SetFrameEvent(last.eventId, True)

    def Replay(self):
        return self._replay

    # ==================== 工作进程自己用 ====================

    def close(self):
        """Shutdown controller 与 CaptureFile。返回关掉的路径，没有打开的为 None。"""
        controller, cap, path = self.controller, self._cap, self._path
        self.controller = None
        self._cap = None
        self._path = None
        self._actions = {}
        self._names = {}
        if controller is not None:
            controller.Shutdown()
        if cap is not None:
            cap.Shutdown()
        return path if controller is not None else None
