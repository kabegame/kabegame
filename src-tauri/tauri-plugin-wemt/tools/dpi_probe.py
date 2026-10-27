import ctypes, ctypes.wintypes as wt, json
u = ctypes.WinDLL("user32", use_last_error=True)
# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
try:
    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception as e:
    pass
w, h = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
try:
    dpi = u.GetDpiForSystem()
except Exception:
    dpi = 0
class RECT(ctypes.Structure):
    _fields_=[("l",ctypes.c_long),("t",ctypes.c_long),("r",ctypes.c_long),("b",ctypes.c_long)]
def rect(hwnd):
    r=RECT(); u.GetWindowRect(hwnd, ctypes.byref(r)); return [r.l,r.t,r.r-r.l,r.b-r.t]
out={"screen": [w,h], "system_dpi": dpi, "host_workerw_0xE05D0": rect(0x000E05D0)}
mon = u.MonitorFromWindow(0x000E05D0, 2)
class MONITORINFO(ctypes.Structure):
    _fields_=[("cbSize",wt.DWORD),("rcMonitor",RECT),("rcWork",RECT),("dwFlags",wt.DWORD)]
mi=MONITORINFO(); mi.cbSize=ctypes.sizeof(MONITORINFO)
if u.GetMonitorInfoW(mon, ctypes.byref(mi)):
    out["monitor"]=[mi.rcMonitor.l,mi.rcMonitor.t,mi.rcMonitor.r-mi.rcMonitor.l,mi.rcMonitor.b-mi.rcMonitor.t]
    out["work"]=[mi.rcWork.l,mi.rcWork.t,mi.rcWork.r-mi.rcWork.l,mi.rcWork.b-mi.rcWork.t]
print(json.dumps(out, indent=1))
