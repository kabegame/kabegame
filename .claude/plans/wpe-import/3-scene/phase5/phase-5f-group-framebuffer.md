# P5f：组里的子孙读 `_rt_FullFrameBuffer`

> 起因（2026-11-17，用户）：dev 库图片 14292（工坊 `3465215190`）退回预览图，日志
> `场景壁纸 14292 退回预览图： model:passthrough:children:framebuffer`。它只差这一个键：组合层「路面雨滴」（id 2481，
> `composelayer`，1960×600）下面两个 `Rain_Splash` 粒子的材质 `halo_1_1` 开了 `REFRACT`，要读快照。
> P5b 步骤 4 把「组里读快照」照报了（`groupChildIssues`），理由是没有实测、读码推断 WPE 读的是组开始时那份。
> 语料（`ignore/p13/f/corpus-f2.json`，233 张）里带这个键的 3 张：`3465215190`、`3233141951` 只差它，`3524852519` 还差别的。

## 总体设计思路

WPE 的「拷快照」是一个函数（`_rt_FullFrameBuffer` 的虚函数 `+8`）：把**当前绑定的渲染目标**拷进 `_rt_FullFrameBuffer`。在顶层，
当前目标就是场景目标，整张拷；在组里画子孙时，当前目标是组的合成 RT。组的合成 RT 和快照尺寸不同，驱动只拷两者重叠的
**左上角** `min(宽) × min(高)`，快照其余部分保持上一次拷贝的内容（步骤 0 实测，见下）。读快照的着色器照常按 `gl_Position`
算屏幕坐标，而组里的投影是组的局部正交，所以它们按「组矩形 = 整个 0–1」去采整张 1920×1080 的快照：组 RT 的内容只占
左上角那一块，其余采到的是组开始前（或更早）拍下的场景。画面看起来「不对」，但这是 WPE 的确定行为，语料场景是在这种行为下调出来的。

三个拷贝点在组里的表现不同（读码 + 实测）：
- **层首拷贝**（基础材质读快照或 colorBlendMode 混合）只看**直接父对象**是不是组合层（`+0x180` 父指针、`+0x120 & 4`），是就不拷；
  组里隔着分组节点的孙子层照拷，拷的是组 RT；
- **effect 前拷贝**、**粒子前拷贝**不看父对象，组里照拷，拷组 RT；
- **上屏**（passthrough / 组的上屏）**不拷**：读码这一段没有拷贝调用。顶层的混合层由层首拷贝管着，不受影响。

所以要做的事很小：编译期不再报这个键；计划里层首拷贝对「直接父是组」的图层跳过、组里的上屏不拷；渲染器执行快照时拷
**当前目标**（组里是组的合成 RT，`copyTextureToTexture` 到快照的 (0, 0)，尺寸取两者较小），不再一律拷场景目标。
着色器、uniform、组的局部正交都不动：读快照的子孙按局部正交算出来的屏幕坐标，和 WPE 一样。

关键决策：
- **照 NVIDIA 驱动的行为做。** WPE 用 `ResolveSubresource` 拷（两边都不是 MSAA、尺寸也不同，按 D3D11 规范这次调用不合法），
  这台机器（NVIDIA）上真实窗口画面与 RenderDoc 回放逐像素相同，结果就是「拷左上角重叠部分」。别的驱动上 WPE 自己可能就不一样，
  我们不去模拟，记为已知差异来源。
- **快照仍是全场一张。** 组里的拷贝改写的就是这张，之后顶层再拷会整张覆盖，和 WPE 一样；不另开「组快照」。
- **「每层至多拷一次」保留。** WPE 的 effect 前拷贝标志在 effect 循环开始时清 0，层首拷过之后 effect 前会再拷一次；但两次之间
  当前目标不被本层改动（本层画在自己的合成 RT 里），拷到的内容相同，画面等价，不复刻这次多余的拷贝。
- **结构变化要能重排。** 「直接父是不是组」随 `setParent` 变（组内换到分组节点下面，组归属不变），登记表的位置派生量
  （`structureKey`）把它算进去，代替原来「带 `GROUP_CHILD_FRAMEBUFFER` 的 effect 下标」那一项。

## 步骤 0 结果（2026-11-17）

工程 `ignore/p5/proj/p5f-{a,b,c,d,e}`（生成器 `ignore/p5/f/gen_f.py`），WPE 1920×1080 各抓 1 帧，`A:\p5f\<变体>\`，
上屏帧 `ignore/p5/f/wpe/wpe-<变体>-f<帧号>.png`（`kbp rdc frame --present`）。背景 kbbg（r、g 坐标渐变，b 32 像素棋盘）。

| 工程 | 组 | 子层 |
|---|---|---|
| p5f-a | 900×500，居中 | S 绿方块 → FB（基础材质 `kbfb` 按屏幕坐标采快照）→ FX（effect `kbfbfx`：0.5·上一张 + 0.5·快照）→ P（静止 `REFRACT` 粒子，不绑法线）→ CB（红方块 colorBlendMode 2） |
| p5f-b | 同 a，`copybackground: false` | 同 a |
| p5f-c | 1920×1080，居中（与场景同尺寸） | 同 a |
| p5f-d | 同 a，转 0.3 弧度 | 同 a |
| p5f-e | 2400×600（比屏幕宽） | S → 分组节点 N（孙子 FBg 读快照）→ 嵌套组 I（里面 FBi）→ P |

顶层：BG → M（品红，组外）→ TF（读快照）→ 组 → TA（读快照）。

**实测（p5f-a，事件号是 `a-frame220.rdc` 的）**

| 项 | 结果 |
|---|---|
| 组开始 | Resolve 79：场景目标 → 快照（组的 composelayer 材质读快照，组在顶层） |
| FB（基础 pass 读快照，直接父是组） | 没有拷贝；采到的是组开始那份，按局部正交的 UV 采整张（FB 里看到的是屏幕 x 299–853、y 194–626 那一块，带品红 M 的一角） |
| FX（effect 读快照） | effect 之前 Resolve 144；拷后快照（`fb-e145`）= 组 RT 900×500 贴在左上角，其余与拷前相同 |
| P（REFRACT） | 画之前 Resolve 164，同上 |
| CB（cbm 2） | 层首、上屏都没有拷贝；passthrough 上屏（220）的槽 1 是快照（读到 164 之后的那份） |
| 组的上屏 241 → 组后 TA | Resolve 243 拷场景目标，正常 |
| 真实画面 | 测试窗口 `kbp sample grab` 与回放的上屏帧，除左上角 RenderDoc 提示文字外逐像素相同：「贴左上角」是驱动的真实行为，不是回放假象 |

**实测（p5f-e，`e-frame188.rdc`）**：S 之后、FBg 之前有 Resolve 96（FBg 的直接父是分组节点 N，层首照拷）；拷后快照的左上
1920×600 与组 RT（2400×600）的左上同尺寸块逐像素相同（RGBA 都比），其余与拷前相同（`ignore/p5/f/topleft.py`）。嵌套组 I 与
FBi 都没有拷贝；I 的 composelayer 采到的是 96 改过的快照。

**读码**（`ignore/p4/rea/wp.asm`，`FUN_1401e8aa0`）：
- 层首 `0x1401e8f63`：`cl`（材质要快照或 cbm ∉ {0, 31}）且 fullscreen 条件之后，`rbx+0x180`（父）非空且 `父+0x120 & 4` 时跳过；
- effect 前 `0x1401e9b12`：标志 `[rsp+0x170]` 在 effect 循环前清 0（`0x1401e9a25`），某 effect 的标志 bit1（要快照）且本层 effect
  前还没拷过就拷，**不看父**；
- 末 pass `0x1401ea0dd`：同 effect 前的标志（末 pass 属于最后一个 effect，已被 effect 前那次覆盖）；
- passthrough 上屏 `0x1401ea06d` 起：没有拷贝调用；
- 粒子 `FUN_1402366f0`（`0x140236819`）：每对象一次，不看父（rea-p4b-render 6.1）。

## 现状锚点

**a. 编译期照报**（`compile/features.ts` 的 `groupChildIssues`）
```ts
  const framebuffer =
    (!layer.passthroughModel && layer.passes.some((pass) => pass.framebuffer)) ||
    !!layer.text?.clearAlphaPass?.framebuffer ||
    layer.effects.some((effect) => effect.enabled && effectNeedsFramebuffer(effect)) ||
    (cbm !== 0 && cbm !== 31) ||
    (!!layer.particle && someParticleSystem(layer.particle, (system) => system.passes.some((pass) => pass.framebuffer)));
  if (framebuffer) keys.push(GROUP_CHILD_FRAMEBUFFER);   // 现状：组里读快照一律照报
```
`compile/bundle.ts` 的 `applyGroupRules` 另把「关着、运行时可能打开、读快照」的 effect 记上 `GROUP_CHILD_FRAMEBUFFER`（打开时整场重编译），
不在组里时去掉；`compile/fragment.ts` 切片时去掉它；`compile/registry.ts` 的 `structureKey` 把带它的 effect 下标算进位置派生量。

**b. 计划里的拷贝点**（`render/graph.ts` 的 `planLayer`）
```ts
    // 规则 1：基础材质需要帧缓冲
    if (base.framebuffer) snapshot();                       // 直接上屏路径，现状：不看父
  ...
  // 规则 1：基础材质需要帧缓冲，或 colorBlendMode 混合
  if (base.framebuffer || passthrough) snapshot();          // 合成路径，现状：不看父
  ...
      if (pass.framebuffer) snapshot();                     // 文本层 composelayer_clearalpha，现状：不看父
  ...
      if (pass.framebuffer) snapshot();                     // passthrough 上屏前，现状：照拷
  ...
      if (pass.framebuffer) snapshot();                     // 组的上屏（groupUpload）前，现状：照拷
```

**c. 执行快照**（`render/scene.ts` 的 `encode`）
```ts
    const snapshot = () => {
      if (this.snapshot)
        encoder.copyTextureToTexture(
          { texture: sceneTexture },                        // 现状：一律拷场景目标
          { texture: this.snapshot.texture },
          { width: this.width, height: this.height },
        );
    };
  ...
    const runOps = (ops: readonly Op[], sceneTarget: GPUTextureView = sceneView) => {
        ...
        } else if (op.kind === "snapshot") {
          // 组里（P5b 步骤 4）也拷真正的场景目标：组里的绘制都不落在它上面，拍到的就是组开始时那份
          if (!started) begin();
          end();
          snapshot();
        } else if (op.kind === "particle-tree") {
          for (const item of arranged(op.tree)) {
            if (item !== "snapshot") draw(begin(sceneTarget), item);
            else { if (!started) begin(); end(); snapshot(); }   // 现状：同上
          }
        ...
        } else if (op.kind === "subtree") {
          ...
          for (const object of op.layer.subtree) {
            const child = this.runtimeByObject.get(object);
            if (child) runLayer(child, target.view);            // 现状：只传 view，执行快照时拿不到组 RT 的纹理
          }
```

## 点 1 — 编译期不再报（`compile/features.ts`、`compile/bundle.ts`、`compile/fragment.ts`、`compile/registry.ts`）

- **删除**
  - `GROUP_CHILD_FRAMEBUFFER` 常量与 `groupChildIssues` 里的 `framebuffer` 判断（`groupChildIssues` 只剩 fullscreen / perspective / sprite / model / shape）。
  - `applyGroupRules` 里给关着的 effect 记 / 去这个键的两段；`fragment.ts` 切片时去这个键的一段（`fragmentOf` 不再特别处理 effect 的 `unsupported`）。
- **修改**
  - `registry.ts` 的 `structureKey`：`marks` 一项换成「直接父是组」（`layer.group !== null && layer.parent === layer.group`）。
    > 说明：组内换父（直接挂组 ↔ 挂在分组节点下）时组归属、层数都不变，但层首拷贝变了，要重排。
  - 各处注释（`features.ts` 的 `groupChildIssues` 文档、`effectNeedsFramebuffer` 的用途、`bundle.ts` 的 `applyGroupRules`、`fragment.ts`、`registry.ts`、`state.ts` 的 `syncEffectSupport`）同步。
```ts
// registry.ts
function structureKey(layer: SceneLayer, byObject: ReadonlyMap<number, SceneLayer>): string {
  ...
  // 修改：原来是带 GROUP_CHILD_FRAMEBUFFER 的 effect 下标（P5f 起没有这个键）
  const directGroupChild = layer.group != null && layer.parent === layer.group;
  return JSON.stringify([layer.group ?? null, depth, layer.subtree ?? [], attachment, directGroupChild]);
}
```

## 点 2 — 计划里的拷贝点（`render/graph.ts`）

- **新增**
```ts
/**
 * 直接父对象是组（P5f）：WPE 的层首拷贝只看直接父是不是组合层（`FUN_1401e8aa0` 的 `0x1401e8f63`：`+0x180` 父、`+0x120 & 4`），是就不拷；
 * 组里隔着分组节点的孙子层照拷（拷组的合成 RT，`p5f-e`）。
 */
export function isDirectGroupChild(layer: Pick<SceneLayer, "group" | "parent">): boolean {
  return layer.group != null && layer.parent === layer.group;
}
```
- **修改**
  - 三处层首拷贝（直接上屏、合成路径、文本层 `clearAlphaPass`）在 `isDirectGroupChild(layer)` 时不拷。
  - 两处上屏前的拷贝（passthrough、`groupUpload`）在 `layer.group != null`（在组里）时不拷；顶层不变（顶层的混合层已由层首拷过，
    读码上屏本来不拷，顶层这里是多余但无害的一次，不动它免得改顶层已对过的计划）。
  - effect 前（规则 2、3）与粒子前不变。
  - 文件头「`_rt_FullFrameBuffer`」一条的「后半是组里的图层」改写成 P5f 的规则。
```ts
  // 规则 1：基础材质需要帧缓冲，或 colorBlendMode 混合；直接父是组时 WPE 不拷（P5f）
  if ((base.framebuffer || passthrough) && !isDirectGroupChild(layer)) snapshot();   // 修改
```

## 点 3 — 执行快照拷当前目标（`render/scene.ts`）

- **修改**
  - `runOps` / `runLayer` 的「画到场景」目标从 `GPUTextureView` 换成同时带纹理与尺寸的目标（场景目标缺省；组画子树时是组当前的合成 RT，`resolveTarget` 的结果）。
  - `snapshot(target)`：目标是场景目标时照旧（没开过场景 pass 先清一次，整张拷）；是组 RT 时先 `end()`，
    `copyTextureToTexture({ texture: 组 RT }, { texture: 快照, origin: (0, 0) }, { width: min(组 RT 宽, 快照宽), height: min(高) })`，不碰 `started`。
  - `op.kind === "snapshot"` 与粒子树里的 `"snapshot"` 都用它。注释改写（删掉「组里也拷真正的场景目标」）。
```ts
    /** 拷快照（P5f）：拷当前目标。组里是组的合成 RT，只拷左上角重叠部分，快照其余保持上一次的内容（`p5f-a`、`p5f-e`，NVIDIA 驱动的 ResolveSubresource 行为）。 */
    const snapshot = (target: DrawTarget) => { ... };
```
- 组 RT 已带 `COPY_SRC`（`createTarget`），快照带 `COPY_DST`，两者格式都是场景格式（HDR 时 `rgba16float`），不用改资源。

## 点 4 — 测试

- **新增 / 修改**
  - `compile/p5b.test.ts`：组里读快照的几种用法不再报键（`groupChildIssues` 只剩 fullscreen 等），`3465215190` 形状的内存工程 `unsupported` 为空。
  - `compile/registry.test.ts`、`compile/fragment.test.ts`、`host.l3b.test.ts`：去掉对这个键的期望（l3b 用别的组内键做例子，如 `model:passthrough:children:fullscreen`）；
    registry 加一条：组内从直接挂组换到分组节点下面，`changed` 含这个对象。
  - `render/graph` 的单测（就近的 `p5b-group` 计划测试）：直接父是组时层首不拷、隔分组节点时照拷、effect 前与粒子照拷、组里的 passthrough / `groupUpload` 不拷、顶层不变。
  - `render/p5b-group.test.ts` 的假设备：组里执行快照时拷贝源是组 RT、目标原点 (0, 0)、尺寸取较小值（比屏幕宽、比屏幕窄各一例）；顶层仍是场景目标整张。
- 只跑相关测试文件（`compile/p5b`、`registry`、`fragment`、`host.l3b`、`host.l5`、`host.script`、`script/structureRuntime`、`dev/probe.scripts`、`render/p5b-*`、`render/l7`、涉及 `GROUP_CHILD_FRAMEBUFFER` 的测试）。

## 点 5 — 文档

- `cocs/wpe/WPE_SCENE.md`：P5b 组那一节与「`_rt_FullFrameBuffer` 快照」一条改成 P5f 的规则（三个拷贝点在组里的表现、拷当前目标、左上角、NVIDIA 驱动行为），照报表里删掉 `…:framebuffer`；新增「组里读快照（P5f）」一节放步骤 0 的实测表。
- `cocs/README.md`：WPE_SCENE 条目的组 / 快照相关摘要与适用场景各补一句。
- `versions/latest/changelog.md` 一行；`versions/latest/regression.md` 一节。
- 本文件末尾补「实施记录」。

## 验收

- tsc 0 错，相关测试通过；变异（层首不看父、上屏照拷、快照拷场景目标、拷贝尺寸取整张）都能被单测抓住。
- p5f-a..e 导入 dev，`render_scene` 出我们的整帧，与 `ignore/p5/f/wpe/` 逐像素比（屏蔽 FR / CLK）。
- `3465215190`：dev 里不再退回；和 WPE 抓帧比组「路面雨滴」所在区域（雨滴粒子有随机，比静止部分与雨滴的折射底色）。
- 语料扫描：`3465215190`、`3233141951` 变干净，别的场景键不变。

## 合并注意

工作区有别的会话未提交的改动（`render/scene.ts`、`render/state.ts`、`host.ts` 等常被并行改），提交时按块挑自己的，用临时索引。

## 实施记录（2026-11-17）

**实现**（执行代理按点 1–4，验收由我做）：
- 编译期：删掉 `GROUP_CHILD_FRAMEBUFFER` 与 `effectNeedsFramebuffer`（删后无人引用），`groupChildIssues` 只剩 fullscreen / perspective / sprite / model / shape；
  `applyGroupRules` 不再给 effect 记 / 去标记；`objectSlice` 不再过滤；`structureKey` 的 marks 换成「直接父是组」。`restructure` 里的 `syncEffectSupport` 照旧调（现在通常没有变化）。
- 计划层：`isDirectGroupChild`；三处层首拷贝（直接上屏、合成路径、文本 clearalpha）直接父是组时跳过；passthrough 与 `groupUpload` 上屏前的拷贝在组里跳过。
- 渲染器：`encode` 里「画到场景」的目标带纹理与尺寸（`DrawTarget`），组画子树时传组的合成 RT；`snapshot(target)` 拷当前目标，组里拷到快照 (0, 0)、尺寸取较小。
- 偏离：嵌套组的内组（直接父是组）层首不再拷，`p5b-group.test.ts` 里旧的嵌套组期望随之改了，这是规则的直接结果（`p5f-e` 实测 I 前没有 Resolve）。

**测试**：`compile/p5b`、`registry`、`fragment`、`host.l3b` 改期望；`render/p5b-group.test.ts` 新增计划层 4 例与假设备 3 例（拷贝源、origin、尺寸）；
`render/text.test.ts` 新增文本层 clearalpha 1 例（变异检查发现漏了这一处后补的）。

**验收**
- tsc 0 错；相关测试 50 个文件全过（17 个 689 passed / 12 skipped，33 个 806 passed / 18 skipped），另 `text.test.ts` 35 passed。
- 变异（`ignore/p5/f/mutate_f.py`，`kbp mutate --mode workspace`）：10 处全部检出（层首三处、上屏两处、直接父判断、拷贝源、拷贝尺寸、子树不传组 RT、登记表派生量），还原一致。
- 和 WPE 整帧对照（`render_scene` 1920×1080、10 帧 0.05 s 回放，`kbp cmp frame --kbp-layers`）：`p5f-a` / `b` / `c` / `e` 0 差；`p5f-d`（组转 0.3 弧度）1 个像素差 1 级。宿主产物 `index-d4u6SB4P.js`。
- `3465215190`（dev 图片 14292）：`unsupported` 为空；3 秒回放后溅射粒子画出来，底部路面观感与 WPE 抓帧（`A:\p5f\real\`，组里那次 Resolve 在 1960×600 的组 RT 绑定时）一致；
  整帧还有和组无关的差异（全屏「滤镜」层的透明度动画、歌名文字随时间变化），不在本步。
- 语料（`ignore/p5/f/corpus-p5f.json` 对 `ignore/p13/f/corpus-f2.json`）：干净 195 → 197（`3233141951`、`3465215190`），掉出 0，新增键 0；
  去掉的键还有 `script:api:layer.playSingleAnimation`（P12e 提交带来的，不是本步）。
