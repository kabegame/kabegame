# 命令行自动抓 Wallpaper Engine 的 RenderDoc 帧。用法见 SKILL.md。
# 只结束自己启动的 WPE；对 config.json 的改动都先备份，stop 时按字节还原。
import argparse
import ctypes
import ctypes.wintypes as wintypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
WORK = os.path.join(REPO, '.kabegame', 'debug', 'wpe-renderdoc')
STATE = os.path.join(WORK, 'state.json')
BACKUP = os.path.join(WORK, 'config.json')

WPE_DIR = os.environ.get('KABEGAME_WPE_ROOT', r'D:\Applications\Steam\steamapps\common\wallpaper_engine')
WPE_EXE = os.path.join(WPE_DIR, 'wallpaper64.exe')
CONFIG = os.path.join(WPE_DIR, 'config.json')
RENDERDOC = os.environ.get('RENDERDOC_DIR', r'C:\Program Files\RenderDoc')
QRENDERDOC = os.path.join(RENDERDOC, 'qrenderdoc.exe')
RENDERDOCCMD = os.path.join(RENDERDOC, 'renderdoccmd.exe')
# 抓帧先落这里，再移到 --out。和 A:\<项目>\ 同盘，移动不用复制几百 MB
TEMPLATE = os.environ.get('WPE_RD_TEMPLATE', r'A:\_rdtemp\wallpaper64')


def die(message):
    print('错误：' + message, file=sys.stderr)
    sys.exit(1)


def wpe_pids():
    out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq wallpaper64.exe', '/FO', 'CSV', '/NH'],
                         capture_output=True).stdout.decode('utf-8', 'replace')
    return [int(line.split('","')[1]) for line in out.splitlines() if 'wallpaper64' in line]


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_state():
    if not os.path.exists(STATE):
        return None
    with open(STATE, encoding='utf-8') as f:
        return json.load(f)


def save_state(state):
    os.makedirs(WORK, exist_ok=True)
    with open(STATE, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


def session():
    state = load_state()
    if state is None:
        die('没有进行中的会话，先跑 start')
    if state.get('pid') not in wpe_pids():
        die('会话的 WPE 进程已经不在了，跑 stop 还原配置后再 start')
    if 'ident' not in state:
        # start 中途失败时 WPE 已经起来了，这里补上，不用整个重来
        state['ident'] = in_renderdoc('find', 45, pid=state['pid'], timeout=30)['ident']
        save_state(state)
    return state


def spawn_detached(command_line, cwd):
    """经 WMI 起进程。工具的作业对象结束时，作业里的进程会被一起带走，WPE 要跨多条命令存活。"""
    script = ('$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments '
              '@{CommandLine=$env:KB_CMD; CurrentDirectory=$env:KB_CWD}; '
              'if ($r.ReturnValue -ne 0) { exit 1 }; Write-Output $r.ProcessId')
    result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True,
                            env=dict(os.environ, KB_CMD=command_line, KB_CWD=cwd), timeout=30)
    if result.returncode != 0:
        die('WMI 启动失败：' + result.stderr.decode('utf-8', 'replace')[:300])


def in_renderdoc(action, limit, **params):
    out = os.path.join(WORK, f'target-{action}.json')
    if os.path.exists(out):
        os.remove(out)
    env = dict(os.environ, WPE_RD_ACTION=action, WPE_RD_OUT=out, WPE_RD_PARAMS=json.dumps(params))
    subprocess.run([QRENDERDOC, '--python', os.path.join(HERE, 'target.py')], env=env, timeout=limit)
    if not os.path.exists(out):
        die(f'qrenderdoc 脚本没有写结果（{action}）')
    with open(out, encoding='utf-8') as f:
        result = json.load(f)
    if 'error' in result:
        die(f'{action} 失败：{result["error"]}\n{json.dumps(result.get("seen", []), ensure_ascii=False)}')
    return result


def control(command):
    # 没有主实例时，控制进程会自己变成主实例并弹出浏览界面，所以 session() 校验过才能走到这里
    subprocess.run(f'"{WPE_EXE}" -control {command}', timeout=30, check=True)


def apply_settings(items):
    """按文本替换，其余内容逐字节不动。只认文件里恰好出现一次的标量键。"""
    with open(CONFIG, encoding='utf-8', newline='') as f:
        text = f.read()
    for item in items:
        if '=' not in item:
            die(f'--set 要写成 键=值：{item}')
        key, value = item.split('=', 1)
        pattern = re.compile(r'("' + re.escape(key) + r'"\s*:\s*)("[^"\r\n]*"|[^,\s{\[]+)')
        found = pattern.findall(text)
        if len(found) != 1:
            die(f'config.json 里 {key} 出现 {len(found)} 次，只支持恰好一次的标量键')
        quoted = found[0][1].startswith('"')
        new = json.dumps(value) if quoted else value
        text = pattern.sub(lambda m: m.group(1) + new, text)
    with open(CONFIG, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def cmd_start(args):
    if load_state() is not None:
        die('上一次会话没有结束，先跑 stop')
    running = wpe_pids()
    if running:
        die(f'WPE 正在运行（PID {running}）。这个工具不结束别人启动的进程，请先从托盘退出')
    if not os.path.exists(RENDERDOCCMD):
        die(f'找不到 {RENDERDOCCMD}')
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(os.path.dirname(TEMPLATE), exist_ok=True)
    shutil.copy2(CONFIG, BACKUP)
    # 先落状态再改配置：中途失败也能用 stop 还原
    state = {'config_sha256': digest(BACKUP), 'settings': args.set, 'started': time.time()}
    save_state(state)
    apply_settings(args.set)
    spawn_detached(f'"{RENDERDOCCMD}" capture -d "{WPE_DIR}" -c "{TEMPLATE}" "{WPE_EXE}" -silent', WPE_DIR)
    deadline = time.time() + args.timeout
    while time.time() < deadline and not wpe_pids():
        time.sleep(0.2)
    pids = wpe_pids()
    if len(pids) != 1:
        die(f'wallpaper64 进程数是 {len(pids)}：{pids}。跑 stop 还原配置')
    state['pid'] = pids[0]
    save_state(state)
    state = session()
    print(json.dumps({'pid': state['pid'], 'ident': state['ident'], 'settings': args.set}, ensure_ascii=False))


def cmd_status(args):
    state = load_state()
    if state is None:
        print(json.dumps({'session': None, 'wpe': wpe_pids()}))
        return
    alive = state.get('pid') in wpe_pids()
    info = in_renderdoc('status', 30, ident=session()['ident']) if alive else {}
    print(json.dumps({'session': load_state(), 'alive': alive, 'target': info}, ensure_ascii=False, indent=1))


def resolve_project(name):
    """接受工程目录、project.json、工坊 ID、默认工程名或 myprojects 里的名字。"""
    workshop = os.path.normpath(os.path.join(WPE_DIR, '..', '..', 'workshop', 'content', '431960'))
    for item in (name, os.path.join(WPE_DIR, 'projects', 'defaultprojects', name),
                 os.path.join(WPE_DIR, 'projects', 'myprojects', name), os.path.join(workshop, name)):
        path = os.path.join(item, 'project.json') if os.path.isdir(item) else item
        if os.path.isfile(path):
            return os.path.abspath(path)
    die(f'找不到工程 {name}')


def cmd_open(args):
    session()
    path = resolve_project(args.project)
    if args.close_desktop:
        control(f'closeWallpaper -monitor {args.monitor}')
        time.sleep(1)
    if args.window:
        width, height = args.size.split('x')
        control(f'openWallpaper -file "{path}" -playInWindow "{args.window}" -width {width} -height {height}')
    else:
        control(f'openWallpaper -file "{path}" -monitor {args.monitor}')
    # 命令发出就返回，场景还在加载，这时抓帧抓到的是上一张
    time.sleep(args.wait)
    print('已打开', path)


def cmd_close(args):
    session()
    control(f'closeWallpaper -location {args.window}' if args.window else f'closeWallpaper -monitor {args.monitor}')
    print('已关闭')


def cmd_capture(args):
    state = session()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    tag = args.tag or os.path.basename(out)
    result = in_renderdoc('capture', args.timeout + 40, ident=state['ident'], frames=args.frames, cycle=args.cycle,
                          timeout=args.timeout, any_window=args.any_window)
    saved = []
    for cap in sorted(result.get('captures', []), key=lambda c: c['frame']):
        target = os.path.join(out, f'{tag}-frame{cap["frame"]}.rdc')
        shutil.move(cap['path'], target)
        saved.append({'path': target, 'frame': cap['frame'], 'mb': round(cap['bytes'] / 1048576, 1)})
    frames = [item['frame'] for item in saved]
    gaps = [b - a for a, b in zip(frames, frames[1:]) if b - a != 1]
    # 文件名和大小看不出抓错了窗口，回放第一张，报绘制数和后备缓冲尺寸
    check = in_renderdoc('inspect', 120, path=saved[0]['path']) if saved else None
    print(json.dumps({'api': result.get('api'), 'windows': result.get('windows'), 'saved': saved, 'gaps': gaps,
                      'first_frame': check}, ensure_ascii=False, indent=1))
    if len(saved) < args.frames:
        die(f'只抓到 {len(saved)} / {args.frames} 帧。windows 为 0 说明这个进程还没有在呈现的窗口')


def ui_processes():
    out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq wallpaperui.exe', '/FO', 'CSV', '/NH'],
                         capture_output=True).stdout.decode('utf-8', 'replace')
    return [int(line.split('","')[1]) for line in out.splitlines() if 'wallpaperui' in line]


def wait_gone(pid, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if pid not in wpe_pids():
            return True
        time.sleep(0.2)
    return pid not in wpe_pids()


def desktop_windows():
    """WPE 的桌面窗口挂在 WorkerW 下面，不是顶层窗口，EnumWindows 看不到。"""
    user32 = ctypes.windll.user32
    found = []
    callback = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def class_of(hwnd):
        name = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, name, 128)
        return name.value

    def child(hwnd, _):
        if class_of(hwnd) == 'WPEDesktopDX11Window':
            found.append(hwnd)
        return True

    def top(hwnd, _):
        if class_of(hwnd) in ('WorkerW', 'Progman'):
            user32.EnumChildWindows(hwnd, callback(child), 0)
        return True

    user32.EnumWindows(callback(top), 0)
    return found


def selected_wallpapers():
    """备份里每个显示器选中的壁纸：{显示器号: project.json}。"""
    with open(BACKUP, encoding='utf-8') as f:
        data = json.load(f)
    for user in data.values():
        chosen = user.get('general', {}).get('wallpaperconfig', {}).get('selectedwallpapers') if isinstance(user, dict) else None
        if chosen:
            out = {}
            for key, value in chosen.items():
                match = re.fullmatch(r'Monitor(\d+)', key)
                if match and value.get('file'):
                    out[int(match.group(1))] = os.path.join(os.path.dirname(value['file']), 'project.json')
            return out
    return {}


def restore_wallpaper():
    # 被强杀后 WPE 下次启动不自动加载壁纸，等一会儿没有就按备份放回去
    deadline = time.time() + 12
    while time.time() < deadline:
        if desktop_windows():
            return {'desktop': True, 'by': 'WPE 自己加载'}
        time.sleep(0.5)
    placed = selected_wallpapers()
    if not placed:
        return {'desktop': False, 'by': '备份里没有选中的壁纸'}
    for monitor, path in placed.items():
        subprocess.run(f'"{WPE_EXE}" -control openWallpaper -file "{os.path.normpath(path)}" -monitor {monitor}', timeout=30)
    deadline = time.time() + 15
    while time.time() < deadline:
        if desktop_windows():
            return {'desktop': True, 'by': 'openWallpaper', 'placed': placed}
        time.sleep(0.5)
    return {'desktop': False, 'by': 'openWallpaper 后仍没有窗口', 'placed': placed}


def cmd_stop(args):
    state = load_state()
    if state is None:
        die('没有进行中的会话')
    pid = state.get('pid')
    if pid in wpe_pids():
        # 只能强杀：WPE 没有退出命令，也不响应 WM_CLOSE。不加 /T：它按父进程号走树，
        # Windows 的父进程号可能是回收过的旧值。wallpaperui 主进程没了会自己退，下面核对
        subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True)
        if not wait_gone(pid, 15):
            die(f'PID {pid} 结束不了，配置没有还原')
    leftover = ui_processes()
    deadline = time.time() + 10
    while leftover and time.time() < deadline:
        time.sleep(0.5)
        leftover = ui_processes()
    shutil.copyfile(BACKUP, CONFIG)
    restored = digest(CONFIG) == state['config_sha256']
    if not restored:
        die('还原后的 config.json 哈希对不上，备份在 ' + BACKUP)
    os.remove(STATE)
    report = {'stopped': pid, 'ui_left': leftover, 'config_restored': True, 'config_sha256': state['config_sha256'][:12]}
    if args.relaunch:
        spawn_detached(f'"{WPE_EXE}" -silent', WPE_DIR)
        deadline = time.time() + 30
        while time.time() < deadline and not wpe_pids():
            time.sleep(0.2)
        report['relaunched'] = wpe_pids()
        report['wallpaper'] = restore_wallpaper()
    print(json.dumps(report, ensure_ascii=False))
    if args.relaunch and not report['wallpaper'].get('desktop'):
        die('WPE 起来了，但桌面壁纸没有回来')


def main():
    parser = argparse.ArgumentParser(description='命令行自动抓 WPE 的 RenderDoc 帧')
    sub = parser.add_subparsers(dest='command', required=True)
    start = sub.add_parser('start')
    start.add_argument('--set', action='append', default=[], metavar='键=值', help='临时改 config.json，stop 时还原')
    start.add_argument('--timeout', type=float, default=30)
    start.set_defaults(run=cmd_start)
    status = sub.add_parser('status')
    status.set_defaults(run=cmd_status)
    opener = sub.add_parser('open')
    opener.add_argument('project', help='工程目录、project.json、工坊 ID、默认工程名或 myprojects 里的名字')
    opener.add_argument('--window', help='放进这个名字的窗口；不给就换掉桌面壁纸')
    opener.add_argument('--wait', type=float, default=4, help='发出命令后等场景加载的秒数')
    opener.add_argument('--size', default='1920x1080')
    opener.add_argument('--monitor', type=int, default=0)
    opener.add_argument('--close-desktop', action='store_true', help='先关桌面壁纸，让窗口成为唯一能抓的交换链')
    opener.set_defaults(run=cmd_open)
    close = sub.add_parser('close')
    close.add_argument('--window')
    close.add_argument('--monitor', type=int, default=0)
    close.set_defaults(run=cmd_close)
    capture = sub.add_parser('capture')
    capture.add_argument('--out', required=True, help=r'目录，约定 A:\<项目>\<用途>')
    capture.add_argument('--frames', type=int, default=10, help='连续抓几帧')
    capture.add_argument('--tag', help='文件名前缀，默认取目录名')
    capture.add_argument('--cycle', type=int, default=0, help='抓之前切几次活动窗口')
    capture.add_argument('--any-window', action='store_true', help='有多个可抓窗口也继续，自己核对抓到的是哪个')
    capture.add_argument('--timeout', type=float, default=60)
    capture.set_defaults(run=cmd_capture)
    stop = sub.add_parser('stop')
    stop.add_argument('--relaunch', action='store_true', help='还原后用普通方式重新启动 WPE')
    stop.set_defaults(run=cmd_stop)
    args = parser.parse_args()
    args.run(args)


main()
