"""本地桥：旧 RenderDocBridge.call 的替身。

在 qrenderdoc --python 里运行，直接用 .claude/mcps/wpe-renderdoc/renderdoc_worker 的服务层（ReplayContext、RenderDocFacade、
RequestHandler），不经 IPC、不要界面、不经 MCP。调用方先把 MCP 目录放进 sys.path（main.py 做）。

返回值先过一遍 JSON（dumps 再 loads）：旧桥的结果是扩展 json.dumps 后由客户端 json.load 的，元组变列表、整数键变字符串，
这里照做，移植过来的提取脚本看到的形状和旧桥逐项相同。

依赖：renderdoc_worker 的 ReplayContext、RenderDocFacade、RequestHandler 三个类与 handle() 的返回形状
（{"id", "result"} 或 {"id", "error": {"code", "message"}}）。MCP 改这三个时要同步这里。

要兼容 RenderDoc 内嵌的 Python 3.8。
"""

import json


class BridgeError(RuntimeError):
    """服务层回了错误（对应旧桥的 RenderDocBridgeError）。"""

    def __init__(self, method, code, message):
        RuntimeError.__init__(self, "%s：[%s] %s" % (method, code, message))
        self.method = method
        self.code = code
        self.message = message


class LocalBridge(object):
    """旧 RenderDocBridge.call 的替身：同一套服务层，返回同样形状的 JSON。"""

    def __init__(self):
        from renderdoc_worker.context import ReplayContext
        from renderdoc_worker.renderdoc_facade import RenderDocFacade
        from renderdoc_worker.request_handler import RequestHandler

        self.ctx = ReplayContext()
        self._handler = RequestHandler(RenderDocFacade(self.ctx))
        self._next = 0

    def call(self, method, params=None):
        self._next += 1
        response = self._handler.handle({"id": self._next, "method": method, "params": params or {}})
        if "error" in response:
            error = response["error"]
            raise BridgeError(method, error.get("code"), error.get("message"))
        return json.loads(json.dumps(response.get("result")))

    def close(self):
        """关掉打开的抓帧（Shutdown controller 与 CaptureFile）。"""
        return self.ctx.close()
