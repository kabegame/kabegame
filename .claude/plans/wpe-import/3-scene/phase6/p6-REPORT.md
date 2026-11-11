# P6 实测报告

> 上级：[phase-6-script-text-sound.md](phase-6-script-text-sound.md)。读码在 `rea-p6*.md`，那里的结论没有实测；这里记实测核对，结论以本文件为准。每节写清工程、取数方法、读数脚本和结果。

## P6a 声音语义的实测核对（2026-11-11）

读码在 [rea-p6a-sound.md](rea-p6a-sound.md)。

**工具：**
- **工程：** 由 `ignore/p6/defs/p6a.py`（`kbp gen p6a --data ignore/p6`）生成，放在 `ignore/p6/proj/p6a-*`。声音文件是自己生成的单声道 16 位 44.1 kHz 纯音 WAV，每个文件一个频率。每个工程有一个 PROBE 层：脚本在模块顶层 `engine.registerAudioBuffers(64)`，每帧记帧号、`engine.runtime`、各声音层的 `isPlaying` 与 64 段频谱，每 5 帧 `console.error('[p6a] …')` 一行；要调方法的工程另有 CTRL 层，按 runtime 调 `play` / `pause` / `stop`，写 `[p6c] runtime 名 方法 调前 调后`。
- **WPE：** `wpe-renderdoc` MCP 开本会话的测试窗口（1280×720，fps 20，用户设置没改），`apply_properties` 运行中改壁纸音量与用户属性。没有抓帧。
- **取数：**
  - 日志：`ignore/p6/a0/cut_log.py` 从开窗游标起直接读 WPE 的 `log.txt`，`flags.py` 看 `isPlaying` 的变化点；
  - 录音：`ignore/p6/a0/rec.py` 用 WASAPI 回环录默认扬声器的混音（`uv run --with soundcard --with numpy`），`ana_rec.py` / `ana_segs.py` / `amps_at.py` / `ana_pan.py` 用 Goertzel 按频率量幅度、切段、分声道。录音和 runtime 用脚本动作造成的空档对齐。
- 结果在 `ignore/p6/a0/out/`。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 测试窗口出声，回环能采到 WPE 自己 | `p6a-calib`：7 个纯音逐个在频谱里出现，静音段读数为 0 | 成立。频段：125 Hz → 第 4 段、250 → 10、500 → 21、1 k → 32、2 k → 38、4 k → 46、8 k → 54 |
| 加载时就开始放，不等第一帧 | `p6a-calib`：文件开头 0.5 s 静音，第一个音在 runtime 0.63 s 出现 | 成立（开始时刻在 runtime 0.13 ± 0.05 s 内，含频谱的一帧延迟） |
| 单文件 `loop` 无缝循环 | `p6a-calib`：周期 9.27 s（文件 9.25 s），段间没有空隙 | 成立 |
| 增益 = `min(1, volume² × G)`，G = 壁纸音量 / 100 | `p6a-vol2`：5 个对象不同频率同时放。A（幅度 0.2、`volume` 0.5）/ B（0.05、1）= 1.00；C / B = 2.0、E / B = 9.0（输出与文件幅度成正比）；D（0.05、`volume` 3）/ B = 2.0 | **平方成立，钳制成立**。D / B = min(1, 9G) / G = 2 反推缺省 G = 0.5 |
| 运行中改壁纸音量立即生效 | `apply_properties({volume: 50})` 没有变化；改 25 后 A、B、C、E 减半，D 不变（D / B = 4 = 1 / 0.25） | 成立。**测试窗口的缺省壁纸音量是 50**；钳制在 `volume² × G` 上，不是先钳 `volume²` |
| `loop` 多文件：每个放一遍、带放回随机换下一个，中间不留空 | `p6a-loopmulti`：1 / 1.5 / 2 s 三个文件，40 s 内每段都是整个文件长或它的整数倍（连选同一个），段间空隙 0–0.06 s | 成立。空隙落在帧边界（20 fps） |
| `random`：从开始播放算起，等「时长 + U(mintime, maxtime)」 | `p6a-random`：Q（1 s、min = max = 1）开始到开始恰好 2.00 s；R（1 s ×3、0.5 / 3）12 个间隔在 1.70–3.94 s，均值 2.82（理论 [1.5, 4)、均值 2.75） | 成立 |
| `random` 的 `isPlaying` 在间隙里仍为真 | `p6a-random`：两个对象 1065 帧全是真 | 成立 |
| `single` 放一遍后 `isPlaying` 变假 | `p6a-single`：0–2.05 s 为真，之后假 | 成立 |
| `single` 放完后 `pause` 再 `play` 会从头重放，`isPlaying` 仍为假（陷阱） | `p6a-single`：7 s 的 `play` 出了一整段 2 s 的声音，`isPlaying` 调前调后都是 0；12 s 再 `play` 为真 2 s | 成立 |
| `play` 在放的时候：停掉、从头放 | `p6a-play`：5.0 s 时 500 Hz 那半已放 1 s，又从头放 1 s，连成 2.02 s | 成立 |
| `pause` → `play`：从原处续播 | 9.7 s 暂停（500 Hz 放了 0.7 s），10.7 s 恢复后再放 0.3 s 500 Hz 接 1000 Hz | 成立 |
| `stop` → `play`：从头放 | 14.9 s 停（500 Hz 放了 0.92 s），15.9 s 恢复后 500 Hz 完整 1 s | 成立 |
| `isPlaying`：`pause`、`stop` 后假，`play` 后真；重复 `pause` 无害 | 日志调前调后逐条吻合 | 成立 |
| `startsilent`：不放、`isPlaying` 假，直到 `play` | `p6a-silent`：T 在 4.0 s `play` 之前不出声、为假 | 成立 |
| 音量为 0 时不开始；变成正数时才从头放 | `p6a-silent`：Z 的 `volume` 绑属性 `zvol`（缺省 0）一直不出声、`isPlaying` 假；`apply_properties({zvol: 1})` 后才出声，从文件开头放 | 成立 |
| 自身或父层不可见不停 | `p6a-misc`：V 挂在 `visible: false` 的分组下，从头就在放；W 在 3 s 被脚本设为不可见，幅度不变 | 成立 |
| 多个声音同时开始 | `p6a-misc`：P1、P2 开头的 0.1 s 脉冲同一个 10 ms 窗口出现 | 成立 |

**读码没写、实测得到的：**
- **单声道源的声像：** 单声道 0.2 的文件左右声道各 0.0622 = 0.2 × 0.5 × 0.622；立体声每声道 0.2 的文件左右各 0.0999 = 0.2 × 0.5。单声道源居中、每个前置声道约 −4.1 dB。本机输出设备是 8 声道（HECATE G1500 BAR），OpenAL Soft 多半把一部分分给中置，系数随设备布局变，不是固定的等功率律。Web Audio 把单声道原样复制到两个声道，同一文件在我们这边会响约 4 dB。
- **脚本频谱带自适应归一化：** `registerAudioBuffers` 的数组不是绝对幅度。纯音持续时读数逐帧上升，`1 / 读数`每帧减一个常数（分母线性衰减）；读数超过 1 时分母立刻追上、读数压回 1.000，起音那一帧可以到 3–4（`p6a-vol` 的第 32 段）。所以它只能认频率，不能比音量。这条留给 P9（`g_AudioSpectrum*`）。

**没测：**
- **WPE 暂停时的淡出（`k = min(1, 6·dt)`）：** MCP 不能让测试窗口进入暂停，桌面壁纸不碰。只能人耳核对。
- `volume` 写成负数、`playbackmode` 写成未知字符串：语料没有。

## P6b 文本语义的实测核对（2026-11-12）

读码在 [rea-p6b-raster.md](rea-p6b-raster.md)（字体、栅格化、图集、MSDF）与 [rea-p6b-layout.md](rea-p6b-layout.md)（字段、排版、文字框、作为图层、脚本）。

**工具：**
- **工程：** `ignore/p6/b0/defs/p6b.py`（`kbp gen p6b --data ignore/p6/b0 --defs ignore/p6/b0/defs`）生成 7 个，放在 `ignore/p6/b0/proj/p6b-*`：`geom`（字号、图集、步进、行高与 `spacing`、负字距加半透明）、`align`（九种对齐、三行纵向对齐）、`wrap`（按词、按字断行，行数限制，省略号，两端对齐）、`fx`（`padding` 与合成 RT、钳制、两种背景、`colorBlendMode` 31）、`fallback`（中日韩、emoji、符号）、`script`（`text` 字段脚本计数器，脚本写 `text` 的类型转换），以及补测的 `extra`（四个 CFF 的 `otf`、没有 hinting 表与带完整指令的 TrueType、行数已满时的省略号与截断）。字体只用 WPE `assets/fonts` 的字体（`extra` 另用了几个）和 `systemfont_arial`，场景 1920×1080 正交。
- **抓帧：** `wpe-renderdoc` MCP 的 `capture_sweep`，窗口 1920×1080，抓帧在 `A:\p6b\<工程>\`，日志 `ignore/p6/b0/out/logs/`。没有改 WPE 设置。
- **导出：** `ignore/p6/b0/rdc_text.py`（`qrenderdoc --python`，复用 MCP 工作进程的服务层）导出每次绘制的管线、常量、顶点与渲染目标尺寸，图集存 PNG，结果 `ignore/p6/b0/out/rd/dump.json`、`out/rd/tex/`。
- **离线参考：** 在 `ignore/p6/venv`（独立虚拟环境，`freetype-py` 2.x 自带 FreeType 2.13.2，`uharfbuzz` 0.56.4）里照读码写的 `ft_ref.py`（字体、回退链、字形位图；`FTRULE=fpgm FTCFF=native` 是最终的 hinting 规则）与 `ft_layout.py`（分行、断行、对齐、文字框、原点），和抓帧逐顶点、逐像素比；`fx_view.py` 列绘制，`script_frame.py` 认计数器画的是哪个数。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 不用 DirectWrite 画字，用静态链接的 FreeType + HarfBuzz | `0x1401ad1dc`–`0x1401ad1f2` 是 `FT_Set_Char_Size(face, 0, (int)(pointsize·64), 300, 300)`，乘数常量 64.0；exe 里有 FreeType 的 `autofitter` / `truetype` / `psaux` / `sfnt` 模块名；DirectWrite 只在 HarfBuzz 的 `hb-directwrite` 里 | 成立（我核对的） |
| 每个字形一个四边形，图集 1:1，坐标是 300 DPI 的整数像素 | 每个文本对象一次 `DrawIndexed`，索引数 = 字形数 × 6（空格是零尺寸四边形，换行符没有）；顶点 20 字节；RobotoMono 32 号「A」72×96、步进 80（0.6 em × 133.33） | 成立 |
| 图集 R8、512²、1 级 mip；线性、wrap；混合 `SrcAlpha / InvSrcAlpha` | `geom` g1 的管线状态 | 成立 |
| 正交场景里对象的 `depthtest: enabled` 不起作用 | 全部文本绘制深度测试关 | 成立 |
| 图集按「字体 + 字号」共享 | `geom` 8 个对象 5 张图集：RobotoMono 32 号三个对象共用一张、12 号两个共用一张 | 成立 |
| 字形位图：`FT_LOAD_RENDER \| FT_LOAD_COLOR`，8 位灰度、没有 ClearType / gamma | 离线 FreeType 2.13.2 照此渲染：NotoSans、Arial、微软雅黑、Malgun 的字形和 WPE 图集**逐像素相同**；RobotoMono 差 1 像素 | 部分成立，见下一行 |
| （读码没说）没有 hinting 指令的字体怎么 hint | RobotoMono 只有 `prep`、没有 `fpgm` / `cvt`。加 `FT_LOAD_FORCE_AUTOHINT` 后 RobotoMono 的 4 个对象逐像素相同，同时 NotoSans、Arial 用这个标志反而对不上 | **WPE 的 FreeType 对没有 `fpgm` 的 TrueType 字体用自动 hinter**，有完整指令的走字节码。本机 2.13.2 的判定还看 `prep`，要自己补这条规则 |
| 步进取 HarfBuzz 不 hinting 的步进、截成整数再加 `spacing.x` | 30 个直接上屏对象的全部字形位置一致（含负字距） | 成立 |
| 回退链：主字体 → arial → seguiemj → arialuni → segoeui → Twemoji → seguisym → msyh.ttc → Malgun，逐码点、按 face 切段排字 | `fallback`：é、汉字、假名、韩文、★、😀 和 `NotoSans` 的「中文テスト」，位置与像素全部一致（16 万多像素） | 成立。NotoSans 自身没有中日韩字，落到微软雅黑 |
| 彩色字形（emoji）另画一次，用 RGBA8 图集与 `basefontrgba` | b1 先画 8 个普通字形（R8），紧接着单独一次 6 个索引（RGBA8 图集），然后才画下一个对象 | 成立。「之后」是本对象的普通字形之后 |
| 行高 = 主字体 `height >> 6` + `spacing.y`；分行、断行、省略号、两端对齐、行内对齐 | `geom` g6、`align`、`wrap` 共 19 个对象：每个四边形位置一致（`wrap` 按词断、40 个 A 按字断成 19 / 19 / 2，`blockalign` 行宽恰为 `maxwidth`，`"a\nb\nc\n"` 加两行限制得到 `a` / `b…`） | 成立 |
| 横向对齐偏移 ±w/2；纵向 `center` 是「首行 ascender 线与末行基线的中点」，`top` / `bottom` 用 ascender / descender | 全部 30 个直接上屏对象，模型矩阵平移出的局部原点与离线计算在 0.01 像素内一致 | 成立 |
| 文字框 = 墨迹包围盒（高至少「行数 × 行高」）；`padding` 只在有 effect、`colorBlendMode` 合成或背景时加，钳到 512 | `fx`：f1（`padding` 0）合成 RT 149×176 = 文字框；f2（20）189×216；f3（600，12 号）1080×1090；f7（无 effect，`padding` 50）不走合成；我核对了 `0x140257de9`–`0x140257e62` 的条件 | 成立 |
| 合成 RT 初值是背后的场景快照、alpha 清 0；开背景时清成背景色 | f1、f2、f3 字前一次 `composelayer` 绘制读场景快照；f5（背景 + effect）没有这一步 | 成立（清屏色没有读 Clear 的值） |
| 直接上屏的背景是 `flat` 四边形，颜色 `backgroundcolor`、alpha 对象 alpha；LDR 下不乘 `backgroundbrightness` | f4：字前一次绘制，`g_Color` (1, 0, 0)、`g_Alpha` 0.5（`backgroundbrightness` 3） | 成立 |
| `colorBlendMode` 31 是 additive，不走合成 | f6：直接上屏，`SrcAlpha / One` | 成立 |
| `text` 字段脚本当帧生效 | 计数器 `'F' + n`：RenderDoc 第 182 帧（脚本第 183 帧）画的是 F183，下一帧 F184 | 成立 |
| 脚本写 `text`：数字转字符串，`null` 不写；枚举写错值取第一项；没有 `alignment`；`padding` 写数字铺满、读回 Vec2 | 日志：`init string "abc" number 32 {"x":32,"y":32} … center undefined`、`num string "12"`、`null string "12"`、`align left`、`padding {"x":10,"y":10}` | 成立 |
| （补测 `p6b-extra`）CFF 的 `otf` 怎么 hint | Atami、Alcubierre、spincycle_3d、Segment7 四个 CFF 字体：强制自动 hinting 时都差 1 像素；走 FreeType 自带的 CFF 引擎（缺省）时**逐像素相同** | **CFF 走原生引擎**，「没有 `fpgm` 就自动 hinting」只对 TrueType（`glyf`）成立 |
| 没有 `fpgm` / `prep` 的 TrueType 自动 hinting | 8bitOperator 逐像素相同；opensticks 8 个字形里 3 个有残差（「M」宽 1 像素、另两个 1 和 36 个像素）；换不 hinting、轻量 hinting 都更差；FreeType 2.12.0、2.13.0、2.13.2 结果相同 | 基本成立，**opensticks 有残差没解释**，推断是 WPE 的 FreeType 比 2.13.2 新（2.13.3 / 2.14 改过自动 hinter），留给 1a 自己编 FreeType 时按版本试 |
| 行数已满、宽度溢出时：加省略号逐字回退；不加时在第一个越界的非空白字形处截断 | e9（不加）：第二行截成 `jumps over the lazy dog a`，36 个四边形一致；e8（加）：**接「…」前去掉前缀尾部的空白**之后一致（`…lazy dog…`，行宽 588），不去掉会宽一个空格 | 成立，补一条读码没写的：去掉尾部空白 |

**结论：** 离线的 FreeType 2.13.2 + HarfBuzz，加上两条 hinting 规则（TrueType 没有 `fpgm` 就自动 hinting，CFF 走原生引擎），和读码的排版规则一起，对 7 个工程的 45 个对象里 44 个**和 WPE 逐像素、逐坐标相同**：字形位图逐像素比了 32 个对象（约 70 万像素），四边形位置与对象原点比了 39 个直接上屏的对象，计数器文字比了 1 个；唯一的例外是 opensticks 的 3 个字形。所以文本可以做到和 WPE 几乎完全一致，前提是我们也用 FreeType + HarfBuzz 栅格化、排字，而不是浏览器画布。

**没测：**
- `anchor`：要用和场景不同比例的窗口。
- MSDF 路径（描边、投影、模糊；语料 2 张、5 个对象）。
- 透视场景的 `_depth` 材质（我们还没有透视，P5d）。
- 图集扩容与回收：不影响画面（采样 1:1、字形之间有清零的 1 像素间隔，排布不同结果相同）。
- 复杂文种（阿拉伯文、印地文等）的排字：语料没有。
