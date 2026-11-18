# P5g：文本对象的 `perspective: true`

> 起因（2026-11-18，wpe p6 d/e 的语料清扫转来，用户让转给 P5）：文本对象上的 JSON `"perspective": true` 报 `object:perspective`
> （`compile/features.ts` 只对图像层与模型放行），挡住 2 张：`3841256486`（myprojects，只差这个键）、`3348595482`（工坊，另有翻译器的
> `float2` 解析问题，不归本步）。组合层上的 `perspective`（`bundle.ts` 的 passthrough + perspective）仍是语料 0 个，不在本步。

## 总体设计思路

文本层是图像层的子类，绘制走同一个基类函数 `FUN_1401e8aa0`（rea-p6b-layout 虚表：`+0x50` 用基类）。那个函数在直接上屏分支里，
对 `+0x120 & 0x80`（`perspective`）的图层先压一份透视相机（`0x1401e9233` 判位、`0x1401e92b3` 调 `FUN_1401e5b60`），再调虚函数
`+0xf0` 画；文本的 `+0xf0` 就是「直接上屏」（`0x140258050`：背景、字形、彩色字形）。合成路径的上屏（末 pass、passthrough）也在同一个
基类里压透视相机（`0x1401e9eb3`）。所以文本层开 `perspective` 的规则和 P5b 的图像层完全一样：**画到场景目标的绘制换成透视粒子那一份
视图投影，画进合成 RT 的不变**。

画面和图像层看起来很不一样（步骤 0 实测：直接上屏的文本被压成一条线，走合成的只是斜切），原因在着色器：文本字形与背景的顶点着色器
（`basefont` 一族）把顶点当二维点 `(x, y, 1)`、只取 MVP 的 x、y、w 三列（RenderDoc 反汇编：`dp3 … g_ModelViewProjectionMatrix[i].xywx`），
丢掉了 z 列。绕 x 轴转的文本在透视相机下，局部 y 的贡献有一部分进 z、一部分进 w，丢掉 z 后就塌成一条线。末 pass / passthrough
用的是 effect / passthrough 材质，四维全乘，看起来是正常的透视梯形。我们的文本着色器就是同一份 WPESL 翻译来的，MVP 一样，画面就一样，
不用另做什么。

所以改动只有三处：编译期给文本层设 `layer.perspective`（只认 JSON true，同图像层）；能力表放行文本；渲染器给文本「直接上屏」的绘制
传透视那份视图投影（末 pass、passthrough 上屏本来就走图像层那段 `!!layer.perspective && step.target.kind === "scene"`）。光标命中
（`render/cursor.ts` 的 `pickable.perspective` 读 `layer.perspective`）、反射名单（`reflection:planar:perspective`）、组里照报
（`groupChildIssues` 的 `…:perspective`）都按 `layer.perspective` 走，文本层自动跟上。

## 步骤 0 结果（2026-11-18）

工程 `ignore/p5/proj/p5g-a`、`p5g-par`（生成器 `ignore/p5/g/gen_g.py`），WPE 1920×1080 各抓 1 帧（`A:\p5g\a2\`、`A:\p5g\par\`），上屏帧
`ignore/p5/g/wpe/wpe-a-f197.png`、`wpe-par-f183.png`。全部文本绕 x 轴转 −0.9 弧度、`pointsize` 16：

| 对象 | 用法 | WPE 画面 |
|---|---|---|
| T1 | 直接上屏，无背景，`perspective: true` | 压成一条线 |
| T2 | 直接上屏，`opaquebackground` | 背景与字都压成细条 |
| T3 | 带 effect（合成路径，末 pass 上屏） | 斜切的透视 |
| T4 | colorBlendMode 2（passthrough 上屏） | 同 T3，按混合模式变暗 |
| T5 | 同 T1，`perspective: false` | 正交（对照） |
| PI | 图像层 `perspective: true`（P5b 已实现） | 透视梯形（对照） |

`p5g-par` 同 `p5g-a`，开相机视差（mouseinfluence 0，视差点恒在中心）。

RenderDoc（`a2-frame196.rdc`）：T1 字形（事件 61）的 MVP 与 `vs_out` 已取（w 随顶点 y 变，确认是透视），着色器只用 MVP 的 xyw 三列。

## 点 1 — 编译期（`compile/bundle.ts`、`compile/features.ts`）

- **修改**
  - 文本对象（`isTextObject`）建图层时设 `layer.perspective = object.perspective === true`（同图像层 `compileImageModel` 那一行）。
  - `features.ts` 的放行条件加 `text`：
```ts
  // 图像层（P5b 步骤 1）、模型（P5c 步骤 1）与文本层（P5g）的 perspective：JSON true 已实现；绑属性、挂脚本或别的取值，以及别的对象上为真，照报
  if (active(object.perspective) && !((kind === "image" || kind === "model" || kind === "text") && object.perspective === true))
    unsupported.add("object:perspective");
```
  - 相关注释（`SceneLayer.perspective` 的文档「只在图像层上」、`compileShape` 旁那句「只认图像层与模型」若涉及文本）同步。

## 点 2 — 渲染器（`render/scene.ts`）

- **修改**：`step.kind === "text"` 那一支的视图投影：
```ts
        // 直接上屏（`text` 步骤画到场景）：`perspective: true` 换透视那一份（P5g，同图像层，`FUN_1401e8aa0` 的 `0x1401e92b3`）；画进合成 RT 的
        // 字形用 RT 像素的正交（`textMatrices` 不读它）
        viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, !!layer.perspective),
```
  > 说明：看 `textMatrices`（`render/uniforms.ts`）确认合成路径的字形不读传入的 `viewProjection`；若读，就改成只在 `space === "direct"` 时换透视。
  > 不改 `textMatrices`（P6e 的文本 anchor 也要动它）。

## 点 3 — 测试

- `compile` 的能力表单测：文本对象 `perspective: true` 不再报键、`layer.perspective` 为真；绑属性 / 非 true 照报；组合层上为真照报（不变）。
- 渲染 uniform 的单测（文本直接上屏的 MVP）：`perspective` 时用 `perspectiveViewProjection`、否则场景那份；合成路径的字形不受影响；末 pass 已有图像层的用例，文本层补一例。
- 只跑相关测试文件。

## 点 4 — 文档

`cocs/wpe/WPE_SCENE.md`（P5b「透视图层」一行、能力表 332 行附近「图像层与模型之外的对象」、新增「文本层的 perspective（P5g）」一节放步骤 0 的表）、`cocs/README.md`、changelog、regression。

## 验收

- tsc、相关测试；变异（不设文本的 `perspective`、直接上屏不换透视、能力表不放行）。
- `p5g-a`、`p5g-par` 导入 dev，`render_scene` 1920×1080 与 WPE 上屏帧逐像素比（屏蔽 FR / CLK）。
- 语料：`3841256486` 变干净，`3348595482` 只剩翻译器那一项；别的场景键不变。

## 合并注意

`render/scene.ts` 有别的会话未提交的改动，提交时按块挑；`render/uniforms.ts` 的 `textMatrices` P6e 也要改，本步不碰它。

## 实施记录（2026-11-18）

**实现**（执行代理按点 1–3，验收由我做）：`compile/bundle.ts` 在文本对象建图层处设 `layer.perspective = object.perspective === true`；
`compile/features.ts` 放行 `kind === "text"`；`render/scene.ts` 的 `text` 步骤传 `viewProjectionOf(…, !!layer.perspective)`。`textMatrices` 没动
（合成分支不读传入的视图投影，`mulAffine` 只要求模型矩阵仿射，透视的视图投影照常可用）。

**测试**：`compile/texts.test.ts` 两例（能力表、编译取值）；`render/text.test.ts` 一例（假设备核对直接上屏字形与背景的 MVP 用透视那份、
不开时用场景那份、合成路径字形不受影响）。

**验收**
- tsc 0 错；相关 10 个测试文件 326 passed / 14 skipped。
- 变异（`ignore/p5/g/mutate_g.py`）：不设文本的 `perspective`、能力表不放行、直接上屏不换透视，3 处全部检出。
- 和 WPE 整帧对照（`render_scene` 1920×1080，`kbp cmp frame --kbp-layers`）：`p5g-a`、`p5g-par` 0 差。宿主产物 `index-Bq9rUc4_.js`（含别的会话未提交的改动）。
- 语料（`ignore/p5/g/corpus-two.json` 对 wpe p6 d/e 的 `ignore/p6/e0/corpus-now3.json`）：`3841256486` 干净，`3348595482` 只剩翻译器的 `float2`；
  重叠的场景里本步只去掉这 2 张的 `object:perspective`，没有新增的键（另外去掉的 `getTextureAnimation`、聚光阴影来自工作区里 P6e、P13i 未提交的改动）。
- 顺带看到 `3808922316` 报 `script:api:layer.perspective`（脚本读写图层的 `perspective`），不在本步。
