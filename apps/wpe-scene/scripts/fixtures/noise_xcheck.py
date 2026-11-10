"""P4b 步骤 4 对拍的另一半：读 noise_xcheck.test.ts 写出的 JSON（TS 产品代码的输入与输出），用同目录的 noise_ref.py 重算，逐位比较。

用法（仓库根，先跑 noise_xcheck.test.ts，见 README.md）：
  python -X utf8 -I apps/wpe-scene/scripts/fixtures/noise_xcheck.py [--input 文件] [--out 文件]
  --input 缺省环境变量 NOISE_XCHECK_JSON，再缺省 ignore/fixtures/noise-xcheck-ts.json（同 noise_xcheck.test.ts 的缺省输出）；
  --out   结果文本，缺省和 --input 同目录的 noise-xcheck.txt。
结果打印并写 --out。全部「不一致 0」才说明两份实现逐位一致；退出码不看结果。
原件：ignore/p4/b4/xcheck.py（这里只把输入、输出路径参数化）。
"""
import argparse
import importlib.util
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..'))
spec = importlib.util.spec_from_file_location('noise_ref', os.path.join(HERE, 'noise_ref.py'))
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)

parser = argparse.ArgumentParser(description='TS 噪声实现与 noise_ref.py 逐位对拍')
parser.add_argument('--input', default=os.environ.get('NOISE_XCHECK_JSON')
                    or os.path.join(REPO, 'ignore', 'fixtures', 'noise-xcheck-ts.json'), help='noise_xcheck.test.ts 写出的 JSON')
parser.add_argument('--out', default=None, help='结果文本，缺省和 --input 同目录的 noise-xcheck.txt')
args = parser.parse_args()
OUT = args.out or os.path.join(os.path.dirname(os.path.abspath(args.input)), 'noise-xcheck.txt')


def bits(x):
    return struct.unpack('<I', struct.pack('<f', x))[0]


data = json.load(open(args.input, encoding='utf8'))
lines = []
for name, fn, arity in [('snoise1', ref.snoise1, 1), ('snoise2', ref.snoise2, 2), ('snoise3', ref.snoise3, 3)]:
    rows = data[name]
    bad = []
    nonzero = 0
    equal_inputs = 0
    for row in rows:
        args_, ours = row[:arity], row[arity]
        theirs = fn(*args_)
        if ours != 0:
            nonzero += 1
        if arity == 3 and len(set(args_)) < 3:
            equal_inputs += 1
        # 0 与 −0 视为相同（JSON 不保留 −0）
        if not (ours == theirs and (ours == 0 or bits(ours) == bits(theirs))):
            bad.append((args_, ours, theirs))
    extra = f'，其中含相等坐标的 {equal_inputs} 组' if arity == 3 else ''
    lines.append(f'{name}：{len(rows)} 组（非零 {nonzero}{extra}），不一致 {len(bad)}')
    for args_, ours, theirs in bad[:10]:
        lines.append(f'  {args_} TS {ours!r} Python {theirs!r}')
text = '\n'.join(lines)
print(text)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
open(OUT, 'w', encoding='utf8', newline='\n').write(text + '\n')
