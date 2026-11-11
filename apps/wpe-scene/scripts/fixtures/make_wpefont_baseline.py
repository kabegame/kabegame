"""P6b 1b：从 1a 选型探针的结果生成 wpefont 的字形基线（src/wpefont/fixtures/baseline.json，index.test.ts 用）。

用法（仓库根）：python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_wpefont_baseline.py [--results 文件] [--proj 目录] [--out 文件]
  --results  1a 用 FreeType 2.14.3 / HarfBuzz 15.0.0 发布包编出的 wasm 跑 p6b-* 工程的输出（ignore/p6/b1a/harness.mjs 的格式），
             缺省 ignore/p6/b1a/out/ft2.14.3/wasm-b.json（WPE 真值的替身：1a 已证明它和 WPE 抓帧的图集一致，不入库）；
  --proj     测试工程目录（读各工程的 scene.json 取文字、字体、字号），缺省 ignore/p6/b0/proj；
  --out      输出文件，缺省 apps/wpe-scene/src/wpefont/fixtures/baseline.json。
生成后用仓库的 Prettier 格式化（node node_modules/prettier/bin/prettier.cjs --write <文件>）。

只收单行、不需要回退的对象（字体都在 WPE 的 assets/fonts/，测试不碰系统字体）：RobotoMono（g1 32 磅、g3 72 磅）、
NotoSans（g4）、四个 CFF 的 otf（e1–e4）、没有 hinting 表的 8bitOperator（e6）与带完整指令的 Blackout（e7）。
不满足（多行、出现回退字体）时报错。只存位图的 SHA-1，不存位图本身。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, '..', '..'))
REPO = os.path.normpath(os.path.join(APP, '..', '..'))

OBJECTS = [
    'p6b-geom/g1', 'p6b-geom/g3', 'p6b-geom/g4',
    'p6b-extra/e1', 'p6b-extra/e2', 'p6b-extra/e3', 'p6b-extra/e4', 'p6b-extra/e6', 'p6b-extra/e7',
]

parser = argparse.ArgumentParser(description='生成 wpefont 的字形基线 baseline.json')
parser.add_argument('--results', default=os.path.join(REPO, 'ignore', 'p6', 'b1a', 'out', 'ft2.14.3', 'wasm-b.json'))
parser.add_argument('--proj', default=os.path.join(REPO, 'ignore', 'p6', 'b0', 'proj'))
parser.add_argument('--out', default=os.path.join(APP, 'src', 'wpefont', 'fixtures', 'baseline.json'))
args = parser.parse_args()

results = json.load(open(args.results, encoding='utf8'))
scenes = {}


def scene_object(key):
    project, name = key.split('/')
    if project not in scenes:
        scenes[project] = json.load(open(os.path.join(args.proj, project, 'scene.json'), encoding='utf8'))
    matches = [o for o in scenes[project]['objects'] if o.get('name') == name and isinstance(o.get('text'), str)]
    if len(matches) != 1:
        sys.exit(f'{key}：scene.json 里找到 {len(matches)} 个同名文本对象')
    return matches[0]


objects = []
for key in OBJECTS:
    obj = scene_object(key)
    entry = results[key]
    text = obj['text'].replace('\r', '')
    font = obj['font']
    if '\n' in text or len(entry['rows']) != 1:
        sys.exit(f'{key}：不是单行')
    segments = entry['rows'][0]
    if len(segments) != 1 or segments[0]['font'] != os.path.basename(font):
        sys.exit(f'{key}：出现了回退字体 {[s["font"] for s in segments]}')
    # 同 harness.mjs：字号钳到 [1, 256]
    pointsize = max(1, min(256, obj['pointsize']))
    objects.append({
        'key': key,
        'font': font,
        'pointsize': pointsize,
        'text': text,
        'metrics': entry['metrics'],
        # 前 12 列：gid、cluster、x/y 步进、x/y 偏移、宽、高、left、top、像素格式、位图 SHA-1（去掉第 13 列 base64）
        'glyphs': [g[:12] for g in segments[0]['glyphs']],
    })

out = {
    'source': (
        'ignore/p6/b1a/out/ft2.14.3/wasm-b.json：P6b 1a 用 FreeType 2.14.3 / HarfBuzz 15.0.0 发布包编出的 wasm 跑 p6b-* 工程的结果，'
        '已和 WPE 抓帧的图集逐像素核对（生成：apps/wpe-scene/scripts/fixtures/make_wpefont_baseline.py）。'
        'font 相对 WPE 的 assets/；metrics 为 ascender、descender、height（26.6）、units_per_EM、load_flags；'
        '每个字形为 gid、cluster、xAdvance、yAdvance、xOffset、yOffset（26.6）、width、rows、left、top、pixel_mode、'
        '位图 SHA-1（逐行紧排）。'
    ),
    'objects': objects,
}
os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
with open(args.out, 'w', encoding='utf8', newline='\n') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write('\n')
print(f'{args.out}：{len(objects)} 个对象、{sum(len(o["glyphs"]) for o in objects)} 个字形')
