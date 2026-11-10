"""P4b 步骤 4：从 WPE 轨迹与回放工具的导出（fixture-data.json）生成产品代码的固定数据（src/particles/fixtures/）。

用法（仓库根）：python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_noise_fixtures.py [--data 目录] [--fixture-data 文件] [--out 目录]
  --data          对比台数据目录，缺省环境变量 KBP_DATA，再缺省 ignore/p4（按本脚本的位置推出仓库根）；读
                  <data>/tracks/rd-p4b-fps60.json、rd-p4b-fps10.json（WPE 抓帧的轨迹）与 <data>/proj/p4b/particles/*.json（测试工程）；
  --fixture-data  P4b 步骤 4 回放的导出，缺省 <data>/b4/out/fixture-data.json（WPE 真值，不入库，来源见 README.md）；
  --out           输出目录，缺省 apps/wpe-scene/src/particles/fixtures。
生成后用仓库的 Prettier 格式化（node node_modules/prettier/bin/prettier.cjs --write <文件>）。生成：
- noise.json：snoise1 / snoise2 / snoise3 的单点真值与 turbulentvelocityrandom 的方向真值（turbvel-axes）；
- p4b-turb.json：turb、turb-ph5、turb-xyz、turb-ovr 的连续 6 个抓帧（位置、精确 dt 与 g_Time），给短程强制回放；
- p4b-posoffset60.json、p4b-posoffset10.json：posoffset-1 / -6 / -sign 从加载起整段回放（dts + times + 6 个抓帧），格式同现有 replay fixture。
原件：ignore/p4/b4/make_fixtures.py（这里只把输入、输出路径参数化）。各文件 `source` 字段里的路径是最初生成时的记录，照原样写，
改了重新生成的文件就和仓库里的不同。
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, '..', '..'))
REPO = os.path.normpath(os.path.join(APP, '..', '..'))

parser = argparse.ArgumentParser(description='生成 noise.json、p4b-turb.json、p4b-posoffset60/10.json')
parser.add_argument('--data', default=os.environ.get('KBP_DATA') or os.path.join(REPO, 'ignore', 'p4'),
                    help='对比台数据目录（tracks/、proj/），缺省 KBP_DATA 或 ignore/p4')
parser.add_argument('--fixture-data', default=None, help='回放导出的 fixture-data.json，缺省 <data>/b4/out/fixture-data.json')
parser.add_argument('--out', default=os.path.join(APP, 'src', 'particles', 'fixtures'), help='输出目录')
args = parser.parse_args()

P4 = os.path.abspath(args.data)
OUT = os.path.abspath(args.out)
data = json.load(open(args.fixture_data or os.path.join(P4, 'b4/out/fixture-data.json'), encoding='utf8'))
tracks = {tag: json.load(open(os.path.join(P4, 'tracks', f'rd-{tag}.json'), encoding='utf8')) for tag in data}
PASSES = {'p4b-fps60': 1, 'p4b-fps10': 2}
OVERRIDES = {'turb-ovr': {'id': 92, 'speed': 2, 'rate': 0.5}}


def particle(name):
    spec = json.load(open(os.path.join(P4, 'proj/p4b/particles', name + '.json'), encoding='utf8'))
    # 控制点数组只有 id，和结果无关，去掉缩短文件
    spec.pop('controlpoint', None)
    return spec


def r(x, digits=9):
    return float(f'{x:.{digits}g}')


def write(name, obj):
    path = os.path.join(OUT, name)
    text = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    open(path, 'w', encoding='utf8', newline='\n').write(text + '\n')
    print('written', path, len(text))


os.makedirs(OUT, exist_ok=True)
SOURCE_TAIL = ('工程 ignore/p4/proj/p4b（生成器 ignore/p4/gen_b.py），WPE 2.8.42 RenderDoc 轨迹 ignore/p4/tracks/rd-p4b-fps60.json（1 遍）'
               '与 rd-p4b-fps10.json（2 遍）；由 ignore/p4/b4/make_fixtures.py 生成')

# ---- noise.json ----
noise = {
    'source': (
        '单点真值都从 WPE 粒子的位置反推（ignore/p4/b4/replay.test.ts 的 B、C 段）：'
        'snoise1 —— turbvel（phasemin = phasemax、scale 1、offset 0、timescale 1）出生方向 (−sin ang, cos ang)，n = ang/π，输入是出生帧的 T；'
        'snoise2 —— posoffset-1（octaves 1、directions 1 1 0、distance 100）出生偏移 /100 就是 snoise2(px·0.001, T) 与 snoise2(T, py·0.001)；'
        'snoise3 —— fps60（1 遍）turb、turb-xyz、turb-ovr 相邻三帧位置差分出速度增量，N = Δv/(k·spd)，精度约 1e-4；'
        'turbvelAxes —— turbvel-axes（forward 1 0 0、scale 2、offset 0.5、timescale 0.5）出生方向角。'
        'T 取日志 runtime 列（6 位小数）的 float32，抓帧时用轨迹的 g_Time。' + SOURCE_TAIL
    ),
    'snoise1': [], 'snoise2': [], 'snoise3': [],
    'turbvelAxes': {'module': next(m for m in particle('turbvel-axes')['initializer'] if m['name'] == 'turbulentvelocityrandom'),
                    'rows': []},
}
for tag, d in data.items():
    for t, n, _ in d['snoise1']:
        noise['snoise1'].append([t, r(n)])
    for x, y, n, _ in d['snoise2']:
        noise['snoise2'].append([x, y, r(n)])
    for t, angle, _ in d['axes']:
        noise['turbvelAxes']['rows'].append([t, r(angle)])
    for a, b, c, n in d.get('snoise3', []):
        noise['snoise3'].append([a, b, c, r(n, 6)])
write('noise.json', noise)

# ---- p4b-turb.json ----
turb = {
    'source': ('turb*（mask 1 0 0 / 1 1 1，phasemin = phasemax，speed 100，scale 0.01，timescale 1；turb-ph5 的 phasemin = phasemax = 5；'
               'turb-ovr 的 instanceoverride speed 2、rate 0.5）连续 6 个抓帧的位置，dt 与 g_Time 是轨迹里的 float32 原值（精确）。'
               '湍流场是混沌的，从加载起整段回放会把日志 6 位小数的输入误差放大到上百像素，所以只做短程强制回放。' + SOURCE_TAIL),
    'systems': {name: {'particle': particle(name), **({'instanceoverride': OVERRIDES[name]} if name in OVERRIDES else {})}
                for name in ['turb', 'turb-ph5', 'turb-xyz', 'turb-ovr']},
    'runs': [],
}
for tag, d in data.items():
    turb['runs'].append({'tag': tag, 'passes': PASSES[tag], 'frames': d['forced']['frames']})
write('p4b-turb.json', turb)

# ---- p4b-posoffset{60,10}.json ----
for tag, d in data.items():
    names = ['posoffset-1', 'posoffset-6', 'posoffset-sign']
    track = tracks[tag]
    fixture = {
        'source': ('posoffset-1 / -6 / -sign（scale 0.001、distance 100、timescale 1，octaves 1 / 6 / 2，posoffset-sign 的 sign 0 −1 0）'
                   '从加载起整段回放；dt 取日志累计时间的相邻差分（6 位小数），times 取日志 runtime 列，抓到的帧用轨迹里的 float32 dt 与 g_Time'
                   + ('；日志缺第 151、152 帧，dt 按 ignore/p4/b3 的反推拆成 0.099343 / 0.099521，T 累加' if tag == 'p4b-fps10' else '')
                   + '。' + SOURCE_TAIL),
        'tag': tag,
        'passes': PASSES[tag],
        'systems': {name: {'particle': particle(name)} for name in names},
        'dts': d['dts'],
        'times': d['times'],
        'frames': [{'frame': f['frame'], 'systems': {name: f['systems'][name] for name in names}} for f in track['frames']],
    }
    write(f'p4b-posoffset{tag[-2:]}.json', fixture)
