# 照 rea-p4b-modules.md C1–C3 伪代码独立写的噪声参考实现（float32，每步舍入），给步骤 4 交叉核对用。不读产品代码。
# 用法：python -X utf8 -I apps/wpe-scene/scripts/fixtures/noise_ref.py <a> <b> <c>          打印 snoise3(a, b, c)
#       也可按文件 import（noise_equal_cases.py、noise_xcheck.py）：snoise1 / snoise2 / snoise3
# 常量表读同目录的 noise-tables.json。原件：ignore/p4/noise_ref.py（这里只改了常量表的位置）。
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, 'noise-tables.json'), encoding='utf-8') as f:
    TABLES = json.load(f)


def f(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]


def bits(u):
    return struct.unpack('<f', struct.pack('<I', u))[0]


PERM256 = TABLES['snoise1']['perm']['data']
S3 = TABLES['snoise3']


def table(name):
    entry = S3[name]
    return entry['data'] if isinstance(entry, dict) else entry


PERM = table('perm')
MOD12 = table('permMod12')
GX, GY, GZ = table('gradX_mul_x0'), table('gradY_mul_y0'), table('gradZ_mul_z0')


def floor_trunc(x):
    i = int(x)  # cvttss2si：向零截断
    if f(float(i)) > x:
        i -= 1
    return i


def snoise1(x):
    x = f(x)
    i0 = floor_trunc(x)
    x0 = f(x - f(float(i0)))
    x1 = f(x0 - 1)

    def grad(h, v):
        g = f(float(h & 7) + 1)
        if h & 8:
            g = -g
        return f(g * v)

    h0 = PERM256[i0 & 255]
    t0 = f(1 - f(x0 * x0)); t0 = f(t0 * t0); t0 = f(t0 * t0)
    n0 = f(grad(h0, x0) * t0)
    h1 = PERM256[(i0 + 1) & 255]
    t1 = f(1 - f(x1 * x1)); t1 = f(t1 * t1); t1 = f(t1 * t1)
    n1 = f(grad(h1, x1) * t1)
    return f(f(n1 + n0) * bits(0x3eca3d71))


def snoise2(x, y):
    x, y = f(x), f(y)
    F2, G2, C2 = bits(0x3ebb67ae), bits(0x3e58658c), bits(0x3ed8658c)
    s = f(f(x + y) * F2)
    i = floor_trunc(f(x + s)); j = floor_trunc(f(y + s))
    t = f(f(float(i + j)) * G2)
    x0 = f(x - f(f(float(i)) - t)); y0 = f(y - f(f(float(j)) - t))
    i1, j1 = (1, 0) if x0 > y0 else (0, 1)
    x1 = f(f(x0 - i1) + G2); y1 = f(f(y0 - j1) + G2)
    x2 = f(f(x0 - 1) + C2); y2 = f(f(y0 - 1) + C2)
    ii, jj = i & 255, j & 255
    p = lambda k: PERM256[k & 255]

    def grad(h, a, b):
        u, v = (a, b) if (h & 0x3c) == 0 else (b, a)
        if h & 1:
            u = -u
        v = f(v * -2) if h & 2 else f(v + v)
        return f(v + u)

    def corner(t, h, a, b):
        if t < 0:
            return 0.0
        t2 = f(t * t)
        return f(grad(h, a, b) * f(t2 * t2))

    t0 = f(f(f(0.5) - f(x0 * x0)) - f(y0 * y0))
    t1 = f(f(f(0.5) - f(x1 * x1)) - f(y1 * y1))
    t2 = f(f(f(0.5) - f(x2 * x2)) - f(y2 * y2))
    n0 = corner(t0, p(ii + p(jj)), x0, y0)
    n1 = corner(t1, p(ii + i1 + p(jj + j1)), x1, y1)
    n2 = corner(t2, p(ii + 1 + p(jj + 1)), x2, y2)
    return f(f(f(n1 + n0) + n2) * bits(0x4234ec30))


def snoise3(a, b, c):
    a, b, c = f(a), f(b), f(c)
    F3, G3, TWO_G3 = bits(0x3eaaaaab), bits(0x3e2aaaab), bits(0x3eaaaaab)
    s = f(f(f(b + c) + a) * F3)
    i = math.floor(f(a + s)); j = math.floor(f(b + s)); k = math.floor(f(c + s))
    t = f(f(float(k + j + i)) * G3)
    x0 = f(a - f(f(float(i)) - t)); y0 = f(b - f(f(float(j)) - t)); z0 = f(c - f(f(float(k)) - t))
    i1 = int(y0 <= x0 and z0 <= x0)
    j1 = int(x0 < y0 and z0 < y0)
    k1 = int(x0 < z0 and y0 < z0)
    i2 = int(i1 or (x0 < y0 and z0 <= x0) or (x0 < z0 and y0 <= x0))
    j2 = int(j1 or (y0 < z0 and x0 < y0) or (z0 <= y0 and y0 <= x0))
    k2 = int(k1 or (z0 <= y0 and x0 < z0) or (y0 < z0 and z0 <= x0))
    x1 = f(f(x0 - i1) + G3); y1 = f(f(y0 - j1) + G3); z1 = f(f(z0 - k1) + G3)
    x2 = f(f(x0 - i2) + TWO_G3); y2 = f(f(y0 - j2) + TWO_G3); z2 = f(f(z0 - k2) + TWO_G3)
    x3 = f(f(x0 - 1) + 0.5); y3 = f(f(y0 - 1) + 0.5); z3 = f(f(z0 - 1) + 0.5)
    ii, jj, kk = i & 255, j & 255, k & 255
    gi0 = MOD12[ii + PERM[jj + PERM[kk]]]
    gi1 = MOD12[ii + i1 + PERM[jj + j1 + PERM[kk + k1]]]
    gi2 = MOD12[ii + i2 + PERM[jj + j2 + PERM[kk + k2]]]
    gi3 = MOD12[ii + 1 + PERM[jj + 1 + PERM[kk]]]
    R = bits(0x3f19999a)

    def corner(g, x, y, z):
        t = f(f(f(R - f(x * x)) - f(y * y)) - f(z * z))
        if t < 0:
            return 0.0
        t2 = f(t * t); t4 = f(t2 * t2)
        return f(f(f(f(GZ[g] * z) + f(GY[g] * y)) + f(GX[g] * x)) * t4)

    n0 = corner(gi0, x0, y0, z0); n1 = corner(gi1, x1, y1, z1)
    n2 = corner(gi2, x2, y2, z2); n3 = corner(gi3, x3, y3, z3)
    return f(f(f(f(n3 + n2) + n1) + n0) * 32)


if __name__ == '__main__':
    print(snoise3(*(float(v) for v in sys.argv[1:4])))


def turb_point(px, py, pz, T, scale=0.01):
    """turbulence 的 Nx（mask 1 0 0）：φ = T（phasemax − phasemin = 0、timescale 1），X = (x + φ)·scale。"""
    X, Y, Z = f(f(px + T) * scale), f(f(py + T) * scale), f(f(pz + T) * scale)
    return snoise3(X, Y, Z)
