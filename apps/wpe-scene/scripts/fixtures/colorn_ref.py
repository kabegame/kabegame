# P4b 步骤 6：colorn 的独立参考实现（照 rea-p4b-render.md 7.1、7.3、7.4 的伪代码，numpy float32 逐步舍入，fmod 双精度），
# 生成产品单测的逐位真值 apps/wpe-scene/src/particles/fixtures/colorn.json。不读产品代码。依赖 numpy。
# 用法（仓库根）：python -X utf8 -I apps/wpe-scene/scripts/fixtures/colorn_ref.py [--out 文件]
#   --out 缺省 apps/wpe-scene/src/particles/fixtures/colorn.json（按本脚本的位置推出）。
# 原件：ignore/p4/b6/colorn_ref.py（这里只把输出路径参数化）。文件 `source` 字段里的路径是最初生成时的记录，照原样写，
# 改了重新生成的文件就和仓库里的不同。
import argparse
import json
import math
import os
import random

import numpy as np

f = np.float32
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'src', 'particles', 'fixtures', 'colorn.json')


def rgb2hsv(c):
    """FUN_1401b8b90：全部 divss。"""
    r, g, b = (f(x) for x in c)
    mx = max(r, g, b)
    mn = min(r, g, b)
    d = f(mx - mn)
    if d < f(1e-5) or mx <= f(0):
        return f(0), f(0), mx
    s = f(d / mx)
    if r < mx:
        h = f(f(f(r - g) / d) + f(4)) if g < mx else f(f(f(b - r) / d) + f(2))
    else:
        h = f(f(g - b) / d)
    h = f(h / f(6))
    if h < f(0):
        h = f(h + f(1))
    return h, s, mx


def hsv2rgb(h, s, v):
    """FUN_1401b8c70：C、m、各分量 float；两次 fmod 双精度，X 在双精度里算完再转 float。"""
    h, s, v = f(h), f(s), f(v)
    C = f(v * s)
    H = f(math.fmod(float(f(h * f(6))), 6.0))
    X = f(float(C) * (1.0 - abs(math.fmod(float(H), 2.0) - 1.0)))
    m = f(v - C)
    z = f(0)
    if 0 <= H < 1:
        t = (C, X, z)
    elif 1 <= H < 2:
        t = (X, C, z)
    elif 2 <= H < 3:
        t = (z, C, X)
    elif 3 <= H < 4:
        t = (z, X, C)
    elif 4 <= H < 5:
        t = (X, z, C)
    elif 5 <= H < 6:
        t = (C, z, X)
    else:
        t = (z, z, z)
    return tuple(f(x + m) for x in t)


def clamp01(x):
    return f(0) if x < 0 else f(1) if x > 1 else x


def shift(c, target_hsv, system_hsv):
    """0xb / 0xc 的 active 分支：dh = hc − h0 先算，h' 取 floor 后的小数，s'、v' 钳到 [0, 1]。"""
    h, s, v = rgb2hsv(c)
    dh = f(target_hsv[0] - system_hsv[0])
    ds = f(target_hsv[1] - system_hsv[1])
    dv = f(target_hsv[2] - system_hsv[2])
    hue = f(dh + h)
    hue = f(hue - f(math.floor(hue)))
    return hsv2rgb(hue, clamp01(f(ds + s)), clamp01(f(dv + v)))


def round5(x):
    """%.5f 往返（Python 的 % 格式化按精确值舍入、中点取偶，和 MSVC 一致）。"""
    return f(float('%.5f' % float(f(x))))


def system_color(initializers, operators):
    """7.1：colorrandom 后者覆盖前者；都没有时取第一个 colorchange 的 startvalue；结果 %.5f 往返。"""
    color = (f(1), f(1), f(1))
    has = False
    for init in initializers:
        if init['name'] == 'colorrandom':
            mn = [f(x) for x in init.get('min', [0, 0, 0])]
            mx = [f(x) for x in init.get('max', [255, 255, 255])]
            color = tuple(f(f(f(f(mx[i] - mn[i]) * f(0.5)) + mn[i]) * f(0.003921569)) for i in range(3))
            has = True
    if not has:
        for op in operators:
            if op['name'] == 'colorchange':
                color = tuple(f(x) for x in op.get('startvalue', [1, 1, 1]))
                has = True
                break
    return tuple(round5(x) for x in color), has


def num(x):
    return float(x)


def main():
    global OUT
    parser = argparse.ArgumentParser(description='colorn 的独立参考实现，生成 fixtures/colorn.json')
    parser.add_argument('--out', default=OUT, help='输出文件，缺省 apps/wpe-scene/src/particles/fixtures/colorn.json')
    OUT = os.path.abspath(parser.parse_args().out)
    rng = random.Random(20261108)
    cases = {'rgb2hsv': [], 'hsv2rgb': [], 'shift': [], 'round5': []}
    named = [
        (1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0), (0, 1, 1), (1, 0, 1), (1, 1, 1), (0, 0, 0),
        (1, 0.5, 0), (0.5, 0, 0), (0, 0.5, 1), (0.2, 0.4, 0.8), (0.9, 0.9, 0.9), (1, 0.5, 0.5),
        (0.3, 0.3, 0.30001), (2, 0.5, 0), (0.998, 0.002, 0),
    ]
    colors = [tuple(f(x) for x in c) for c in named]
    for _ in range(60):
        colors.append(tuple(f(rng.random()) for _ in range(3)))
    for c in colors:
        cases['rgb2hsv'].append({'in': [num(x) for x in c], 'out': [num(x) for x in rgb2hsv(c)]})
    hsvs = [(f(1 / 401), f(1), f(1)), (f(1 / 401), f(0.7), f(1)), (f(5 / 6), f(1), f(1)), (f(0.999999), f(1), f(1)),
            (f(1.5), f(1), f(1)), (f(-0.25), f(1), f(1)), (f(0.25), f(0), f(0.5))]
    for _ in range(60):
        hsvs.append((f(rng.random()), f(rng.random()), f(rng.random())))
    for hsv in hsvs:
        cases['hsv2rgb'].append({'in': [num(x) for x in hsv], 'out': [num(x) for x in hsv2rgb(*hsv)]})
    pairs = [
        ((1, 0, 0), (0, 1, 0), (1, 0, 0)),          # 红平移成绿
        ((1, 1, 0), (0, 0.5, 1), (1, 0.5, 0)),      # c-range 的 B
        ((1, 0, 0), (0, 0.5, 1), (1, 0.5, 0)),      # c-range 的 A
        ((1, 1, 1), (0, 0, 1), (0, 1, 0)),          # c-two：白不变
        ((0, 1, 0), (0, 0, 1), (0, 1, 0)),          # c-two：绿 → 蓝
        ((0, 0, 1), (0, 1, 0), (1, 0, 0)),          # c-change 的 B：色相正好 1.0
        ((1, 0, 0), (1, 0, 0), (0, 1, 0)),          # 色相和为负，取模
        ((0, 0, 1), (0, 1, 0), (0.5, 0, 0)),        # 7.4 (a)：v 抬过 1，钳位
        ((1, 0.5, 0.5), (0.5, 0.5, 0.5), (1, 0, 0)),  # s 降到负，钳位
        ((1, 0, 0), (0, 0.5, 0), (1, 0, 0)),        # 7.4 (b) 的 A
        ((0, 0.5, 1), (0, 0.5, 0), (1, 0, 0)),      # 7.4 (b) 的 B
    ]
    for _ in range(60):
        pairs.append(tuple(tuple(f(rng.random()) for _ in range(3)) for _ in range(3)))
    for c, target, system in pairs:
        c = tuple(f(x) for x in c)
        t_hsv = rgb2hsv(target)
        s_hsv = rgb2hsv(system)
        cases['shift'].append({
            'color': [num(x) for x in c],
            'target': [num(x) for x in t_hsv],
            'system': [num(x) for x in s_hsv],
            'out': [num(x) for x in shift(c, t_hsv, s_hsv)],
        })
    for x in [0.39215687, 1 / 255, 0.0039215689, 100 / 255, 0.5, 0.123456, 0.999996, 0.25, 0.33333334]:
        cases['round5'].append({'in': num(f(x)), 'out': num(round5(x))})
    # 系统色：几组模块组合
    systems = [
        ([{'name': 'colorrandom', 'min': [255, 0, 0], 'max': [255, 255, 0]}], []),
        ([{'name': 'colorrandom', 'min': [255, 255, 255], 'max': [255, 255, 255]},
          {'name': 'colorrandom', 'min': [0, 255, 0], 'max': [0, 255, 0]}], []),
        ([], [{'name': 'colorchange', 'startvalue': [1, 0, 0]}]),
        ([{'name': 'colorrandom', 'min': [100, 7, 33], 'max': [201, 15, 255]}], [{'name': 'colorchange', 'startvalue': [0, 0, 1]}]),
        ([{'name': 'colorrandom'}], []),
        ([], []),
    ]
    cases['system'] = []
    for inits, ops in systems:
        rgb, has = system_color(inits, ops)
        cases['system'].append({'initializers': inits, 'operators': ops, 'rgb': [num(x) for x in rgb], 'hasColor': has})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # 写完由仓库的 Prettier 格式化（printWidth 120，数组能放进一行就放一行）：
    #   node node_modules/prettier/bin/prettier.cjs --write apps/wpe-scene/src/particles/fixtures/colorn.json
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(json.dumps({
            # 最初生成时的记录，照原样写（见文件头）
            'source': 'ignore/p4/b6/colorn_ref.py（照 rea-p4b-render.md 7.1、7.3 的伪代码，numpy float32，fmod 双精度）',
            **cases,
        }, ensure_ascii=False, indent=2))
        fh.write('\n')
    print('写入', os.path.normpath(OUT), {k: len(v) for k, v in cases.items()})


if __name__ == '__main__':
    main()
