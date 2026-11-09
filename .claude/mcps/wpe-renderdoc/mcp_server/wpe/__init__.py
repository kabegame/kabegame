"""
WPE 一侧：常驻共享的 WPE 进程、各会话自己的测试窗口、配置与日志（第 2 批）。

- process.py   WPE 进程、注入、崩溃标记、启动与正常退出、设置界面、桌面壁纸窗口
- windows.py   顶层窗口枚举、测试窗口（WPEOverlappedWallpaper）、物理像素矩形、等出现 / 消失
- registry.py  机器级窗口表与两把文件锁（windows.lock、wpe.lock）
- control.py   wallpaper64.exe -control
- projects.py  解析工程
- log.py       log.txt 游标与增量
- settings.py  config.json 读写（照 WPE 自己的格式）
- ensure.py    ensure_running、restart_wpe
- session.py   本会话的窗口：开、关、改属性、列表、陈旧窗口回收、退出时清理
"""

from .common import WpeError  # noqa: F401
