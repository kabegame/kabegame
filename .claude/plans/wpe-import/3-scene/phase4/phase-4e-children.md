# P4e — 子系统与音频（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)「P4e」。底座沿用 P4a–P4d（各子计划与 `rea-*.md`），本节新增的语义由步骤 0 写进 `rea-p4e-children.md`、`rea-p4e-audio.md` 和报告。
> 语料用 HEAD `c22b66a2` 的扫描（`ignore/p4/d7/corpus.json`，165 个工程；152 张口径限到 P4c 收尾时的名单）。统计脚本 `ignore/p4/e0/scan_e.py`，结果 `ignore/p4/e0/out/scan.txt`。
> 步骤 0 只调研；步骤 1 起每步能单独验收、单独提交。步骤 1 以后的划分是初稿，步骤 0 做完后按结论定稿。

## 总体设计思路

P4e 有两块：子系统是新的结构，音频是现有模块上的一个系数。

**子系统把「一个粒子层一个系统」变成一棵树。** 粒子 JSON 的 `children` 每一项引用另一个粒子 JSON，按 `type` 分两类：
- `static`（缺省类型，语料 188 条 / 22 张）：和父系统一起建、一起模拟、一起画，就是一个挂在父系统下面的普通系统。它的模型矩阵是「父的模型矩阵 · 条目的 `origin` / `angles` / `scale`」（rea-p4c-sim 第 5 节的「父栈顶 · 子条目的局部变换」），控制点可以经 `flags 4` 与 `parentcontrolpoint` 读父系统的控制点（父分支已在 rea-p4c-sim 1.8 读到）。
- 事件子系统（`eventfollow` 205 条 / 19 张，`eventspawn` 10 / 7，`eventdeath` 33 / 3）：父粒子出生或死亡时建一个子系统**实例**，实例的控制点由父粒子的位置写入（`FUN_14022a580`，从 `controlpointstartindex` 起），`eventfollow` 每帧跟着父粒子走。一条条目最多同时有 `maxcount` 个实例（缺省 10），`probability` 决定建不建。实例什么时候回收、父粒子死后 `eventfollow` 的实例怎样，要步骤 0 查清。

所以模拟侧要把 `ParticleSystem` 扩成可以持有子系统：每个子条目一份定义；`static` 一个实例，事件类一个实例池。帧内顺序照 WPE：父系统模拟（含出生、判死时触发事件）→ 写顶点 → 递归更新子系统（rea-framework Q3 第 6 步）。复位（对象不可见、周期发射进入新周期对 `def+0x64 & 2` 的子系统）和预热（预热时关掉事件处理，`sys+0x41`）都要递归，规则读码已有线索，步骤 0 补实测。

**绘制从「一层一次」变成「一层若干次」。** 每个子条目有自己的材质和 renderer，WPE 画完父系统后递归画子系统（`FUN_1402366f0`），折射快照父子共用「本对象已拷」位。我们的粒子层要改成按树的先序列出若干次绘制，每次一套管线、一段顶点；同一条目的多个事件实例是合成一次绘制，还是像 WPE 那样每实例一次，看步骤 0 抓帧里的绘制数和顺序（影响混合结果的只有实例之间的先后）。子系统的 renderer、材质、COMBO 走现有的粒子编译路径，子系统 JSON 一并进能力表检查。

**音频是模块上的一个系数。** `audioprocessingmode ≠ 0` 时，发射器（`sphererandom`、`boxrandom`）的 `rate`、`turbulentvelocityrandom` 的相位范围、`turbulence` / `vortex` / `vortex_v2` 的速度乘上一个由频谱算出的值（rea-p4b-modules D）。取值函数 `FUN_14022a8a0` 还没读：频段（`frequencystart` / `end` 钳到 ≤ 15，像是 16 段）、`bounds`、`exponent`、`mode` 各值、平滑、没有音频时取什么，都由步骤 0 查清。数据通路用宿主已有的 `WpeMediaHub` 订阅（P3c 点 0 为脚本接的），现在只在脚本注册音频缓冲时才订阅，要改成「场景里有粒子用音频时也订阅」；P11 的 `g_AudioSpectrum*` 将来共用同一条（总计划 P11「谁先做谁建」）。

几个关键决定：
- **按覆盖排先后。** 只差子系统和音频的 32 张（165 张口径）里，只要 `static` 的 10 张最多，其次是 `eventfollow`。`static` 排第一，它同时打好「系统树、多次绘制」的底子，事件类在上面加实例池。
- **步骤 0 一次做完。** 两个 REA 子代理并行（子系统一份、音频一份），一次 WPE 会话抓完全部确定性工程。
- **验收照旧靠回放。** 子系统逐粒子比轨迹；音频用工程自带的纯音（P6a 的做法：WPE 回环能采到自己的声音），同一帧从 CLK 层读出 WPE 的频谱，回放时喂给我们的模拟器，比发射数与速度。

## 范围与解锁

语料（`scan_e.py`，HEAD `c22b66a2`）：

| 口径 | 带粒子 | 现在完全覆盖 | 只差子系统 | 只差音频 | 只差这两类 | P4e 的上限 |
|---|---|---|---|---|---|---|
| 165 张 | 108 | 61 | 24 | 3 | 32 | 93 |
| 152 张 | 95 | 57 | 22 | 0 | 26 | 83 |

子系统现在不进编译、能力表不扫它们（`particle:children` 整张退回）。步骤 0b 在快照里让能力表递归检查子系统（JSON 用法与材质，同顶层），子系统没有带出任何新键，所以上限就是准确数：
- 165 张口径：61 → 子系统做完 87 → 音频做完 93；
- 152 张口径：57 → 80 → 83。

**能渲染的场景**：整张只差子系统的 3 张，`3778592720`（`static`）、`3811798465`（`eventfollow`）、`1514925620`（`eventspawn`），能渲染 38 → 41。音频不解锁场景（开着音频的 11 张都还差别的）。总计划风险 4 原以为 P4e 不解锁场景，这里更正。

按「这张场景要做什么」分组（32 张，165 张口径）：
- `static` 10 张，`static` + 音频 1 张；
- `eventfollow` 7 张，`eventfollow` + `static` 3 张，`eventfollow` + 音频 2 张，`eventfollow` + `eventspawn` 2 张；
- `eventspawn` 1 张；`eventdeath` 1 张（另带 mode 0 的音频字段）；
- 四种都要的 2 张（`3560756264` 另要音频，`3832133196`）；
- 只差音频 3 张：2 张真开（mode 3），`3233141951` 只是写了字段、`mode` 为 0。

**子系统条目的字段**（436 条，嵌套到第 2 层的 156 条）：
- `origin`（非零的 152 条，`"60 0 0"` 到 `"660 0 0"` 的等差一组）、`angles`（非零 2 条：`"0 0 -50"`）、`scale`（非 1 的 15 条）；
- `maxcount`（10 有 94 条，最大 500）、`probability`（1 以外：0 有 7 条、0.5、0.2 各 3 条）、`controlpointstartindex`（1 有 3 条）、`flags`（0、1、2）；
- 没有条目写 `instanceoverride`。
- 子系统自己的 `flags`：0、1（世界空间）、2、3、4（透视）、8、248；控制点 `flags 4` + `parentcontrolpoint 1` 只有 `3832133196` 一处。
- 子系统的 renderer：`sprite` 36 张、`spritetrail` 4 张、`rope` 2 张。

**`audioprocessing*`**：语料里开着的（mode ≠ 0）全是 `mode 3`，11 张、37 处，都在顶层系统，都在 `project.json` 声明了 `supportsaudioprocessing`。用在 `sphererandom` 10 处、`turbulence` 9、`boxrandom` 7、`turbulentvelocityrandom` 5、`vortex` 4、`vortex_v2` 2。`bounds` 有 `"0 1"`、`"0.5 1"`、`"0.8 1"`、`"0.9 1"`、`"1 1"` 等，`exponent` 0.5–3，`frequencyend` 2–16（16 超过钳制上限）。mode 为 0 时的字段现在也照报，挡住 `3233141951` 等，这一项是中性的，步骤 1 顺手放开。

**本节不做，继续报不支持：**
- 一个系统多个 renderer（`particle:renderers`，P4c 决定 3）。
- `instanceoverride` 的绑定与脚本写入（P4f）、`emitParticles`（P4f）。
- 场景级的 `general.supportsaudioprocessing`（写在 `scene.json` 里的 1 张）与 `g_AudioSpectrum*` uniform（P11）。

## 现状锚点

**a. 有子系统就整张退回**（`compile/features.ts:754`）
```ts
scanValue(system.children, unsupported);
// …
if (Array.isArray(system.children) && system.children.length > 0) unsupported.add("particle:children"); // 现状：子系统 JSON 不读、不检查
```

**b. 音频字段只在 `vortex_v2` 的表里，且只放行 0**（`particles/modules.ts:1044`）
```ts
audioprocessingmode: int(0, (value) => value === 0),   // 现状：非 0 报 …:audioprocessingmode
audioprocessingexponent: num(2),
// 其它模块没登记这组键：写了就按未知字段报，mode 为 0 也报
```

**c. 一个粒子层一个系统**（`particles/system.ts:397`）
```ts
step(frameDt: number, time?: number, inputs: ControlPointInputs = IDENTITY_INPUTS): void {
  // …
  this.advance(dt, frameDt, this.passes, inputs); // 现状：没有子系统的更新、事件、实例
```

**d. 音频只为脚本订阅**（`host.ts:384`）
```ts
/** 脚本第一次注册音频缓冲时向 `WpeMediaHub` 订阅，Hub 有订阅才开回环采集。… */
private subscribeAudio(): void {
  // 现状：粒子拿不到音频；数据经 `scriptApi.applyAudioFrame` 只写进脚本的缓冲
```

## 步骤 0 — 调研

不改产品代码。

### 0a — REA 读码（两个子代理并行）

**`rea-p4e-children.md`**，格式同 `rea-p4c-sim.md`，每条标地址和证据等级。已知线索：rea-framework Q3 第 4、6 步；rea-p4a C1（预热关 `sys+0x41`、子系统预热入口 `0x14022f430`）；rea-p4c-sim 1.5（事件子系统强制 `n = 8`）、1.8（父分支）、第 3 节（`sys+0x3f5` / `0x3f6`、`FUN_14022a580`）；rea-p4d-modules 1.3（`FUN_14022f6c0` 递归复位、事件实例创建 `0x14023754c`、`0x14023b07e`、`def+0x64 & 2`）；rea-p4b-render 3.x（`FUN_1402366f0` 递归绘制、折射快照共用位、`FUN_14022bd40` 的生效传递）。
1. **解析：** 条目的全部键与缺省（`FUN_1401c1430`、`0x1401d1354`），`type` 的编号，`flags` 各位（`def+0x64` 的 bit0、bit1 和 JSON `flags` 的关系），`origin` / `angles` / `scale` 怎么组成局部矩阵（旋转顺序、角度单位）。
2. **`static`：** 建立时机（`FUN_14022ebe0`）、模拟的先后、模型矩阵（父栈顶 · 局部变换；父或子是世界空间时）、`instanceoverride` 是否传给子系统、预热是否跟着父系统、复位与生效传递。
3. **事件子系统：**
   - 实例池：每条目几个实例、`maxcount` 是实例数还是子系统的粒子上限，满了怎样，实例何时回收；
   - 触发：`eventspawn` / `eventfollow` 在出生时、`eventdeath` 在判死时（rea-framework Q3 第 4 步）；`probability` 用哪个随机数；同一帧多个父粒子的先后；
   - 写控制点：`FUN_14022a580` 写哪个坐标空间、从 `controlpointstartindex` 起写几个，`eventfollow` 每帧更新、父粒子死后怎样；`sys+0x3f5` / `0x3f6` 的含义；
   - 实例的发射器：是否从头开始（`FUN_14022f6c0`）、`starttime` 是否预热；
   - 两遍模式、预热（`sys+0x41`）下事件怎样。
4. **绘制：** 递归顺序（父先子后、条目顺序、实例顺序），每个实例一次绘制还是合并；子系统的模型矩阵（`ctx+0xaf0`、`FUN_14005ecb0`，rea-p4c-render 末条）；折射快照共用；子系统存活数为 0 时。
5. **随机数：** 子系统实例有没有自己的 `R` 序列，和父系统的随机数怎么交错（影响逐粒子回放能不能对上）。

**`rea-p4e-audio.md`**，格式同 `rea-p4b-modules.md`。已知线索：rea-p4b-modules D（解析 `FUN_1401c1e20`、各模块的取值点）。
1. **取值函数 `FUN_14022a8a0`：** 读哪份频谱（几段、左右声道、`mode` 1 / 2 / 3 各取什么）、`frequencystart` / `end` 的区间怎么聚合、`bounds` 与 `exponent` 的公式、结果的范围。
2. **数据来源：** 频谱在哪里更新、每帧一次还是按采集包、有没有平滑或自适应归一化（脚本缓冲有，p6-REPORT 第 40 行；这里是不是同一份数据）、暂停时怎样。
3. **没有音频时：** `supportsaudioprocessing` 没声明、没有声音、采集失败，各取什么值（全零频谱下的系数）。
4. **各模块的作用点：** 发射 `rate`、`turbulentvelocityrandom` 相位范围、`turbulence` / `vortex` / `vortex_v2` 速度；每帧取一次还是每粒子取一次；在两遍模式下取几次。

### 0b — 准确的覆盖数（Claude）

在 HEAD 快照（`kbp snapshot export`）里临时改能力表：`particle:children` 不再报，改为读出子系统 JSON（沿 `children` 递归、按编译管线的查找顺序）逐个跑 `checkParticleFeatures` 与粒子材质检查；`audioprocessingmode` 为 0 的音频字段不报。跑 `kbp corpus scan`，得到子系统和音频之外还挡着的键与准确的上限、可解锁的场景。快照改动只为统计，不进产品。

**实施记录（2026-11-11，已完成）：**
- 快照 `ignore/p4/e0/rec`（HEAD `e2345b19`，`apps/wpe-scene/src` 与 `c22b66a2` 相同；wasm 用 d7 那份，和基线同口径），改动脚本是 scratchpad 的 `e0_patch.py`，改动行都带 `DEBUG-P4E0`。
- 结果 `ignore/p4/e0/out/corpus-rec.json`，比较脚本 `ignore/p4/e0/cov_e0.py`，结果 `out/cov.txt`。
- 去掉的键只有 `particle:children`（36 张）与 mode 0 的音频字段（7 个键，`3233141951`、`3570308528` 因此干净）；没有新增的键。原先只差子系统或音频的 32 张，做完全部干净。
- 核对递归确实执行：临时给每个子系统加一个探测键，`3832133196`、`3811798465` 列出 9 个子系统文件，含第二层（`thunderbolt_child_spawner` 下的两个）。

### 0c — 确定性工程与实测（Claude）

- **新增** `ignore/p4/defs/p4e0.py`（`kbp gen`），出这几个工程：
  - `p4e-static`：缺省条目；`origin` / `angles` / `scale` 各一个；父或子是世界空间；子系统控制点 `flags 4` + `parentcontrolpoint`、`flags 8`；父系统 `starttime` 预热；周期发射的父系统（`def+0x64 & 2` 的复位）；隐藏再显示（递归复位）。
  - `p4e-follow`：父粒子匀速直线、寿命错开；`eventfollow` 子系统用 `sphererandom` 持续发射；条目 `maxcount` 小于父粒子数（看实例上限）；`probability 0.5`；`controlpointstartindex 1`；父粒子死后子系统的去向。
  - `p4e-event`：`eventspawn`、`eventdeath` 各一组，子系统用 `instantaneous` 一次发完，看位置、时机与实例回收。
  - `p4e-draw`：父子材质不同、混合不同，看绘制数与顺序；父子都开 `REFRACT`，看快照次数。
  - `p4e-audio`：工程自带一个持续纯音（单频、已知频段）和一段静音，`project.json` 声明 `supportsaudioprocessing`；CLK 层读 `g_AudioSpectrum16Left` / `Right`（及 64 段）写像素；发射器、`turbulence` 各开 `mode 1 / 2 / 3`、几种 `bounds` / `exponent` / 频段；另出一份不声明 `supportsaudioprocessing` 的副本。
- 抓帧（`wpe-renderdoc` MCP）：全部 fps 60；`p4e-follow`、`p4e-static`、`p4e-audio` 另抓 fps 10。`kbp rdc track` 读每个系统的轨迹，`p4e-draw` 读绘制列表。
- **会出声：** `p4e-audio` 会从扬声器放测试音，抓帧前先告诉用户，期间别的声音会混进回环。
- 结论写进报告新节「P4e 语义的实测核对」。

**验收：**
- 两份读码文档覆盖上面各项，都有字段表、缺省值、公式和证据等级。
- 准确的覆盖上限和解锁名单定下来，步骤 1 以后的划分按它定稿。
- 事件实例的上限、回收与绘制方式有实测；音频系数的公式能用抓到的频谱复算出 WPE 的发射数。
- 步骤 1 以后要回放的数据都已抓到。

### 步骤 0 实施记录（2026-11-12）

**0a 读码。** 两份文档 [rea-p4e-children.md](rea-p4e-children.md)、[rea-p4e-audio.md](rea-p4e-audio.md)，两个子代理并行，各开 `p4b-mod` 快照的副本。要点：
- 子系统：`type` 只认小写四种；局部矩阵 `L = T·Rz·Ry·Rx·S`（弧度，缺分量补 0）；条目 `flags` bit0 把父的存活粒子写进子控制点、bit1 让父的新周期复位 static 子系统；static 按自己的 `starttime` 预热、不跟父；事件实例池的上限是条目 `maxcount`、满了丢弃、发射器结束且粒子死光后回收（后进先出复用）；实例矩阵 `X = T(p)·L`；每实例单独一次绘制，先序「父 → static → 事件实例」；`probability` 抽全场景共用的流 A。
- 音频：取值函数没有状态，读归一化后的 16 段数组（就是 `g_AudioSpectrum16Left/Right`），mode 1 / 2 / 3 是左 / 右 / `0.5·max(L + R)`，再过 `bounds`、smoothstep、`exponent`；总开关只有 `project.json` 的 `supportsaudioprocessing`，没有音频时系数为 0；频谱由采集线程做 FFT、渲染线程每帧做自适应归一化（第 6 节）。

**0c 实测。** `ignore/p4/defs/p4e0.py` 出 8 个工程（子系统两轮 6 个、音频 2 个），抓 12 组，结论见报告「P4e 语义的实测核对」：读码里能用抓帧判定的各条都成立。顺带的两点：
- 两个 eventdeath 条目时上限失守比读码预测的更彻底，两个条目都失守（`ed-max2` 12 s 后 60、59 个实例）。语料有 3 张（`3560756264`、`3570308528`、`3832133196` 的烟花预设，一个系统 3 个 eventdeath 条目，`ignore/p4/e0/scan_multi.py`）。
- 自引用嵌套第 8 层起 WPE 的位置是乱的（像矩阵栈溢出），语料最深 2 层，不复刻。

**工具。** kbp-tools 两处小改（随步骤 1 提交）：`kbp rdc track` 记下 CLK 读到的 `g_AudioSpectrum*`（WPE 把 `float[n]` 打包成 `float4[n/4]`，从 `members` 展开）；`gen.write_project(audio=…)` 让 CLK 读频谱、`project.json` 声明开关。不传 `audio` 时生成结果逐字节不变（`p4d-dist2`、`p4e-static` 重新生成比过）。

**WPE 会话。** 常驻的 WPE 上开自己的测试窗口，`capture_sweep` 三轮（子系统两轮、音频一轮）加一次 3 帧的音频探测，每轮跑完 fps 改回 20、`config.json` 回到这一轮开始时的哈希。第二轮开始时哈希已和第一轮测前不同（`5ff457dc…` → `332812d0…`），是两轮之间别处改的，没动。音频那轮从扬声器放了测试音（用户 2026-11-12 同意）。

## 步骤 1 以后（初稿）

| 步骤 | 内容 | 新增覆盖（165 张，上限） | 解锁候选 |
|---|---|---|---|
| 1 | 系统树与多次绘制；`static` 子系统（局部变换、父控制点、递归复位与预热）；mode 0 的音频字段放开 | 11 | `3778592720` |
| 2 | 事件子系统：实例池、`eventfollow` | 10 | `3811798465` |
| 3 | `eventspawn`、`eventdeath` | 5 | `1514925620` |
| 4 | `audioprocessing*`：取值函数；宿主的频谱处理（照 rea-p4e-audio 第 6 节做自适应归一化与 64 → 32 → 16 逐级取最大，粒子与脚本共用）；场景里有开着音频的模块时也订阅 `WpeMediaHub` | 6 | — |
| 收尾 | 文档、回归、覆盖数 | — | — |

新增覆盖按 165 张口径、做完该步时累计能覆盖的计（合计 32，61 → 93）。

## 步骤 1 — 系统树、多次绘制与 static 子系统

### 思路

子系统的状态归父系统所有：`ParticleSystem` 持有自己的 static 子系统（步骤 2 再加事件条目的实例池），`step` 走完自己的模拟之后按条目顺序步进它们，和 WPE 的 `FUN_1402308a0` 同一个结构（rea-p4e-children 3.2）。渲染器仍然每个粒子对象只步进根系统，绘制则按先序展开成若干次：父 → static 子孙（条目顺序、深度优先）。每次绘制有自己的程序（子系统自己的材质）、顶点缓冲、uniform 与模型矩阵，但共用对象的快照与可见性。

编译期把子系统 JSON 和它的材质编进 bundle，挂在父的 `SceneParticle.children` 上，结构和顶层系统完全一样，所以能力表、模块表、着色器、帧表这些路径不用分叉，子系统直接复用。事件条目在本步也解析进来（类型、`maxcount`、`probability` 等），能力表按类型报 `particle:children:<type>`，步骤 2、3 实现一种删一种。

几个取舍：
- **随机数：** 子系统与父共用同一个 `ParticleRandom`（WPE 共用一个 MT19937，7.3）。我们不复刻 WPE 的流，共用只是让「一个对象一个随机源」的种子规则不变。
- **`dt′`：** 子系统拿父的 `dt′`，不再乘自己的 `instanceoverride.rate`（3.4 末条），实例覆盖里只有 `rate` 不进子系统。
- **不复刻的 WPE 怪行为：** 嵌套第 8 层起的错位（0c 实测，像矩阵栈溢出）；深度上限 10 照做（自引用的文件到 10 层停）。
- **照复刻的 WPE 怪行为：** 世界 static 子系统的预热用 `M = L`、它的本地孙辈绘制时 `M = L·L₂`（3.3）；条目 `flags` bit0 写控制点不补偿 `L`（第 5 节）。都由抓帧确认过或代码确定，语料里出现时画面与 WPE 一致。

### 现状锚点

**a. 子系统整张退回**（`compile/features.ts:754`）
```ts
if (Array.isArray(system.children) && system.children.length > 0) unsupported.add("particle:children"); // 现状：不读子系统 JSON
```

**b. 粒子对象只编一个系统**（`compile/bundle.ts:779`）
```ts
async function compileParticle(index: number, object: SceneObject, layer: SceneLayer): Promise<void> {
  // 读 object.particle → checkParticleFeatures → parseParticle → 编材质的 pass，放进 layer.particle（现状：children 不看）
```

**c. `SceneParticle` 没有子系统**（`compile/particles.ts:142`）
```ts
export interface SceneParticle {
  file: string;
  maxcount: number;
  // … emitters / initializers / operators / renderer / controlpoints / instance / passes
  passes: ScenePass[]; // 现状：一个系统一份材质
}
```

**d. 一帧只模拟自己**（`particles/system.ts:397`）
```ts
step(frameDt: number, time?: number, inputs: ControlPointInputs = IDENTITY_INPUTS): void {
  const dt = f32(f32(frameDt) * this.rate);
  // … 时间累加
  this.advance(dt, frameDt, this.passes, inputs);
  // 现状：没有子系统的更新
```

**e. 控制点只有缺省、指针、flags 2 三条路**（`particles/controlpoints.ts:305`）
```ts
// 其余（含 f & 4：顶层系统没有父，走缺省更新 FUN_14022a070，1.8）  // 现状：父分支没做
update({ world: matrix, pointer }: ControlPointInputs): void {
```

**f. 粒子层一个绘制步骤**（`render/graph.ts:154`）
```ts
export function planParticleLayer(layer: Pick<SceneLayer, "particle">): LayerPlan {
  const pass = particle?.passes[0];
  // …
  if (pass.framebuffer) steps.push({ kind: "snapshot" });
  steps.push({ kind: "particles", pass, target: { kind: "scene" }, inputs, blending: pass.blending, perspective: … }); // 现状：一次
```

**g. 渲染器每个粒子 draw 一个系统**（`render/scene.ts:1708`、`:1154`）
```ts
stepParticles(frametime, time, state?, cursor = [0.5, 0.5]): void {
  for (const draw of this.draws) {
    const particles = draw.particles; // 现状：draw ↔ 系统一一对应，每个都步进
```

**h. 音频字段只在 `vortex_v2` 登记**（`particles/modules.ts:1044`）
```ts
audioprocessingmode: int(0, (value) => value === 0),   // 现状：其它五个模块写了音频字段就按未知字段报，mode 0 也报
```

### 点 1 — 编译：子系统进 bundle（`compile/particles.ts`、`compile/bundle.ts`、`compile/features.ts`）

- **新增** `compile/particles.ts`：
```ts
/** `children` 一项（rea-p4e-children 1.1–1.4）。`type` 不认识（含大小写不同）的条目解析时丢掉，和 WPE 编号 0 整条忽略相同。 */
export interface SceneParticleChild {
  type: "static" | "eventfollow" | "eventspawn" | "eventdeath";
  /** 条目 `flags`：bit0 父粒子写子控制点（第 5 节），bit1 父的新周期复位 static 子系统（3.7）；其余位没有读者。 */
  flags: number;
  controlPointStartIndex: number;     // 只在 flags bit0 时起作用；有符号 int
  probability: number;                // 事件类才读（步骤 2、3）
  maxcount: number;                   // 事件类的活跃实例上限（4.1）
  /** `L = T·Rz·Ry·Rx·S`（列主序 4×4，弧度）；三个向量只认字符串，缺的分量补 0（1.4，实测 `st-scale1`）。 */
  local: Mat4;
  system: SceneParticle;
}
```
  `SceneParticle` **新增** `children: SceneParticleChild[]`（缺省空数组）。
- **新增** `parseParticleChildEntry(entry: unknown): Omit<SceneParticleChild, "system"> | null`：缺省 `probability 1`、`maxcount 10`、`type "static"`、`controlpointstartindex 0`、`flags 0`（`FUN_1401c1430`）；`name` 不是字符串返回 null（调用方报 `particle:child:name`）。
- **修改** `bundle.ts` 的 `compileParticle` 拆出 `compileParticleSystem(json, file, key, depth)`，顶层与子系统共用：能力检查 → `parseParticle` → 编材质 pass（稳定键：顶层 `objects/<i>/particle/passes/<k>` 不变，子系统 `objects/<i>/particle/children/<n>/…/passes/<k>`）→ 递归 `children`（`depth < 10` 才建，同 `FUN_14022ebe0` 的 `sys.depth < 10`）。子系统文件读不到报 `particle:missing:<name>`，解析失败报 `particle:parse:<name>`。子系统不吃对象的 `instanceoverride` 绑定（绑定表只登记顶层），实例值由模拟器从对象上传下去（点 2）。
- **修改** `features.ts`：删掉 `particle:children`；`checkParticleFeatures` 对 eventfollow / eventspawn / eventdeath 条目报 `particle:children:<type>`（步骤 2、3 删）。子系统 JSON 由 `compileParticleSystem` 照顶层同样检查。
- **修改** `modules.ts`：`sphererandom`、`boxrandom`、`turbulentvelocityrandom`、`turbulence`、`vortex` 登记五个 `audioprocessing*` 字段，`audioprocessingmode` 只放行 0（同 `vortex_v2`），非 0 照报 `…:audioprocessingmode`（步骤 4）。

### 点 2 — 模拟：static 子系统（`particles/system.ts`、`particles/controlpoints.ts`）

- **新增** `ParticleSystem` 的子系统字段与构造：
```ts
/** static 子系统（3.1），条目顺序；事件条目的实例池在步骤 2 加。 */
readonly statics: { entry: SceneParticleChild; system: ParticleSystem }[] = [];
/** 父系统（3.1 的 `sys+0x10`），顶层为 null。控制点父分支读它（1.8）。 */
readonly parent: ParticleSystem | null;
/** 深度（顶层 0）。 */
readonly depth: number;
```
  构造参数加 `{ parent, entry }`（顶层不给）。子系统的实例值 = 对象的 `instanceoverride`，按子系统自己的 `flags` bit3–7 决定登记哪些（`instanceMultipliers` 已按 flags 处理），**不含 `rate`**、不含控制点覆盖（3.4：加载时到不了子系统，运行时改控制点覆盖我们不支持）。
- **修改** 加载顺序（`prewarm`，3.1）：先建并预热全部 static 子孙（深度优先，各按**自己的** `starttime`，模型矩阵本地 `M_父 · L`、世界 `L`），再做本系统的控制点初始化与预热。父的预热循环不步进子系统（3.5）。
- **修改** `step(frameDt, time, inputs)` 拆成「顶层入口乘 `rate` 得 `dt′`」和「`stepWith(dt′, frameDt, time, inputs, emit)`」：
```ts
private stepWith(dt: number, frameDt: number, time: number, inputs: ControlPointInputs, emit: boolean): void {
  // 系统时间、图层时间 += dt′（同现状）
  if (dt > 0) this.advance(dt, frameDt, this.passes, inputs, emit);   // 修改：emit 为 false 时跳过发射
  // ropetrail 采样（同现状）
  for (const { entry, system } of this.statics) {
    if (entry.flags & 1) writeParentPoints(this, entry, system, inputs.world);   // 新增：第 5 节
    // 子系统的 M = 父的模拟 M · L，本地、世界子系统都一样（3.3）
    system.stepWith(dt, frameDt, time, { ...inputs, world: multiply(inputs.world, entry.local) }, emit);
  }
}
```
- **新增** `writeParentPoints`（第 5 节）：父的存活粒子按槽号，写进子 `cp[startindex..7]` 的 `current` 平移；`X = parW ? (childW ? I : inverse(top)) : (childW ? top : I)`，`top` 是父的模拟 `M`；跳过 `flags & 0x10005` 的点（`j` 不变）；不补偿 `L`。条目 `flags` bit0 时子系统控制点数强制为 8（1.5），`i ≥ startindex` 的点不做缺省更新（rea-p4c-sim 第 3 节的 `sys+0x3f5` / `0x3f6`）。
- **修改** `ControlPointSet.update` 加父分支（rea-p4c-sim 1.8）：`f & 4` 且有父、`parentcontrolpoint < 父的个数` 时
```ts
// pcp = 父 cp[parentcontrolpoint].current；M = 本系统的模拟 M，Mprev = 父的模拟 M
!selfW && !parW && !(f & 8):  current = inverse(M) · (Mprev · pcp)
!selfW &&  parW && !(f & 8):  current = inverse(M) · pcp
 selfW && !parW && !(f & 8):  current = Mprev · pcp
否则:                          current = pcp
```
  读的是父本帧已更新的控制点（子系统在父模拟之后）；子系统预热时读到的是父的初值（`current = base`，3.1）。
- **修改** 周期复位（3.7）：`emit` 里 `periodStarted` 时，对 `entry.flags & 2` 的 static 子系统递归复位（系统时间 0、发射器计时、mapsequence 序号）并清发射器结束位、重新打开；不清粒子。
- **修改** 不可见（3.6）：顶层存活数 > 0 时，复位与清空递归到 static 子孙（`FUN_14022f6c0` 的复位 + `FUN_14022fd90` 的清粒子）；之后照常 `stepWith(…, emit = false)` 步进整棵树。顶层存活数为 0 时不复位，子系统里还活着的粒子照常模拟到死。顶层自己在不可见帧上的行为保持现状（控制点更新、系统时间累加），用回归保证 P4d 的案例逐字节不变。
- **修改** `setInstance`：递归到 static 子系统（3.4 运行时改值），子系统按自己的 flags 重乘，`rate` 不传。
- **新增** `forEachDrawn(callback)`：按绘制先序（父 → static 子孙）列出系统与它的绘制模型矩阵所需的信息（`local`、世界位），渲染器与回放共用。

### 点 3 — 渲染：一个粒子层多次绘制（`render/graph.ts`、`render/scene.ts`）

- **修改** `ParticleStep` **新增** `node: number[]`（在系统树里的路径，顶层 `[]`，static 子系统 `[n]`、`[n, m]`…）、`world: boolean`（这个系统 `flags & 1`）。`planParticleLayer` 按先序给每个有 pass 的系统一个步骤，每个用自己的 `pass`、`inputs`、`blending`、`perspective`（各自的 `flags & 4`）。快照：先序里第一个需要帧缓冲的系统之前拷一次，同一对象只拷一次（rea-p4e-children 第 6 节，折射位父子共用）。
- **修改** `createParticles`：只为顶层步骤建 `ParticleSystem`（整棵树）；子系统步骤的 `ParticleDraw.system` 指向树里对应节点（按 `node` 取），顶点缓冲按它自己的容量与 renderer 分配。
- **修改** `stepParticles`：只步进顶层 draw，步进后把这棵树全部节点的 draw 标 `stale`。
- **新增** 绘制模型矩阵（第 6 节、3.3）：
```ts
// top：父系统绘制后的栈顶。顶层：本地 W、世界画完后恢复成 W；static 子系统 X = L
drawModel(node) = node.world ? I : top(parent) · L
top(node)       = node.world ? (顶层 ? W : L) : drawModel(node)
```
  uniform（`particleUniformValues` 的 `world`）、朝向、拖尾眼位都用它。
- **修改** `checkRenderable` 等按步骤遍历的地方对子系统步骤同样检查（程序、顶点属性、renderer），问题照报。
- dev 探针 `particleTrack` / `host.particles` 的输出带上子系统（键 `<object>/<node 路径>`），供回放与真机核对。

### 点 4 — 回放工具（`.claude/skills/kbp-tools/ts/replayLib.ts`，Claude 做）

- 回放按 `kbp-meta.json` 的先序（`order` 里子系统紧跟父）给 `forEachDrawn` 列出的系统起名，draws 认法的轨迹逐系统比位置、尺寸、颜色。
- 新案例 `e1`：`p4e-static`、`p4e-static2` 两种 fps（`s-*`、`st-*`，事件条目的系统不比），子粒子的位置在子系统坐标里比（WPE 的 `vs_in` 也是），模型矩阵另比 MVP 的平移与 3×3。

### 验收

- 子代理：宿主 tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过，Prettier；新增单测覆盖局部矩阵（弧度、缺分量补 0）、`type` 大小写、深度上限、父分支四种组合、条目 bit0 / bit1、不可见的递归复位、预热顺序、多次绘制的先序与快照只拷一次、mode 0 音频字段不报。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest 自跑；变异检查（不乘 `L`、子系统乘自己的 `rate`、预热跟着父、父分支公式、bit1 不复位、快照每系统一次）。
  2. 回放 `e1`：static 的系统逐粒子在限内，MVP 与 WPE 一致；`kbp regress` 现有案例逐字节相同（顶层行为不变）。
  3. 语料（`kbp regress --corpus`）：去掉的只有 `particle:children`（换成事件类型键的场景照旧不干净）和 mode 0 的音频字段，覆盖 61 → 72（165 张口径），能渲染多 `3778592720`。
  4. `3778592720` 真机：Kabegame 与 WPE 同时刻的画面对比（粒子统计量与整帧），预览与桌面各看一次。
  5. 帧时间：带 static 子系统的语料场景用 dev 强制渲染各跑 10 s，记录粒子模拟与上传耗时。
- 过后请用户提交（连同 kbp-tools 的两处小改与 `p4e0.py`）。

### 步骤 1 实施记录（2026-11-12）

子代理在 HEAD `37606401` 的快照 `ignore/p4/e1/ov` 里实现点 1–3（另一个会话同时在改 `apps/wpe-scene`，做 P5b），Claude 做点 4、验收，再用 `git apply` 打进工作区（`git apply --check` 直接通过；P5b 未提交的改动和本步在 `bundle.ts`、`features.ts`、`graph.ts`、`scene.ts`、`render/particles.test.ts` 有交叠，合并前的这 5 个文件存在 `ignore/p4/e1/pre-merge/`）。补丁 `ignore/p4/e1/step1.patch`，16 个文件，+1877 / −171。

**和计划的差异（子代理报告，Claude 核对后接受）：**
1. 子系统的 `timescale` 也乘对象的 `rate`（计划写「实例覆盖不含 `rate`」）。实测 `p4e-rate` 确认，rea-p4e-children 3.4 已补更正。
2. `renderer: []` 的系统不画、照常递归子系统（rea 第 6 节）。语料 8 处都是带子系统的发射器系统（`ignore/p4/e1/scan_renderer.py`），现在能画的场景不受影响。
3. 结构命名：`stepWith` 是 `stepNode` + `stepStatics`（`TreeFrame` 另带对象的 `W` 与图层时间，remap 的 `layerorigin` / `layertime` 读对象的）；`ControlPointInputs.parent` 即 `Mprev`；绘制模型矩阵是纯函数 `particleDrawModel`；`local` 存 `number[]`（bundle 要过 Worker）。
4. 事件类条目的子系统也编进 bundle（模拟与绘制都不建），能列全它们自己的问题，步骤 2、3 直接用。
5. 新键（语料 0 处）：`particle:child:name`、`particle:child:<origin|angles|scale>`、`particle:binding:child:<键>`、`particle:child:controlpointstartindex`（bit0 且下标为负，WPE 越界写，我们跳过负下标）。
6. Claude 验收时补了一处：`SceneParticleChild.index` 记 JSON `children` 里的条目下标。`children` 跳过了不认识的类型，系统树路径用数组下标，材质稳定键与对照工具起名用 JSON 下标（不加时 `st-type` 的子系统在回放里认错名）。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest（快照与合并后的工作区各跑一次，带 `KABEGAME_WPE_ROOT`） | tsc 0 error；工作区 69 个文件 1799 个用例，只有已知的 `3830255100: 219 次请求`（P5a）失败；Prettier 通过 |
| `kbp regress`（HEAD 快照 ↔ 步骤 1 快照，现有 12 个案例 + 语料） | 12 个案例逐字节相同、两边全过；语料 173 张只有本步的键变化：去掉 `particle:children` 36 张与 mode 0 的音频字段，新增 `particle:children:eventfollow` 19、`eventspawn` 7、`eventdeath` 3，没有别的新键 |
| 覆盖（`ignore/p4/e1/cov_e1.py`） | 165 张口径 61 → 72、152 张口径 57 → 67，和计划相同；能渲染多 `3778592720`，没有变少的 |
| 回放 `e1`（新案例，`p4e-static` fps 60、`p4e-static2` fps 60、`p4e-rate` fps 20） | 全部系统在限内（位置最大 3.7e-4，尺寸、颜色、alpha 差 0）；另核对「我们有粒子而 WPE 没画」为无（`s-hide` 的抓帧落在隐藏段，父子都清空）。`p4e-static-fps10` 不进案例：日志缺 101–131 帧，平分出的时刻让顶层系统也差一个发射间隔；两遍模式由 `p4e-rate-fps20` 覆盖 |
| 合并后的工作区 `kbp replay --all` | 13 个案例全过 |
| 变异（`ignore/p4/e1/mutate_e1.py`，11 处） | 全部检出：子系统不乘 `L`、`timescale` 不乘 `rate`、子系统不预热、世界子系统预热用 `W·L`、不做父分支、bit1 不复位、bit0 不写控制点、不可见不清子孙、世界子系统绘制矩阵、快照每系统一次、渲染器不按根去重；还原后整树哈希相同 |
| `3778592720` 对 WPE（fps 20，抓帧 `A:\p4e\real-3778592720-fps20`） | 统计量：父系统 36–38 个（WPE 36–39）、子系统各 4 个（WPE 3–4），子系统尺寸 531–904 / 609–886（WPE 525–844 / 648–988）、alpha 0.014–0.136（WPE 0.006–0.136），y 都是 0；整帧（回放到同一时刻、1920×1097 画布）和 WPE 上屏画面目视一致（`ignore/p4/e1/out/real/`） |
| 帧时间（屏外宿主 `renderFrame` 连跑 600 帧） | 整帧均值 4.43 ms、p95 5.8 ms；每个粒子对象（含子系统）模拟均值 0.1 ms，写顶点 0.02 ms |

**工具：** `kbp rdc track` 的 points 认法在连续同系统绘制时另核颜色（`p4c-trail` 的现有轨迹重新提取逐字节相同）；回放库按 `kbp-meta.json` 的 `children` 给子系统起名，同名第 2 次起记 `名字#n`；`p4e-static`、`p4e-static2` 的轨迹改用 points 认法，draws 版存为 `rd-<标签>-draws.json`。

**待用户：** `3778592720` 在图库预览与桌面上看一眼（光斑大小、数量和 WPE 一致，没有闪烁或缺失）。

## 决定

**已定（2026-11-12 用户，按下面各条的推荐）：** 1、3、4、5 照推荐做；2 不存在了。

1. **事件实例的绘制：** WPE 每实例一次绘制。推荐照做，步骤 2 实测帧时间；同条目的实例同材质、按建立先后画，合成一次绘制画面相同（一次绘制内按图元顺序混合），帧时间不够再合并。
2. **子系统字段级的不支持项：** 0b 扫描子系统没有带出新键，这一项不存在了。
3. **没有音频时：** WPE 的系数是 0（发射器不发、速度项为 0），非 Windows 和没声明开关时照这个算，不报不支持。推荐照做：和 WPE 在没声音时的画面相同。
4. **多个 eventdeath 条目的上限失守**（新增）：推荐照 WPE 复刻。语料 3 张烟花预设一个系统挂 3 个 eventdeath 条目，不复刻时同时在场的烟花会比 WPE 少。
5. **脚本音频缓冲改用归一化频谱**（新增）：宿主现在给脚本的是 `WpeMediaHub` 的原始值，只做段内取最大，没有 WPE 的自适应归一化（p6-REPORT 第 40 行实测过 WPE 有）。步骤 4 建好共用的频谱处理后，推荐脚本一并改读它，和 WPE 对齐；这会改变现有用脚本音频的场景的画面，要过脚本场景的回归。

## 风险

1. ~~**覆盖数是上限**~~：0b 递归扫过子系统，没有新键，上限就是准确数。
2. **逐粒子回放：** 事件实例没有独立的随机流，`probability` 还会多抽流 A（rea-p4e-children 7.3）。我们不复刻 WPE 的 MT19937，确定性工程照旧把随机范围收成 min = max、`probability` 用 0 或 1，只比位置与时机；`probability` 小数只做统计。
3. **绘制次数：** `eventfollow` 语料有 205 条条目（19 张），每条缺省 10 个实例；每实例一次绘制时一张场景的绘制数可能上百，要实测帧时间，必要时合并。
4. **音频回环的干扰：** 实测期间用户放的声音会进 WPE 的频谱；以 CLK 层读到的频谱为准回放，不假设输入。
