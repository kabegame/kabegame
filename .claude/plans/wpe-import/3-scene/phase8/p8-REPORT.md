# P8 步骤 0 实测报告（2026-11-12）

> 上级：[P8 总计划](phase-8-image-material.md)。读码见 [rea-p8-layer.md](rea-p8-layer.md)、[rea-p8-render.md](rea-p8-render.md)。
> 本报告是 WPE 一侧的实测，没有改产品代码，Kabegame 这边没有跑。

## 结论

1. **合成 RT 的寻址只看对象的 `clampuvs`，缺省钳制。** 不写和写 `true` 都是 Clamp（同一张池化 RT），只有显式 `false` 才是 Wrap；纹理 `.tex` 的 ClampUVs 标志不参与。语料 428 处都是 `true`，所以这个键实际中性。我们现在跟着纹理标志走，纹理没有 ClampUVs 时用了 Wrap，和 WPE 不同（现在能渲染的场景里只有 `3832772446` 的一个图层是这种情况）。
2. **合成 RT 的过滤是「对象 `nointerpolation: true` 或纹理 NoInterpolation」时最近邻**，否则线性；对象写 `false` 压不过纹理标志。我们现在不看对象的键。
3. **基础纹理的采样器只看 `.tex` 标志**（ClampUVs → Clamp，否则 Wrap；NoInterpolation → Point，否则 8 倍各向异性），对象的 `clampuvs` / `nointerpolation` 对它没有作用。
4. **形状对象画的是 effect 常量 `point0`–`point3` 围成的四边形**，不是正方形：顶点 = ((u − 0.5)·W, (0.5 − v)·H)、uv = 点本身，两个三角形 (p0, p2, p1)、(p0, p3, p2)。W×H 缺省是正交高度的正方形（1080×1080），写了 `size` 就按 `size`。MVP 是普通图层的（含父链、旋转、缩放），混合 SrcAlpha / One、写掩码 RGB、不测深度。
5. **形状的几何取第一个 effect 的点，着色器用最后一个 effect，不看 effect 的 `visible`**：两个 effect 的点和 RAYMODE 都不同时，顶点是第一个的点、变体是第二个的；最后一个 effect 写死不可见照样画它，唯一的 effect 写死不可见也照样画（补测 `p8-shape2`，读码 rea-p8-layer §1）；对象写死不可见时不画。`DIRECTDRAW: 0` 被强改成 1。对象的 `alpha`、`color`、`brightness`、`clampuvs` 不进 `lightshafts` 的着色器；DIRECTDRAW 下不用的槽 0 WPE 不绑纹理。形状和同深度的普通图层吃一样的视差。
6. **对齐是模型空间里的平移**：偏移 = (±w/2, ±h/2)（`left` +、`right` −、`top` −、`bottom` +，场景 y 向上；角向取值两个分量都有），在缩放、旋转之前。有 effect 时上屏那次同样偏，画进合成 RT 的基础 pass 不偏；子层不跟父层的对齐偏移走（子层的位置只看父层的 `origin`）。8 种取值 × 普通 / 旋转缩放 / 带 effect / 带子层，共 45 个图层（含 9 个子层）、270 个顶点按这条公式预测，两帧最大差都是 1.4e-4 像素（`check_align.py`）。偏移在模型矩阵的平移里（顶点仍是居中的），和视差叠加。脚本读 `thisLayer.alignment` 得到字符串，写字符串立即读回新值；写数字 2 读回 `"center"`。
7. **被依赖的图层有独占的 RT，装的是走完 effect 链的结果**：这张 RT 就是它合成链的第 0 张，起点安排成让最后一个 pass 落在它上面（没有 effect 时就是基础 pass）。可见的话再多一次把它铺上屏的绘制；不可见（写死或绑属性当前为假）的照画进 RT、不上屏。两个引用方指向同一个图层时只画一次。
8. **`dependencies` 决定这张 RT 存不存在**：没被任何 `dependencies` 列到的隐藏图层不画；引用它、引用不存在的 id、用 `_b` 后缀，绑的都是一张 6×6 的占位纹理（见 12）。
9. **WPE 不按依赖调整绘制顺序**：被依赖者在引用方之前时，引用方读到本帧的内容；在之后时读到上一帧的（三帧连续核对，每帧都落后一帧）。
10. **`alphawriting` 的写掩码**：缺省时画到场景目标是 RGB、画进合成 RT 和 effect fbo 是 RGBA（和我们现在一致）；`enabled` 一律 RGBA；`disabled` 一律 RGB。`cursorripple` 的 `enabled` 写在 fbo pass 上，对我们来说本来就写 alpha，实际中性。
11. **`alphatocoverage`（`msaa: none`）是硬阈值**：混合关、`AlphaToCoverageEnable` 开、写掩码 RGB；alpha > 0.5 的像素整片写入，≤ 0.5 的不写（渐变条在 alpha 0.4995 / 0.5005 之间切开，对象 alpha 0.5 的最大 alpha 正好 0.5、一列都没画）。读码补充：WPE 绑定时给着色器加 `ALPHATOCOVERAGE=1`，`genericimage4` 先把 alpha 锐化成 `saturate((a − 0.5) / max(fwidth(a), 0.0001) + 0.5)`，阈值是锐化之后再过单采样 A2C 的结果。
12. **引用不到的合成 RT 绑的是 6×6 的黄黑棋盘格**（读码；实测按 6 格逐格读 B4–B6 的像素，黑黄交替，第一格黑）。

## 方法与工具

全部在 `ignore/p8/`：
- `gen_p8.py`：确定性工程，写到 `proj/`。骨架照 `ignore/p5/b0/gen_b.py`：FR、CLK 两个固定图层；测试纹理是自写的 RGBA8 `.tex`（`kbgrid0` / `kbgrid3`：64×64、四边各一色的 1 像素边框加 8 像素棋盘，标志 0 / 3；`kbmark`：四象限四色；`kbgrad`：红色、alpha 沿 x 从 0 到 255）；effect 全部自写（`kbzoom` 采样坐标绕中心放大 1.6 倍、`kbcopy`、`kbref` 显示槽 1、`kbtime` 输出本帧时间、`kbinv` 反色、`kbshowa` 把 alpha 显示成灰度），`lightshafts` 照编辑器的做法拷进工程。
- `rdc_dump_p8.py`：在 `qrenderdoc --python` 下复用 wpe-renderdoc MCP 的服务层，把每次绘制的采样器、混合（含 `AlphaToCoverage`，直接读 D3D11 输出合并状态）、深度、绑定的纹理、渲染目标、`vs_in` / `vs_out`、被读到的常量导成 `out/dump.json` / `dump2.json`，并存每次画进非后备缓冲目标之后的 PNG 与最后的后备缓冲（`out/png/`）。
- `show.py`（按绘制列状态）、`ana_align.py`（四角换回场景坐标、求对齐偏移，结果 `out/ana_align.txt`）、`check_align.py`（按公式预测全部顶点）。
- 语料：`scan_p8.py`、`sum_p8.py`、`ana_p8.py`、`rtref.py`、`rtgap.py`、`scan_texflags.py`（`out/texflags.json`，风险 1 的「`.tex` 标志 × 对象标志」分布）。

环境：WPE 2.8.42，用户设置 `fps` 20、`msaa` none、`postprocessing` disabled（只读，没改）。测试窗口 1920×1080，抓帧在 `A:\p8\<标签>\`：

| 标签 | 帧 | 内容 |
|---|---|---|
| `p8-clamp-fps20` | 193–194 | 纹理标志 0 / 3 × 对象 none / clampuvs / nointerpolation / 两者，基础纹理越界采样一行、合成 RT 越界采样一行；组合层两个 |
| `p8-clamp2-fps20` | 161–162 | 对象显式写 `false` |
| `p8-shape-fps20` | 157–158 | 形状 10 个变体 |
| `p8-align-fps20` | 138–139 | 9 种对齐 × 普通 / 旋转缩放 / 带 effect / 带子层 |
| `p8-dep-fps20` | 158–160 | 被依赖图层 8 种组合 |
| `p8-alpha-fps20` | 156–157 | `alphawriting` 三种 × fbo / 场景目标 / 合成 RT |
| `p8-a2c-fps20` | 160–161 | alpha 渐变条：alphatocoverage、translucent 对照、对象 alpha 0.5 |
| `p8-par-fps20` | 157–158 | 视差 × 形状 / 对齐；脚本改对齐 |
| `p8-dep2-fps20` | 156–157 | 依赖补测 4 种组合 |
| `p8-shape2-fps20` | 154–155 | 形状补测：两个 effect 的点与变体不同、effect 不可见 |
| `p8-misc-fps20` | 153–154 | 渲染侧补测：上屏 pass 的 `alphawriting`、带 effect 的 A2C、隐藏的组合层与画面外的图层被依赖 |
| `<ID>-fps20` | 各 1 帧 | 只差 P8 的 6 张语料场景（`3656079027`、`3668499717`、`3811764016`、`3812887609`、`3819646765`、`3821678218`），后面各步的对照真值 |

## 合成 RT 与基础纹理的采样（`p8-clamp`、`p8-clamp2`）

每个图层 200×200、纹理 64×64。第一行基础材质用自写着色器在基础 pass 里越界采样，看基础纹理的采样器；第二行 genericimage4 + `kbzoom`，看合成 RT 的采样器。读的是 RenderDoc 管线状态里槽 0 的采样器：

| 纹理标志 | 对象 | 基础纹理 | 合成 RT |
|---|---|---|---|
| 0 | 不写 | Wrap / 各向异性 | Clamp / Linear |
| 0 | `clampuvs: true` | Wrap / 各向异性 | Clamp / Linear（和上一行同一张池化 RT） |
| 0 | `nointerpolation: true` | Wrap / 各向异性 | Clamp / Point |
| 0 | 两者 true | Wrap / 各向异性 | Clamp / Point |
| 0 | `clampuvs: false` | Wrap / 各向异性 | **Wrap** / Linear |
| 0 | `nointerpolation: false` | Wrap / 各向异性 | Clamp / Linear |
| 0 | 两者 false | Wrap / 各向异性 | Wrap / Linear |
| 3 | 不写 / true（四种） | Clamp / Point | Clamp / Point |
| 3 | `clampuvs: false` | Clamp / Point | **Wrap** / Point |
| 3 | `nointerpolation: false` | Clamp / Point | Clamp / **Point** |
| 3 | 两者 false | Clamp / Point | Wrap / Point |
| 组合层 | 不写 / `clampuvs: true` | — | Clamp / Linear |
| 组合层 | `clampuvs: false` | — | Wrap / Linear |

- 合成 RT 的池化与 p2-REPORT B5 的名字 `sc.<W>.<H>.<n|b><c|r><k>` 对得上：不写和 `true` 共用一张，`nointerpolation` 的另一张，纹理标志 3 的四种都落在 `n`、`c` 那张。
- 基础纹理「各向异性」是 8 倍、mip 也是各向异性；我们的基础纹理采样器是线性。只在缩小加斜视时有差别，2D 图层 1:1 摆放时看不出来，只记。

## 形状对象（`p8-shape`）

`colorastart` 各不相同、`rayspeed` / `noiseamount` 为 0。9 次绘制：S7（写死不可见）没画，其余各一次：

| 变体 | 结果 |
|---|---|
| S1 普通，origin (480, 540) | `vs_in` 是 p0–p3 围成的四边形：p0 (0.2456, 0.0946) → (−274.75, 437.86)、p3 (0.0742, 0.95) → (−459.92, −486)，即 ((u − 0.5)·1080, (0.5 − v)·1080)；索引绘制 6 个顶点 (p0, p2, p1, p0, p3, p2)，uv 等于点本身。MVP = VP · T(origin) |
| S2 旋转 0.5、缩放 0.5×0.8 | 顶点同 S1，MVP 含旋转、缩放 |
| S3 挂在旋转过的父层下 | MVP 含父链 |
| S4 两个 effect | 只画一次，着色器是第二个（RAYMODE 1，读 `g_Feather`、`g_StartAngle`） |
| S5 第二个 effect 写死不可见 | 只画一次。两个 effect 是同一个变体、同一组点，分辨不出画的是哪个（初稿据此推成「画前一个可见的」，是错的，见补测） |
| S6 alpha 0.5、color 红、brightness 2 | 着色器不读 `g_Color4` / `g_Alpha`，画面和 S1 只差位置 |
| S8 `parallaxDepth 1 1`（视差关）、`clampuvs` | 和 S1 一样，只差位置 |
| S9 combos 写 `DIRECTDRAW: 0` | 顶点、常量和 S1 相同：被强改成 1 |
| S10 `size: 300 200` | 顶点 ((u − 0.5)·300, (0.5 − v)·200)：写了 `size` 就用它 |

补测 `p8-shape2-fps20`（154–155）：两个 effect 的点（p1 是 0.1–0.9 的方块、p2 是歪的四边形）和 RAYMODE（2、1）都不同：

| 变体 | 顶点的 uv | 着色器 |
|---|---|---|
| SA 两个都可见 | p1（第一个的） | RAYMODE 1（第二个的） |
| SB 第二个写死不可见 | p1 | RAYMODE 1：不可见的最后一个照样画 |
| SC 只有一个 effect、写死不可见 | p2 | RAYMODE 1：照样画 |

- 混合：SrcAlpha / One（additive），写掩码 RGB，深度测试关。
- 绑定：`util/noise`（256×256，标志 0 → Wrap / 各向异性）和 `gradient/gradient_iridescent`（64×2，标志 2 → Clamp / 各向异性）；DIRECTDRAW 下不采样的 `g_Texture0` 没绑。

## 对齐（`p8-align`）

图层 160×100（d 行 120×80），每行 9 种取值。四角从 `vs_out` 换回场景坐标（y 向上），和「以 origin 为中心」比：

| 取值 | 普通 / 带 effect 的中心 − origin | 旋转 0.5 + 缩放 1.5×0.75 |
|---|---|---|
| center | (0, 0) | (0, 0) |
| top | (0, −50) | (17.978, −32.909) |
| bottom | (0, 50) | (−17.979, 32.909) |
| left | (80, 0) | (105.310, 57.531) |
| right | (−80, 0) | (−105.310, −57.531) |
| topleft | (80, −50) | (123.289, 24.621) |
| topright | (−80, −50) | (−87.332, −90.440) |
| bottomleft | (80, 50) | (87.332, 90.440) |
| bottomright | (−80, 50) | (−123.289, −24.621) |

- 旋转缩放那一列等于把普通列的偏移先乘缩放 (1.5, 0.75)、再转 0.5 弧度，即偏移在模型空间、在 `S`、`R` 之前。
- 带 effect（c 行）：上屏那次的四角和普通行一样偏；基础 pass 画进 64×64 的合成 RT，顶点是 (0, 0)–(64, 64)，不偏。
- 带子层（d 行）：父层自己按规则偏（120×80 → ±60、±40）；30×30 的子层（`origin 0 0 0`）中心一律落在父层的 `origin` 上，不随父层的对齐移动。
- 偏移在模型矩阵里，不在顶点上：上屏那次的 `vs_in` 一律是居中的 ±w/2、±h/2，偏移出现在 MVP 的平移里。

补测 `p8-par-fps20`（157–158，视差开、amount 1、mouseinfluence 1、delay 0；光标在哪无所谓，只比同深度的对象）：

| 对象 | MVP 平移 | 说明 |
|---|---|---|
| L1 居中、深度 1，origin (480, 700) | (−2.0, 1.5537) | 光标离中心远，视差平移很大 |
| S 形状、深度 1、同一 origin | (−2.0, 1.5537) | 和 L1 完全相同：形状照常吃视差 |
| L2 居中、深度 1，origin (1440, 700) | (1.2e-7, 1.5537) | |
| A `top`、深度 1、同一 origin | (1.2e-7, 1.4611) | 比 L2 在 y 上少 0.0926 = 50 / 540：对齐偏移和视差叠加 |
| D `top`、深度 0，origin (1440, 400) | (0.5, −0.3519) | 只有对齐偏移：(350 − 540) / 540 |
| T `top`，脚本改对齐 | (0, −0.4444) | 见下 |

- 脚本（挂在 T 的 `origin` 上）：第 5 帧读 `thisLayer.alignment` 得到字符串 `"top"`，写 `"bottomright"` 后立即读回 `"bottomright"`；第 8 帧写数字 2，读回字符串 `"center"`，抓帧里 T 也是居中的。数字怎么映射见读码。

## 图层依赖（`p8-dep`）

引用方 B 是白色纯色层 + `kbref`（槽 1 指向被引用者的 `_rt_imageLayerComposite_<id>_a`）。按绘制顺序：

| 组合 | 被引用者 A 的绘制 | B 槽 1 绑的 | B 显示 |
|---|---|---|---|
| 1 A 写死隐藏、无 effect、在 B 前、列在 `dependencies` | 基础 pass 画进 A 独占的 64×64 RT，不上屏 | A 的 RT | `kbmark`（左上角红） |
| 2 A 可见、`kbtime`、在 B 前 | 基础 pass → 池化 RT；`kbtime` → A 独占 RT；再一次把独占 RT 铺上屏 | A 的独占 RT | 本帧时间 |
| 3 A 写死隐藏、`kbtime`、在 B 后 | 同 2，但不上屏 | A 的独占 RT（本帧还没画） | **上一帧**的时间（158 / 159 / 160 三帧都落后一帧） |
| 4 B 不写 `dependencies` | A 不画 | 6×6 占位纹理（Wrap / Point） | 黄黑棋盘格 |
| 5 引用不存在的 id | — | 6×6 占位纹理 | 黄黑棋盘格 |
| 6 `_b` 后缀 | — | 6×6 占位纹理 | 黄黑棋盘格 |
| 7 A 是组合层（可见、无 effect） | 基础 pass 拷背景进 A 的 200×200 RT，再上屏 | A 的 RT | A 那块背景（黑） |
| 8 A 写死隐藏、`kbinv` | 基础 pass → 池化 RT；`kbinv` → A 独占 RT，不上屏 | A 的独占 RT | 反色的 `kbmark`（左上角青） |

- 占位纹理每个引用各一张（三个不同的资源），都是 6×6。

补测 `p8-dep2-fps20`（156–157）：

| 组合 | 被引用者 A 的绘制 | B 显示 |
|---|---|---|
| 9 A 可见、无 effect | 基础 pass 画进 A 独占的 RT，再一次铺上屏（共 2 次） | `kbmark` |
| 10 A 的可见性绑用户属性（当前 false）、`kbtime` | 同写死隐藏：基础 pass → 池化 RT，`kbtime` → 独占 RT，不上屏 | 本帧时间 |
| 11 A 写死隐藏、两个 effect（`kbinv`、`kbtime`） | 基础 pass → **独占 RT**，`kbinv` → 池化 RT，`kbtime` → 独占 RT | 本帧时间 |
| 12 两个引用方指向同一个 A | A 只画一次，两边绑同一张 | 都是 `kbmark` |

- 独占 RT 就是这个图层合成链的第 0 张（p2-REPORT B5 的 `_rt_imageLayerComposite_<id>_a`），另一张从池里借；起点安排成让最后一个 pass 落在独占 RT 上：0 个 effect 基础 pass 写它，1 个 effect 由 effect 写它，2 个 effect 基础 pass 和第二个 effect 写它。

## 写入状态（`p8-alpha`、`p8-a2c`）

`alphawriting` 读的是每次绘制的写掩码（1–15，15 = RGBA）：

| | 画到场景目标 | 画进合成 RT（基础 pass） | 画进 effect fbo |
|---|---|---|---|
| 缺省 | 7 | 15 | 15 |
| `enabled` | 15（后备缓冲 alpha 读到 76 = 0.3） | 15 | 15 |
| `disabled` | 7 | 7（RT 里留着上一个用这张池化 RT 的图层的 alpha） | 7 |

- 我自写的 fbo pass 顶点乘了 MVP（中间 pass 应该直接用 NDC 四边形，WPE 的 `cursorripple_apply_force.vert` 就是 `gl_Position = vec4(a_Position, 1.0)`），所以 fbo 里没有像素；写掩码从管线状态读，不受影响。

`alphatocoverage`：

| 条 | 混合 | A2C | 写掩码 | 结果（1024 列，纹理 256 列线性放大） |
|---|---|---|---|---|
| alphatocoverage | 关 | 开 | 7 | 前 512 列不画，第 512 列起纯红 |
| translucent 对照 | SrcAlpha / InvSrcAlpha | 关 | 7 | 256 级渐变 |
| alphatocoverage + 对象 alpha 0.5 | 关 | 开 | 7 | 一列都没画 |

- 第 511、512 列的 alpha 按线性插值是 0.4995、0.5005，所以切在 0.5；对象 alpha 0.5 时最大 alpha 正好 0.5 也不画，所以是 alpha > 0.5 才写。这是本机（NVIDIA）单采样下的行为，驱动不同可能不同。
- 读码（rea-p8-render 第 5 节）：绑定时另加 `ALPHATOCOVERAGE=1`，`genericimage4` 把 alpha 锐化成以 0.5 为中心的阶跃（`saturate((a − 0.5) / max(fwidth(a), 0.0001) + 0.5)`，GLSL 分支再 `a < 0.5` 就 discard）。锐化后 0.4995 → 0、0.5005 → 1，对象 alpha 0.5 的那条锐化后最大正好 0.5，和实测吻合。我们照抄宏、在着色器里按「锐化后 > 0.5」丢弃片元即可，阈值上的等号只在 alpha 恰为 0.5 时有区别。

## 渲染侧补测（`p8-misc`）

| 对象 | 预测（rea-p8-render §6） | 实测 |
|---|---|---|
| W1：effect 的上屏 pass 材质写 `alphawriting: enabled` | 15：上屏那次写掩码仍是 7 | 7 |
| W2：`alphatocoverage` 图层带 `kbcopy` | 22：基础 pass A2C 关、写掩码 15；上屏 pass A2C 开 | 基础 pass A2C 关、混合关、写掩码 15；上屏 pass A2C 开、混合关、写掩码 7 |
| A13：写死隐藏的组合层被依赖 | 6：拷快照、画进它的 RT，不上屏 | 从 1920×1080 快照画进 200×200 的 RT，没有上屏的绘制 |
| A14：写死隐藏、放在 (−5000, −5000) 被依赖 | 7：不做视锥剔除，照画进 RT | 照画 |

## 读码与实测的对照

两份读码（rea-p8-layer、rea-p8-render）的结论，实测覆盖到的全部吻合：

| 读码结论 | 实测 |
|---|---|
| 形状的四点四边形、索引 (0, 2, 1, 0, 3, 2)、`size` 缺省正交高 × 正交高 | `p8-shape` S1、S10 |
| 形状的几何取第一个 effect，画最后一个 effect，不看 effect 的 `visible` | `p8-shape2` |
| 形状的 MVP 含父链、视差，不读对象的颜色 | `p8-shape` S2、S3、S6，`p8-par` S |
| 对齐的 9 个枚举（center 0、top 1、topright 2、right 3、bottomright 4、bottom 5、bottomleft 6、left 7、topleft 8），偏移 ±w/2、±h/2 在缩放旋转之前，子层不带父层的偏移 | `p8-align` 270 个顶点 |
| 不是字符串的对齐按 `center` | `p8-par` T：写数字 2 读回 `"center"` |
| `clampuvs` 缺省为真，合成 RT 只按它选寻址；过滤 = 对象 `nointerpolation` 或纹理 NoInterpolation；基础纹理只看 `.tex` 标志，非点采样时 8 倍各向异性 | `p8-clamp`、`p8-clamp2` |
| `dependencies` 给被引用的图层置 `0x1010`：强制走合成路径、建独占 RT、不可见也画、不做视锥剔除；不改绘制顺序 | `p8-dep`、`p8-dep2`、`p8-misc` |
| 独占 RT 是合成链的第 0 张，最后一个 pass 落在它上面；可见时多一次铺上屏 | `p8-dep2` A11、A9 |
| `_b` 不存在；引用不到时绑 6×6 黄黑棋盘格 | `p8-dep` B4–B6 |
| `alphawriting` 缺省时场景目标 7、合成路径 15；`enabled` (1, 1)、`disabled` (1, 0)；上屏的最后一个 effect pass 不受它影响 | `p8-alpha`、`p8-misc` W1 |
| A2C：混合关、`AlphaToCoverageEnable` 开；画进合成 RT 的基础 pass 关掉 A2C | `p8-a2c`、`p8-misc` W2 |

推翻的旧结论：
- sample-gaps §2.1「形状是边长等于正交高度的正方形」：那只是找不到四个点时的退路，语料 24 个形状都写了点。
- rea-p4a「图像层没有读 `alignment`」：它在模型 JSON 的解析段里找，`alignment` 是对象键、走通用属性表；rea-p5-modelflags 是对的。
- 总计划「风险 1」的前提「`clampuvs` 缺省 false = 重复」：缺省是钳制，风险的方向反了，实际受影响的只是「纹理没有 ClampUVs」的图层（现在能渲染的 1 个）。
- 本报告初稿的「形状最后一个 effect 不可见时画前一个」：S5 分辨不出，补测推翻。

实测没覆盖、只按读码记的：自引用时 `bind` 胜出（静态确认）；被依赖图层的 effect 可见性切换时 RT 销毁重建、新 RT 不清；`msaa` x2 下的 A2C；被依赖的是文本层；形状挂多 pass 的 effect 时非末 pass 解引用空指针（不测，可能让 WPE 崩溃）；透视场景里的形状（语料 0 张）。

## 对各步的影响

- **步骤 1（合成 RT 的采样）**：合成 RT 的寻址 = 对象 `clampuvs` 不为 `false` 时钳制；过滤 = 对象 `nointerpolation: true` 或基础纹理 NoInterpolation 时最近邻。`clampuvs: true` 中性，能力表不再报；`false` 也照规则实现（语料 0 个）。基础纹理的采样器不变（各向异性只记不补）。现在能渲染的 `3832772446` 有一个图层会从重复变成钳制，用 `kbp regress --corpus` 和它的整帧比较兜住。解锁 `2981249186`、`3637191856`、`3668499717`。文本对象（P6b）同一条规则。
- **步骤 2（形状）**：
  - 几何：第一个 effect 第一个 pass 的 `point0`–`point3`（材质常量，含实例覆盖），顶点 `(Sx·p.x − Sx/2, Sy·(1 − p.y) − Sy/2, 0)`、uv = p、索引 (0, 2, 1, 0, 3, 2)；`Sx×Sy` 是 `size`，缺省正交高 × 正交高；四个点找不到时退回以原点为中心的方块。
  - 绘制：最后一个 effect 的 pass，不看 effect 的 `visible`；强制 `DIRECTDRAW = 1`、最后一个 pass 强制 additive；没有基础纹理和合成 RT，`previous` 的 bind 跳过；画到当前目标（父对象是组合层时画进它的合成 RT）。
  - 矩阵：MVP = 场景 VP · 视差（根对象）· W（不带对齐）；效果矩阵按读码（单位阵、`g_EffectTextureProjectionMatrix = diag(Sx/2, Sy/2, 1, 1)`）。
  - 中性的对象键：`alpha`、`color`、`brightness`、`colorBlendMode`、`clampuvs`、`nointerpolation`、`castshadow`、`disablepropagation`；照报：多 pass 的 effect、透视场景（语料都是 0 个）。
  - 解锁 `3811764016`、`3812887609`、`3819646765`、`3821678218`，加上步骤 1 后还有 `3656079027`；对照真值是 `A:\p8\<ID>-fps20`。
- **步骤 3（对齐）**：
  - 模型矩阵在本地矩阵之后右乘 `T(offset)`，offset = (±trunc(w)/2, ±trunc(h)/2)；作用到上屏的模型矩阵、效果矩阵与 `g_LayerModelMatrix`、组合层画子层时的裁剪窗口、图像层 `perspective`、命中测试；不作用到子层、视差、画进合成 RT 的基础 pass。
  - 不是字符串（含 `{user, value}`）按 `center`。
  - 脚本 `layer.alignment` 能读写（字符串、写入立即重建），归 P8（语料 3 张，都写在图像层上；原先算在 P6）。
  - 顺带：WPE 的四边形边长按 `trunc(size)`，我们用浮点（语料只有 `3351163962` 的 4 个图层是 819.2）。
  - 解锁 `3812487163`。
- **步骤 4（图层依赖）**：
  - 加载时收集全部对象（含模型对象）的 `dependencies`，给被指向的图像层（与文本层，P6b）标「被依赖」：强制走合成路径、合成链第 0 张换成独占 RT、不可见也画（只进 RT、不上屏）、可见时最后多一次铺上屏（基础材质的混合、写掩码 7）、不做视锥剔除。
  - 起点按 effect 数的奇偶安排，让最后一个 pass 落在独占 RT 上。
  - 材质里的 `_rt_imageLayerComposite_<id>_a` 在加载时按名字解析到这张 RT；解析不到（没被依赖、id 不存在、`_b`）绑 6×6 黄黑棋盘格（点采样、重复）。
  - 不改绘制顺序：被依赖者在后面时引用方读上一帧，独占 RT 要跨帧保留。
  - 和 `buildableLayers` 的「写死不可见不建资源」冲突：被依赖的图层要例外。
- **步骤 5（写入状态）**：
  - `alphawriting`：缺省维持现状；`enabled` 时画到场景目标也写 alpha；`disabled` 时合成 RT 与 fbo 也不写 alpha；上屏的最后一个 effect pass 不受它影响。`cursorripple` 的 `enabled` 在 fbo 上，结果和现在相同。
  - `alphatocoverage`：混合关、写掩码同 `normal`，着色器加 `ALPHATOCOVERAGE=1`（`genericimage4` 自带锐化），画到场景目标时在着色器里丢弃锐化后 alpha ≤ 0.5 的片元（WebGPU 的 alpha-to-coverage 只在多重采样目标上可用）；画进合成 RT 的基础 pass 不丢弃、写 RGBA。`msaa` x2 只记不补。
