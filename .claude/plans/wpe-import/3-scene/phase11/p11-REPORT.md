# P11 实测报告

> P11 步骤 0 的 WPE 实测（WPE 2.8.42 + RenderDoc，wpe-renderdoc MCP）。读码见 [rea-p11-textures.md](rea-p11-textures.md)、[rea-p11-media.md](rea-p11-media.md)，计划见 [phase-11-audio-media.md](phase-11-audio-media.md)。
> 测试工程定义在 `ignore/p11/defs/`（`kbp gen <模块> --data ignore/p11`），抓帧在 `A:\p11\`，提取结果在 `ignore/p11/tracks/`、`ignore/p11/out/`。WPE 的帧率设置是 20 fps（日志里 dt ≈ 0.05）。

## 音频 uniform（2026-11-13）

**工程：** `p11a.py` 的 `p11-audio`：沿用 P4e 的立体声测试音（左 1 kHz、右 250 Hz，一圈 4 s，WPE 回环采到自己的声音），CLK 图层读 `g_AudioSpectrum16/32/64Left/Right` 六个数组（`gen.write_project(audio=(16, 32, 64))`）；`p11-audio-off` 是去掉 `project.json` 里 `supportsaudioprocessing` 的副本。抓帧 `A:\p11\audio`（10 帧）、`A:\p11\audio-off`（3 帧），`kbp rdc track` 提取到 `ignore/p11/tracks/rd-p11-audio*.json`，核对脚本 `ignore/p11/ana_audio.py`。

| 结论 | 依据 | 结果 |
|---|---|---|
| 32 段是 64 段相邻两段取最大，16 段是 32 段相邻两段取最大，左右声道各自算 | 10 帧 × 左右，逐值比 | 最大偏差 0，成立 |
| 六个 uniform 就是 `SceneSpectrum` 的 `L*` / `R*` 三块（P4e 已建） | 上一行的关系与 P4e 的 16 段核对 | 成立 |
| 左右声道是两份数据 | 左峰在 16 段的第 8 段（1 kHz）、右峰在第 2 段（250 Hz），和 P4e `a-band` 的落段一致 | 成立 |
| 静音时整块为 0 | 测试音静音段的 4 帧六个数组全 0 | 成立 |
| 没声明 `supportsaudioprocessing` 时全 0 | `p11-audio-off` 3 帧全部值为 0 | 成立 |

所以 P11a 只剩接线：每帧把 `SceneSpectrum` 的三块左右声道按打包形态写进常量缓冲。

## 属性纹理 `scenetexture`（2026-11-13）

**工程：** `p11b.py` 的 `p11-ut`：用户属性 `ut`（`scenetexture`，缺省空串）同时绑在三个槽上：
- 图像层材质槽 0，缺省 `util/clouds_256`（256×256）；
- 粒子材质槽 0，缺省 `particle/drop`（32×128）；
- `blend` effect 的槽 1，缺省 `util/clouds_256`。effect 的 json、材质、着色器要拷进工程（effect 里的材质路径按工程 / assets 根解析，不按 effect 目录；不拷时 WPE 日志 `Failed opening: materials/effects/blend.json`，effect 退化成直通）。

`p11-ut-init` 是属性缺省值直接写成图片绝对路径的副本。测试图在 `ignore/p11/texsrc/`：`ut-a.png`（300×200 RGBA，四象限红 / 绿 / 蓝 / 黄，alpha 255 / 128 / 255 / 0）、`ut-b.jpg`（640×360，80 像素宽的橙蓝竖条）、`ut-c.png`（100×400，上品红下青）。

**做法：** 测试窗口里用 `apply_properties` 依次把 `ut` 设成图片的绝对路径（正斜杠）、空串、不存在的路径，每次抓 1 帧（`A:\p11\ut`、`A:\p11\ut2`）；`p11-ut-init` 直接开窗抓（`A:\p11\ut-init`）。读管线状态里槽上的纹理、取像素、存图，`kbp rdc consts` 读 `g_Texture1Resolution`（`ignore/p11/out/consts-*.json`）。

| 情形 | 图像层槽 0 | 粒子槽 0 | effect 槽 1 |
|---|---|---|---|
| 空串（开窗时） | `clouds_256`，256×256，7 级 mip | `drop` | `clouds_256` |
| `ut-a.png`（300×200） | 200×200 | 50×200 | 200×200，`g_Texture1Resolution` = (200, 200, 200, 200) |
| `ut-b.jpg`（640×360） | 360×360 | 90×360 | — |
| `ut-c.png`（100×400） | — | 100×400 | 100×100，`g_Texture1Resolution` = (100, 100, 100, 100) |
| 空串（设过图之后） | 回到 `clouds_256` | — | — |
| 不存在的路径（紧接在一张有效图之后） | — | — | 回到缺省，`g_Texture1Resolution` = 256 |
| 加载时就是 `ut-a.png`（`p11-ut-init`） | — | — | 200×200 |

结论：
1. **属性值是图片的绝对路径**，运行中改属性就地换纹理，加载时的值也生效。PNG（带 alpha）和 JPG 都收。
2. **纹理是从源图正中裁出的最大矩形，宽高比等于这个槽缺省纹理的宽高比，像素一比一，不缩放。** 证据：`ut-b.jpg` 的 360×360 一行像素是「蓝 20、橙 80、蓝 80、橙 80、蓝 80、橙 20」，正是源图 x ∈ [140, 500) 这一段（压扁的话会是 8 段各 45）；`ut-c.png` 在 1:1 的槽里得 100×100（保留源高会是 400×400），在 1:4 的槽里得 100×400。粒子槽没有图层尺寸，1:4 只能来自 `drop` 的 32×128。
3. **格式**：`R8G8B8A8_UNORM`，直通 alpha（不预乘：绿象限读到 (0, 1, 0, 0.502)，黄象限 (1, 1, 0, 0)），只有 1 级 mip。
4. **采样器**：过滤是线性、没有各向异性（缺省纹理 `clouds_256` 是 8 倍各向异性）；寻址和该槽缺省纹理一样（`clouds_256` Wrap，`drop` ClampEdge），推断是沿用缺省纹理的标志（`drop.tex` 的标志 0x2），读码确认。
5. **`g_Texture<n>Resolution` = (w, h, w, h)**，w、h 是裁出来的尺寸。
6. **空串、不存在的路径都回到缺省纹理**，不保留上一张有效图。
7. **effect pass 上的 `usertextures` 和材质 pass 同样处理。**

**补测：裁切比例按谁、大图**（`p11b.py` 的 `p11-ut-ar`，抓帧 `A:\p11\ut-ar`）：两个图像层，`ar-a` 是 400×400 的图层配 1:4 的 `drop`，`ar-b` 是 600×300 的图层配 1:1 的 `clouds_256`。

| 情形 | `ar-a`（图层 1:1、缺省纹理 1:4） | `ar-b`（图层 2:1、缺省纹理 1:1） |
|---|---|---|
| `ut-b.jpg`（640×360） | 90×360，ClampEdge | 360×360，Wrap |
| `ut-d.png`（6000×3000） | — | 3000×3000 |

8. **裁切比例只看缺省纹理，不看图层 `size`。** 采样器寻址也跟缺省纹理（`drop` 的 ClampEdge 跟到了 1:1 的图层上）。
9. **6000×3000 照样裁成 3000×3000，没有缩小**；更大的图有没有上限没测（WebGPU 的缺省上限是 8192）。

**还没测：** GIF、视频；`keepaspect`、`usertexturereference`（语料 0 处）。

**和读码对照：** rea-p11-textures 的结论和以上 9 条逐条吻合，并给出了代码位置。读码另外查明：
- 比例取的是缺省纹理的图像尺寸（不是补到 2 的幂的纹理尺寸）；精灵表取帧尺寸；`usertexturereference` 优先；`keepaspect` 时不裁。
- 只有 `textures` 同位置是非空字符串的槽才会换，只看前 10 个槽。
- 收的文件分三种：视频扩展名走视频纹理，`.gif` 是动图，其它交给 FreeImage。

这几条实测没覆盖，以读码为准。

## P11b 补测：槽 0、instanced、RT 缺省、精灵表、GIF、视频、解码（2026-11-14）

**工程**（`ignore/p11/defs/p11b2.py`，`kbp gen p11b2 --data ignore/p11`）：
- `p11b-npot`：两个图像层，槽 0 缺省是自写的 `kbt/npot.tex`（300×200 放在 512×256 里，RGBA8888、1 级 mip）。`np-auto` 带 `autosize`、`scale 2`，`np-size` 是 `size 600 400`、不带。
- `p11b-inst`：instanced 纯色层，模型 `instanced` + `solidlayer`，材质 `util/solidlayer_instance_4`。对象 `size 600 400`、`color 1 0.5 0.25`，`instance.usertextures: ["ut"]`。`inst-fx` 挂一个 tint，`inst-plain` 不挂。
- `p11b-rt`：组合层 `dep`（500×300、不可见、被依赖）。图像层 `user` 的 blend 槽 1 缺省是 `_rt_imageLayerComposite_10_a`，`usertextures: [null, "ut"]`。
- `p11b-sheet`：粒子材质槽 0 缺省是精灵表 `particle/nature/leaves7`（512×512、6×5 帧、标志 `0x4`）。
- GIF、视频、解码样本用步骤 0 的 `p11-ut`。

抓帧在 `A:\p11b\`，测试窗口 1600×900（另一个会话占着 1920×1080）。

| # | 情形 | 结果 |
|---|---|---|
| M1 | 非 2 的幂的槽 0 换图（`ut-b.jpg` → 540×360） | 两个图层的顶点 UV 都从缺省纹理的 `0.000293 – 0.585645`、`0.000586 – 0.780664` 变成 `0.000278 – 0.999722`、`0.000417 – 0.999583`：上界跟着当前纹理变成 1，内缩按新纹理的 `0.15 / 尺寸`（0.15/540、0.15/360）。带不带 `autosize` 一样。图层尺寸不变（`np-auto` 仍是 300×200）。清空后回到缺省纹理的 UV |
| M2 | instanced 换图 | 合成 RT 从 32×32（`util/white`）变成用户纹理的尺寸：`ut-a.png` → 300×200，`ut-c.png` → 100×66。裁切比例取对象 `size`（600×400 → 1.5），不是 `util/white` 的 1:1：`ut-c` 的 100×400 裁成 `trunc(100 / 1.5)` = 66 行，同读码 rea-p5-modelflags §6.2「把对象 `size` 写进 `instance.usertexturereference`」。`g_Color4` 从 `(1, 0.5, 0.25, 1)` 变成 `(1, 1, 1, 1)`，带 effect 的基础 pass 和直接上屏的 `inst-plain` 都变 |
| M3 | effect 槽的缺省是被依赖图层的合成 RT | 空值时槽 1 绑那张 500×300 的 RT；换成 `ut-b.jpg` 后是 600×360 的普通纹理，比例取 RT 的 500×300（`trunc(360 · 5/3)` = 600）。采样器夹取、线性 |
| M4 | 精灵表槽换图 | 纹理按帧比例裁（帧 85.3×102.4 → `ut-a` 裁成 166×200）。几何着色器输出的 UV 仍是缺省精灵表的帧（如 `u 0.3333–0.5`、`v 0–0.2`），用户纹理被当成 6×5 的帧表采样 |
| M5 | GIF（`ut-anim2.gif`：4 帧 300×200，延时 100 / 200 / 50 / 300 ms，第 3 帧左半透明，`loop 0`、disposal 2） | 纹理 200×200（按 1:1 裁），R8G8B8A8、1 级 mip，采样器**点采样**（缺省纹理是线性），寻址跟缺省纹理（Wrap）。20 帧里按帧延时换帧：红约 100 ms、绿约 200 ms、蓝只出现在一帧、黄约 300 ms，650 ms 一圈；透明区画出来是背景色，不叠上一帧。第一版测试图被 PIL 量化坏了（主色成了透明下标），改用共享调色板重做 |
| M6 | 视频（`ut-video.mp4`：320×240、每秒一种颜色） | 槽上是 240×240 的 Render Target（按 1:1 裁后的尺寸），线性、寻址跟缺省纹理。UV 内缩 `0.15/240`。6 帧里从红换到绿，在播放 |
| M7 | 解码（WPE 导出的槽纹理对浏览器的解码） | 浏览器这一路：`createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "from-image" })` → `copyExternalImageToTexture`（`premultipliedAlpha: false`）→ 读回，照 WPE 裁切（脚本 `ignore/p11/b/dec_browser.js`）。下面几种和 WPE **逐像素相同**：16 位 RGBA PNG（都取高字节，不四舍五入）、调色板 + `tRNS`、灰度 + alpha、24 位 BMP、ICO。EXIF 方向 6 的 JPEG 两边都按 EXIF 转，方向一致；6043 / 40000 个像素有差，最大 47 / 18 / 66，在色块边界上，是 JPEG 解码库的色度上采样不同（PIL 与浏览器的结果相同，WPE 的 FreeImage 不同）。带 `gAMA` 的那张也是 0 差，但它只有 0 / 255 两种值，gamma 校正改不动，**测不出**，见 M9 |
| M8 | 读码 R5 的加载时情形：`p11b-rt-init`（`ignore/p11/b/make_rt_init.py`，属性 `ut` 的缺省值就是 `ut-b.jpg`） | 槽 1 仍是那张 500×300 的 RT，用户图**没生效**。M3 那种运行中改值才生效 |
| M9 | gamma 与 16 位灰度（`ignore/p11/b/make_gamma.py`：256×256 渐变，`gAMA` 1.0 / 0.6 / 1/2.2 / 没有；16 位灰度值 `0x1000 + 0xC000·x/255 + y`） | 拟合脚本 `ignore/p11/b/gamma_fit.py`。`gAMA` 1.0、0.6 的 RGB 和 libpng 的 8 位表 `floor(255 · (i/255)^(1/(2.2·文件 gamma)) + 0.5)` **逐像素相同**，alpha 不动；1/2.2 与没有 `gAMA` 时不变（`|2.2·文件 gamma − 1| < 0.05` 不校正）。16 位灰度按 `floor((v − min(255, 最小值)) · 255 / (最大值 − min(255, 最小值)) + 0.5)` 拉伸，0 差；取高字节最大差 47 |

**结论：**
1. **槽 0 换图后，图层的 UV 上界与内缩按当前纹理重算。** 图层尺寸不变，`autosize` 取参考尺寸。
2. **instanced 的参考尺寸是对象 `size`。** 换图后：
   - 合成 RT 是用户纹理的尺寸；
   - `g_Color4` 在用户纹理生效时是白、回到缺省纹理时是对象色。
3. **缺省是 RT 的槽**：运行中改值时，参考尺寸取 RT 的尺寸，采样器夹取；加载时就有值则不生效（M8）。
4. **粒子精灵表**：运行中换图时帧表仍按缺省纹理，只换纹理。
5. **GIF 按帧延时随时间换帧、点采样**；视频的纹理是裁后尺寸的 RT。
6. **解码**：
   - 浏览器的 `createImageBitmap`（上面的参数）在 8 位 PNG、BMP、ICO 上和 FreeImage 逐像素相同。
   - 有两处要宿主自己补：PNG 的 `gAMA` 照 libpng 的表校正；16 位灰度按 `[min(255, 最小值), 最大值]` 拉伸，浏览器只给 8 位，补不出来。
   - JPEG 只差在色度上采样。

**和读码对照（`rea-p11b.md`）**：M1–M9 与读码逐条吻合。读码另外查明、实测没覆盖的：
- 过滤串只有 `*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4`；值是 `/` 分隔的绝对路径。
- 强制为 1 的还有 `g_Alpha`；任一槽的用户纹理生效都算，不限槽 0。
- GIF 的推进与合成规则：只在被绘制时用当帧 `g_Frametime` 推进，一帧最多前进一帧，无限循环。解码器是 stb 派生的，disposal 与背景色有怪处（背景色 R、B 互换）。
- 视频与 P9a 是同一个播放器类，裁切写在拷贝的源矩形上。
- 精灵表在加载时就是用户图时，每个粒子画整张。

## 媒体回调与封面（2026-11-13）

**工具：**
- **SMTC 夹具** `ignore/p11/smtc/fixture.ps1`：Windows PowerShell 5.1 + WinRT `MediaPlayer`，手动驱动 SMTC，不放声音。步骤表 `steps.json`（`make_steps.py` 生成），外面往 `go.txt` 写步号，它就依次应用、记 `fixture.log`；写 `quit` 退出。
  - 坑一：脚本要带 UTF-8 BOM，否则 5.1 按 ANSI 读中文注释，会把 `param` 行吞掉。
  - 坑二：变量名不分大小写，`$steps` 就是 `[string]` 参数 `$Steps`。
  - 坑三：`Genres` 是 WinRT vector，要按 `ICollection<string>` 反射调用。
- **只读探针** `probe.ps1`：列出系统的媒体会话和「当前会话」。
- **测试工程** `p11c.py` 的 `p11-media`：`LOG` 图层的脚本导出五个媒体回调与 `applyUserProperties`，每次调用写一行 `[p11m] <update 计数> <runtime> <Date.now()> <事件> <内容>`；`TH-CUR` 画 `$mediaThumbnail`（缺省 `util/clouds_256`，1:1），`TH-PREV` 画 `$mediaPreviousThumbnail`（缺省 `particle/drop`，1:4）。
- **期望值**：`ignore/p11/media_colors.py` 按读码复算五色。

**做法：** 先启动夹具并应用第 1 步，再开 WPE 测试窗口，之后逐步推进。抓帧在 `A:\p11\media`；日志存在 `ignore/p11/out/p11-media-log.txt` 和 `p11-media-fixture.log`。这台机器 `windowupdaterate` 是 1000。中途重启了一次 WPE：用户关掉之前那个实例后，由 MCP 启动；那个实例从上午 10:48 起不再写日志，也不响应开测试窗口。

| 结论 | 依据 | 结果 |
|---|---|---|
| 只有 `MediaPlaybackEvent` 是全局类，静态常量 0 / 1 / 2，其余四个事件类是 `undefined` | `init` 里的 `typeof` | 成立 |
| 加载顺序：`init` → `status {enabled: true}`（init 后补发）→ 首次 `applyUserProperties`（全集）→ 约 80 ms 后又一个 `status {enabled: true}`（子进程新拉起时的全局补发）→ 约 0.75 s 后数据到达 | 日志前 9 行 | 成立，和读码对「子进程新拉起」的预测一致 |
| 一次刷新里 播放 → 属性 → 时间轴，之后（下一条事件）`applyUserProperties({})` → `mediaThumbnailChanged` | 第 1 步的数据到达、第 7 步 | 成立 |
| 从夹具改值到回调是 0.2–0.8 s | 夹具时间戳对 `Date.now()` | 符合 1 s 刷新 + winrtutil 的 100 ms 轮询 |
| 同一个刷新间隔里改两次标题只收到最后一次 | 第 4、5 步相隔 2 ms → 只有 `P11 Delta` | 成立 |
| `position` / `duration` 截断成整秒 | 37.8 / 200.5 → 37 / 200 | 成立 |
| `state` 暂停 2、播放 1 | 第 6、7 步 | 成立 |
| `genres` 用 `,` 连接、不加空格；`contentType` 为 `"music"`；`subTitle` 为空串 | 第 1 步 | 成立 |
| 颜色是 `Vec3` 实例，值是 0–255 整数除以 255 | `instanceof Vec3`，乘 255 后都是整数 | 成立 |
| 五色算法 | m1 / m2 / m3 / m4 / m6（PNG）的主、次、第三色和黑白值都与复算逐值相同（含 m1 的 (200, 39, 39) 截断、m4 全灰时主色为黑、m6 的 alpha 0 像素不计入） | 成立 |
| 封面按槽的缺省纹理比例居中裁切 | m2（320×180）在 1:1 槽 180×180、第 122 列起变黄；m1 在 1:4 槽 45×180 | 成立 |
| `$mediaPreviousThumbnail` 是上一条封面消息的那张 | 第 2 步后 previous 是 m1 | 成立 |

**和读码不一致、以实测为准：**
1. **`textColor` 与 `highContrastColor` 的对应反了。** m5 收到 `textColor` = (101, 35, 178)（等于次色）、`highContrastColor` = 黑。拿 WPE 给的主、次、第三色照算法算：黑白值是黑，「对比度够的颜色」是次色。所以：
   - 脚本的 `highContrastColor` = 主色与黑的对比度 < 2.5 时为白、否则为黑；
   - `textColor` = 次色（对比度 ≥ 2.5 且大于第三色的）/ 第三色（≥ 2.5）/ 否则同 `highContrastColor`。
   这和 `lib.sceneScript.d.ts` 的说明一致（`textColor` 可能是次色或第三色，`highContrastColor` 只是黑或白）。读码把消息里两个值和字段名的对应标成了【推】，这里更正。
2. **应用重新设置封面时，哪怕是同一张图也会发封面消息，previous 跟着轮换。** 第 3 步重设同一张 m2 并改标题：收到 `mediaThumbnailChanged`，previous 变成 m2（1:4 槽读到蓝色）。只改标题（第 4、5 步）不发封面。读码的「字节相同不发」至少在应用重设封面时不成立。

**JPEG 封面的颜色只作参考：** m5 是平滑的色相渐变，各色相格的权重几乎相等。WPE 用 FreeImage 解码，复算用 PIL，像素差一点就选中了别的格（WPE 主色 (112, 179, 35)，复算 (36, 168, 185)）。实现时按浏览器的解码结果算，渐变类封面可能和 WPE 选的格不同。纯色块的 PNG 逐值相同。

**被打断的部分：** 第 12 步（超长标题）时，系统的当前会话换成了 Kabegame 自己的预览（`usePreviewMediaSession`，用户当时在预览一张壁纸）。WPE 随即重发了它的属性、时间轴和封面，这说明当前会话一换，WPE 就跟着换。超长字段清空、停止（state 0）、清空显示信息（`hasThumbnail: false`）、会话消失这几项没测到，以读码为准。

**对 P11c 的提示：** 场景在 Kabegame 里预览时，Kabegame 自己的媒体会话可能成为当前会话，场景会把这张壁纸的名字当成「正在播放的音乐」。2026-11-13 用户定不过滤（同 Phase 8）。

## 快捷方式

没有实测：门禁要在测试窗口里真的点鼠标，MCP 没有给 WPE 窗口发点击的工具，靠注入鼠标事件又会动用户的光标。以读码为准，P11d 动工时请用户手动点一次核对。
