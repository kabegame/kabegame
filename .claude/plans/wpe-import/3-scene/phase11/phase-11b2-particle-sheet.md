# P11b2 — 粒子精灵表槽的用户纹理（`usertextures:particle-sheet`）

> 2026-11-18 用户：「usertextures:particle-sheet 现在需要支持了」。P11b「决定」3 当时定为照报，这一节把它做掉。
> 依据：[rea-p11b.md](rea-p11b.md) 第 6 节（R6）、[p11-REPORT.md](p11-REPORT.md)「P11b 补测」M4。

## 总体设计思路

WPE 的粒子系统只在**加载时**看一次材质槽 0 的纹理：带帧表就给系统置 `0x1000000`，着色器变体（`SPRITESHEET*`、`THICKFORMAT`）与模拟器的 frame 列都按这个位定，之后不再重算；材质刷新也不通知粒子系统。槽 0 绑了用户纹理时，`usertextures` 在建材质时就按属性**当时的值**解析好了，所以「加载时槽 0 是谁」取决于加载时属性有没有值：

| 加载时槽 0 | 运行中换成 | 画法 |
|---|---|---|
| 缺省精灵表（属性为空） | 用户图 | 帧表照旧：用户图按帧比例裁后被当成同样行列的精灵表，每个粒子画一格、按旧帧序轮换（M4 已实测） |
| 用户图（属性有值） | — | 没有帧表：不写帧表宏、frame 不推，每个粒子画整张用户图 |
| 用户图 | 清空回缺省精灵表 | 仍没有帧表：每个粒子画整张精灵表 |

第一行我们的渲染器其实已经做对了：`render/scene.ts` 写 `g_RenderVar1` 时，槽 0 是用户纹理就取 `fallback` 的帧表（P11b 按 M4 写的）。缺的是第二、三行，所以 P11b 宁可整张退回。这一步只补「加载时定一次」：

- **编译期定这个粒子系统是不是精灵表**：`compilePass` 里 `parseUserTextures` 已经先于 `particleDefines` 跑，在那里判断槽 0 是不是「加载时就生效的用户纹理」，是的话这个系统按「槽 0 没有帧表」编：不写帧表宏、不因帧表走厚格式、`TEX0FORMAT` 取用户纹理的格式（RGBA8，【推】，步骤 0 核对）、`particle.spriteSheet = false`。之后运行中换图、清空，都只换绑定的纹理，系统的变体与 frame 列不动——渲染器现成的就地换图路径就是这样，不用改。
- **「加载时」指什么**：WPE 的加载对应我们一个场景宿主实例第一次编译这张场景时的属性值。之后因为属性改 `size` / `colorBlendMode`、`general.hdr` 等引起的重编译（对象级或整场），在 WPE 里都是就地改、不重新加载，所以要沿用第一次加载时的判定，不能按重编译时的新值重定。做法是宿主在第一次编译时把「加载时属性快照」记下来，此后每次编译（整场、片段、对象级重编译）都把它随编译输入带上，编译期判定只读快照。快照只对这一个判定用，别的照旧读当前值。
- **能力键**：`usertextures:particle-sheet` 删掉，不再报。

范围外（照旧，不改）：
- 系统来源（封面 `$mediaThumbnail`）、快捷方式图标：加载时在 WPE 里都还是缺省纹理（封面要等第一条媒体消息，图标是异步取的），永远落在第一行，现有代码已对。
- `g_RenderVar1` 在 WPE 里是全局残值（`ctx+0xb8`，上一个写它的粒子绘制留下的）。第一行我们取本系统缺省纹理的帧表，同一场景只有一个精灵表系统时两者相同；多个精灵表系统交错换图的残值差异不复刻（语料没有）。

## 现状锚点

**a. 编译期照报**（`apps/wpe-scene/src/compile/usertextures.ts`，`parseUserTextures`）
```ts
    if (item.keepAspect) issues.add("usertextures:keepaspect");
    if (options.particle && slot === 0 && base.kind === "texture" && base.sheet)
      issues.add("usertextures:particle-sheet"); // 现状：粒子槽 0 缺省是精灵表就整张退回
```

**b. 粒子 pass 的宏只看缺省纹理的帧表**（`compile/bundle.ts`，`particleDefines`）
```ts
    let texture: SceneTexture | undefined = slots[0] === undefined ? undefined : bundle.textures[slots[0]];
    // …
    const thick = rope || system.renderer?.kind === "spritetrail" || !!system.trail || !!texture?.sheet;
    const tex0 = particleTex0Format(format, thick, system);
    return {
      ...particleRendererDefines(system),
      ...(rope ? {} : particleSheetDefines(texture?.sheet, system)), // 现状：不知道槽 0 加载时是用户图
      ...(tex0 !== undefined ? { TEX0FORMAT: String(tex0) } : {}),
    };
```

**c. 系统的 `0x1000000`**（`compile/bundle.ts`，`compileParticleMaterial` 末尾）
```ts
    // 基础材质槽 0 的纹理带帧表：WPE 置系统的 `0x1000000`，模拟器据此每帧算 frame（rea-p4b-render.md 2.3、2.5）
    const slot0 = particle.passes[0]?.textures[0];
    particle.spriteSheet = slot0 !== undefined && !!bundle.textures[slot0].sheet; // 现状：只看缺省纹理
```

**d. 运行中换图时帧表取缺省纹理的**（`render/scene.ts`，粒子 uniform）
```ts
      // 槽 0 是用户纹理时帧表仍按缺省纹理（p11-REPORT M4：运行中换图沿用缺省的帧表）
      const base = input?.kind === "user" ? input.fallback : input;
      // …
        sheet: base?.kind === "texture" ? this.bundle.textures[base.index]?.sheet : undefined,
```
现状已是第一行的行为。第二、三行时着色器没有 `SPRITESHEET`，这里写进 `g_RenderVar1` 的值没人读，不用改。

**e. 编译用的属性**（`compile/bundle.ts`，`compileScene` 与片段）
```ts
  let properties = currentProperties(project, input.userProperties ?? {});   // 整场
  // …
    properties = currentProperties(project, request.properties);              // 片段 / 对象级重编译
```
现状只有当前值，没有「加载时」的概念。

## 点 1 — 编译期判定与宏（`compile/usertextures.ts`、`compile/bundle.ts`）

- **删除**
  - `parseUserTextures` 里的 `usertextures:particle-sheet`，连同 `UserTextureOptions.particle` 的注释改写（选项本身若没有别的用处一并删）。
- **新增**
  - 编译输入 `SceneCompileInput.loadProperties?: Record<string, unknown>`（片段请求同名字段）：加载时的用户属性快照，缺省时等于 `userProperties`。
  - 纯函数 `particleUserAtLoad(slot0Source, loadValues)`：槽 0 的来源是属性（`kind: "property"`）且快照里的值是非空字符串（再按「待定」1 决定要不要加「文件读得到」）→ true；系统来源、快捷方式一律 false。
- **修改**
  - `compilePass`：粒子 pass 在 `parseUserTextures` 之后算 `userAtLoad`，传给 `particleDefines`，并记在 pass 上（`MaterialPass` 内部字段，不进 bundle 外形）。
  - `particleDefines`：`userAtLoad` 时 `texture` 当作「没有帧表、格式 RGBA8888」：
```ts
    const sheet = userAtLoad ? undefined : texture?.sheet;                     // 修改：加载时是用户图就没有帧表
    const thick = rope || system.renderer?.kind === "spritetrail" || !!system.trail || !!sheet;
    const tex0 = particleTex0Format(userAtLoad ? USER_TEXTURE_TEX_FORMAT : format, thick, system); // 修改：格式取用户纹理（步骤 0 核对）
    return {
      ...particleRendererDefines(system),
      ...(rope ? {} : particleSheetDefines(sheet, system)),
      ...(tex0 !== undefined ? { TEX0FORMAT: String(tex0) } : {}),
    };
```
  - `compileParticleMaterial` 末尾：
```ts
    const slot0 = particle.passes[0]?.textures[0];
    particle.spriteSheet =
      slot0 !== undefined && !!bundle.textures[slot0].sheet && !particle.passes[0]?.userAtLoad; // 修改
```
  - 同系统多 renderer、子系统：判定按各自的基础材质 pass 来，规则不变。
- **说明**：判定只读快照；参考尺寸（按帧比例裁）不变，WPE 在两种情形下都取缺省纹理的帧尺寸（rea-p11b 6.3）。

## 点 2 — 宿主记快照（`host.ts`）

- **新增**
  - `SceneHost` 的 `loadProperties`：本实例第一次编译这张场景时的用户属性全集（同 `userProperties` 的形状）。换场景（`kbScene` 变）时重取。
- **修改**
  - 整场编译、开片段会话、对象级重编译的请求都带上 `loadProperties`。
- **说明**：「清空脚本存储」、设置引起的整场重新加载都还在同一个宿主实例里，沿用快照；WPE 设置变化会重新加载壁纸（那时按新值判定），这一处差异记为有意不同（重新打开预览 / 桌面即按新值）。要不要在设置引起的重载时也重取，见「待定」2。

## 点 3 — 测试、能力表、文档

- **修改**
  - `compile/p11b.test.ts` 的「粒子材质槽 0 的缺省是精灵表：usertextures:particle-sheet」改成：属性为空时有帧表宏、`spriteSheet` 真、不报；快照有值时没有帧表宏、薄格式、`spriteSheet` 假；当前值有值但快照为空时仍按精灵表；系统来源与快捷方式不受影响。
  - `cocs/wpe/WPE_SCENE.md`「用户纹理（P11b）」：照报清单删掉粒子精灵表槽，补一段加载时判定；`cocs/README.md` 对应条目同步。
  - 回归一节、changelog 一行。

## 步骤

0. **实测补洞**（WPE，`ignore/p11/defs/p11b2.py` 的 `p11b-sheet` 派生两个工程）：
   - `p11b-sheet-init`：属性缺省值就是 `ut-a.png`（同 M8 的做法）。抓帧看粒子顶点格式、`g_RenderVar1` 是否被写、UV 是否整张、画面；看 `TEX0FORMAT` 的变体（比对着色器反汇编里的格式分支）。运行中清空属性再抓一次，预期整张精灵表。
   - `p11b-sheet-missing`：属性缺省值是一个不存在的路径。预期按读码（建材质时同步读失败 → 槽 0 是缺省精灵表 → 有帧表），实测定「待定」1。
1. **点 1、点 3 的单测**（HEAD 快照里做，`compile/bundle.ts` 别的会话正在改，三方合并）。
2. **点 2**，接上宿主；dev 探针 `renderFrame` 的 `userTextures` 回放两种加载情形。
3. **走查**（按 `FINAL_CHECK.md`）：生成工程两种加载情形 × 换图 / 清空，与 WPE 整帧比；语料重扫，`3799462430`、`3812473896` 去掉这个键后能不能渲染（当前 HEAD 上它们别的键是否都已清零，开工时先重扫确认）；导入其中一张，在预览里选图、重开预览各看一次。
4. **收尾**：文档、回归、changelog，提交等你同意。

## 验收

- 生成工程：加载时为空 → 换图（M4 情形）、加载时有值、加载时有值再清空，三种和 WPE 整帧逐像素相同（粒子随机数按回放对齐），或差异能归到已知差异（JPEG 色度上采样等）。
- 语料：只去掉 `usertextures:particle-sheet`，原来能渲染的不掉出。
- 改属性后不整场重编译（仍走就地换图）；加载时判定跨重编译不变。

## 待定

1. **加载时值非空但文件读不出来**。WPE 建材质时同步读，读不出就是缺省精灵表、仍按精灵表画；我们编译在 Worker 里，解码在编译之后。
   - **A（推荐）编译期探一下文件在不在**：经宿主的 `SceneReader` 读文件头几个字节，读不到当作没值（按精灵表编）。文件在但解码失败（内容坏了）仍按「用户图」编，回缺省后画整张精灵表，记为已知差异。代价是编译期多一次读文件。
   - **B 只看值非空**：文件被删了也按「用户图」编，画整张精灵表；实现最省，差异面大一点。
   步骤 0 的 `p11b-sheet-missing` 先确认 WPE 确实按精灵表画，再定。
2. **设置引起的整场重新加载是否重取快照**。WPE 改后处理等设置会重新加载壁纸，那时按新值判定。
   - **A（推荐）不重取**：快照跟宿主实例走，简单、不会因为改设置让粒子画法突变；差异只在「运行中选了图、又改了场景设置」这一种组合下，重开即一致。
   - **B 重取**：设置引起的整场重载算一次新加载，和 WPE 一样；要在宿主区分「设置重载」与「属性引起的重编译」。

## 风险

1. `compile/bundle.ts`、`host.ts` 是共享热点（工作区里现在就有别的会话未提交的改动），按快照实现、三方合并。
2. `TEX0FORMAT` 在用户图时的取值是推断，步骤 0 核对；对不上就照实测改。
3. 语料只有 2 张 3 项，且属性缺省都为空：语料只覆盖第一行，第二、三行只靠生成工程验证。

## 实施记录

### 决定（2026-11-18 用户：「可以」，两条待定按推荐）
1. 待定 1 选 A：编译期探文件在不在，读不到当作没值；文件在但解码失败记为已知差异（步骤 0 的 `p11b-sheet-missing` 先核对 WPE）。
2. 待定 2 选 A：快照跟宿主实例走，设置引起的整场重载不重取。

### 步骤 0 — 实测（2026-11-18，完成）

工程由 `ignore/p11/b2/make_sheet_init.py` 从 `p11b-sheet` 复制，抓帧在 `A:\p11b2\`（1600×900，粒子是第 46 号事件）。

| 工程 | 情形 | 顶点格式 | 槽 0 | 几何着色器输出的 UV | 结论 |
|---|---|---|---|---|---|
| `p11b-sheet-init` | 属性缺省值是 `ut-a.png` | 薄格式（stride 44，POSITION + TEXCOORD + COLOR） | 用户图 166×200（按帧比例裁），线性采样 | 0–1 整张 | 没有帧表，每个粒子画整张用户图；四边形宽高比跟用户图（83×100 像素） |
| `p11b-sheet-missing` | 属性缺省值是不存在的路径 | 厚格式（stride 60，多一列 TEXCOORD1） | 缺省精灵表 512×512、9 级 mip、8 倍各向异性 | — | 读不到就按精灵表画，待定 1 的 A 成立 |
| `sheet-init-cleared` | `p11b-sheet-init` 运行中 `applyProperties ut = ""` | — | 缺省精灵表 | 0–1 整张 | 仍没有帧表，每个粒子画整张精灵表（四边形 83×83，跟纹理宽高比） |

- `leaves7` 本身就是 RGBA8888（格式 0），用户纹理也是 RGBA8，这个样本上 `TEX0FORMAT` 两种取法相同；实现照「用户纹理是格式 0」写。
- M4（加载时为空、运行中换图）P11b 已实测，渲染器现状就是那个行为。

### 步骤 1–3（2026-11-18，在独立工作树 `ignore/p11/b2/wt`（HEAD `f32defcf`）里做，主区这 8 个文件当时与 HEAD 相同，直接拷回）

**代码**（`apps/wpe-scene/src`）：
- `compile/usertextures.ts`：删 `UserTextureOptions.particle` 与 `usertextures:particle-sheet`；新增 `particleUserAtLoad(slots, properties, probe)`。
- `compile/bundle.ts`：`CompileSceneInput.loadProperties`；`ParticleSheetSystem.userAtLoad`（`compilePass` 在 `parseUserTextures` 之后填）；`particleDefines` 在 `userAtLoad` 时不写帧表宏、不因帧表走厚格式、`TEX0FORMAT` 按 `FBO_FORMATS.rgba8888.tex`；`compileParticleMaterial` 的 `spriteSheet` 取基础变体；`sheetProperties`：整场与对象级重编译读 `loadProperties`，`compileFragment` 的新对象读当前值。
- `compile/client.ts`、`protocol.ts`（`OpenRequest.loadProperties` 可选）、`workerHandler.ts`：透传。`host.ts`：`loadProperties ??=` 第一次编译时的属性全集。
- 单测：`p11b.test.ts`（不再报；`particleUserAtLoad` 三组）、`sheet.test.ts`（编译期四种：属性为空、加载时有图、只看快照、读不到）。

**和计划的不同**：「待定」1 的探测是读第 1 个字节，空文件也按读不到。走查发现工程**缺省值**里的文件路径宿主读不到（`file:` 放行只认 metadata 里用户设过的值，P11b 起如此，语料缺省都是空串），这时按「读不到」走精灵表，记进文档。

**验证**：见回归「场景壁纸粒子精灵表槽的用户纹理（P11b2）」S0–S5。语料 `ignore/p11/b2/regress/`：只有两张去掉这个键，干净 223 → 225。产物用 `buildSceneHost.ts` 重建过（`index-BhN-RH59.js`）。走查用的 `p11b-sheet-live` 去掉了 `boxrandom` 的 `minoffset` / `maxoffset`（它们照报、宿主会退回）。

**没做的**：S6 预览里真实选图、重开（要开用户的预览）；S7 非 Windows。

### 改成运行时生效（2026-11-18，用户：「我觉得有点问题，能运行时更改吗」→ 方案后「可以」）

**决定**：不照 WPE「加载时定一次」，改成按属性的当前值定、改值当场切换。理由：WPE 运行中换图把用户图切成格子、要重开才画整张，是 WPE 的缺陷，语料画面不依赖它（两张场景作者缺省都是空串），按「语料依赖的 WPE 缺陷才复现」改成正确做法，记为有意不同。上面「总体设计思路」里的快照设计与待定 2 作废。

**改动**（同样在 `ignore/p11/b2/wt` 里做，改前的文件存在 `ignore/p11/b2/base2/`，三方合并回主区，主区 `bundle.ts` 上 P13j 的未提交改动不受影响）：
- 删掉快照：`CompileSceneInput.loadProperties`、`sheetProperties`，client / protocol / workerHandler / host 退回 HEAD。
- `particleUserAtLoad` → `particleUserImage`、`ParticleSheetSystem.userAtLoad` → `userImage`，按当前 `properties` 判定。
- `compilePass`：槽 0 的缺省是精灵表、来源是属性时，给属性另登记 `{ kind: "recompile", reason: "layer-structure", path: "<pass 键>/usertextures/0" }`（如 `objects/0/particle/passes/0/usertextures/0`），宿主经 `recompileObjectOf` 只重编这个对象（L6）。
- 单测：`sheet.test.ts` 去掉快照用例，加「登记了对象级重编译、`planApply` 分到对象 0」「缺省不是精灵表时不登记」。

**验证**：tsc 0；vitest 相关文件全过；走查 `p11b-sheet-live`（15609）：选图、清空各一次，`recompiledObjects` 0 → 1 → 2、`recompiled` 为空、日志没有出错。屏外宿主不跑帧循环，切换后的画面留给回归 S6 在预览里看。

### 修清空报错（2026-11-18，用户在预览里选图后清空，整张报 `Destroyed texture [user …x8] used in a submit`）

**原因**：`render/scene.ts` 的 `syncUserTextures` 只重绑 `step.kind === "draw"` 的 draw，`rebindDrawInputs` 也跳过粒子（P11b 写的「粒子槽编译期照报」）。清空时来源变空，`releaseUnusedUserTextures` 算「在用」时这张已解析不出名字就释放了，而对象级重编译异步、换上之前旧粒子 draw 的 bind group 还拿着它。P11b 时粒子槽整张退回，这条路没走过；选图时同理旧粒子层在新层换上之前不换图。

**修复**：两处都放行 `particles`，`rebindDrawInputs` 的模型矩阵取 `draw.particles?.model`。单测 `render/p11b.test.ts`「粒子材质槽 0 换图（P11b2）」：选图后 bind group 是用户图、`g_Texture0Resolution` 是裁后尺寸，清空后换回缺省、用户纹理已释放、bind group 不再引用它；撤掉修复时失败（变异检查）。tsc 0，`render/` 下 p11b、particles、l4、rebuild、p8 与 `host.usertextures` 全过。dev 屏外宿主复测见回归 S8。宿主产物重建为 `index-CF8o2yw2.js`。

**顺带**：在主区跑 Prettier 时把 `scene.ts` 里 HEAD 原有的一行（`sceneDrawTarget`）也排了版，已手工恢复，主区只留 P13j 与本步的块。

### 走查（2026-11-18，用户「按军规补 FINAL_CHECK」）

**做法**（`FINAL_CHECK.md` 原则 1–5）：
- 复制工程：`kbp content isolate <ID> --keep <对象> --instrument --data ignore/p11/b2`，再用 `ignore/p11/b2/make_iso_fixed.py` 把粒子 JSON 的随机初始化器收成 min = max、`turbulentvelocityrandom` 去掉、`sphererandom` 距离 0（WPE 粒子随机数按时间做种、不可复现，同 P4「随机范围收成 min = max」），派生 `-user`（属性缺省值是 `ut-a.png`，WPE 加载时就是用户图）。被测的材质、usertextures、帧表、renderer、动画模式、父链、对象绑定与脚本一律不动。
- WPE：`capture_sweep` 各 4 帧，1920×1080、fps 20、后处理 ultra（WPE 当前设置，没改），抓帧 `A:\p11b2\<标签>`，日志 `ignore/p11/b2/out/`。
- Kabegame：导入不带图的那份；「有图」用 `set_wpe_web_user_properties` 写用户值（同缺省值的不会存，`file:` 放行要它），`renderFrames.ts` / `render_scene` 按日志回放、`canvas` 1920×1080、ultra；`kbp cmp frames` 整帧比。
- `randomframe`（`3799462430`「樱花」）的 `R`：第一遍注入 `R_k = k/1e5`、从我们的轨迹按位置读出生序号，再按位置把 WPE 的 `R`（`TEXCOORD1.w`）填进去（`make_random.py`、`merge_random.py`，225 与 228 两帧合并，出生序号 106–289、重叠 0 冲突）。

**结果**：

| 复制工程 | 状态 | 帧 | 初次 | 定位与处理 | 最终 |
|---|---|---|---|---|---|
| `3812473896-iso-leaves`（「叶子 2」+ 子系统 `leaves2b`） | 为空 | 226–229 | 最大 5，每帧约 8 千个像素 > 0、约 190 个 > 2 | 逐粒子：位置 / 旋转 / 尺寸逐位相同，帧号与 alpha 比例全是 1.0002442 = `1/(rcpps(9)·9)`；帧号 ×30 后的混帧权重差推算最大 5.58 级 | 已知差异（近似倒数）。临时把 `rcp(9)` / `1/life` 换成 `rcpps(9)`（`// DEBUG-p11b2-rcp`，已删）后最大 2、约 300–430 个像素 |
| 同上 | 加载时有图 | 226–229 | 最大 7 | 父系统薄格式、绑 166×200 用户图、线性 1 级 mip，和 WPE 一致；差异同上，叠在子系统的混帧差上 | 已知差异；临时换 `rcpps(9)` 后最大 3、约 230–310 个像素 |
| `3799462430-iso-sakura`（「樱花」，`randomframe`） | 为空 | 225、228 | 未注入 `R`：最大 124 | `R` 注入后：最大 2（392、465 个像素） | 已知差异（同上类） |
| 同上 | 加载时有图 | 224–227 | **最大 224，每帧约 440 个像素 > 32** | **bug**：用户图 WPE 159×200、我们 160×200。`defaultOfTexture` 用 `round(RV1.x · 宽)` = round(102.5) = 103，WPE 取 TEXS 格宽 102（`rosepetals` 格 102×128）。改取 `frames.cell`（`compile/usertextures.ts`，单测 `p11b.test.ts`） | 修后最大 5–10、每帧 13–41 个像素 > 2、最多 1 个 > 8。换 `rcpps(9)` 后有差像素 650 → 130，> 2 的不变：都在用户图色块硬边（红蓝交界），159 宽纹理画进 36 像素、1 级 mip，几何舍入（fxc 几何着色器 vs Tint 顶点着色器展开四角，投影矩阵也差 1 ulp）被强缩小放大，归着色器舍入 |

**未解释**：无。`leaves7`（85×102）两种参考尺寸算法都得 166，所以第一张没暴露那个 bug——正是 FINAL_CHECK 说的「生成工程的验收证明不了真实壁纸」。

**工具缺口**（没修，记下）：`renderFrames.ts` 不收 `random`，注入 `R` 只能逐帧调 `render_scene`、把几百个数贴进调用；`kbp rdc track` 不认解包的真实工程，取 `R` 靠自己按位置配对。

**期间的失误**：命令里三次误带了读 stdin / `-c` 的空 Python 调用（没有执行任何代码），违反「Python 只用脚本文件」。
