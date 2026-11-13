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
