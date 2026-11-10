# 从 WPE 真值截出模拟器单测的固定数据（P4a 步骤 3），写到 apps/wpe-scene/src/particles/fixtures/：fps60、fps10、s15、s60、p4a2.json。
# dt：日志累计时间相邻差分（6 位小数），抓到的帧换成轨迹里的 float32 dt（回放工具里对得更好的取法）。
# 用法（仓库根）：python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_replay_fixtures.py [--data 目录] [--out 目录]
#   --data 对比台数据目录，缺省环境变量 KBP_DATA，再缺省 ignore/p4（按本脚本的位置推出仓库根）；读 <data>/tracks/rd-<标签>.json
#          （WPE 抓帧的轨迹）、<data>/out/<标签>-log.txt（WPE 日志的 [kbp] 行）、<data>/proj/<工程>/（测试工程）。这些是 WPE 真值，
#          不入库，来源见 README.md；
#   --out  输出目录，缺省 apps/wpe-scene/src/particles/fixtures。
# 生成后用仓库的 Prettier 格式化（node node_modules/prettier/bin/prettier.cjs --write <文件>）。
# 原件：ignore/p4/step3/make_fixtures.py（这里只把输入、输出路径参数化）。各文件 `source` 字段里的路径是最初生成时的记录，照原样写，
# 改了重新生成的文件就和仓库里的不同。
import argparse
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, '..', '..'))
REPO = os.path.normpath(os.path.join(APP, '..', '..'))

parser = argparse.ArgumentParser(description='生成 fps60、fps10、s15、s60、p4a2.json')
parser.add_argument('--data', default=os.environ.get('KBP_DATA') or os.path.join(REPO, 'ignore', 'p4'),
                    help='对比台数据目录（tracks/、out/、proj/），缺省 KBP_DATA 或 ignore/p4')
parser.add_argument('--out', default=os.path.join(APP, 'src', 'particles', 'fixtures'), help='输出目录')
args = parser.parse_args()
P4 = os.path.abspath(args.data)
OUT = os.path.abspath(args.out)

# tag → (工程, 遍数, 系统)。p4a2 粒子多，只取首尾两帧（控制在 200 KB 内）
KEEP_FRAMES = {'p4a2': {897, 900}}
FIXTURES = {
    'fps60': ('p4-0', 1, ['linear', 'custom', 'birth', 'gravity', 'order-fade-ab', 'order-fade-ba', 'order-move-ab',
                          'order-move-ba']),
    'fps10': ('p4-0', 2, ['linear', 'custom', 'birth', 'gravity', 'order-fade-ab', 'order-fade-ba', 'order-move-ab',
                          'order-move-ba']),
    's15': ('p4-0', 2, ['drag', 'gfirst', 'o2-init-ab', 'o2-init-ba']),
    's60': ('p4-0', 1, ['drag', 'gfirst', 'o2-init-ba']),
    'p4a2': ('p4a2', 1, ['burst', 'inst']),
}


DROP = {'material', 'renderer', 'controlpoint', 'children'}


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def dts_of(tag, truth, last):
    with open(os.path.join(P4, 'out', f'{tag}-log.txt'), encoding='utf-8') as f:
        rows = [(int(a), float(c)) for a, _, c in re.findall(r'(\d+),(\d+\.\d+),(\d+\.\d+)', f.read())]
    assert [r[0] for r in rows[:last]] == list(range(1, last + 1))
    runtime = [r[1] for r in rows]
    dts = [round(runtime[0], 6)] + [round(runtime[i] - runtime[i - 1], 6) for i in range(1, last)]
    for frame in truth['frames']:
        dts[frame['frame'] - 1] = frame['dt']
    return dts


def main():
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for tag, (project, passes, names) in FIXTURES.items():
        truth = load(os.path.join(P4, 'tracks', f'rd-{tag}.json'))
        scene = load(os.path.join(P4, 'proj', project, 'scene.json'))
        objects = {o['name']: o for o in scene['objects'] if 'particle' in o}
        last = max(f['frame'] for f in truth['frames'])
        systems = {}
        for name in names:
            obj = objects[name]
            particle = load(os.path.join(P4, 'proj', project, obj['particle']))
            # 不影响模拟的键（材质、renderer、全是缺省值的控制点、children: null）不进固定数据，控制体积
            entry = {'particle': {k: v for k, v in particle.items() if k not in DROP}}
            if 'instanceoverride' in obj:
                entry['instanceoverride'] = obj['instanceoverride']
            systems[name] = entry
        dts = dts_of(tag, truth, last)
        fixture = {
            'source': f'WPE 2.8.42 RenderDoc 轨迹 ignore/p4/tracks/rd-{tag}.json（工程 ignore/p4/proj/{project}，'
                      f'脚本帧 {truth["frames"][0]["frame"]}–{last}，{passes} 遍）；dt 取 ignore/p4/out/{tag}-log.txt '
                      f'累计时间的相邻差分（6 位小数），抓到的帧用轨迹里的 float32 dt。'
                      f'由 ignore/p4/step3/make_fixtures.py 生成',
            'tag': tag,
            'passes': passes,
            'systems': systems,
            'dts': dts,
            'frames': [{'frame': f['frame'], 'systems': {n: f['systems'][n] for n in names if n in f['systems']}}
                       for f in truth['frames'] if f['frame'] in KEEP_FRAMES.get(tag, {f['frame']})],
        }
        path = os.path.join(OUT, f'{tag}.json')
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(fixture, f, ensure_ascii=False, separators=(',', ':'))
        size = os.path.getsize(path)
        total += size
        print(path, size)
    print('合计', total)


if __name__ == '__main__':
    main()
