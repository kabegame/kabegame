"""在 qrenderdoc --python 里运行的抓帧提取器（RenderDoc 内嵌的 Python 3.8）。

入口是 main.py；bridge.py 是本地桥（直接调 .claude/mcps/wpe-renderdoc/renderdoc_worker 的服务层）；
track.py / frame.py / stats.py 是三个提取器，从 ignore/p4 的旧脚本移植，输出格式不变。
要兼容 Python 3.8：不用 match、不用运行期求值的 `X | None` 注解、不用 3.9+ 的标准库新接口。
"""
