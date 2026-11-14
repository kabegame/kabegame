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
| 4 | 一个系统多个 renderer：一个系统按 renderer 数组出几个 draw，各绑自己的变体材质、各写各的顶点（2026-11-13 改，原写「共用一份顶点写入」，理由见步骤 4「思路」）；rope 类和别的 renderer 混挂仍报 | 107 → 108 |
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

2026-11-13 用户同意提交，连同步骤 0 的文档一起提交 `ef16dcf1`（`host.ts` 里别的会话加的 2 行没带进来）。

## 步骤 2 — HDR 下的 `instanceoverride.brightness`

### 思路

WPE 在重算实例覆盖时（`FUN_1401d15a0` 开头，rea-p4f-script 第 7 节）算 `k = (HDR && !(flags & 8)) ? brightness : 1`，再写出生时的实例颜色 `instColor = colorn·k`（`colorn` 生效时）或 `(k, k, k)`；新粒子出生先写 `instColor` 进 rgb 列，颜色 initializer 再乘上去。所以 `k` 只乘颜色三通道、不乘 alpha，有没有颜色模块都乘，在 `colorn` 之后，不钳制（实测 `p4f-bright`：`colorn` 的 (0.25, 1, 0.25) 乘 2 得 (0.5, 2, 0.5)）。我们这边出生颜色初值就是 `ParticleSystem.instanceColor`（`applyColorn` 写，P4b 步骤 6），结构相同，所以只要在算它时乘上 `k`。

HDR 位在 WPE 里只在加载时判定（P3 K3），我们也是：场景 HDR 变了整场重编译。所以 HDR 由编译期写进每个系统的定义（顶层与子系统都写），模拟器按自己的 `flags & 8` 决定乘不乘，子系统、事件实例在递归重算里同样处理。`brightness` 从「HDR 时登记成重编译目标、非默认值报不支持」改成普通的就地目标：改值置脏、下一帧重算 `instanceColor`，只影响之后出生的粒子（读码 7）。

### 现状锚点

**a. 编译期：HDR 下登记成重编译**（`compile/bundle.ts` 的 `compileParticleSystem`）
```ts
const brightnessActive = postprocess.hdr && (flags & 8) === 0;
const instanceTarget = (field: InstanceKey): BindingTarget =>
  field === "brightness" && brightnessActive
    ? recompile("layer-structure", `objects/${index}/instanceoverride/brightness`) // 现状：HDR 下改值整场重编译
    : { kind: "particle-instance", object: index, field };
```

**b. 能力表：HDR 下非默认值照报**（`compile/features.ts` 的 `checkParticleInstance`）
```ts
if (context.hdr && colorOverride && resolved.brightness !== 1) unsupported.add("particle:instance:brightness");
// 挂 `{script}` 也报 `particle:binding:instance:brightness`（`SCRIPT_INSTANCE_KEYS` 没有它）
```

**c. 模拟器：出生颜色初值不看 `brightness`**（`particles/system.ts` 的 `applyColorn`）
```ts
const state = colornState(this.def, this.instance.colorn, parent ? parent.colornGate : true);
this.instanceColor = state.instanceColor; // 现状：colorn 或 (1, 1, 1)，没有 k
```

### 点 1 — 编译（`compile/particles.ts`、`compile/bundle.ts`、`compile/features.ts`、`compile/scripts.ts`）

- **新增** `SceneParticle.hdr: boolean`：场景加载时判定的 HDR（`postprocess.hdr`），顶层与子系统都写（`compileParticleSystem` 传下去）。
- **修改** `instanceTarget`：`brightness` 一律是 `{ kind: "particle-instance", object, field: "brightness" }`，删掉重编译分支。
- **修改** `checkParticleInstance`：删掉 `particle:instance:brightness`；`SCRIPT_INSTANCE_KEYS` 加 `brightness`（挂脚本不再报）。注释同步。

### 点 2 — 模拟（`particles/system.ts`、`particles/colorn.ts`）

- **修改** `applyColorn`：
```ts
// rea-p4f-script 第 7 节：k 只在 HDR 且本系统没有 flags & 8 时取 brightness；乘在 colorn 之后、逐通道、不钳制
const k = this.def.hdr && (this.def.flags & 8) === 0 ? f32(this.instance.brightness) : 1;
this.instanceColor = state.instanceColor.map((c) => f32(c * k));
```
  - 子系统、事件实例沿用（它们的 `def.hdr` 由编译期写、`instance.brightness` 是对象的值，`flags & 8` 各看自己的）。
  - `instanceColor` 只在出生时写进颜色列，已有粒子不变（不用另做）。

### 点 3 — 回放工具与案例（Claude 做）

- 新案例 `f2`：`p4f-bright` 的「超高」与「关闭」两档逐粒子比颜色与 alpha（`b-1`、`b-05`、`b-2`、`b-2-f8`、`b-2-cn`、`b-2-a`）；回放按编译出来的 `def.hdr`，不另传。

### 验收

- 子代理：tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过（已知的失败另列），Prettier（`--ignore-path <空文件>`）。新增单测：HDR / LDR 两种下的 `instanceColor`（有无 `colorn`、`flags 8`）、alpha 不乘、改 `brightness` 只影响之后出生的粒子、子系统与事件实例各按自己的 `flags & 8`、编译期 `brightness` 是就地目标且不再报、挂脚本不报。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest 自跑；变异检查（不看 HDR、不看 `flags & 8`、乘到 alpha 上、乘在 `colorn` 之前（结果相同，作对照）、钳到 1、改值时重写已有粒子的颜色）。
  2. `kbp regress`（HEAD 快照 ↔ 步骤 2 快照，现有案例含 `f1`）逐字节相同；语料只去掉 `particle:instance:brightness`（3 张），粒子覆盖 104 → 107。
  3. 回放 `f2` 在包络内。
  4. 真机：只差 `brightness` 的三张（`2833017810`、`3286859278`、`3509243656`）都还有别的不支持项，在「超高」档下强制渲染其中一张，读 `host.particles` 的颜色确认乘了 `k`、画面没有异常。
- 过后请用户提交。

### 步骤 2 实施记录（2026-11-13）

子代理在 HEAD `ef16dcf1` 的快照 `ignore/p4/f2/ov` 里实现点 1–2，Claude 做点 3 与验收。HEAD 没动；工作区里 `compile/bindings.ts`、`bundle.ts`、`features.ts` 有别的会话未提交的改动（图层 `alignment` 等），这 3 个文件 `git merge-file` 三方合并、没有冲突，合并引入的增删行数与补丁逐文件相同；其余 8 个直接覆盖。合并前的文件在 `ignore/p4/f2/pre-merge/`，补丁 `ignore/p4/f2/step2.patch`（11 个文件，+656 / −95）。

**和计划的差异（子代理报告，Claude 核对后接受）：**
1. `checkParticleInstance` 的签名去掉了 `resolved` 与 `hdr`（原来只给 `brightness` 那条检查用，删掉后是死参数），调用方与两个测试的 helper 跟着改。
2. `k` 抽成 `particles/colorn.ts` 的 `instanceBrightness(def, brightness)`（复用 `DISABLE_COLORN`），乘法仍在 `applyColorn`。
3. `hdr` 经 `parseParticle` 的选项传入、缺省 false，现有手写夹具不用改。
4. 改了已有断言：`compile/p4a5.test.ts` 4 处（`brightness` 不再报、HDR 下也是就地目标、挂脚本不报）、`compile/p4f1.test.ts` 4 处（`SCRIPT_INSTANCE_KEYS` 变成 8 个键，`brightness` 挂脚本从照报改为写回目标）。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest / Prettier | 快照：tsc 0 error，108 个文件 2605 个用例，只有已知的 `pipeline.test.ts`「本机语料…请求次数有界」失败（Claude 自跑同子代理）；Prettier（`--ignore-path <空文件>`）11 个文件通过。合并后的工作区：宿主 tsc 0 error；全量 vitest 一次另有 `render/particles.test.ts`「切换壁纸 / 重编译…销毁渲染器全部释放」失败，单跑这个文件 65 个全过，不含本步的工作区快照与单含本步的快照副本里也都通过，按负载下的偶发记，没有再跑全量（用户定） |
| 新增单测 | 24 个（`particles/p4f2.test.ts` 15、`compile/p4f2.test.ts` 9），覆盖计划清单全部各项；子代理另对模拟器单测做了 4 处变异自检 |
| `kbp regress`（HEAD 快照 ↔ 步骤 2 快照，18 个旧案例含 `f1` + `f2` + 语料） | 18 个旧案例逐字节相同；`f2` 只在 HEAD 上失败。语料 173 张只在 3 张（`2833017810`、`3286859278`、`3509243656`）里去掉 `particle:instance:brightness`，没有新键，干净的数量不变 |
| 覆盖 | 165 张口径粒子用法完全覆盖 104 → 107；还挡着的只剩 `particle:renderers` 1 张（步骤 4） |
| 回放 `f2`（新案例：`p4f-bright` 超高档按 `ultra` 编译、关闭档按 `disabled` 编译，6 个系统） | 全过，两档颜色、alpha 差 0（HEAD 上超高档 `b-05`、`b-2`、`b-2-cn`、`b-2-a` 颜色超限、`b-1` 与 `b-2-f8` 通过）。为它给 kbp-tools 加了案例参数 `postprocess`（`replayLib.ts` 的编译按档位缓存，缺省 `disabled`，旧案例逐字节不变） |
| 变异（`ignore/p4/f2/mutate_f2.py`，7 处） | 全部检出：不看 HDR、不看 `flags & 8`、`k` 钳到 1、不乘、alpha 也乘、编译期不传 HDR（这 6 处单测与 `f2` 都抓到）、`brightness` 不在脚本键表里（只有单测）；还原后树哈希相同 |
| 真机（2026-11-13 提交 `a32a8071`） | 用户把「场景后处理」调成超高后做。工作区里别的会话未提交的 `compile/animations.ts`（P10）引用了 `scripts.ts` 里还没加的导出，宿主按工作区构建不了，所以拼一份宿主工程（`ignore/p4/f2/hostbuild`，`src` 是「HEAD + 本步」的快照副本、补上未入库的 `wpefont.wasm`），经 `KABEGAME_WPE_SCENE_OUT_DIR` 构建进 dev 的资源目录。导入 `p4f-bright`（本步之后没有不支持项、不用强制渲染）开预览截图，和 WPE 超高档抓帧的上屏画面（fp16 线性换 sRGB）在六组粒子带上逐点比：`b-05` (60, 66, 60)、`b-2` (235, 236, 235)、`b-2-cn` (173, 255, 173，泛光带光晕) 等全部相同或差 1–2 个色阶，`b-2-f8` 同基准，`b-2-a` 半透明虚线只在一个采样点上落到了空隙（时刻不同）。截图 `ignore/p4/f2/out/real-p4f-bright-ultra.png`，WPE 画面 `ignore/p4/f2/out/wpe-frames/`。测完 `projects_remove` 移除了测试行；没测还差别的项的真实场景 |

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

## 步骤 3 — `IParticleSystem` 的方法与 `instance` 对象

### 思路

粒子对象的图层代理照 P6a 给声音对象登记 `ISoundLayer` 的做法，另登记五个方法和只读字段 `instance`（rea-p4f-script 1.1–1.3）。方法落到根 `ParticleSystem` 上新开的几个入口；`instance` 是一个代理对象，24 个字段（7 个系数、`colorn`、`brightness`、`controlpoint0..7`、`controlpointangle0..7`）的读写全部经现有的 `particle-instance` 目标：写走 `SceneState.write`（和用户属性、字段脚本同一个 setter，`rate` 走步骤 1 的单独路径，下一帧生效），读取读状态里的覆盖值（没设过的控制点 x 是 FLT_MAX、`colorn` 是 (−1, −1, −1)，5.1）。控制点的运行时改值是新增的：`setInstance` 照 5.5 把覆盖写进 `cp[N]` 的 base（平移替换、角度 Z·Y·X 换 3×3，跳过 `0x10005`），递归到 static 子系统与事件实例；顺带字段脚本与用户属性也能挂在控制点覆盖上。

方法的语义照读码第 2–4 节，三处照已定 5–7 不复刻：
- `pause`：根上置「脚本暂停」位，整棵树共用（新建、复用的事件实例同样带上）。暂停时发射函数整段不跑：不发射，`delay`、`duration`、周期计时、余数都冻结，eventspawn / eventfollow 不建；模拟、判死、eventdeath 照常（2.1）。
- `stop`：根与 static 子孙的发射器全部标结束、计时复位（同不可见复位的 `resetEmitterTiming`）、图层时间清零、清全部粒子、销毁各层的活跃事件实例（空闲池保留），不清暂停位（2.3）。另记「被 `stop` 停下」：这之后置脏重算不重开发射器，只有 `play()` 能解（已定 6）。
- `play`：清暂停位；整棵树不活跃时复位发射计时、清结束位、重开（递归 static），不预热（已定 5：WPE 不复位计时，`duration` 型发射器停在 −1）。还活跃时只清暂停位（2.2）。
- `isPlaying` = 没暂停 且 `isActive()`（第 3 节）。
- `emitParticles(n)`：只认整数，0 与非整数（含缺参数）当 1、负数不发（4.1，实测 `()`、`(0)`、`(2.7)` 都是 1，`(-3)` 是 0）。在脚本阶段当场发：每个发射器各发 `n` 个，每条现算 `容量 − 存活数`，满了丢弃；没被挡的发射器（没结束、没暂停、`delay ≤ 0`）连同待发的 `instantaneous` 一起记欠账（`acc −= pending + n`），被挡的不动计时（4.3）；照常触发 eventspawn / eventfollow，建实例用对象的 `W`（已定 7）。新粒子与脚本阶段新建的事件实例**本帧不画**：WPE 在写完顶点之后才跑脚本，下一帧模拟开头它们先增龄 `dt′` 再画（4.4）。我们的帧序是脚本之后才写顶点，所以给这批粒子记「本帧脚本出生」，写顶点与 `particleSnapshot` 跳过它们，下一次 `step` 开头清掉标记。

编译期去掉对应的不支持项：`scriptApi.ts` 的 `PARTICLE_LAYER_METHODS` 宁可多报规则整条删掉（粒子层与声音层的同名方法都有了），`MISSING_SCRIPT_API` 删 `emitParticles` 与 `instance`；`checkParticleInstance` 的控制点挂脚本、绑用户属性（`particle:instance:controlpoint:user`）不再报。

不解锁场景：语料里带粒子层脚本方法键的 41 张，去掉这类键后最少还差 3 项（`ignore/p4/f2/out/regress` 的扫描）。粒子覆盖不变（107）。

### 现状锚点

**a. 编译期宁可多报**（`compile/scriptApi.ts`）
```ts
export const PARTICLE_LAYER_METHODS: readonly string[] = ["play", "pause", "stop", "isPlaying"];
// scanScriptApi：场景里有粒子层时，任意接收者上的这四个名字都报 `particle.<名>`
...methods("any", ["emitParticles"], UNIQUE),   // MISSING_SCRIPT_API 的 layer 组；字段表里还有 "instance"
```

**b. 图层代理只给声音对象登记播放方法**（`script/api.ts`）
```ts
if (this.isSoundLayer(index)) this.installSound(api, index); // 现状：粒子对象上没有 play / … / emitParticles / instance
sound?(object: number): SoundScriptTarget | null;           // 访问接口只有声音
```

**c. 发射没有暂停门、没有脚本发射入口**（`particles/system.ts` 的 `emit`）
```ts
private emit(dt: number, record = false): void {
  for (const emitter of this.emitters) {
    const count = emissionCount(emitter.state, emitter.fields, dt, this.alive, capacity, this.random, this.context.audio);
    // 现状：没有「脚本暂停」位；没有 n > 0 越过门的路径
```

**d. 控制点覆盖只在建系统时用一次**（`particles/controlpoints.ts`）
```ts
const angle = def.instance.controlpointAngles[i];   // 现状：静态值，运行中改不了
const position = def.instance.controlpoints[i];
// features.ts：控制点绑用户属性报 particle:instance:controlpoint:user，挂脚本报 particle:binding:instance:controlpoint<N>
```

### 点 1 — 模拟（`particles/system.ts`、`particles/emitters.ts`、`particles/vertices.ts`、`particles/track.ts`）

- **新增** `ParticleSystem`（只在根上调用）：
```ts
/** 脚本 `pause()`（rea-p4f-script 2.1）：置暂停位，整棵树的发射整段不跑（计时冻结），模拟照常。 */
scriptPause(): void;
/** 脚本 `play()`（2.2，已定 5）：清暂停位；整棵树不活跃时复位发射计时、清结束位、重开（递归 static），不预热。 */
scriptPlay(): void;
/** 脚本 `stop()`（2.3，已定 6）：标结束、复位计时、图层时间清零、清粒子、销毁活跃事件实例（递归），记「被 stop 停下」。 */
scriptStop(): void;
/** 脚本 `isPlaying()`（第 3 节）。 */
scriptIsPlaying(): boolean;
/** 脚本 `emitParticles(n)`（第 4 节，已定 7）：当场发，`inputs` 是这一帧的控制点输入（对象 `W` 等），新粒子与新实例本帧不画。 */
emitParticles(n: number, inputs: ControlPointInputs): void;
```
- **修改** `emit`：暂停位为真时整段跳过（含帧尾的结束判定与周期计时，以及之后的 eventspawn / eventfollow）；子系统与实例读根的暂停位。
- **修改** `emissionCount`（或新增一个兄弟函数）：支持「额外发 `n` 个、`dt = 0`」的脚本路径，门内记欠账、门外不动计时，帧尾照 4.3。
- **修改** `setInstance` 的重开：被 `stop` 停下时不重开；新增控制点覆盖的运行时写入（5.5）。
- **新增** 「本帧脚本出生」标记：`writeVertices` 与 `particleSnapshot` 跳过，下一次 `step` 开头清掉；脚本阶段新建的事件实例同样本帧不画。

### 点 2 — 脚本 API 与宿主（`script/api.ts`、`host.ts`、`render/state.ts`、`render/scene.ts`）

- **新增** 访问接口 `particles?(object): ParticleScriptTarget | null`（宿主从渲染器的根系统取，`emitParticles` 带上这一帧的控制点输入）；`installParticle` 只登记在粒子对象的图层代理上，五个方法照上面接。
- **新增** `instance` 只读字段：返回一个代理，24 个字段的 getter 读 `SceneState.particleInstances`，setter 经 `write({ kind: "particle-instance", object, field })`；`Vec3` / 数字 / `{x, y, z}` 的转换同现有图层字段。
- **修改** `particle-instance` 的字段扩到控制点覆盖（`controlpoint<N>`、`controlpointangle<N>`，vec3），`SceneState` 存覆盖值，`sync` 照旧置脏重算。

### 点 3 — 编译（`compile/scriptApi.ts`、`compile/features.ts`、`compile/scripts.ts`、`compile/particles.ts`）

- **删除** `PARTICLE_LAYER_METHODS` 与 `ScriptApiScene.particleLayers` 的多报；`MISSING_SCRIPT_API` 删 `emitParticles`、`instance`（`script/api.test.ts` 双向核对跟着过）。
- **修改** `SCRIPT_INSTANCE_KEYS` 加 16 个控制点键；`checkParticleInstance` 的控制点挂脚本、绑用户属性不再报。

### 点 4 — 回放工具与案例（Claude 做）

- 新案例 `f3`：`p4f-api` fps 20 / 60、`p4f-api2` fps 20，钩子按 `[kbpx]` 日志里的 runtime 在对应帧的脚本阶段（`observe`）调产品入口；`instance` 的 API 写入照步骤 1 在下一帧生效。按已定 5–7 和 WPE 不同的 `b-end-play`、`b-stop-write` 与 `p4f-api3` 的脚本发射对照不比（单测覆盖）。

### 验收

- 子代理：tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过（已知的失败另列），Prettier（`--ignore-path <空文件>`）。新增单测：五个方法的语义各一组（暂停冻结 `duration` 与周期计时、暂停中 eventdeath 照建、`stop` 递归清空并销毁实例、`stop` 后改系数不重开、自然结束后 `play` 复位计时重新发射、活跃时 `play` 只清暂停位、`isPlaying` 的各种状态、`emitParticles` 的参数归一化 / 欠账 / 容量 / 越过的门 / 触发 eventspawn 且用 `W` / 本帧不画下一帧增龄）、`instance` 代理的 24 个字段读写（未设控制点读 FLT_MAX、`colorn` 读 (−1, −1, −1)、写 `rate` 走单独路径）、控制点覆盖运行时写入与递归、只在粒子对象上登记、编译期不再报这些键。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest 自跑；变异检查（暂停时帧尾照跑、暂停不传给子孙、`stop` 不清实例、`stop` 后重开、`play` 不复位计时、`emitParticles` 不记欠账、越过容量、本帧就画、建实例用单位阵、`isPlaying` 不看暂停位）。
  2. `kbp regress`（HEAD 快照 ↔ 步骤 3 快照，现有案例含 `f1`、`f2`）逐字节相同；语料只去掉 `script:api:particle.*`、`*.emitParticles`、`*.instance` 与控制点的两个键，粒子覆盖不变（107），能渲染不变。
  3. 回放 `f3` 在包络内。
  4. 真机：`p4f-api` 导入 dev 库开预览，看暂停、停止、补发的样子和 WPE 抓帧一致；语料里用 `emitParticles` 发闪电的 `3286859278` 强制渲染看一眼。
- 过后请用户提交。

### 步骤 3 实施记录（2026-11-13）

子代理在 HEAD `2edac843` 的快照 `ignore/p4/f3/ov` 里实现点 1–3，Claude 做点 4 与验收。导出时 HEAD 在两次导出之间动过一次（基线先导成了 `905b4a78`），按开发副本的提交重导基线后两份一致。之后 HEAD 进了 P9b 等提交（`b42b9990`），工作区里 `compile/bundle.ts`、`features.ts`、`host.ts`、`host.script.test.ts`、`render/scene.ts` 另有别的会话未提交的改动；27 个文件里 15 个照旧直接覆盖，12 个 `git merge-file` 三方合并，冲突 8 处手工解决：
- `compile/bundle.ts` 1 处：别的会话在工作区里去掉了 `ANIMATION_PENDING`（导入与两处使用），取它那边，再套上本步的 `checkScriptFeatures(scripts.list, unsupported)`；
- `compile/scriptApi.ts` 2 处注释、`host.ts` 1 处（P9b 的 `video` 访问接口与本步的 `particles`）、`script/api.ts` 2 处（P9b 的 `IVideoTexture` 与本步的 `installParticle` / `particleInstance`）、`script/api.test.ts` 2 处导入：都是两边各加一样，全部保留。
合并引入的增删行数与补丁逐文件一致（`scriptApi.ts` 少的一行是冲突处保留了 HEAD 的那句，`api.test.ts` 多的 6 行是导入被 Prettier 拆成多行）。合并前的文件在 `ignore/p4/f3/pre-merge/`，补丁 `ignore/p4/f3/step3.patch`（27 个文件，+2240 / −204）。

**和计划的差异（子代理报告，Claude 核对后接受）：**
1. 【推】参数归一化：int32 范围内的整数原样，非整数、非数字、越界一律当 0 再按「0 当 1」发 1 个（实测只有 `()`、`(0)`、`(2.7)`、`(-3)`）。
2. 【推】`stop` → `play` 时又复位一次计时：WPE 停止期间 `delay` / `duration` 照样倒数、系统时间照样累加，这些量不为 0 或用到 `particlesystemtime` 时和 WPE 不同（实测工程都是 0）。
3. 【推】「被 stop 停下」只在 `play()` 真的重开（整棵树不活跃）时解除；`stop` → `emitParticles` → 活跃时 `play` 仍算停下。
4. 【推，计划之外】重编译与单图层重建沿用旧树的暂停 / 停止（`adoptScriptControl` / `adoptParticleScripts`），否则重建后的新树会自己重新发射。
5. 【推，计划之外】首次加载时脚本 `init` 早于渲染器建场景：这期间粒子层的方法按顺序记下，`beforeFirstFrame` 补调；这期间的 `isPlaying` 按记下的暂停 / 停止回答，退回预览图时丢掉。
6. rope / ropetrail 写段也跳过本帧脚本出生的粒子（计划只写了 `writeVertices` 与 `particleSnapshot`）。
7. 控制点覆盖用的 M 照 WPE 的 `FUN_140229760`：世界 static 子系统在这里用 `L`、模拟时是 `W·L`，只有冻结帧（`rate ≤ 0`）看得出差别。
8. 行为变化（照 rea-p4e-children 3.4）：置脏重算时对象的控制点覆盖也写进 static 子系统与池里的实例，以前子系统拿不到。`kbp regress` 18 个旧案例逐字节相同，没有受影响的。
9. 【推】控制点的条件绑定得到布尔值时取 null（未设），不另报。
10. `emitParticles` 用 `inputs.world` 作执行上下文的模型矩阵、原点与建实例的 `top`；场景时间与图层时间取根最近一次步进的；`instance` 整体赋值忽略。
11. 改了已有断言：`compile/sounds.test.ts`（播放控制不论有没有粒子层都不报）、`script/api.test.ts`（夹具加粒子层，方法只在声音层与粒子层上有、`emitParticles` / `instance` 只在粒子层上有）、`compile/p4a5.test.ts`、`compile/p4f1.test.ts`（控制点挂脚本、绑用户属性不报，`SCRIPT_INSTANCE_KEYS` 24 个）、`particles/lifecycle.test.ts`（实例值多两张控制点表）。
12. 过程问题：子代理又误跑了一次空 heredoc 的 `python -X utf8 -I -`（只起交互解释器、读到 EOF 退出，没执行代码）；用 Python 写的 5 个测试文件变成了 CRLF，已转回 LF（补丁里 0 个 CR）。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest / Prettier | 快照：tsc 0 error，116 个文件 2805 个用例，只有已知的 `pipeline.test.ts`「本机语料…请求次数有界」失败（Claude 自跑同子代理）；Prettier（`--ignore-path <空文件>`）27 个文件通过。合并后的工作区：宿主 tsc 0 error，本步相关的 15 个测试文件 268 个用例全过（没跑全量） |
| 新增单测 | 50 个（`particles/p4f3.test.ts` 28、`script/p4f3.test.ts` 8、`compile/p4f3.test.ts` 5、`render/p4f3.test.ts` 7、`host.script.test.ts` 2）；子代理另做 25 处变异自检，全部检出 |
| `kbp regress`（HEAD 快照 ↔ 步骤 3 快照，18 个旧案例 + `f1` + `f2` + `f3` + 语料） | 18 个旧案例逐字节相同；`f1` 只差一行不支持项列表（`p4f-api2` 不再报脚本方法键，两边都在放行规则内）；`f3` 在 HEAD 上跑不下去（没有这些入口）。语料 183 张里 41 张不同，只去掉 `script:api:particle.play` 39、`stop` 30、`pause` 16、`isPlaying` 8 与 `layer.emitParticles` 1，没有新增的键，干净的数量不变 |
| 覆盖 | 粒子用法完全覆盖不变（107）；不解锁场景 |
| 回放 `f3`（新案例：`p4f-api` fps 20 / 60、`p4f-api2` fps 20） | 全过：各系统逐粒子位置 ≤ 6.7e-4、其余差 0；`isPlaying` 和 WPE 日志逐条相同（两种 fps 共 724 条）；脚本发射建的 eventspawn 实例 `b-spawn-c` 对上。钩子读 `[kbpx]` 事件、窗口之后的事件跳过；为它给 kbp-tools 的 `observe` 加了第 6 个参数（这一帧的控制点输入），`f1`、`f2` 在 HEAD 上照样全过 |
| 变异（`ignore/p4/f3/mutate_f3.py`，10 处） | 9 处检出：暂停时照跑、`isPlaying` 不看暂停、`stop` 不清粒子、`play` 不重开、参数四舍五入、不记欠账（这 6 处单测与 `f3` 都抓到）、`stop` 不记停下、本帧就进快照、建实例用单位阵（只有单测）。`no-capacity`（门外不钳容量）是等价变异：`spawn` 找不到空槽就返回、连随机数都不抽 |
| 真机 | 宿主按工作区构建。`p4f-api` 导入 dev 库、强制渲染开预览（它的帧号脚本读光标、报 `input.cursorScreenPosition`），8 s 里各系统的存活数按 4 s 周期循环、和脚本时间表一致：`a-stop` 停止时清成 0、`play` 后从 1 涨到 14，`a-emit-stopped` 停止后补发 2 个、之后的 `play` 因为还有粒子活着只清暂停位（同 WPE），`a-tree` 连子系统一起清空再恢复，`a-emit-cap` 一直是容量 8。`3286859278` 的 `Thunderbolt` 脚本第一帧就因 `input is not defined`（光标输入 API，别的阶段）被禁用，`emitParticles` 不会被调到，测不到。打开预览替换了用户主窗口里原来开着的预览（13616）。测完删掉强制渲染开关、`projects_remove` 移除测试行 |

### 没测到的（步骤 0–3，2026-11-13 记）

下面这些只有单测或读码，没有 WPE 对照或真机，收尾时再走查一遍，语料用得到的要补实测：

**步骤 1（实例覆盖挂脚本、`rate`）**
- 负的 `rate`：照汇编两个时间倒退、模拟跳过，没有实测。
- 真机只看了 `3809965824`；`3706286085`（`alpha`、`rate` 挂鼠标按下的脚本）还差三十多项，没测。
- 合并后的工作区没跑全量 vitest（步骤 2、3 同样只跑了相关文件）。

**步骤 2（HDR 下的 `brightness`）**
- 真实场景（`2833017810`、`3286859278`、`3509243656`）都还差别的项，没在真机上看；只有确定性工程 `p4f-bright` 和 WPE 逐像素比过。
- `brightness` 挂字段脚本、运行中改值只有单测（WPE 读码：只影响之后出生的粒子）。

**步骤 3（`IParticleSystem` 与 `instance`）**
- 语料里唯一用 `emitParticles` 的 `3286859278`：`Thunderbolt` 脚本第一帧因 `input is not defined` 被禁用，真机调不到；`3570560686`（`particles.emitParticles(4)`）没看。
- 已定 5–7 有意和 WPE 不同，只有单测：自然结束后 `play` 复位计时重新发射（`b-end-play`）、`stop` 后改系数不重开（`b-stop-write`）、脚本发射建实例用 `W`（`p4f-api3` 只抓了 WPE 的单位阵行为，没有「用 `W`」的对照）。
- 子代理按推断定的（都只有单测）：
  - 参数归一化只实测了 `()`、`(0)`、`(2.7)`、`(-3)`；−2.5、2³¹ 这类没测；
  - `stop` → `play` 时又复位一次计时，停止期间 `delay` / `duration` 不为 0 或用到 `particlesystemtime` 时和 WPE 不同；
  - 「被 stop 停下」只在 `play` 真的重开时解除（`stop` → `emitParticles` → 活跃时 `play` 仍算停下）；
  - 重编译、单图层重建沿用旧树的暂停 / 停止；
  - 首次加载时 `init` 里调的方法先记下、`beforeFirstFrame` 补调；
  - 控制点的条件绑定得到布尔值时取 null。
- 控制点覆盖的运行时写入只实测了顶层系统（`a-inst-cp`）；写进 static 子系统与事件实例（置脏重算时递归，同 rea-p4e-children 3.4）、世界 static 子系统在冻结帧上用 `L` 的那处，只有单测。`controlpointangleN` 的读写没有实测。
- rope / ropetrail 跳过本帧脚本出生的粒子只有单测。
- 读码列了但没做、没测的：`stop` 后同一帧 `emitParticles` 会把旧顶点画一帧（rea 4.4【推】，不复刻）；图层图像发射器（类型 3）在脚本阶段的位置（4.4【推】）；脚本发出的粒子 `inheritcontrolpointvelocity` 读到 0（4.4【推】）；对象不可见时 `emitParticles` 发出的粒子下一帧被复位清掉（4.6）。
- 暂停中 eventdeath 建出的实例带暂停位、`play` 后才发，只有单测。

## 步骤 4 — 一个系统多个 renderer

### 思路

WPE 对一个系统的 renderer 数组逐条各画一次（rea-p4f-script 8.3）：每条有自己的变体材质（同一个基础材质按 renderer 类型加宏，8.1），绘制前按**这一条**的 `orientation` / `axis` 算 `g_Orientation*`，拖尾那条另写 `g_RenderVar0.xyz`；sprite 与 spritetrail 共用一份每帧写一次的顶点缓冲，速度为 0 的粒子在拖尾那次绘制里四角是 NaN、被丢掉（8.3，`p4f-multi` 的 `m-st-zero` 实测）。子系统、事件实例规则相同（8.4）。所以多 renderer 在我们这边就是「一个系统出几个 draw」：P4e 已经把粒子层改成每帧沿系统树现排、按模板池化 draw，这一步把模板从「一个系统」细分成「一个系统的一个 renderer」，每个 renderer 一个计划步骤、一份变体 pass、一组 draw。

**各写各的顶点，不共用缓冲（改了定稿表的说法）。** 共用只是 WPE 省一次写入，画面上看不出：两个 draw 读的是同一批存活粒子、同一个槽序。我们现在每个 draw 自己持有顶点（`ParticleDraw.vertices` 与缓冲），拖尾 draw 写顶点时就跳过退化的粒子（`trailDrawable`，不靠 GPU 丢 NaN 图元）。要共用，就得把顶点从 draw 上拆出来给同一系统的几个 draw 共享、给拖尾 draw 另建逐帧的索引缓冲来跳过退化粒子，还要保证两个变体的顶点布局逐项相同；这些全是为语料里唯一的一处（`3465215190` 的 `Snow`，另差 18 项、不能渲染）多写的结构。各写各的，每个 draw 的写法和现在单 renderer 时完全一样，单 renderer 的系统逐字节不变，代价是多 renderer 的系统多写一次顶点。以后要是有能渲染的场景在这上面费时，再按 rea 8.2 改成共用。

**rope 类和别的 renderer 混挂仍报 `particle:renderers`。** rope 与 ropetrail 的缓冲、rope 表、拖尾历史是系统级的（8.2：rope、ropetrail 各一份，两个 ropetrail 共用一份历史、段数与间隔取第一条；两类共用 `sys+0x30` 的 `K`），多条 rope 类记录各自的参数怎么作用到同一份缓冲上没追，也没有抓帧；语料 0 处。支持范围是任意条数的 sprite / spritetrail（实测过的组合：T8、T8r、`m-st-zero`、`m-ss`、`m-child`）。

细节照 WPE：
- **厚格式看整个系统**（8.1，rea-p4b-render 2.4）：系统里有 spritetrail（或槽 0 是帧表）时，同系统的 sprite 变体也写 `THICKFORMAT`、顶点带速度列（T8：sprite 那次有 `THICKFORMAT = 1`、没有 `TRAILRENDERER`）；`TEX0FORMAT` 跟着走厚格式的规则（只看格式 8–11，不看朝向）。轨迹的 `thick` 列同样按系统判断。
- **顺序**：一个系统的各 renderer 按数组顺序连着画，画完才轮到子系统（8.3 的循环在递归之前）。快照照旧是每对象至多一次、在先序里第一个要帧缓冲的系统之前（同一个基础材质，各变体的 `framebuffer` 相同）。
- **`g_RenderVar0`**：WPE 是全局的、没写的分量留着上一次绘制的值（8.3）；sprite 变体与非 `TRAILRENDERER` 变体不读它，所以不复刻残值，sprite 那次照旧写 0（同现在的单 sprite）。
- **退化粒子**：sprite 那次画、拖尾那次不画，就是各自现在的写法。

稳定键：第一个 renderer 的变体沿用 `objects/<i>/particle/passes/<k>`（单 renderer 系统的键、常量、管线缓存都不变），第 r 个（r ≥ 1）是 `objects/<i>/particle/renderers/<r>/passes/<k>`（子系统同样接在自己的键后面）。材质常量的用户属性绑定按 pass 键登记（`shaderUniforms`），两个变体各登记一份，改值时都写到；粒子材质里没有字段脚本与关键帧（它们只挂在 scene.json 的 effect pass 上，`owner.pass` 比的是 effect 的键）。

覆盖：去掉 `particle:renderers` 后 `3465215190` 粒子用法干净，107 → 108（带粒子的场景全部覆盖）；不解锁场景。

### 现状锚点

**a. 能力表：两个以上 renderer 一律报**（`compile/features.ts:1374`，`checkParticleFeatures`）
```ts
if (category === "renderer" && entries.length > 1) unsupported.add("particle:renderers"); // 现状：sprite + spritetrail 也报
```

**b. 只解析第一个 renderer，材质只编一份**（`compile/particles.ts:519`、`compile/bundle.ts` 的 `compileParticleMaterial`）
```ts
const module = renderers.find((item) => DRAWN_RENDERERS.has(item.name)); // 现状：第一个表内的 renderer，其余忽略
// compileParticleMaterial：
const sheetSystem: ParticleSheetSystem = { flags, animationMode: particle.animationMode, renderer: particle.renderer };
for (const [k, pass] of material.passes.entries())
  particle.passes.push(await compilePass(pass, { key: `${key}/passes/${k}`, particle: sheetSystem })); // 现状：一份 pass
```

**c. 厚格式按单个 renderer 判断**（`compile/bundle.ts` 的 `particleDefines`、`particles/track.ts:120`）
```ts
const thick = rope || system.renderer?.kind === "spritetrail" || !!texture?.sheet; // 现状：sprite 不知道同系统有拖尾
const thick = system.def.spriteSheet || system.def.renderer?.kind === "spritetrail";  // track.ts，同上
```

**d. 每个系统一个计划步骤**（`render/graph.ts:429`，`planParticleLayer`）
```ts
if (system.renderers.length)
  steps.push({ kind: "particles", pass, /* … */ node, world: (system.flags & 1) !== 0, instanced }); // 现状：一个系统一步
```

**e. 渲染器按模板路径取模板，uniform 与几何读系统的 renderer**（`render/scene.ts`）
```ts
const template = tree.templates.get(path.join("/"));        // walkParticles：一个模板路径一个模板、一个 draw 池
draw(template.pool[0]);                                     // arrangeParticles：每个系统画一次
const renderer = particles.system.def.renderer;            // refreshParticleGeometry：朝向 NaN、拖尾眼位
renderer: layer.particle ? particleNode(layer.particle, step.node).renderer : undefined, // uniformValues：g_Orientation*、g_RenderVar0
```

**f. 四角探针按图层出一项**（`dev/particleCorners.ts`、`render/scene.ts` 的 `particleProbe(object, node, occurrence)`）
```ts
const probe = scene.particleProbe(object);   // 现状：顶层系统、第一个 draw；没有 renderer 维度
```

### 点 1 — 编译（`compile/particles.ts`、`compile/bundle.ts`、`compile/features.ts`）

- **修改** `checkParticleFeatures`：只在表内 renderer 多于一个、且其中有 rope 类时报 `particle:renderers`。
```ts
// 修改：sprite / spritetrail 任意条数支持（P4f 步骤 4）；rope 类的缓冲、rope 表、拖尾历史是系统级的，和别的 renderer 混挂没测，照报
const drawn = entries.filter((entry) => DRAWN_RENDERERS.has(entry.name));
if (category === "renderer" && drawn.length > 1 && drawn.some((entry) => isRopeRenderer(entry.name))) unsupported.add("particle:renderers");
```
- **新增** `SceneParticle.draws`，**修改** `renderer` 的含义：
```ts
/**
 * 绘制（P4f 步骤 4，rea-p4f-script 8.3）：表内的每个 renderer 一项，JSON 顺序，各画一次；`renderer: []` 时为空。只有表外类型
 * （已报）时按缺省 sprite 画一项，同现在强制渲染的画法。
 * `passes` 是这一条的变体材质：第 0 项就是 `SceneParticle.passes`（同一个数组），第 r 项（r ≥ 1）的稳定键
 * `<系统键>/renderers/<r>/passes/<k>`。
 */
draws: { renderer: ParticleRenderer; passes: ScenePass[] }[];
/**
 * 模拟用的 renderer（修改）：有 rope 类时是第一个 rope 类（rope 表与拖尾历史跟它建），否则是第一个表内的，一个都没有时缺省 sprite。
 * 支持的组合里 rope 类总是唯一的 renderer，所以和以前「第一个」相同；强制渲染 rope 混挂时模拟仍有 rope 表。
 */
renderer: ParticleRenderer;
/** 系统的 sprite 缓冲是厚格式（WPE 系统标志 `0x3000000`，rea-p4f-script 8.2）：有 spritetrail，或槽 0 是帧表。 */
// 新增导出函数，bundle 的宏与 track.ts 共用
export function particleThick(def: Pick<SceneParticle, "spriteSheet" | "draws">): boolean;
```
  > 说明：`spriteSheet` 在编完材质之后才定，宏那边按 `texture?.sheet` 判断帧表，只从 `draws` 取「有没有 spritetrail」。
- **修改** `ParticleSheetSystem` **新增** `trail: boolean`（系统里有 spritetrail），`particleDefines` 的厚格式：
```ts
const thick = rope || system.renderer?.kind === "spritetrail" || system.trail || !!texture?.sheet; // 修改：同系统有拖尾时 sprite 也厚
```
  > 说明：sprite 分支在厚格式时写 `THICKFORMAT = 1`（rea-p4b-render 2.4 的写法，现在只有帧表会走到）；`particleTex0Format` 收到的 `thick` 跟着变。
- **修改** `compileParticleMaterial`：每个 `draws` 项编一份变体，第 0 项沿用现在的键，`renderer: []` 时照旧按缺省 sprite 编一份放进 `passes`（只给「有没有材质」「要不要帧缓冲」用）。
```ts
const trail = particle.draws.some((draw) => draw.renderer.kind === "spritetrail");
const variants = particle.draws.length ? particle.draws : [{ renderer: particle.renderer, passes: particle.passes }];
for (const [r, draw] of variants.entries()) {
  const sheetSystem: ParticleSheetSystem = { flags, animationMode: particle.animationMode, renderer: draw.renderer, trail };
  const base = r === 0 ? key : `${key}/renderers/${r}`;
  for (const [k, pass] of material.passes.entries())
    draw.passes.push(await compilePass(pass, { key: `${base}/passes/${k}`, particle: sheetSystem }));
}
// 第 0 项和 `particle.passes` 是同一个数组（parseParticle 建 draws 时就这样连起来）
```

### 点 2 — 计划（`render/graph.ts`）

- **修改** `ParticleStep` **新增** `renderer: number`（`draws` 下标），`planParticleLayer` 每个系统按 `draws` 顺序出步骤，每步用自己那一项的 `passes[0]`：
```ts
visitParticleTemplates(particle, (system, node, instanced) => {
  const pass = system.passes[0];
  if (!pass) return false;
  // 修改：一个 renderer 一步，数组顺序（8.3）；`draws` 为空（`renderer: []`）时不出步骤，照常列子系统
  system.draws.forEach((draw, renderer) => {
    const variant = draw.passes[0];
    // 强制渲染 rope 混挂：只画模拟跟着建的那条 rope 类（`SceneParticle.renderer`），别的 rope 类跳过
    if (isRopeRenderer(draw.renderer.kind) && draw.renderer !== system.renderer) return;
    steps.push({ kind: "particles", pass: variant, /* inputs、blending、raster 照旧取 variant */ node, renderer, world, instanced });
  });
});
```
  > 说明：`render:multi-pass` 与运行时纹理的检查照旧对每一步做。`particleTreeWantsFramebuffer` 不变（看基础 pass）。

### 点 3 — 渲染（`render/scene.ts`）

- **修改** 模板：键仍是模板路径，一个模板带这个系统的全部 renderer 步骤，池里每一项是一次出现的一组 draw（每个 renderer 一个）：
```ts
interface ParticleTemplate {
  /** 这个系统的各 renderer 步骤与预备好的管线，`draws` 顺序（P4f 步骤 4）。 */
  renderers: { step: ParticleStep; prepared: PreparedDraw }[];
  /** 第 k 次出现用第 k 组（每组按 renderer 顺序各一个 draw）；非实例化的模板建场景时建第 0 组。 */
  pool: Draw[][];
  instanced: boolean;
}
```
- **修改** `arrangeParticles`：一个系统的一组 draw 按顺序连着画，再走子系统（`walkParticles` 的回调里画完整组，子孙由 `forEachDrawn` 之后访问，顺序就是 8.3）；实例化模板换实例时整组 `assignParticles`。
- **修改** `ParticleDraw` **新增** `renderer: ParticleRenderer`（这一步的 `draws[step.renderer].renderer`）；`refreshParticleGeometry`、`uniformValues` 的粒子分支、`createParticles` 的拖尾判断都读它，不再读 `system.def.renderer` / `particleNode(...).renderer`。
```ts
const renderer = particles.renderer;   // 修改：这次绘制自己的 renderer（8.3：朝向按各自记录算）
renderer: particleNode(layer.particle, step.node).draws[step.renderer].renderer, // uniformValues：g_Orientation*、g_RenderVar0
```
- **修改** 标签：`renderer ≥ 1` 的 draw 在标签末尾加 ` r<r>`，第 0 个不变。
- **修改** `particleProbe(object, node, occurrence, renderer = 0)`；`checkRenderable` / `planProblems` 的粒子属性检查按步骤自己的 renderer（`particleAttributeProblems`）。
- **修改** `particles/track.ts` 的 `thick` 用 `particleThick(def)`；`particles/system.ts`、`rope.ts`、`ropetrail.ts` 读 `def.renderer` 的地方不改（含义见点 1）。
- **修改** `dev/particleCorners.ts`：每个粒子层按顶层系统的 `draws` 各出一项，第 r 项（r ≥ 1）带 `renderer: r`，第 0 项和现在逐字节相同。
  > 说明：这个文件工作区里有别的会话未提交的改动（+35 / −7），合并时三方合并。

### 点 4 — 回放工具与案例（Claude 做）

- `kbp corners offline` 与 `kbp rdc track` 的轨迹里，同一系统的第二次绘制叫 `<名字>#2`（`p4f-multi` 的 `kbp-meta.json` 记了每个对象的 `draws`）。工具按 `draws` 把 `#2…#n` 认成同一系统的第 2…n 个 renderer：四角比对应 renderer 的变体，粒子输入核对 n 份相同（共用缓冲）。
- 新案例 `f4`：`p4c-trail`（fps 60，T8、T8r 起比）、`p4f-multi`（fps 20 / 60），只比四角与整帧，轨迹沿用 `c` 系列（模拟不变）。

### 验收

- 子代理：tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过（已知的失败另列），Prettier（`--ignore-path <空文件>`）。新增单测：
  - 编译：sprite + spritetrail 两种顺序各编两份变体，sprite 那份有 `THICKFORMAT`、没有 `TRAILRENDERER`、`TEX0FORMAT` 按厚格式规则；两个 sprite 不同朝向时非厚格式的 `TEX0FORMAT` 各按各的朝向；稳定键（第 0 个不变、第 r 个带 `renderers/<r>`）；材质常量绑用户属性时两份都登记；子系统同样；只有 rope 混挂报 `particle:renderers`；单 renderer 系统的 pass（键、宏、程序、常量）和改动前相同（bundle 只多出 `draws` 字段）。
  - 计划：步骤按 `draws` 顺序、父的各 renderer 在子系统之前；`renderer: []` 不出步骤；强制渲染 rope 混挂只出模拟那条 rope 类。
  - 渲染（假设备）：每帧绘制序列（父 r0、父 r1、static 子 r0、r1、实例……），实例化模板的整组复用与换实例；`g_Orientation*` 各按各的 renderer、拖尾那次 `g_RenderVar0.xyz` 是自己的参数、sprite 那次是 0；速度 0 的粒子 sprite 那次写、拖尾那次不写；朝向 NaN 只跳过那一个 draw；单 renderer 层的 draw、标签、uniform 字节和改动前相同。
  - 轨迹：sprite + spritetrail 系统的 sprite 也带 `thick`。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest 自跑；变异检查：sprite 不随系统变厚、两次绘制都用第一个 renderer 的朝向、renderer 顺序反过来、拖尾那次不跳退化粒子、子系统只画第一个 renderer、整组画完才画子系统改成先画子系统、第 r 个变体沿用第 0 个的键。
  2. `kbp regress`（HEAD 快照 ↔ 步骤 4 快照，现有案例含 `f1`–`f3`）逐字节相同；语料只有 `3465215190` 去掉 `particle:renderers`，粒子覆盖 107 → 108，能渲染不变；单 renderer 场景的粒子 pass 键与宏不变（`kbp corpus diff` 的附加字段核对）。
  3. 四角（`f4`）：T8、T8r、`m-st-zero`、`m-ss`、`m-child` 每个 renderer 的四角和 WPE `gs_out` 比，限 0.01 像素；`m-st-zero` 拖尾那次 WPE 是 NaN、我们不写。
  4. 整帧：`renderFrame` 确定性回放 `p4f-multi`、`p4c-trail` 的抓帧时刻，和 WPE 整帧比（`kbp cmp frame`，按 bbox 归类），差在 P4c 的包络内。
  5. 真机：`p4f-multi` 导入 dev 库、强制渲染开预览，截图看两次绘制都在、顺序对；`3465215190` 强制渲染看 `Snow` 的雪花与拖尾。测完删强制渲染开关、`projects_remove` 移除测试行。
- 过后请用户提交。

### 步骤 4 实施记录（2026-11-14）

子代理在 HEAD `d58a7048` 的快照 `ignore/p4/f4/ov` 里实现点 1–3，Claude 做点 4 与验收。补丁 `ignore/p4/f4/step4.patch`（14 个文件，+1582 / −144）。合并时 HEAD 已到 `7cbde3c6`：12 个文件 HEAD 没动、工作区干净，照拷；`compile/bundle.ts`、`dev/particleCorners.ts` 被别的提交改过（P11a 的 `+3`、回放跑脚本的 `+159`），`git merge-file` 三方合并，没有冲突，合并引入的增删行数与补丁逐文件一致。合并前的文件在 `ignore/p4/f4/pre-merge/`。

**和计划的差异（子代理报告，Claude 核对后接受）：**
1. 【推】新增 `particleDraws(system)`，计划、渲染器、四角探针都经它读 `draws`：已有十几个测试在解析之后整个换掉 `particle.passes`，第 0 项总读 `passes` 才不会拿到换掉之前的空数组；没有 `draws` 的手写定义（`p5d-depth.test.ts`、`p8.test.ts`）按以前的规则画一次。编译出来的定义两种情况都碰不到。
2. 【推】强制渲染 rope 混挂时按下标跳过别的 rope 类（和第一个 rope 类的下标比），不按计划比对象：bundle 经 JSON 往返后对象不再是同一个。
3. 【推】`render:multi-pass` 与运行时纹理的不支持项仍按基础 pass、每个系统查一次（各变体是同一个材质，逐步查会让单 renderer 的 reasons 也变）；每一步的 `inputs` 按自己的变体算。
4. 【推】`ParticleSheetSystem.trail` 可选；另导出 `hasSpriteTrail`：宏在编完材质之前定，那时 `spriteSheet` 还不知道，`particleThick = spriteSheet || hasSpriteTrail`。同系统有拖尾的 sprite 的 `THICKFORMAT` 写在 `particleRendererDefines` 里，有帧表时 `particleSheetDefines` 再写一遍同值。
5. 【推】表外 renderer 不计条数：`[foo, rope]` 只报 `particle:renderer:foo`。
6. 计划之外：`render/state.ts` 的 `SceneState.constants` 加上第 r 个变体的 pass 键（否则变体的材质常量与属性写入落不到它上面）；`uploadableTextures` 也过一遍变体；ropetrail 的 `g_RenderVar0` 按这次绘制的 renderer 写（强制混挂时 sprite 那次不再写它）。
7. 改了两处已有测试：`compile/particles.test.ts` 的 `[sprite, sprite]`、`[sprite, spritetrail]`、`[spritetrail, sprite]` 不再报 `particle:renderers`（计划要的变化）；`render/events.test.ts` 的辅助函数改成 `pool.flat()`（池现在每次出现一组），断言没动。
8. 过程问题：子代理在一条 grep 命令里误写了 `cat > /tmp/…`，在 `/tmp` 建了一个空文件，下一条命令删掉了。Claude 一侧：验收时为占位跑了一条空的 `python -X utf8 -I -c ""`（违反约定，没执行任何代码）；核对行数时用 `git add -N` 往共享暂存区加了三个新测试文件的占位项，随即 `git reset` 撤掉，暂存区恢复为空。

**点 4 的做法和计划不同：** 没建回放案例 `f4`（模拟不变，轨迹沿用 `c` 系列）。改的是 `kbp corners offline`：同一系统的第 r + 1 次绘制 `名字#<r + 1>` 对产品的 `draws[r]`，P4e 起的源码另按 `forEachDrawn` 比 static 子系统（名字取 `kbp-meta.json` 的 `children`）；源码没有 `draws` 时只比第一个 renderer。工具改动在 HEAD 快照上和改之前逐行相同（p4c-trail、p4c-sprite、p4d-rope、p4f-multi，只多出 `m-child-c` 的 5 帧、差 0）。另外回归里 `e4` 两边都失败：案例要求编译「必须报」`uniform:g_AudioSpectrum*`，P11a 步骤 1（`94f5998f`）实现了这几个 uniform 之后不再报；案例改成 `allow`（只许出现这几个），P11a 前后的源码都通过。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest / Prettier | 快照：tsc 0 error，134 个文件（2 个跳过）3166 个用例，3124 通过、42 跳过、0 失败（Claude 自跑，已知的 `pipeline.test.ts` 这次也通过）；Prettier 14 个文件通过。合并后的工作区：宿主 tsc 0 error，本步相关的 12 个测试文件 342 个用例全过（没跑全量） |
| 新增单测 | 31 个（`compile/p4f4.test.ts` 15、`render/p4f4.test.ts` 14、`particles/p4f4.test.ts` 2）；子代理另在同一进程里加载两份源码，逐字节核对单 renderer 的编译结果（去掉 `draws` 后的 bundle 与翻译请求）和 8 帧渲染（全部缓冲、管线、探针输出）相同 |
| `kbp regress`（HEAD 快照 ↔ 步骤 4 快照，20 个案例 + 语料） | 20 个案例逐字节相同（`e4` 两边同样失败，原因见上，改案例后两边都过）；语料 183 张里只有 `3465215190` 不同，只去掉 `particle:renderers`，没有新增的键 |
| 覆盖 | 粒子用法完全覆盖 107 → 108（带粒子的场景全部覆盖）；能渲染不变 |
| 离线四角（`p4c-trail`、`p4c-sprite`、`p4d-rope`、`p4f-multi` fps 20 / 60） | 65 个系统、不符 0 处：T8、T8r 两个 renderer 的四角都差 0；`m-st-zero#2`（拖尾、速度 0）我们不写顶点、WPE 四角全是 NaN；`m-ss#2`（第二个 sprite，`fixed`、`axis 1 0 0`）、`m-child-c` / `m-child-c#2`（子系统的两个 renderer）差 0；两个工程不再报 `particle:renderers` |
| 变异（`ignore/p4/f4/mutate_f4.py`，9 处） | 全部检出、快照按原字节还原。改变体宏的那处（每个变体都按模拟用的 renderer 编）单测与四角都抓到（T8#2 差 60 像素）；其余 8 处（sprite 不随系统变厚、第 r 个变体沿用第 0 个的键、能力表回到「多于一个就报」、步骤倒序、子系统只出第一个、uniform 按第一个 renderer、几何按模拟用的 renderer、轨迹 `thick` 旧规则）只有单测抓到：离线四角自己算 uniform，看不到渲染器里的改动 |
| 整帧（真机宿主按工作区构建，`render_scene` 确定性回放，和 WPE 的 Present 比） | `p4c-trail` 第 922 帧、`p4f-multi` fps 60 第 789 帧整帧 0 差异。`p4f-multi` fps 20 第 278 帧差 25 个像素（最大 196），都在 `m-ss` 旋转 sprite 的两条斜边上：第 251–275 帧日志与轨迹都没有、时间线只能平分，粒子出生时刻跟着偏，这一帧 x 是 51.84（WPE 52.30），斜边错开一列，和绘制无关 |
| 真机 | `3465215190`（Rainy Day）强制渲染出图正常，`Snow` 159 颗，不支持项里没有 `particle:renderers`。宿主产物按工作区重建过（`target/debug/resources/wpe-scene`）。测完 `projects_remove` 移除两条测试行（`p4f-multi`、`p4c-trail`），没有设强制渲染开关 |

2026-11-14 用户同意提交 `79800ab7`，并要求用 `TODO:[WPE_SCENE]` 标注没确定的 Rainy Day 测试（`compile/features.ts` 的多 renderer 规则处）。

### 没测到的（步骤 4，2026-11-14 记）

- `Snow` 只看了强制渲染的一帧，没和 WPE 抓帧比：这张另差 18 项，不能渲染，画面整体本来就和 WPE 不同。代码里在 `compile/features.ts` 的多 renderer 规则处标了 `TODO:[WPE_SCENE]`（2026-11-14 用户），这张能渲染之后抓帧对比。
- 渲染器侧（uniform、几何、绘制顺序）只有单测和三帧整帧对比，离线四角看不到；实例化模板（事件子系统）挂多个 renderer 只有单测，测试工程里没有。
- 帧表系统（`spriteSheet`）与 spritetrail 混挂、两个朝向不同的非厚格式 sprite 的 `TEX0FORMAT`（格式 8–11 以外）只有单测。
- rope 类与别的 renderer 混挂仍报 `particle:renderers`，强制渲染时只画第一个 rope 类，没有 WPE 对照。
- `g_RenderVar0` 的残值（WPE 是全局、没写的分量留着上一次绘制的值）不复刻，按读码不影响画面（sprite 变体不读它），没有实测。
- 多 renderer 系统每帧多写一次顶点，开销没量。

## P4f 收尾（2026-11-14）

**文档**：`cocs/wpe/WPE_SCENE.md` 新增「粒子（P4f）」一节，改掉各节里「P4f 照报」的旧说法（能力表的 `particle:renderers`、`particle:instance:*` 两行，`instanceoverride` 就地生效、`colorn`、P4c 的多 renderer、P4e 的「还挡着的键」、P6a 的 `PARTICLE_LAYER_METHODS`、未实现 API 清单里的 `emitParticles`）；`cocs/README.md` 加 P4f 条目与适用场景；changelog 用户侧、开发侧各一条；回归文档新增「场景壁纸 P4f」一节（F1–F17）；总计划 `phase-4-particles.md` 补「完成情况」。

**「没测到的」走查**：先看语料用不用得到，用得到的补测，用不到或测不了的记下理由。语料扫描脚本 `ignore/p4/f4/scan_unverified.py`、`rate_scripts.py`（只读）。

| 项 | 语料 | 结论 |
|---|---|---|
| 负的 `rate`（步骤 1） | 静态值与属性没有负数；挂脚本的 12 处都是「最小值 + 音频 × 区间」或缓动插值，滑块下限不小于 0 | 碰不到，不补测 |
| 全量 vitest（步骤 1–3 的合并后工作区没跑） | — | HEAD `79800ab7` 快照（含 P4f 全部提交、不含别的会话未提交的改动）跑全量：137 个文件里 135 个通过、2 个跳过，3234 个用例里 3192 个通过、42 个跳过，0 失败 |
| `brightness` 运行中改值（步骤 2） | `2833017810` 的 12 个粒子对象把 `brightness` 绑了用户属性 | **补测**：生成 `p4f-bright2`（`defs/p4f0.py`，三个系统的 `brightness` 绑同一个属性，粒子匀速右移、越右越老，对照 `flags 8` 与带 `colorn`），WPE 超高档（当时已是超高，是别的会话补测泛光时改的，没动）用 `apply_properties` 改值后抓帧（`A:\p4f\p4f-bright2-*`）：改成 2 后新粒子 0.941、改回 1 时最近出生的 4 颗 0.471、更老的 12 颗仍是 0.941，`flags 8` 始终 0.471，带 `colorn` 的同样切开。Kabegame 预览（应用「场景后处理」超高）用 `set_wpe_web_user_properties` 改同一个属性，截图同样一刀切开（`ignore/p4/f4/out/frames/real-bright2-after.png`）。和读码一致 |
| `brightness` 的三张真实场景（步骤 2） | 都还差别的项、不能渲染 | 确定性工程已和 WPE 逐像素比过，不补测 |
| `emitParticles` 的真实场景（步骤 3） | `3286859278`（`Thunderbolt`）、`3570560686`（按钮的 `particles.emitParticles(4)`），调用都在光标回调里 | 测不了：要 `input.cursor*` 与 `cursorClick`（P6）。按 Rainy Day 的先例在 `render/scene.ts` 的 `particleScript` 处标 `TODO:[WPE_SCENE]` |
| 已定 5–7 有意和 WPE 不同的三处（步骤 3） | 语料里没有对自然结束的系统调 `play`、`stop` 后改系数、脚本发射触发世界空间事件实例的写法（`emitParticles` 只有上面两处，父子都是本地空间） | 不补测，回归文档 F17 留 `[ ]` |
| 子代理按推断定的几条（步骤 3：参数越界、`stop` → `play` 复位计时、「被 stop 停下」的解除、重建沿用、`init` 里调方法、控制点条件绑定得到布尔值） | 脚本直接读写 `layer.instance.*` 0 处；`emitParticles` 只有字面量 1 与 4 | 碰不到，只有单测 |
| 控制点覆盖写进子系统与事件实例、`controlpointangleN`、rope 类跳过脚本出生的粒子、暂停中的 eventdeath（步骤 3） | 0 处，或只经上面两张测不了的场景 | 只有单测 |
| Rainy Day 的 `Snow`（步骤 4） | 唯一的多 renderer 系统 | 这张另差 18 项、不能渲染；用户要求标 `TODO:[WPE_SCENE]`（步骤 4 提交里已标） |
| 帧表与拖尾混挂、rope 类混挂、`g_RenderVar0` 残值、多写一次顶点的开销（步骤 4） | 0 处（唯一的多 renderer 是 `Snow`：sprite + spritetrail） | 只有单测或读码 |

**过程问题**：收尾时又误跑了一次 `python -X utf8 -I - < /dev/null`（空的 `python -`，没执行代码），违反约定；之前验收时还有一次空的 `python -X utf8 -I -c ""`（步骤 4 实施记录已记）。

**WPE 与应用状态**：WPE 后处理保持超高（进收尾前别的会话已改成超高，本节没有改设置、没有重启）；测试窗口已关。Kabegame「场景后处理」保持用户设的超高；测试行 `p4f-bright2` 已 `projects_remove`，主窗口的预览换回原来的 13586。
