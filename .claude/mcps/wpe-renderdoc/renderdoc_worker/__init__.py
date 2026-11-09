"""
在 qrenderdoc --python 里运行的回放工作进程（RenderDoc 内嵌的 Python 3.8）。

services/、utils/ 从 ignore/RenderDocMCP/renderdoc_extension/ 原样拷来；
context.py 提供服务层用到的 CaptureContext 子集，背后是一个裸 ReplayController。
"""
