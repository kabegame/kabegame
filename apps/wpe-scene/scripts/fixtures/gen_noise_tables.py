"""P4b 步骤 4：把同目录的 noise-tables.json 生成成产品代码的常量文件 src/particles/noiseTables.ts。

用法（仓库根）：python -X utf8 -I apps/wpe-scene/scripts/fixtures/gen_noise_tables.py [--tables <json>] [--out <ts>]
  --tables 缺省为本目录的 noise-tables.json（从 wallpaper64.exe 2.8.42 按地址读出的常量表，入库）；
  --out    缺省为 apps/wpe-scene/src/particles/noiseTables.ts（按本脚本的位置推出）。
产品代码不能读 ignore/，所以把表原样写成 TS 字面量（字节表、float32 梯度表、标量的位模式），并在文件头写来源与地址。
生成后用仓库的 Prettier 格式化（node node_modules/prettier/bin/prettier.cjs --write <文件>）。
另打印每张表的 FNV-1a 校验值，供 noise.test.ts 钉住。
原件：ignore/p4/b4/gen_tables.py（这里只把输入、输出路径参数化，并改了生成文件头里的脚本位置）。
"""
import argparse
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, '..', '..'))

parser = argparse.ArgumentParser(description='从 noise-tables.json 生成 src/particles/noiseTables.ts')
parser.add_argument('--tables', default=os.path.join(HERE, 'noise-tables.json'), help='常量表 JSON（缺省本目录的 noise-tables.json）')
parser.add_argument('--out', default=os.path.join(APP, 'src', 'particles', 'noiseTables.ts'), help='输出的 TS 文件')
args = parser.parse_args()
SRC = args.tables
OUT = args.out

d = json.load(open(SRC, encoding='utf8'))


def f32_bits(x):
    return struct.unpack('<I', struct.pack('<f', x))[0]


def fnv(values):
    h = 0x811c9dc5
    for v in values:
        for b in struct.pack('<I', v):
            h ^= b
            h = (h * 0x01000193) & 0xffffffff
    return h


perm = d['snoise1']['perm']['data']
perm3 = d['snoise3']['perm']['data']
mod12 = d['snoise3']['permMod12']['data']
gx = d['snoise3']['gradX_mul_x0']['data']
gy = d['snoise3']['gradY_mul_y0']['data']
gz = d['snoise3']['gradZ_mul_z0']['data']
assert len(perm) == 256 and len(perm3) == 512 and len(mod12) == 512
assert perm3[:256] == perm and perm3[256:] == perm
assert mod12 == [p % 12 for p in perm3]
c2 = d['snoise2']['consts']
c3 = d['snoise3']['consts']
sc = d['scalars']


def one(entry):
    """标量常量的位模式（snoise3 的常量是 ×4 广播，四份相同，取第一份）。"""
    b = entry['bits']
    if isinstance(b, list):
        assert len(set(b)) == 1, b
        b = b[0]
    return int(b, 16)


scalars = [
    # 名字, 位模式, 地址, 说明
    ('SNOISE1_SCALE', one(d['snoise1']['scale']), d['snoise1']['scale']['addr'], 'snoise1 的输出系数 0.395'),
    ('F2', one(c2['F2']), c2['F2']['addr'], 'snoise2 的偏斜系数 (√3 − 1)/2'),
    ('G2', one(c2['G2']), c2['G2']['addr'], 'snoise2 的反偏斜系数 (3 − √3)/6'),
    ('G2_CORNER2', one(c2['x2_offset_0_4226497']), c2['x2_offset_0_4226497']['addr'],
     'snoise2 第 3 个角的偏移（x0 − 1 + 2·G2 那项，单独一个常量）'),
    ('SNOISE2_RADIUS', one(c2['half']), c2['half']['addr'], 'snoise2 的半径 0.5'),
    ('SNOISE2_SCALE', one(c2['scale_45_23065']), c2['scale_45_23065']['addr'], 'snoise2 的输出系数 45.23065'),
    ('MINUS_TWO', one(c2['minus2']), c2['minus2']['addr'], 'snoise2 梯度里的 −2'),
    ('F3', one(c3['F3']), c3['F3']['addr'], 'snoise3 的偏斜系数 1/3'),
    ('G3', one(c3['G3']), c3['G3']['addr'], 'snoise3 的反偏斜系数 1/6'),
    ('TWO_G3', one(c3['twoG3']), c3['twoG3']['addr'], 'snoise3 的 2·G3（单独一个常量，值同 F3）'),
    ('G3_CORNER3', one(c3['half']), c3['half']['addr'], 'snoise3 第 4 个角的偏移 0.5（= 3·G3）'),
    ('SNOISE3_RADIUS', one(c3['r0_6']), c3['r0_6']['addr'], 'snoise3 的半径 0.6'),
    ('SNOISE3_SCALE', one(c3['scale32']), c3['scale32']['addr'], 'snoise3 的输出系数 32'),
    ('PI', one(sc['pi']), sc['pi']['addr'], 'turbulentvelocityrandom 的 π'),
    ('ONE', one(sc['one']), sc['one']['addr'], '1.0'),
]
assert one(c3['one']) == 0x3f800000 and one(c3['mask255']) == 0xff and one(c3['ints_1']) == 1


def u8_rows(values):
    return ', '.join(str(v) for v in values)


def f32_rows(values):
    out = []
    for v in values:
        out.append(repr(float(v)) if v != int(v) else str(int(v)))
    return ', '.join(out)


lines = []
lines.append('/**')
lines.append(' * 噪声常量表（P4b 步骤 4）。由 `apps/wpe-scene/scripts/fixtures/gen_noise_tables.py` 从同目录的 `noise-tables.json` 生成，')
lines.append(' * **不要手改**；')
lines.append(f' * 来源 {d["source"]}（导出脚本 `tables.py`，按地址原样读取）。')
lines.append(' *')
lines.append(f' * - `PERM`（`{d["snoise1"]["perm"]["addr"]}`，256 字节）：`snoise1`、`snoise2` 共用的置换表（Ken Perlin 原表），下标按 u8 回绕；')
lines.append(f' * - `PERM512`（`{d["snoise3"]["perm"]["addr"]}`，512 字节）、`PERM_MOD12`（`{d["snoise3"]["permMod12"]["addr"]}`，512 字节）：`snoise3` 用，')
lines.append(' *   前者是 `PERM` 重复两遍，后者是它 `% 12`（生成时核对过）；下标最大 511，不再取模；')
lines.append(f' * - `GRAD_X`（`{d["snoise3"]["gradX_mul_x0"]["addr"]}`）、`GRAD_Y`（`{d["snoise3"]["gradY_mul_y0"]["addr"]}`）、`GRAD_Z`（`{d["snoise3"]["gradZ_mul_z0"]["addr"]}`）：')
lines.append(' *   `snoise3` 的三张 12 项梯度表（和 Gustavson `grad3` 相同），分别乘角点的 x、y、z（`noise3_sse4.asm` `0x1400fd7f3` 起）；')
lines.append(' * - 标量常量按位模式写（`fromBits`），地址见各常量。')
lines.append(' *')
lines.append(' * 依据：`.claude/plans/wpe-import/3-scene/phase4/rea-p4b-modules.md` C 节。')
lines.append(' */')
lines.append('')
lines.append('const bitsView = new DataView(new ArrayBuffer(4));')
lines.append('/** float32 位模式 → 数值。 */')
lines.append('function fromBits(bits: number): number {')
lines.append('  bitsView.setUint32(0, bits);')
lines.append('  return bitsView.getFloat32(0);')
lines.append('}')
lines.append('')
lines.append(f'/** `{d["snoise1"]["perm"]["addr"]}`：`snoise1` / `snoise2` 的置换表。 */')
lines.append(f'export const PERM: Readonly<Uint8Array> = Uint8Array.from([{u8_rows(perm)}]);')
lines.append('')
lines.append(f'/** `{d["snoise3"]["perm"]["addr"]}`：`snoise3` 的 512 字节置换表。 */')
lines.append(f'export const PERM512: Readonly<Uint8Array> = Uint8Array.from([{u8_rows(perm3)}]);')
lines.append('')
lines.append(f'/** `{d["snoise3"]["permMod12"]["addr"]}`：`PERM512 % 12`，`snoise3` 的梯度下标。 */')
lines.append(f'export const PERM_MOD12: Readonly<Uint8Array> = Uint8Array.from([{u8_rows(mod12)}]);')
lines.append('')
for name, data, key in [('GRAD_X', gx, 'gradX_mul_x0'), ('GRAD_Y', gy, 'gradY_mul_y0'), ('GRAD_Z', gz, 'gradZ_mul_z0')]:
    lines.append(f'/** `{d["snoise3"][key]["addr"]}`：`snoise3` 梯度的 {name[-1].lower()} 分量。 */')
    lines.append(f'export const {name}: Readonly<Float32Array> = Float32Array.of({f32_rows(data)});')
    lines.append('')
for name, bits, addr, note in scalars:
    lines.append(f'/** `{addr}`：{note}。 */')
    lines.append(f'export const {name} = fromBits(0x{bits:08x});')
lines.append('')
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
open(OUT, 'w', encoding='utf8', newline='\n').write('\n'.join(lines))
print('written', OUT)
print('fnv PERM', hex(fnv(perm)), 'PERM512', hex(fnv(perm3)), 'PERM_MOD12', hex(fnv(mod12)))
print('fnv GRAD', hex(fnv([f32_bits(v) for v in gx + gy + gz])))
print('fnv SCALARS', hex(fnv([b for _, b, _, _ in scalars])))
