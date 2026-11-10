# 粒子测试数据的生成与参考脚本

`src/particles/` 里几份测试数据和常量文件的生成脚本，以及单测钉的值所用的独立参考实现。它们原来散在对比台
`ignore/p4/` 的各步骤目录里（原件照旧留在那里），挪进来是为了产品自己能复现这些文件。

- 脚本只认自己的位置：输出缺省写进 `apps/wpe-scene/src/particles/`，都可以用 `--out` 改到别处。
- **WPE 真值不入库。** 轨迹、日志、测试工程和回放导出都在对比台数据目录（`--data`，缺省环境变量 `KBP_DATA`，再缺省
  `ignore/p4`），来源和怎么重新得到见下面「输入从哪来」。入库的输入只有 `noise-tables.json`。
- 生成的 JSON / TS 写完都要过仓库的 Prettier，仓库里的文件是格式化之后的样子。
- 夹具 JSON 的 `source` 字段记的是最初生成时的位置（`ignore/p4/b4/make_fixtures.py` 等），脚本照原样写；改了它，重新生成的文件就和仓库里的不同。

依赖：本机 Python 3（`python -X utf8 -I` 运行；只有 `colorn_ref.py` 要 numpy，其余只用标准库）；`noise_xcheck.test.ts` 用仓库根的
Node 与 vitest；格式化用仓库根的 Prettier。命令都从仓库根运行。

## 脚本一览

| 脚本 | 生成或核对 | 输入 |
|---|---|---|
| `gen_noise_tables.py` | 生成 `src/particles/noiseTables.ts`；打印三张置换表与梯度表的 FNV-1a，即 `noise.test.ts` 钉的校验值 | `noise-tables.json` |
| `make_replay_fixtures.py` | 生成 `src/particles/fixtures/fps60.json`、`fps10.json`、`s15.json`、`s60.json`、`p4a2.json`（`replay.test.ts` 用） | 数据目录的轨迹、日志、工程 `p4-0`、`p4a2` |
| `make_noise_fixtures.py` | 生成 `src/particles/fixtures/noise.json`、`p4b-turb.json`（`noise.test.ts` 用）、`p4b-posoffset60.json`、`p4b-posoffset10.json`（`replay.test.ts` 用） | 数据目录的轨迹、工程 `p4b`，P4b 步骤 4 回放的导出 `fixture-data.json` |
| `colorn_ref.py` | 生成 `src/particles/fixtures/colorn.json`（`colorn.test.ts` 用）：`colorn` 的独立参考实现算出的逐位真值 | 无（固定种子） |
| `noise_ref.py` | 噪声的独立参考实现（照读码，float32 逐步舍入），给下面两个脚本 import；命令行 `noise_ref.py a b c` 打印 `snoise3(a, b, c)` | `noise-tables.json` |
| `noise_equal_cases.py` | 核对 `noise.test.ts`「snoise3 坐标相等时的顶点顺序」钉的 8 个值，并打印原版 Gustavson 顺序下的值 | `noise_ref.py` |
| `noise_xcheck.test.ts` + `noise_xcheck.py` | 对拍：20 万组随机 float32 输入，产品的 `snoise1/2/3` 与 `noise_ref.py` 逐位比较 | 产品代码 `src/particles/noise.ts` |

## 用法

### 噪声常量表

```bash
python -X utf8 -I apps/wpe-scene/scripts/fixtures/gen_noise_tables.py [--tables noise-tables.json] [--out noiseTables.ts]
node node_modules/prettier/bin/prettier.cjs --write apps/wpe-scene/src/particles/noiseTables.ts
```

### 回放夹具（P4a 步骤 3）

```bash
python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_replay_fixtures.py [--data ignore/p4] [--out 目录]
node node_modules/prettier/bin/prettier.cjs --write apps/wpe-scene/src/particles/fixtures/{fps60,fps10,s15,s60,p4a2}.json
```

读 `<data>/tracks/rd-<标签>.json`、`<data>/out/<标签>-log.txt`、`<data>/proj/<工程>/`。dt 取日志累计时间的相邻差分（6 位小数），
抓到的帧换成轨迹里的 float32 dt；`p4a2` 只留首尾两帧。

### 噪声夹具（P4b 步骤 4）

```bash
python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_noise_fixtures.py [--data ignore/p4] [--fixture-data 文件] [--out 目录]
node node_modules/prettier/bin/prettier.cjs --write apps/wpe-scene/src/particles/fixtures/{noise,p4b-turb,p4b-posoffset60,p4b-posoffset10}.json
```

读 `<data>/tracks/rd-p4b-fps60.json`、`rd-p4b-fps10.json`、`<data>/proj/p4b/particles/*.json`，以及 `--fixture-data`（缺省
`<data>/b4/out/fixture-data.json`）。

### colorn 参考实现（P4b 步骤 6）

```bash
python -X utf8 -I apps/wpe-scene/scripts/fixtures/colorn_ref.py [--out colorn.json]
node node_modules/prettier/bin/prettier.cjs --write apps/wpe-scene/src/particles/fixtures/colorn.json
```

照 `rea-p4b-render.md` 7.1、7.3、7.4 的伪代码，numpy float32 逐步舍入、`fmod` 双精度；不读产品代码。

### 噪声参考实现与对拍（P4b 步骤 4）

```bash
python -X utf8 -I apps/wpe-scene/scripts/fixtures/noise_ref.py 0.1 0.3 0.3       # 0.2559826374053955
python -X utf8 -I apps/wpe-scene/scripts/fixtures/noise_equal_cases.py           # 和 noise.test.ts 钉的值比
# 对拍：先用产品代码算（写约 29 MB 的 JSON，缺省 ignore/fixtures/noise-xcheck-ts.json，环境变量 NOISE_XCHECK_JSON 改），再用 Python 重算
node node_modules/vitest/vitest.mjs run --config apps/wpe-scene/scripts/fixtures/vitest.config.ts
python -X utf8 -I apps/wpe-scene/scripts/fixtures/noise_xcheck.py [--input 文件] [--out 结果.txt]
```

对拍三行都是「不一致 0」才说明两份实现逐位一致。`vitest.config.ts` 只收本目录的 `*.test.ts`，产品测试不受影响。
对拍只证明两份实现一致，真值仍来自 WPE 轨迹。

### 核对重新生成的文件和仓库里的相同

生成到临时目录再比，不要覆盖产品文件。Prettier 会按 `.gitignore` 静默跳过 `ignore/` 下的文件，仓库外又找不到 `.prettierrc.json`，
所以显式给配置和一个空的忽略文件：

```bash
python -X utf8 -I apps/wpe-scene/scripts/fixtures/gen_noise_tables.py --out <临时目录>/noiseTables.ts
python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_replay_fixtures.py --out <临时目录>
python -X utf8 -I apps/wpe-scene/scripts/fixtures/make_noise_fixtures.py --out <临时目录>
python -X utf8 -I apps/wpe-scene/scripts/fixtures/colorn_ref.py --out <临时目录>/colorn.json
node node_modules/prettier/bin/prettier.cjs --config .prettierrc.json --ignore-path <空文件> --write <临时目录>/*
# 再逐个 cmp <临时目录>/<文件> apps/wpe-scene/src/particles/…
```

## 输入从哪来

### `noise-tables.json`（入库）

从 `wallpaper64.exe` 2.8.42（sha256 `40e2ce02…d993b0`）按地址原样读出的常量表：置换表、`permMod12`、三张梯度表与标量常量，
地址见文件里各项的 `addr`。由 REA 的导出脚本 `ignore/p4/rea/p4b-mod/tables.py` 写出，原件在同目录的 `noise-tables.json`；
入库时用 Prettier 格式化过，数值与原件逐位相同（只有缩进、数组换行和 `e-08` → `e-8` 这类指数写法不同）。读码依据是
`.claude/plans/wpe-import/3-scene/phase4/rea-p4b-modules.md` C 节。

### 轨迹 `<data>/tracks/rd-<标签>.json`（WPE 真值，不入库）

WPE 抓帧（RenderDoc `.rdc`）里提取的逐帧粒子，用 kbp-tools 的 `kbp rdc track`（`.claude/skills/kbp-tools/SKILL.md`）重新提取：

| 标签 | 抓帧目录 | 命令 |
|---|---|---|
| `fps60`、`fps10` | `A:\p4-0\fps60`、`A:\p4-0\fps10` | `python -X utf8 -I .claude/skills/kbp-tools/kbp.py rdc track A:\p4-0\fps60 fps60 p4-0` |
| `s15`、`s60` | `A:\p4-0\sweep\fps15`、`A:\p4-0\sweep\fps60` | `… rdc track A:\p4-0\sweep\fps15 s15 p4-0` |
| `p4a2` | `A:\p4a\p4a2` | `… rdc track A:\p4a\p4a2 p4a2 p4a2` |
| `p4b-fps60`、`p4b-fps10` | `A:\p4b\p4b-fps60`、`A:\p4b\p4b-fps10` | `… rdc track A:\p4b\p4b-fps60 p4b-fps60` |

- `p4-0`、`p4a2` 没有 `kbp-meta.json`，`kbp rdc track` 自动用老认法；`p4b` 按 meta 认。
- 表里 7 组都按上面的命令重新提取过（kbp-tools 第 1 批与第 4 批验收），结果和 `ignore/p4/tracks/` 里的逐字节相同。
- 现有轨迹已经在 `ignore/p4/tracks/`，提取时输出已存在会被拒绝，要覆盖加 `--overwrite`。
- 抓帧没了就只能重新抓：wpe-renderdoc MCP 的 `capture_wallpaper` / `capture_sweep`（`.claude/skills/wpe-renderdoc/SKILL.md`）。
  新抓的是另一次运行，帧号、dt、粒子都不同，生成出来的夹具会变，测试要按新数据核对。

### 日志 `<data>/out/<标签>-log.txt`（WPE 真值，不入库）

抓帧那次运行里 WPE `log.txt` 的 `[kbp]` 行（测试工程的帧号图层每 50 帧写一条「帧号,帧时间,累计时间」，格式见 kbp-tools 的
`SKILL.md`「`[kbp]` 日志」）。和轨迹必须是同一次运行，不能单独重抓；重新抓帧时用 wpe-renderdoc MCP 的
`capture_sweep(jobs, out_root, log_dir=<data>/out)`，它写 `<标签>-log.txt`。

### 测试工程 `<data>/proj/<工程>/`（不入库）

| 工程 | 生成器 |
|---|---|
| `p4-0` | `ignore/p4/gen.py`（P4-0 自己的 `system`，没收进 kbp-tools 的生成库） |
| `p4a2` | `ignore/p4/gen_a2.py` |
| `p4b` | `ignore/p4/gen_b.py`；或把它的 `import` 换成 `from kbp import gen as gen_b` 后用 `kbp gen`（第 2 批验收时重新生成的工程逐字节相同） |

### `fixture-data.json`（P4b 步骤 4 回放的导出，WPE 真值，不入库）

`make_noise_fixtures.py` 要的单点真值与强制回放片段：按 WPE 日志与轨迹回放 `p4b`，从粒子位置反推 `snoise1` / `snoise2` /
`snoise3` 的值、在日志 T 的舍入区间里拟合出生时刻的精确 T（用到产品的 `snoise1` / `snoise2`），再截出 turb* 的 6 个抓帧。

- 写它的是 P4b 步骤 4 的原回放 `ignore/p4/b4/replay.test.ts`，缺省位置 `ignore/p4/b4/out/fixture-data.json`：

  ```bash
  KB_TEST=ignore/p4/b4/replay.test.ts node node_modules/vitest/vitest.mjs run --config ignore/p4/b4/vitest.config.ts
  ```

  它同时改写同目录的 `replay.txt`、`replay.json`、`replay-c.txt`；输入是上面的 `rd-p4b-fps60/10.json`、`p4b-fps60/10-log.txt`、
  `proj/p4b`。
- kbp-tools 的案例 `b4`（`kbp replay b4`，案例在 `ignore/p4/cases/b4.json`）是同一回放的移植，判定逐位相同，但不写这份导出。

## 原件

| 本目录 | 原件 | 改动 |
|---|---|---|
| `gen_noise_tables.py` | `ignore/p4/b4/gen_tables.py` | 输入、输出参数化；生成文件头里的脚本位置 |
| `noise-tables.json` | `ignore/p4/rea/p4b-mod/noise-tables.json` | Prettier 格式化（数值不变） |
| `make_replay_fixtures.py` | `ignore/p4/step3/make_fixtures.py` | 输入、输出参数化 |
| `make_noise_fixtures.py` | `ignore/p4/b4/make_fixtures.py` | 输入、输出参数化 |
| `colorn_ref.py` | `ignore/p4/b6/colorn_ref.py` | 输出参数化 |
| `noise_ref.py` | `ignore/p4/noise_ref.py` | 常量表的位置 |
| `noise_equal_cases.py` | `ignore/p4/b4/equal_cases.py` | `noise_ref.py` 的位置 |
| `noise_xcheck.py` | `ignore/p4/b4/xcheck.py` | 输入、输出参数化 |
| `noise_xcheck.test.ts`、`vitest.config.ts` | `ignore/p4/b4/xcheck.test.ts`、`vitest.config.ts` | 静态导入产品代码、输出参数化；配置的 root 按位置推出 |
