"""P4b 步骤 4：snoise3 在坐标相等时的顶点顺序（rea C3「相等时的顺序」）。用同目录的 noise_ref.py（照读码独立写的参考实现）算
几组构造输入的值，钉进 src/particles/noise.test.ts；同时打印原版 Gustavson 顶点顺序下的值，确认两者不同（测得出这条差异）。

用法（仓库根）：python -X utf8 -I apps/wpe-scene/scripts/fixtures/noise_equal_cases.py
原件：ignore/p4/b4/equal_cases.py（这里只改了 noise_ref.py 的位置）。
"""
import importlib.util
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('noise_ref', os.path.join(HERE, 'noise_ref.py'))
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)
f = ref.f

CASES = [
    (0.1, 0.3, 0.3),  # x0 < y0 = z0：WPE 三个 *1 都是 0，原版 j1 = 1
    (0.3, 0.1, 0.3),  # y0 < x0 = z0
    (0.3, 0.3, 0.1),  # z0 < x0 = y0
    (0.3, 0.1, 0.1),  # x0 > y0 = z0
    (0.1, 0.3, 0.1),  # y0 > x0 = z0
    (0.1, 0.1, 0.3),  # z0 > x0 = y0
    (0.2, 0.2, 0.2),  # 三者相等
    # 其他 b = c 的输入：按读码只有 x0 < y0 = z0、且受影响的角在半径以内时才和原版不同
    (5.1, 7.4, 7.4),
    (2.05, 2.6, 2.6),
    (-1.3, -0.9, -0.9),
    (12.1, 12.5, 12.5),
]


def original(a, b, c):
    """原版 Gustavson 2012 的顶点顺序（其余同 noise_ref.snoise3），只用来确认差异。"""
    a, b, c = f(a), f(b), f(c)
    F3, G3 = ref.bits(0x3eaaaaab), ref.bits(0x3e2aaaab)
    s = f(f(f(b + c) + a) * F3)
    i = math.floor(f(a + s)); j = math.floor(f(b + s)); k = math.floor(f(c + s))
    t = f(f(float(k + j + i)) * G3)
    x0 = f(a - f(f(float(i)) - t)); y0 = f(b - f(f(float(j)) - t)); z0 = f(c - f(f(float(k)) - t))
    if x0 >= y0:
        if y0 >= z0:
            o = (1, 0, 0, 1, 1, 0)
        elif x0 >= z0:
            o = (1, 0, 0, 1, 0, 1)
        else:
            o = (0, 0, 1, 1, 0, 1)
    else:
        if y0 < z0:
            o = (0, 0, 1, 0, 1, 1)
        elif x0 < z0:
            o = (0, 1, 0, 0, 1, 1)
        else:
            o = (0, 1, 0, 1, 1, 0)
    i1, j1, k1, i2, j2, k2 = o
    x1 = f(f(x0 - i1) + G3); y1 = f(f(y0 - j1) + G3); z1 = f(f(z0 - k1) + G3)
    x2 = f(f(x0 - i2) + F3); y2 = f(f(y0 - j2) + F3); z2 = f(f(z0 - k2) + F3)
    x3 = f(f(x0 - 1) + 0.5); y3 = f(f(y0 - 1) + 0.5); z3 = f(f(z0 - 1) + 0.5)
    ii, jj, kk = i & 255, j & 255, k & 255
    P, M = ref.PERM, ref.MOD12
    gi0 = M[ii + P[jj + P[kk]]]
    gi1 = M[ii + i1 + P[jj + j1 + P[kk + k1]]]
    gi2 = M[ii + i2 + P[jj + j2 + P[kk + k2]]]
    gi3 = M[ii + 1 + P[jj + 1 + P[kk]]]
    R = ref.bits(0x3f19999a)

    def corner(g, x, y, z):
        tt = f(f(f(R - f(x * x)) - f(y * y)) - f(z * z))
        if tt < 0:
            return 0.0
        t2 = f(tt * tt); t4 = f(t2 * t2)
        return f(f(f(f(ref.GZ[g] * z) + f(ref.GY[g] * y)) + f(ref.GX[g] * x)) * t4)

    return f(f(f(f(corner(gi3, x3, y3, z3) + corner(gi2, x2, y2, z2)) + corner(gi1, x1, y1, z1)) + corner(gi0, x0, y0, z0)) * 32)


for a, b, c in CASES:
    w = ref.snoise3(a, b, c)
    o = original(a, b, c)
    print(f'[{f(a)!r}, {f(b)!r}, {f(c)!r}] WPE {w!r} 原版 {o!r} {"不同" if w != o else "相同"}')
