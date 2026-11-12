# P4f — 粒子的脚本接口与实例覆盖（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)「P4f」。底座沿用 P4a–P4e（各子计划与 `rea-*.md`），本节新增的语义由步骤 0 写进 `rea-p4f-script.md` 和报告。
> 语料用 P4e 收尾的扫描（`ignore/p4/e5/corpus.json`，HEAD `1e929b3b`，165 个工程 + 8 个测试工程）。定范围的脚本 `ignore/p4/f0/scope.py`，结果 `ignore/p4/f0/out/scope.txt`。
> 步骤 0 只调研；步骤 1 起每步能单独验收、单独提交。步骤 1 以后的划分是初稿，步骤 0 做完后按结论定稿。

## 总体设计思路

P4f 让脚本能控制粒子系统，分两种入口，最后都落在模拟器已有的接口上：
- **字段脚本挂在 `instanceoverride` 上**（`{"rate": {"script": "…", "value": 1}}`）：每帧由脚本给出系数，和用户属性改系数是同一件事。P4a 已经把 `instanceoverride` 做成就地目标（`particle-instance`，`ParticleSystem.setInstance` 从基值重乘，不清粒子）。所以这一种只是把字段脚本的写回目标接到 `particle-instance` 上，能力表不再报 `particle:binding:instance:<键>`。
- **图层 API `IParticleSystem`**：`play` / `pause` / `stop` / `isPlaying` / `emitParticles(count)`，以及 `instance` 对象（7 个系数和 `controlpoint0..7`）。前四个是发射的开关与清空，`emitParticles` 是越过常规发射门的一次性发射（rea-p4e-children 末条：发射函数第三参数 > 0 时不受 `sys+0x3f7` bit0 挡）。这些落成 `ParticleSystem` 上的几个方法与一个「脚本停发」位，图层代理在粒子对象上登记它们（同 P6a 只在声音对象上登记 `ISoundLayer`）。

做完之后，编译期对播放控制的「宁可多报」规则（`PARTICLE_LAYER_METHODS`：场景里有粒子层时任意接收者上的这四个名字都报 `script:api:particle.<名>`）就可以删掉：粒子层与声音层的同名方法都有了，接收者认不出类型也无所谓。

另外顺带做两件粒子上剩下的事（已定 2、4）：
- **HDR 下的 `instanceoverride.brightness`**（`particle:instance:brightness`，3 张只差它）：读码已知 HDR 且系统没有 `flags 8` 时实例颜色乘它（rea-p4a C5、rea-p4b-render），现在是照报，补实测后实现。
- **一个系统多个 renderer**（`particle:renderers`，1 张）：WPE 按数组顺序各画一次、共用同一份顶点、各绑自己的变体材质（rea-p4c-render 6.3，P4c 步骤 0 实测两种顺序）。P4e 已经把粒子层改成每帧现排、按模板池化 draw，多 renderer 就是一个系统出几个 draw，各有自己的程序与 `g_RenderVar0`。做完后带粒子的场景里粒子用法全部覆盖。

**深度与剔除不在本节**（已定 1，移到 P5d）。语料里的 `cull:normal`、`depthtest:enabled`、`depthwrite:enabled` 是所有非模型材质 pass 共用的检查，图像层、effect、粒子都有；P5 已定「深度附件由 P5d 建」，P5d 本来就要把非模型 pass 的深度与剔除检查一起统一（`features.ts` `checkPassFeatures` 的注释）。去掉这三类键也不让任何场景干净（见下「范围」），放在 P5d 一起做，少建一次附件、少一轮基线。

几个关键决定：
- **时机照 WPE、按现有的帧顺序。** 一帧里粒子先于脚本步进（P4c：`sync` → `stepParticles` → 脚本 → `sync` → `update`），脚本这一帧写的系数、调的 `emitParticles` 在 WPE 里是当场生效还是下一帧生效，由步骤 0 读码加实测定，模拟器侧只提供同步的入口。
- **随机数照旧不复刻。** `emitParticles` 发出的粒子走同一套 initializer，确定性工程照 P4a–P4e 把随机范围收成 min = max。

## 范围与解锁

语料（`scope.py`，e5 扫描）：

| 组 | 键（张数） |
|---|---|
| 实例覆盖挂脚本 | `particle:binding:instance:rate` 8、`colorn` 5、`count` 3、`size` 3、`alpha` 2、`speed` 2、`lifetime` 1 |
| HDR 下的 `brightness` | `particle:instance:brightness` 3 |
| 粒子层的脚本方法 | `script:api:particle.play` 39、`stop` 30、`pause` 16、`isPlaying` 8（「宁可多报」，接收者多半是声音层）；`script:api:layer.emitParticles` 1 |
| 一个系统多个 renderer | `particle:renderers` 1（`3465215190` Rainy Day 的 `Snow`：`sprite` + `spritetrail`） |
| 深度与剔除（不分图层种类，已定 1 移到 P5d） | `cull:normal` 12、`depthtest:enabled` 6、`depthwrite:enabled` 1 |

- **粒子用法完全覆盖**（带粒子的 108 张里不报 `particle:*` 键，165 张口径）：现在 93。实例覆盖挂脚本做完 +11（104），再加 `brightness` +3（107），多 renderer +1（108，全部）。
- **能渲染：不解锁。** 上面四组全去掉也没有场景干净（每张都另差文字、网格、视频等）；总计划风险 4 原来就写「P4f 不解锁新场景」。
- **脚本源码里的用法**（scene.json 内联脚本，按正则粗查）：
  - `emitParticles` 4 处 / 2 张（`3286859278`、`3570560686`）；
  - `play()` 241 处 / 38 张、`stop()` 201 / 29、`pause()` 39 / 16、`isPlaying()` 17 / 7，接收者认不出类型，是上限；
  - `layer.instance.*`（脚本直接读写实例系数或控制点）0 处。
- 真实场景的验收样本：`3809965824` 的 `鼠标音乐`（`count` / `rate` / `size` / `speed` 都挂脚本，P4e 步骤 4 用过它的测试副本）；`emitParticles` 的两张另差 20–30 项，只能强制渲染看。

- `3465215190` 另差 18 项（人偶、挂接、动画层、点光源阴影、`g_AudioSpectrum*`、文本脚本等），多 renderer 做完也不能渲染；验收靠 P4c 步骤 0 的 `T8`、`T8r` 与新的确定性工程。

**本节不做，继续报不支持：**
- 粒子的 `depthtest` / `depthwrite` / `cullmode`（已定 1，移到 P5d）。
- `instanceoverride` 的控制点绑用户属性（`particle:instance:controlpoint:user`，语料 0）。

## 现状锚点

**a. 实例覆盖挂脚本照报**（`compile/features.ts:763`，`checkParticleInstance`）
```ts
for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
  if (value === null || value === undefined || key === "id") continue;
  if (isScriptValue(value)) unsupported.add(`particle:binding:instance:${key}`); // 现状：脚本不运行，整张退回
```

**b. 字段脚本的写回目标没有 `instanceoverride`**（`compile/scripts.ts` 的 `targetOf`）
```ts
if (owner.kind === "layer" && key in layerTypes)
  return { kind: "layer", object: owner.object, field: key as … };
// … effect visible、general 的 bloom 等；现状：objects/<i>/instanceoverride/<键> 没有目标
```

**c. HDR 下的 `brightness` 登记成重编译、改成非默认值后照报**（`compile/bundle.ts` 的 `compileParticleSystem`、`features.ts` 的 `checkParticleInstance`）
```ts
const brightnessActive = postprocess.hdr && (flags & 8) === 0;
const instanceTarget = (field: InstanceKey): BindingTarget =>
  field === "brightness" && brightnessActive
    ? recompile("layer-structure", `objects/${index}/instanceoverride/brightness`) // 现状：没实现，靠能力表挡
    : { kind: "particle-instance", object: index, field };
// features.ts：if (context.hdr && colorOverride && resolved.brightness !== 1) unsupported.add("particle:instance:brightness");
```

**d. 粒子层的播放控制按名字整张报**（`compile/scriptApi.ts`）
```ts
export const PARTICLE_LAYER_METHODS: readonly string[] = ["play", "pause", "stop", "isPlaying"];
// scanScriptApi：场景里有粒子层时，任意接收者上的这四个名字都报 `particle.<名>`（现状：宁可多报）
...methods("any", ["emitParticles"], UNIQUE),   // MISSING_SCRIPT_API 的 layer 组；`instance` 也在字段表里，只认根对象
```

**e. 图层代理只给声音对象登记播放方法**（`script/api.ts` 的 `installSound`）
```ts
/** 声音层的 `ISoundLayer`（P6a 步骤 2）：只登记在声音对象的图层上 … 粒子层的同名方法是 P4f 的事 */
private installSound(api: ApiObject, object: number): void {
  // 现状：粒子对象的图层代理上没有 play / pause / stop / isPlaying / emitParticles / instance
```

## 步骤 0 — 调研

不改产品代码。

### 0a — REA 读码（一个子代理）

**`rea-p4f-script.md`**，格式同 `rea-p4e-children.md`，每条标地址和证据等级。已知线索：
- 图层成员由 `wallpaper64.exe` 的方法表反射提供（p3-script-REPORT C 节）；`ISoundLayer` 的表在 `DAT_1404e85a0`（rea-p6a-sound 第 7 节，`ignore/p6/rea/sound/script_desc_1401f6e60.asm`）；整份反汇编 `ignore/p4/rea/wp.asm`；
- 发射门（rea-p4b-modules A1：`存活 < 容量`、`!(flags & bit31)`、`sys+0x3f7` bit0、`delay ≤ 0`），发射函数第三参数 > 0 时不受 bit0 挡（rea-p4e-children 末条）；
- 实例覆盖就地生效 `FUN_14022bd40`、`FUN_1401d15a0`（rea-p4a、rea-p4e-children 3.4）；`isActive` `FUN_14022c310`；复位 `FUN_14022f6c0`、清粒子 `FUN_14022fd90`。

要回答：
1. **`IParticleSystem` 的方法表**：在哪、登记在什么对象类型上（只在粒子对象？子系统可不可达）。
2. **`play` / `pause` / `stop`**：各改哪些状态位（`flags & bit31` 是不是「脚本停发」）、发射器的结束位与计时、是否清粒子、是否递归到 static 子系统与事件实例、`play` 会不会重新预热；和对象不可见时的复位（3.6）怎么叠加。
3. **`isPlaying`**：判定是不是 `isActive`（发射器没结束、有存活粒子、子孙活跃）。
4. **`emitParticles(count)`**：缺参数时的 `count`；从哪些发射器、各发几个（乘不乘 `instanceoverride.count`、发射器自己的 `rate` 与 `count`）；越过哪些门（容量、`delay`、bit0、bit31、`duration` 结束）；当场发射还是记到下一次模拟；出生粒子的初值与年龄；会不会触发 eventspawn / eventfollow。
5. **`instance` 对象**：7 个系数的 getter / setter 写到哪（是不是同属性改值的 `FUN_14022bd40`，会不会重开已结束的发射器）；`controlpoint0..7` 的 setter 写什么（实例覆盖的控制点静态值，P4c；只改平移？），getter 读什么。
6. **字段脚本挂在 `instanceoverride` 上**：脚本返回值的写回路径是不是同一个 setter；每帧写还是值变了才写；一帧里和粒子模拟的先后。
7. **HDR 下的 `brightness`**：核对 `k = (HDR && !(flags & 8)) ? brightness : 1` 乘在哪（颜色三通道、alpha 不乘），和 `colorn` 的先后；运行中改值是否就地。
8. **一个系统多个 renderer**（补 rea-p4c-render 6.3）：每个 renderer 的变体材质怎么来（同一个基础材质按 renderer 类型加哪些 COMBO，`TRAILRENDERER` 等），顶点缓冲按 renderer 集合建几份（`need & 3`）、写顶点是否和 renderer 有关（拖尾的退化粒子在共用缓冲里怎么处理），`g_RenderVar0` 在两次绘制之间的值（`RV0.w` 不写、保留上一次），朝向 `FUN_1402298b0` 每次绘制按各自 renderer 的字段算；rope / ropetrail 与 sprite 混挂时各用哪份缓冲；子系统、事件实例上同样适用。

### 0b — 准确的覆盖数（Claude）

在 HEAD 快照里临时改能力表：实例覆盖挂脚本不报（字段脚本照编译期扫描，让脚本里用到的未实现 API 照报出来）、HDR 下 `brightness` 不报、`PARTICLE_LAYER_METHODS` 与 `emitParticles` / `instance` 不报。跑 `kbp corpus scan`，核对去掉的只有这几组、没有新键，粒子覆盖的上限是 104 / 107。

### 0c — 确定性工程与实测（Claude）

- **新增** `ignore/p4/defs/p4f0.py`（`kbp gen`，`overrides` 往粒子对象上并 `instanceoverride` 与字段脚本），出这几个工程：
  - `p4f-instance`：7 个系数各一个系统，`{script}` 按 `engine.runtime` 在已知时刻切换值（阶跃，含切到 0）；`colorn` 切颜色；另一组每帧都写同一个值（看「每帧写」会不会重开发射器或重置什么）。
  - `p4f-api`：粒子层自己的字段脚本按时间表调 `play` / `pause` / `stop` / `emitParticles(n)` / `emitParticles()`，`isPlaying()` 的结果写进一个标记图层的颜色；`instance` 的系数与 `controlpointN` 用 API 写；带 static 子系统与 eventspawn 子系统的一组看递归；对象中途隐藏一段。
  - `p4f-bright`：`brightness` 0.5 / 2，`flags 8` 对照；同一工程抓「关闭」与「超高」两档（`capture_sweep` 改设置、跑完改回）。
  - `p4f-multi`：`sprite` + `spritetrail` 两种顺序、两个 `sprite`（不同朝向）、带速度为 0 的粒子（拖尾退化）、子系统上挂两个 renderer；先看 P4c 的 `T8`、`T8r` 够不够，不够才抓。
- 抓帧（`wpe-renderdoc` MCP）：fps 60 与 fps 20，`kbp rdc track --points` 读轨迹，`p4f-bright` 读整帧颜色。
- 结论写进报告新节「P4f 语义的实测核对」。

**验收：**
- 读码文档覆盖上面各项，都有地址、公式和证据等级。
- 覆盖上限由快照扫描确认，步骤 1 以后的划分按它定稿。
- 方法的时机（当场 / 下一帧）、`emitParticles` 的发射量与门、实例写入的生效时机都有实测。

### 步骤 0 实施记录（2026-11-13）

**0a 读码。** 一个子代理只读汇编（另用 llvm-objdump 读了 `scenescript64.dll` 一小段属性读写），写成 [rea-p4f-script.md](rea-p4f-script.md)，八个问题都有结论。要点：
- 粒子对象的反射表 `FUN_14024cb00`：五个方法（`play` `0x14024c5b0`、`pause` `0x14024c670`、`stop` `0x14024c680`、`isPlaying` `0x14024ca10`、`emitParticles` `0x14024cac0`，参数是整数）与只读字段 `instance`（子对象 `obj+0x778`，24 个字段，比 `d.ts` 多 `brightness` 与 `controlpointangle0..7`）；子系统与事件实例脚本拿不到。
- `pause` 只置 `sys+0x3f7` bit0：发射函数整段返回、计时冻结，传给整棵树；`play` 清它，整棵树不活跃时才重开（不复位计时、不预热）；`stop` 标结束、复位计时、清粒子、销毁活跃实例，递归 static。`isPlaying = !暂停 && isActive`。
- `emitParticles(n)`：`n == 0` 当 1、`n < 0` 不发；当场（脚本阶段）调发射函数 `dt = 0`，每个发射器各发 `n` 个，越过暂停、结束、`delay`，不越过容量；门内的发射器记欠账；新粒子本帧不画、下一帧年龄多一帧；照常触发 eventspawn / eventfollow，但建实例时模型栈顶是单位阵。
- `instance` 写入当场可读回，脏位在下一帧对象更新开头消费（`FUN_14022bd40(sys, 1, 1)`：从基值重算、重开 `rate > 0` 的已结束发射器、钳 `rate` 到 0.01 并写回）；**`rate` 没有回调**，单写它不置脏、不钳制、湍流 `timescale` 不跟。字段脚本走同一个 setter、每帧写、不比较，下一帧生效，**与我们的帧序等价**（风险 2 不成立）。
- `brightness`：`k = (HDR && !(flags & 8)) ? brightness : 1` 只乘颜色三通道。多 renderer：sprite 与 spritetrail 共用一份顶点、每帧写一次，按数组顺序各绑自己的变体材质、各算朝向、各写自己的 `g_RenderVar0` 分量（全局、没写的分量保留上一次）。
- 更正已有读码：`sys+0x3f7` bit0 是脚本暂停位（rea-p4b-modules A1 原推为恒 0）；「第三参数 > 0」的调用者就是 `emitParticles`（rea-p4e-children 末条）；`FUN_14024c680` 就是 `stop`（rea-p4d-modules）；「重开已结束发射器」只清位、不加 `sys+0x3f4`、不复位计时（rea-p4a C5）。

**0b 覆盖。** 不用在快照里重扫：挂在 `instanceoverride` 上的字段脚本本来就收集、扫过 API（`collectScripts` 不看写回目标），能力表逐键报、不互相遮挡，所以上限就是 `scope.py` 的算术：93 → 104 → 107 → 108。

**0c 实测。** 三轮工程（`p4f-instance`、`p4f-api`、`p4f-bright`、`p4f-multi`；读码回来后补 `p4f-api2`、`p4f-api3`），抓帧在 `A:\p4f\`，结论见报告「P4f 语义的实测核对」：读码能用抓帧判定的各条都成立；读码没定的两条实测得到：`emitParticles()` 发 1 个、`emitParticles(2.7)` 发 1 个。WPE 跑完改回 fps 20、后处理「关闭」，`config.json` 哈希与开始时相同（`e802ff46…`）；`capture_sweep` 重启过两次 WPE（改设置、改回）。

## 步骤 1 以后（定稿）

| 步骤 | 内容 | 粒子覆盖（165 张） |
|---|---|---|
| 1 | 实例覆盖挂 `{script}`：字段脚本的写回目标接到 `particle-instance`；`rate` 单独一条路（用户属性改值同样）：不置脏、不钳制、`timescale` 不跟 | 93 → 104 |
| 2 | HDR 下的 `brightness`：从重编译目标改成就地目标，实例颜色乘 `k` | 104 → 107 |
| 3 | `IParticleSystem`：`play` / `pause` / `stop` / `isPlaying` / `emitParticles` 与 `instance` 对象（24 个字段）；脚本发出的粒子本帧不画；已定 5–7 的三处不复刻 WPE；删 `PARTICLE_LAYER_METHODS` 的多报与 `MISSING_SCRIPT_API` 里的对应项 | 不变（去掉 39 张场景里的 `script:api:particle.*` 等键） |
| 4 | 一个系统多个 renderer：一个系统按 renderer 数组出几个 draw，sprite 与 spritetrail 共用一份顶点写入 | 107 → 108 |
| 收尾 | 文档、回归、覆盖数 | — |

## 步骤 1 — 实例覆盖挂 `{script}` 与 `rate` 的单独路径

### 思路

WPE 里字段脚本挂在 `instanceoverride` 上，返回值和脚本赋值、用户属性改值走同一个 setter（rea-p4f-script 6.2）：写进实例覆盖、调改值回调置脏，下一帧对象更新开头从基值重算（5.2、5.3）。我们这边用户属性改值早已是这条路：`SceneState` 写 `particle-instance` 目标、标脏，下一次 `sync`（在 `stepParticles` 之前）调 `ParticleSystem.setInstance` 从基值重乘、重开 `rate > 0` 的已结束发射器。所以 6 个系数与 `colorn` 只要把字段脚本的写回目标接到 `particle-instance`，时机、每帧重算、重开都和 WPE 一致（6.3：第 N 帧写的值第 N+1 帧生效，与我们的帧序等价）。

真正要改的是 `rate`。WPE 的 `rate` 没有改值回调（5.4）：单写它不置脏，下一帧直接用 `dt′ = dt·rate`，**不钳制**（写 0 整棵树冻结，实测 `b-rate0`），湍流类的 `timescale`（`turbulence`、`turbulentvelocityrandom`，条目类型 2）也不跟着变，要等别的系数被写、置脏重算时才跟上；置脏重算时才把 `rate` 钳到 0.01 并**写回**实例覆盖。我们现在把 `rate` 当普通系数：一写就整套重算（`timescale` 当场跟上）并钳到 0.01。用户属性改 `rate` 在 WPE 里是同一条路（P3 I3 已记「`rate` 无回调」），所以两条入口一起改。

所以这一步分两半：编译期给 `instanceoverride` 的字段脚本一个写回目标、能力表不再报；运行时把 `rate` 拆成「只改步进率」与「置脏重算」两件事，`sync` 里先应用前者、再做后者（同一帧都写了时，WPE 的钳制发生在重算里，结果是钳过的值）。

几个取舍：
- **只接 6 个系数与 `colorn`。** `brightness` 的脚本归步骤 2（它要先变成就地目标），`controlpointN` / `controlpointangleN` 的运行时写入归步骤 3（`instance` 对象），这几个挂脚本时照报（语料 0 处）。
- **子系统不登记**（同 P4e 步骤 1）：脚本只挂在对象的 `instanceoverride` 上，值由根系统递归下去。

### 现状锚点

**a. 能力表照报**（`compile/features.ts` 的 `checkParticleInstance`）
```ts
if (isScriptValue(value)) unsupported.add(`particle:binding:instance:${key}`); // 现状：所有键挂脚本都报
```

**b. 字段脚本没有 `instanceoverride` 的目标**（`compile/scripts.ts` 的 `targetOf`）
```ts
if (owner.kind === "layer" && key in layerTypes) return { kind: "layer", … };
// …
return { kind: "unsupported", path }; // 现状：objects/<i>/instanceoverride/<键> 落到这里，运行时只警告一次
```

**c. `rate` 和别的系数一样标脏**（`render/state.ts` 的 `write`）
```ts
if (target.kind === "particle-instance") {
  if (target.field === "colorn") values.colorn = instanceColorn(conditioned(binding, raw));
  else values[target.field] = instanceScalar(conditioned(binding, raw));
  this.dirtyParticles.add(target.object); // 现状：rate 也标脏 → sync 里整套 setInstance
```

**d. 重算时 `rate` 钳到 0.01，`timescale` 跟着乘**（`particles/system.ts`）
```ts
const MIN_RATE = 0.01;
// instanceMultipliers：rate: Math.max(MIN_RATE, instance.rate)  —— timescale 条目乘它
private applyScalars(): void {
  this.rate = f32(Math.max(MIN_RATE, this.instance.rate)); // 现状：步进率永远 ≥ 0.01
}
```

### 点 1 — 编译（`compile/scripts.ts`、`compile/features.ts`）

- **修改** `targetOf`：`owner.kind === "layer"` 且 `path === objects/<i>/instanceoverride/<键>`、键是 `alpha` / `size` / `count` / `speed` / `lifetime` / `rate` / `colorn` 时，返回 `{ kind: "particle-instance", object, field }`；值类型 `colorn` 为 `vec3`，其余 `float`。别的键照旧 `unsupported`。
- **修改** `checkParticleInstance`：上面 7 个键挂 `{script}` 不再报；`brightness`、`controlpointN`、`controlpointangleN` 挂脚本照报 `particle:binding:instance:<键>`（步骤 2、3 删）。注释同步。

### 点 2 — 状态与同步（`render/state.ts`、`render/scene.ts`）

- **修改** `SceneState.write` 的 `particle-instance`：`rate` 写值后记进新的 `rateParticles`（不进 `dirtyParticles`）；其余照旧标脏。`takeDirty` 一并交出。
- **修改** `GpuScene.sync`：先对 `rateParticles` 调 `tree.system.setRate(values.rate)`，再对 `dirtyParticles` 调 `setInstance(values)`；重算里钳过的 `rate` 写回 `SceneState.particleInstances`（WPE 写回 `io.rate`，之后脚本 `instance.rate` 读到的是钳过的值，步骤 3 用）。

### 点 3 — 模拟（`particles/system.ts`）

- **新增**
```ts
/**
 * 只改步进率（rea-p4f-script 5.4：`rate` 没有改值回调）：下一次 `step` 的 `dt′ = frameDt·rate`，不钳制、不重乘模块字段（湍流类的
 * `timescale` 仍是上一次重算时的值），不递归（子系统与实例共享根的 `dt′`）。`rate ≤ 0` 时整棵树冻结：不增龄、不发射、不移动，照画。
 */
setRate(rate: number): void;
```
- **修改** `setInstance`：开头 `instance.rate = max(0.01, rate)`（钳制写回，5.2），其余同现状；`applyScalars` 不再自己钳。
- **修改** `step` / `stepNode`：`dt′ ≤ 0` 时整棵树都不模拟；系统时间、图层时间在冻结时怎么走照 rea-p4f-script 5.4 与 rea-p4e-children 3.5（读汇编确认，写进注释）。

### 点 4 — 回放工具与案例（Claude 做）

- 回放钩子按 FR 日志的 `engine.runtime` 逐帧算出各字段脚本的返回值，下一帧开头照点 2 的顺序应用（`rate` 走 `setRate`，其余 `setInstance`）。
- 新案例 `f1`：`p4f-instance` fps 20 与 fps 60 的 10 个系统逐粒子比；`p4f-api2` 的 `rt-1` / `rt-2`（单写 `rate` 与同时写 `count`，看 `timescale` 跟不跟）。

### 验收

- 子代理：tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过（已知的失败另列），Prettier。新增单测：写回目标映射（7 个键、`brightness` 与控制点仍 `unsupported`）、能力表报与不报、`rate` 不标脏而走 `setRate`、同一帧写 `rate` 与别的系数时结果是钳过的值、`setRate(0)` 冻结整棵树、单写 `rate` 时 `timescale` 不变、每帧写同值仍重开 `rate > 0` 的已结束发射器、用户属性改 `rate` 走同一条路。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest 自跑；变异检查（`rate` 照旧标脏、`setRate` 也钳制、`setInstance` 不钳、`sync` 里两步顺序反了、脚本值当帧生效、不重开已结束发射器）。
  2. `kbp regress`（HEAD 快照 ↔ 步骤 1 快照，现有案例）逐字节相同；语料只去掉 7 个键的 `particle:binding:instance:*`，粒子覆盖 93 → 104（165 张口径），能渲染不变。
  3. 回放 `f1` 在包络内。
  4. 真机：`3809965824` 的测试副本（P4e 步骤 4 用过，删掉视频立绘）放音乐，`鼠标音乐`（`count` / `rate` / `size` / `speed` 都挂音频脚本）随音乐变化，和 WPE 同一段音乐的发射量同量级；`3706286085` 的速度线（`alpha`、`rate` 挂鼠标按下的脚本）按下左键时变化。
- 过后请用户看一眼 `3809965824` 的测试副本，再提交（连同步骤 0 的文档与 `p4f0.py`）。

### 步骤 1 实施记录（2026-11-13）

子代理在 HEAD `35b96c9d` 的快照 `ignore/p4/f1/ov` 里实现点 1–3，Claude 做点 4 与验收。之后 HEAD 进了 P8 步骤 2、P10 文档与 P6b 1e-1（`3c4f723b`），14 个文件里 7 个被改过，照 P4e 逐文件处理：HEAD 没改过的直接覆盖，改过的 `git merge-file` 三方合并；`compile/scripts.ts`（5 处）、`render/state.ts`（4 处）、`render/p3a.test.ts`（2 处）、`host.ts`（1 处）有冲突，都是 P6b 1e-1 的文本字段目标与本步的粒子实例覆盖目标在同几处各加一种，手工两边都保留（`targetOf` 多两个参数 `text`、`particle`，`DirtyState` 同时有 `texts` 与 `rates`）。合并后逐文件的增删行数与补丁相同；合并前的文件在 `ignore/p4/f1/pre-merge/`，补丁 `ignore/p4/f1/step1.patch`（14 个文件，+1070 / −45）。

**和计划的差异（子代理报告，Claude 核对后接受）：**
1. `instanceMultipliers` 也不再钳（计划只写了 `applyScalars`）：WPE 新建子系统读的是 `io` 原值（`FUN_14022f890`），钳制只在 `setInstance` 开头与顶层构造里做；调用方都已先钳，数值逐位不变。
2. 子系统构造时实例值从根系统取（原来从父取）：旧流程里各层相同，结果等价；这样 `setRate` 只改根之后，新建的事件实例读到的是 `io` 当前的 `rate`，同 WPE。
3. 加载时钳制并写回状态（读码 6.1 `0x14022b840`–`0x14022b86f`，子代理对过汇编：`maxss` 后存回 `+0x854` 再重算）：`SceneState.fromBundle`、系统构造、`createParticleTree` 三处；最后一处防单图层重建时状态里留着 `setRate` 单写的 0。
4. 不可见的冻结帧（`dt′ ≤ 0`）不更新控制点：WPE 的控制点更新在被跳过的 `FUN_140236cd0` 里。`frameDt` 缺省 0 时只看 `rate`，现有单测不受影响。
5. 顺带修了一个已有 bug：以前 `instanceoverride/alpha`、`instanceoverride/brightness` 的脚本会因为 `key in layerTypes` 落到图层自己的 alpha / brightness 上（语料 `3516174947`、`3706286085` 的 `alpha` 脚本就是这样）。现在 `instanceoverride` 路径先判断。
6. `host.ts` 的 `readScript` 加 `particle-instance`：`update(value)` 收到状态里的当前值（即 WPE 的 `io`），`colorn` 没设时给 (−1, −1, −1)。
7. 冻结时的读码（【确】）：`FUN_140230650` 每帧 `dt′ = dt·io.rate`（`0x1402307ff`），可见时图层时间照加 `dt′`（`0x140230810`）；`FUN_1402308a0` 先存回系统时间 `St += dt′`（`0x1402308c2`–`0x1402308e3`），再 `dt′ ≤ 0`（含 NaN）跳过模拟（`0x1402308dc`、`0x1402308eb`）；写顶点、拖尾采样（计时器 `subss timer, dt′`）、子系统不看 `dt′`。所以 `rate = 0` 两个时间都不动，负 `rate` 两个时间倒退、模拟照样跳过（负数没有实测）。现有实现本来就这样，只补注释。
8. 改了 3 处已有断言：`compile/p4a5.test.ts`（`count`、`colorn` 挂脚本改为不报，另加 `brightness` 挂脚本仍报）、`render/p3a.test.ts`（`takeDirty()` 多 `rates`）、`particles/noise.test.ts`（`instanceMultipliers({rate: 0.001}).rate` 改为 0.001，见差异 1）。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest / Prettier | 快照：tsc 0 error，99 个文件 2395 个用例，只有已知的 `pipeline.test.ts`「本机语料…请求次数有界」失败（Claude 自跑同子代理）；Prettier 要加 `--ignore-path <空文件>`（`ignore/` 在 .gitignore 里，缺省直接报通过），14 个文件通过。合并后的工作区：宿主 tsc 0 error，105 个文件 2545 个用例，同样只有这一条失败 |
| 新增单测 | 24 个（`compile/p4f1.test.ts` 6、`particles/p4f1.test.ts` 9、`render/p4f1.test.ts` 8、`host.script.test.ts` 1），覆盖计划清单全部各项 |
| `kbp regress`（HEAD 快照 ↔ 步骤 1 快照，17 个旧案例 + `f1` + 语料） | 17 个旧案例逐字节相同；`f1` 只在 HEAD 上失败（还报 `particle:binding:instance:*`，`rt-1` 超限）。语料 173 张只在 11 张里去掉 7 个键的 `particle:binding:instance:*`，没有新键，干净的数量不变 |
| 覆盖 | 165 张口径粒子用法完全覆盖 93 → 104、152 张口径 83 → 93，和计划相同；还挡着的只剩 `particle:instance:brightness` 3 张（步骤 2）、`particle:renderers` 1 张（步骤 4） |
| 回放 `f1`（新案例：`p4f-instance` fps 20 / 60 的 10 个系统，`p4f-api2` 的 `rt-1`、`rt-2`） | 全过：`p4f-instance` 两种 fps 位置 ≤ 3.1e-4，尺寸、颜色、alpha 差 0；`rt-1` 7.0e-4（HEAD 上 18.8 像素，`timescale` 跟着 `rate` 变了）；`rt-2` 4.6e-4。钩子照「第 f 帧写、第 f + 1 帧生效」应用，HEAD 上 7 个系数也全过，确认时机 |
| 变异（`ignore/p4/f1/mutate_f1.py`、`mutate_f1b.py`，8 处） | 全部检出：`rate` 照旧置脏、`setRate` 钳制、`setRate` 走整套重算、`setInstance` 不钳、`sync` 里 `setRate` 落在重算之后、不重开已结束发射器、7 个键照报、写回目标仍是 `unsupported`；只有「`setRate` 走整套重算」「不重开」「照报」回放也抓得到，其余只有单测（回放钩子直接调 `setRate` / `setInstance`，不经 `SceneState` 与 `sync`）；还原后树哈希相同 |
| 真机 `3809965824`（原场景，强制渲染；P9a 之后只差两个光标回调，不用测试副本） | 系统里循环放 P4e 的测试音乐：「鼠标音乐」（`count` / `rate` / `size` / `speed` 挂音频脚本）19–24 个、尺寸 18–36，WPE 同一段音乐 14–24 个、16–29（`ignore/p4/e4/out/wpe-3809965824-music-stats.json`），P4e 用静态值时只有 7–9 个；`notes1_audio_responsive` 6–8（WPE 6–8）、`Blinking Stars` 237–251（WPE 233–241）。场景频谱在动，视频立绘正常。音乐停后（中间 dev 应用被别的会话的 Rust 改动重启了一次，重开预览）频谱全 0，两个带音频的系统都是 0，`Blinking Stars` 照常，和 P4e 测到的 WPE 相同。测完删掉了强制渲染开关 |
| `3706286085` | 还差透视相机、网格、雾等 30 多项，离能看很远，没测；它的 `alpha` 脚本之前落到图层 alpha 上（差异 5） |

## 已定（2026-11-13 用户，都按推荐）

1. **粒子的深度与剔除移到 P5d。** 总计划把它放在 P4f，P5 后来定了「深度附件由 P5d 建，P4f 复用」，P5d 还没做。这三类键是所有非模型 pass 共用的检查，P5d 要一起统一；在 P4f 里去掉它们也不让任何场景干净；kabegame-sample 的 `magic_vortex_orb`（`depthtest: enabled`）随之归 P5d。
2. **HDR 下的 `brightness` 并进 P4f**（步骤 2）：读码已清楚、改动小，粒子覆盖 +3。
3. **`instance` 对象做全：** 脚本直接读写 `layer.instance.*` 的语料是 0 处，但 `instance` 在脚本 API 检查表里，不做的话用到它的场景继续报 `script:api:layer.instance`。7 个系数复用 `setInstance`，控制点写实例覆盖的静态值，按步骤 0 的读码定语义，确定性工程覆盖。
4. **一个系统多个 renderer 并进 P4f**（步骤 4）：P4c 决定 3 时语料 0 张，现在 1 张（`3465215190`）；P4e 的每帧现排与 draw 池让代价降到一步，对照数据 P4c 已抓。做完后带粒子的场景里粒子用法全部覆盖（108）。不解锁场景。

**已定（2026-11-13 用户，步骤 0 之后）：** 下面三条 WPE 的行为是 bug，不复刻（都在步骤 3）。
5. **自然结束后 `play()` 重新发射。** WPE 在整棵树不活跃时只清结束位、不复位计时，`duration` 型发射器停在 −1 不再发、`isPlaying()` 却恒真（读码 2.5，实测 `b-end-play`）。我们在整棵树不活跃时先复位发射计时（同 `stop` 的 `FUN_14022f6c0`）再重开：`duration`、`delay` 从头算，`instantaneous` 再爆发一次；仍不预热。整棵树还活跃时只清暂停位（同 WPE，也同 `d.ts`「If the particle has stopped」）。
6. **`stop()` 之后改实例系数不重新发射。** WPE 的置脏重算会重开 `rate > 0` 的已结束发射器，`stop` 过的系统因此又开始发，之后 `sys+0x3f4` 下溢、`isPlaying()` 恒真（读码 2.5、5.3，实测 `b-stop-write`）。我们让 `stop` 造成的结束只能由 `play()` 解除：重算时的重开只对自然结束（`rate·count` 变成 0 而结束）的发射器生效，`i-count0` 那种切到 0 再切回来照常恢复；`sys+0x3f4` 的下溢不复刻。
7. **脚本 `emitParticles` 建事件实例用对象的 `W`。** WPE 在脚本阶段建实例时模型栈顶是单位阵，父或子是世界空间时实例偏一个 `W`（读码 4.5，实测 `p4f-api3`）。我们和常规发射一样用对象的 `W`。语料里用到这条的 `3286859278` 父子都是本地空间，两种做法画面相同。

## 风险

1. **`play` / `stop` 的接收者多半是声音层：** 去掉「宁可多报」之后，声音层与粒子层的同名方法都按真实类型分派，认错类型的风险在运行时（代理按对象类型登记），不在编译期。
2. ~~**字段脚本的时机**~~：步骤 0 读码与实测，WPE 也是下一帧生效，与我们的帧序等价，不用挪写回点。
3. ~~**`emitParticles` 越过的门**~~：步骤 0 查清，不越过容量（满了丢弃，实测 `a-emit-cap`）。
4. **脚本发出的粒子本帧不画**（步骤 3）：WPE 在写完顶点之后才跑脚本，我们是脚本跑完才写顶点；要在脚本之前记下各系统写顶点用的存活数，或把脚本发出的粒子挂到下一帧，否则会早画一帧、年龄差一帧。
5. **和 WPE 有意不同的三处**（已定 5–7）：自然结束后 `play()` 重新发射、`stop()` 之后改系数不发射、脚本发射建事件实例用 `W`。用到这几处的场景画面会和 WPE 不同（我们是作者预期的样子）；挂了字段脚本的系统在 WPE 里 `stop` 会被下一帧的置脏撤销，我们这边保持停止。
