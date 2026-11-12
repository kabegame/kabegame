"""P6b 1c：从 WPE 抓帧生成文本排版与图集的基线（src/text/fixtures/p6b.json，text/layout.test.ts 用）。

用法（仓库根）：python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_text_fixture.py [--dump 文件 …] [--proj 目录] [--fonts 目录] [--out 文件]
  --dump   rdc 回放导出的绘制（ignore/p6/b0/rdc_text.py 的格式：每个 rdc 的 draws 带 mesh.POSITION / TEXCOORD、textures、
           consts 里的 vertex:g_ModelViewProjectionMatrix；textures 里图集的 saved 是存下的 PNG），缺省
           ignore/p6/b0/out/rd/dump.json 与 dump2.json（WPE 真值，不入库）；
  --proj   测试工程目录（读各工程 scene.json 的文本对象字段），缺省 ignore/p6/b0/proj；
  --fonts  系统字体目录，缺省 %WINDIR%/Fonts：记下抓帧那台机器上 systemfont_* 与回退链文件的有无与 SHA-256 前 16 位，
           测试在字体环境不同时跳过；
  --out    输出文件，缺省 apps/wpe-scene/src/text/fixtures/p6b.json。
生成后用仓库的 Prettier 格式化（node node_modules/prettier/bin/prettier.cjs --write <文件>）。只用标准库（PNG 自己解码）。

每个工程按场景对象顺序列出全部文本对象（`p6b-script` 的文字逐帧变，不收），每个对象：
- fields：排版字段（WPE 的 JSON 写法规整成 layout.ts 的 TextFields：padding / spacing 两个数、可见 effect 个数）与对象原点；
- glyphs / colorGlyphs：字形四边形 [左, 下, 右, 上, u0, v0, u1, v1]，位置是排版坐标（网格顶点原样），UV 换成图集像素；
- 直接上屏：origin = 排版原点在场景里的位置（字形绘制的 MVP 平移，按 1920×1080 正交反推，保留 3 位小数——float32 NDC
  反推的精度，真实值都是整数或 .5）；开了背景时 background = 背景四边形的尺寸；
- 画进合成 RT：rt = RT 尺寸，rtOrigin = 排版原点在 RT 里的位置（同样反推），center = 合成四边形（中心在对象原点 + 对齐偏移）
  在场景里的位置，size = 合成四边形的尺寸（图层 size）。
每个工程的 atlases：字形绘制用到的图集，格式、尺寸与解码后像素的 SHA-256（R8 取 R 通道、RGBA8 取四个通道，逐行紧排）。
"""
import argparse
import hashlib
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HERE, '..', '..'))
REPO = os.path.normpath(os.path.join(APP, '..', '..'))
SCENE_W, SCENE_H = 1920, 1080
SKIP = {'p6b-script'}
# systemfont_* 与回退链里的系统字体（text/fonts.ts 的 SYSTEM_FONTS、FALLBACK_CHAIN）
SYSTEM_FONT_FILES = ['arial.ttf', 'calibri.ttf', 'cambria.ttc', 'comic.ttf', 'consola.ttf', 'micross.ttf', 'segoeui.ttf',
                     'verdana.ttf', 'seguiemj.ttf', 'arialuni.ttf', 'seguisym.ttf', 'msyh.ttc', 'Malgun.ttf']

parser = argparse.ArgumentParser(description='生成文本排版与图集的基线 p6b.json')
parser.add_argument('--dump', nargs='+', default=[os.path.join(REPO, 'ignore', 'p6', 'b0', 'out', 'rd', n)
                                                  for n in ('dump.json', 'dump2.json')])
parser.add_argument('--proj', default=os.path.join(REPO, 'ignore', 'p6', 'b0', 'proj'))
parser.add_argument('--fonts', default=os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts'))
parser.add_argument('--out', default=os.path.join(APP, 'src', 'text', 'fixtures', 'p6b.json'))
args = parser.parse_args()


def png_rgba(path):
    """8 位、不隔行的 RGBA / RGB / 灰度 PNG → (宽, 高, RGBA 字节)。"""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        sys.exit(f'{path}：不是 PNG')
    pos, idat, head = 8, b'', None
    while pos < len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            head = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat += body
        pos += 12 + length
    width, height, depth, ctype, _, _, interlace = head
    channels = {6: 4, 2: 3, 0: 1}.get(ctype)
    if depth != 8 or interlace or not channels:
        sys.exit(f'{path}：不支持的 PNG（位深 {depth}、颜色类型 {ctype}、隔行 {interlace}）')
    raw = zlib.decompress(idat)
    stride = width * channels
    out = bytearray()
    prev = bytearray(stride)
    for y in range(height):
        kind = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            if kind == 1:
                line[i] = (line[i] + a) & 255
            elif kind == 2:
                line[i] = (line[i] + b) & 255
            elif kind == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        if channels == 4:
            out += line
        else:
            for x in range(width):
                px = line[x * channels:(x + 1) * channels]
                out += bytes(px) + b'\xff' if channels == 3 else bytes(px * 3) + b'\xff'
    return width, height, bytes(out)


def num(value):
    """整数值写成整数（JSON 里不出现 32.0 这种写法）。"""
    return int(value) if float(value).is_integer() else value


def vec2(value, default):
    """WPE 的 vec2 字段：数字铺满，字符串按空格切（不足两个时铺满）。"""
    if value is None:
        return list(default)
    if isinstance(value, (int, float)):
        return [num(value), num(value)]
    parts = [num(float(v)) for v in str(value).split()]
    return parts[:2] if len(parts) >= 2 else [parts[0], parts[0]]


def fields_of(obj):
    effects = [e for e in obj.get('effects') or [] if e.get('visible', True) is not False]
    origin = [num(float(v)) for v in str(obj.get('origin', '0 0 0')).split()]
    return {
        'text': obj['text'],
        'font': obj.get('font', 'systemfont_arial'),
        'pointsize': num(obj.get('pointsize', 32)),
        'padding': vec2(obj.get('padding'), [32, 32]),
        'spacing': vec2(obj.get('spacing'), [0, 0]),
        'maxwidth': num(obj.get('maxwidth', 500)),
        'maxrows': int(obj.get('maxrows', 1)),
        'limitwidth': bool(obj.get('limitwidth', False)),
        'limitrows': bool(obj.get('limitrows', False)),
        'limituseellipsis': bool(obj.get('limituseellipsis', False)),
        'blockalign': bool(obj.get('blockalign', False)),
        'opaquebackground': bool(obj.get('opaquebackground', False)),
        'horizontalalign': obj.get('horizontalalign', 'center'),
        'verticalalign': obj.get('verticalalign', 'center'),
        'visibleEffects': len(effects),
        'colorBlendMode': int(obj.get('colorBlendMode', 0)),
        'origin': origin[:2],
    }


def composites(fields):
    return fields['visibleEffects'] > 0 or fields['colorBlendMode'] not in (0, 31)


def is_glyph_draw(draw):
    return 'pixel:g_Color4' in draw['consts'] and draw['textures'] and draw['textures'][0]['name'] == 'g_Texture0'


def integral(value, what):
    if abs(value - round(value)) > 1e-4:
        sys.exit(f'{what}：{value} 不是整数')
    return int(round(value))


def translation(draw, width, height, what):
    """正交 MVP（列主序）的平移反推回像素：tx = (m12 + 1) · W / 2，并核对缩放是 2 / W、2 / H。"""
    m = draw['consts']['vertex:g_ModelViewProjectionMatrix']
    if abs(m[0] - 2 / width) > 1e-7 or abs(m[5] - 2 / height) > 1e-7 or any(abs(m[i]) > 1e-9 for i in (1, 2, 4, 6)):
        sys.exit(f'{what}：MVP 不是 {width}×{height} 的正交投影 {m}')
    return [num(round((m[12] + 1) * width / 2, 3)), num(round((m[13] + 1) * height / 2, 3))]


def quads(draw, atlas_size, what):
    """6 个顶点一组（索引 4i, 4i+2, 4i+1, 4i+1, 4i+2, 4i+3），取回 4 个顶点并核对形状。"""
    pos, uv = draw['mesh']['POSITION'], draw['mesh']['TEXCOORD']
    if len(pos) % 6 or len(pos) != len(uv) or len(pos) // 6 * 6 != draw['indices']:
        sys.exit(f'{what}：顶点数 {len(pos)} / 索引数 {draw["indices"]} 对不上')
    aw, ah = atlas_size
    out = []
    for i in range(0, len(pos), 6):
        p, t = pos[i:i + 6], uv[i:i + 6]
        v0, v2, v1, v3 = p[0], p[1], p[2], p[5]
        t0, t2, t1, t3 = t[0], t[1], t[2], t[5]
        ok = (p[3] == v1 and p[4] == v2 and t[3] == t1 and t[4] == t2 and v0[1] == v1[1] and v2[1] == v3[1]
              and v0[0] == v2[0] and v1[0] == v3[0] and t0[1] == t1[1] and t2[1] == t3[1] and t0[0] == t2[0]
              and t1[0] == t3[0] and all(v[2] == 0 for v in p))
        if not ok:
            sys.exit(f'{what} 第 {i // 6} 个四边形：顶点不是 WPE 的四边形写法 {p} {t}')
        out.append([num(v0[0]), num(v2[1]), num(v1[0]), num(v0[1]),
                    integral(t0[0] * aw, what), integral(t0[1] * ah, what),
                    integral(t1[0] * aw, what), integral(t2[1] * ah, what)])
    return out


def font_env():
    env = {}
    for name in SYSTEM_FONT_FILES:
        path = os.path.join(args.fonts, name)
        env[name] = hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16] if os.path.isfile(path) else None
    return env


dump = {}
for path in args.dump:
    dump.update(json.load(open(path, encoding='utf8')))

projects = {}
for rdc, entry in dump.items():
    project = os.path.basename(os.path.dirname(rdc))
    if project in SKIP:
        continue
    if project in projects:
        sys.exit(f'{project}：dump 里有不止一个 rdc')
    scene = json.load(open(os.path.join(args.proj, project, 'scene.json'), encoding='utf8'))
    texts = [o for o in scene['objects'] if 'text' in o]
    if any(not isinstance(o['text'], str) for o in texts):
        sys.exit(f'{project}：有文字不是字符串的对象')
    draws = entry['draws']
    textures = entry['textures']
    atlases = {}

    def atlas_of(draw, what):
        tex = draw['textures'][0]
        rid = tex['resource_id']
        info = textures.get(rid)
        if not isinstance(info, dict) or 'saved' not in info:
            sys.exit(f'{what}：图集 {rid} 没有存下来')
        key = rid.split('::')[-1]
        if key not in atlases:
            fmt = {'R8_UNORM': 'R8', 'R8G8B8A8_UNORM': 'RGBA8'}[info['format']]
            width, height, rgba = png_rgba(info['saved'])
            if [width, height] != list(info['size']):
                sys.exit(f'{what}：PNG 尺寸 {width}×{height} 与纹理 {info["size"]} 不同')
            pixels = rgba[0::4] if fmt == 'R8' else rgba
            atlases[key] = {'format': fmt, 'size': [width, height], 'sha256': hashlib.sha256(pixels).hexdigest()}
        return key, atlases[key]['size'], atlases[key]['format']

    cursor = 0
    objects = []
    for obj in texts:
        fields = fields_of(obj)
        what = f'{project}/{obj["name"]}'
        start = cursor
        while start < len(draws) and not is_glyph_draw(draws[start]):
            start += 1
        if start == len(draws):
            sys.exit(f'{what}：找不到字形绘制')
        target = draws[start]['rts']
        group = []
        i = start
        while i < len(draws) and is_glyph_draw(draws[i]) and draws[i]['rts'] == target and len(group) < 2:
            fmt = atlas_of(draws[i], what)[2]
            if group and (fmt == 'R8' or atlas_of(group[0], what)[2] == 'RGBA8'):
                break
            group.append(draws[i])
            i += 1
        record = {'name': obj['name'], 'fields': fields, 'atlas': None, 'colorAtlas': None, 'glyphs': [],
                  'colorGlyphs': []}
        for draw in group:
            key, size, fmt = atlas_of(draw, what)
            if fmt == 'R8':
                record['atlas'], record['glyphs'] = key, quads(draw, size, what)
            else:
                record['colorAtlas'], record['colorGlyphs'] = key, quads(draw, size, what)
        if composites(fields):
            rt_id = target[0]
            rt = textures[rt_id]
            rt_size = [rt['width'], rt['height']]
            record['rt'] = rt_size
            record['rtOrigin'] = translation(group[0], rt_size[0], rt_size[1], what)
            final = next((d for d in draws[i:] if d['textures'] and d['textures'][0]['resource_id'] == rt_id), None)
            if final is None:
                sys.exit(f'{what}：找不到合成 RT {rt_id} 上屏的绘制')
            xs = [p[0] for p in final['mesh']['POSITION']]
            ys = [p[1] for p in final['mesh']['POSITION']]
            record['center'] = translation(final, SCENE_W, SCENE_H, what)
            record['size'] = [num(max(xs) - min(xs)), num(max(ys) - min(ys))]
            i = draws.index(final) + 1
        else:
            record['origin'] = translation(group[0], SCENE_W, SCENE_H, what)
            before = draws[start - 1] if start > 0 else None
            if fields['opaquebackground']:
                if not before or before['textures'] or 'pixel:g_Alpha' not in before['consts']:
                    sys.exit(f'{what}：开了背景却找不到背景绘制')
                xs = [p[0] for p in before['mesh']['POSITION']]
                ys = [p[1] for p in before['mesh']['POSITION']]
                record['background'] = [num(max(xs) - min(xs)), num(max(ys) - min(ys))]
        objects.append(record)
        cursor = i
    projects[project] = {'atlases': atlases, 'objects': objects}

out = {
    'source': (
        'WPE 2.8.42 抓帧 A:\\p6b\\<工程>\\*.rdc（P6b 0c，回放导出 ignore/p6/b0/out/rd/dump*.json 与图集 PNG），测试工程 '
        'ignore/p6/b0/proj/p6b-*（生成：apps/wpe-scene/scripts/fixtures/make_text_fixture.py）。glyphs 每项为排版坐标的'
        '左、下、右、上与图集像素的 u0、v0、u1、v1；origin / rtOrigin / center 由 MVP 平移反推（3 位小数）；atlases 的 '
        'sha256 是解码后像素（R8 一字节、RGBA8 四字节 / 像素，逐行紧排）；systemFonts 是抓帧机器上系统字体的有无与 '
        'SHA-256 前 16 位。'
    ),
    'systemFonts': font_env(),
    'projects': projects,
}
os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
with open(args.out, 'w', encoding='utf8', newline='\n') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write('\n')
count = sum(len(p['objects']) for p in projects.values())
atlas_count = sum(len(p['atlases']) for p in projects.values())
print(f'{args.out}：{len(projects)} 个工程、{count} 个对象、{atlas_count} 张图集')
