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

**待用户：** `3778592720` 在图库预览与桌面上看一眼（光斑大小、数量和 WPE 一致，没有闪烁或缺失）。2026-11-12 用户看过，没有问题，提交 `3a22fd83`。

## 步骤 2 — 事件实例池与 `eventfollow`

### 思路

事件子系统和 static 子系统的区别只在「有几份、什么时候有」：static 一个条目恰好一份，建系统时就建好；事件条目是一个**实例池**，父粒子出生（`eventfollow` / `eventspawn`）或死亡（`eventdeath`）时从池里取一个实例，实例自己的发射器结束、粒子死光、子孙都不活跃时还回池里（rea-p4e-children 4.1–4.7）。实例本身就是一棵完整的 `ParticleSystem` 子树，和 static 子系统用同一个构造，只是多一个对象矩阵 `X = T(p)·L`（4.5），模拟时的 `M` 与绘制时的模型矩阵都由它推出。本步把池和 `eventfollow` 做完；`eventspawn`、`eventdeath` 只是触发点不同（出生一次写 `X`、判死时建），留给步骤 3，但池、回收、绘制这些共用部分都在本步建好。

模拟侧在父系统的一帧里加两个挂点，位置照 WPE 的帧内顺序（7.3）：判死之后处理父粒子的死亡（本步只是让跟着它的 `eventfollow` 实例停跟随、停发射，4.6 末段），发射之后处理新粒子（`eventfollow` 按条目、逐新粒子抽 `probability`、取实例、写 `X`、按自己的 `starttime` 预热）。这一帧的 static 子系统步进完，再按条目顺序、按建立先后步进活跃实例：`eventfollow` 先用父粒子本帧 operator 之后的位置重算 `X`，再步进，步进后不活跃的还回池里。预热期间（`starttime`）不建实例（4.8）。

渲染侧最大的变化是**粒子层的绘制顺序改成每帧现排**。步骤 1 的 static 树是固定的，建场景时按先序排一列 draw 就够了；事件实例个数每帧在变，语料里还有 3 处 `eventfollow` 子系统自己挂 static 子系统，WPE 画成「实例 1 → 它的子孙 → 实例 2 → 它的子孙」（第 6 节）。所以每个粒子层只留一个「画这棵树」的 op，编码时沿 `forEachDrawn` 的先序走一遍：每个被画的系统按它的**模板路径**（每层条目下标，实例不计序号）找到预备好的管线，再按「这个模板本帧第几次出现」从池里取一个 draw（第一次用到时才建顶点缓冲、uniform 与 bind group，之后复用）。模型矩阵每帧由 `forEachDrawn` 一起给出，事件实例的 draw 每帧重写 uniform 里随模型矩阵变的那几项。快照照旧每对象至多一次，插在本帧先序里第一个需要帧缓冲的系统之前。

几个关键决定：
- **每实例一次绘制**（「决定」1）。同条目的实例同材质、按先后画，合成一次画面相同，留到帧时间不够时再做。
- **绘制资源按需建、不回收。** 事件子系统的 `maxcount` 语料最大 20000（7 处），条目 `maxcount` 最大 350，按上限预分配不可接受；池里的 draw 第一次用到时建，之后常驻到场景销毁（同 WPE 的池只增不减，4.1）。
- **随机数：** 实例与父共用一个随机源，`probability` 用 `uA`（4.4）。我们不复刻 WPE 的流，确定性工程只用 `probability` 0 / 1 比位置，0.5 只做统计。
- **步骤 3 的边界：** `eventspawn` 与 `eventdeath` 的触发、多个 eventdeath 条目的上限失守、带 rope 时预热里建 eventdeath 实例，都在步骤 3；本步能力表只去掉 `particle:children:eventfollow`。

### 现状锚点

**a. 事件条目整条报不支持**（`compile/features.ts:767`）
```ts
if (entry.type !== null && entry.type !== "static") unsupported.add(`particle:children:${entry.type}`); // 现状：三种事件类型都报
```

**b. 系统只建 static 子系统**（`particles/system.ts` 构造函数末尾）
```ts
if (this.depth < MAX_CHILD_DEPTH)
  (def.children ?? []).forEach((entry, index) => {
    if (entry.type !== "static") return; // 现状：事件条目不建（编译期已编好它的子系统）
    this.statics.push({ index, entry, local: new Float32Array(entry.local), system: new ParticleSystem(…) });
  });
```

**c. 判死只给 rope 收集死亡槽号，发射不记新粒子**（`particles/system.ts:792`、`:833`）
```ts
if (order) dead.push(i); // 现状：只有 rope 系统收集；事件条目不知道哪些父粒子死了
// emit()：逐 emitter 逐个 spawn（现状：不记本帧新粒子的槽号）
```

**d. 一帧只步进 static 子系统**（`particles/system.ts:667`）
```ts
private stepNode(frame: TreeFrame, inputs: ControlPointInputs): void {
  // … advance、拖尾采样
  this.stepStatics(frame, inputs); // 现状：之后没有事件实例
}
```

**e. `forEachDrawn` 只给系统与路径，模型矩阵由渲染器按定义现算**（`particles/system.ts:481`、`render/scene.ts:1247`）
```ts
forEachDrawn(callback: (system: ParticleSystem, node: readonly number[]) => void, node = []): void
// scene.ts：particleDrawModel(W, layer.particle, step.node) —— 现状：只看定义里的 L，算不出实例的 X
```

**f. 粒子层的 draw 在建场景时按 static 先序排定**（`render/graph.ts` 的 `planParticleLayer`、`render/scene.ts:940` 的 `buildLayer`）
```ts
system.children.forEach((child, index) => {
  if (child.type === "static") visit(child.system, [...node, index]); // 现状：每个 static 节点一个步骤、一个 Draw，编码按这个固定顺序
});
```

### 点 1 — 模拟：实例池与 `eventfollow`（`particles/system.ts`）

- **新增**
```ts
/** 一个事件条目的实例池（rea-p4e-children 4.1，条目 `+0x08` 活跃表 / `+0x20` 空闲表）。 */
export interface ParticleEventPool {
  index: number;                 // 条目在 `def.children` 里的下标（模板路径用）
  entry: SceneParticleChild;
  local: Mat4;                   // L
  active: ParticleSystem[];      // 建立先后；绘制与步进都按它
  free: ParticleSystem[];        // 后进先出复用（4.7）
}
// ParticleSystem 新增：
readonly events: ParticleEventPool[] = [];   // 条目顺序；类型 2–4 都建池，本步只有 eventfollow 会被触发
/** 实例的对象矩阵 X（4.5，`inst+0x360`）；static 子系统与顶层为 null。 */
instanceMatrix: Mat4 | null = null;
/** 跟随的父粒子槽号（`inst+0x478`），−1 表示没有或已停跟随。 */
followSlot = -1;
```
- **修改** 判死：有 `eventfollow` 条目（步骤 3 起也含 eventdeath）时同样收集死亡槽号（升序）；判死之后、控制点更新之前，逐死亡槽号停掉跟着它的实例（4.2 第一段）：
```ts
// 4.6 末段（0x140237320–0x1402373bb）：停跟随、全部发射器标结束（含 static 子孙，FUN_14022f640），已有粒子照常活完
inst.followSlot = -1;
inst.endEmitters(); // 递归 static 子孙
```
- **修改** 发射：记本帧新粒子的槽号（出生先后）；全部发射器发完后，非预热时按条目顺序处理（4.3）：
```ts
for (const pool of this.events) {
  if (pool.entry.type !== "eventfollow") continue;                 // 步骤 3 加 eventspawn
  if (pool.active.length >= pool.entry.maxcount) continue;          // 满了：不抽、不建
  for (const b of born) {
    if (this.random.a() > pool.entry.probability) continue;         // 4.4：uA ≤ p 才建
    const inst = this.takeInstance(pool, b, top);                   // 4.7：空闲表尾部复用或新建；写 X（新粒子 operator 之前的位置）；预热
    inst.followSlot = b;
    pool.active.push(inst);
    if (pool.active.length === pool.entry.maxcount) break;
  }
}
```
  预热（`prewarm`）期间不建实例（`sys+0x41` 清零，4.8）。
- **新增** `takeInstance`（4.7）：新建 = 同 static 子系统的构造（父与条目、实例覆盖按子系统自己的 flags），再 `prewarm(实例的模拟矩阵)`（建孙辈、控制点初值、按自己的 `starttime` 预热）；复用 = `resetTiming`（递归）、重开全部发射器（递归）、重算 `X`，`starttime > 0` 时只跑预热循环（不重新初始化控制点，不重新应用实例覆盖）。
- **新增** 实例矩阵（4.5，`top` 是父的模拟矩阵，`p` 是父粒子位置）：
```ts
// 子本地 / 父本地：X = T(p)·L          模拟 M = top·X
// 子本地 / 父世界：X = top⁻¹·T(p)·L    模拟 M = top·X（= T(p)·L）
// 子世界 / 父本地：X = top·T(p)·L      模拟 M = X
// 子世界 / 父世界：X = T(p)·L          模拟 M = X
```
- **修改** `stepNode`：static 子系统之后按条目顺序、按 `active` 顺序步进实例（4.6）：条目 bit0 写控制点（`writeParentPoints`）→ `eventfollow` 且 `followSlot ≥ 0` 时按父粒子本帧位置重算 `X` → 以实例的模拟矩阵 `stepNode` → 不活跃（`isActive`：有 static 子孙或事件实例活跃、有没结束的发射器、存活数 > 0，`FUN_14022c310`）就从 `active` 移到 `free`（其余保序）。本帧新建的实例当帧就步进一次完整的 `dt′`。
- **修改** 不可见（3.6）：顶层存活数 > 0 时，顶层与 static 子孙的各池**销毁**活跃实例（丢掉，不进空闲表），空闲表不动；之后照旧整棵树以 `emit = false` 步进。
- **修改** `setInstance`：递归到各池的活跃与空闲实例（4.7 末条、3.4：`p2 = 0`，不重开已结束的发射器）。
- **修改** `forEachDrawn` 改成同时给出绘制模型矩阵与模板路径（第 6 节）：
```ts
forEachDrawn(object: Mat4, callback: (system: ParticleSystem, template: readonly number[], model: Mat4) => void): void;
// 顶层：model = 世界 ? I : W，画完栈顶 W
// static：model = 世界 ? I : top·L，栈顶 = 世界 ? L : model
// 实例：  model = 世界 ? I : top·X，栈顶 = 世界 ? X : model
// 顺序：自己 → static（条目顺序，各自递归）→ 事件池（条目顺序）→ 活跃实例（建立先后，各自递归）
```
  `particleDrawModel` 删除（只剩 static 时它和新函数等价，渲染器改用新函数）。

### 点 2 — 渲染：粒子层每帧现排（`render/graph.ts`、`render/scene.ts`）

- **修改** `planParticleLayer`：按**模板树**先序给每个有 pass 的系统一个步骤（事件条目的子系统也给，实例共用它），步骤的 `node` 是模板路径；快照步骤不再写进计划（改由编码时插）。模板步骤只用来预备管线与程序（`PreparedDraw`），不再直接对应一个 Draw。
- **新增** 粒子层的运行时：一个 `particle-tree` op 代替原来的若干 draw op；每个模板一个 draw 池（`Draw[]`），第 k 次出现取第 k 个，没有就按模板的 `PreparedDraw` 现建（顶点缓冲按这个系统的容量与 renderer，uniform 缓冲与 bind group 同现在的 `createDraw`）。
- **修改** 编码：`particle-tree` op 沿根系统的 `forEachDrawn` 走，逐个系统：取 draw、把 `particles.system` 指到这个系统、模型矩阵和上一次不同时重写 uniform 里随它变的项（`g_ModelMatrix`、MVP、`g_Orientation*`、拖尾眼位与 `hidden`，即现在 `refreshParticleGeometry` 与 `particleUniformValues` 管的那几项）、写顶点、画；本帧先序里第一个 pass 需要帧缓冲的系统之前拷快照（每对象至多一次，`obj+0x93d`）。存活数为 0 的系统跳过自己的绘制、照常递归（第 6 节）。
- **修改** `stepParticles`：只步进根（同步骤 1）；有事件池的树每帧都标脏（实例个数与位置每帧在变）。
- **修改** `particleStats`、`particleProbe`、`particleTrack`（`particles/track.ts`）：按 `forEachDrawn` 输出，键 `<名字>/<模板路径>`，同一模板第 k 次出现（k ≥ 2）加 `#k`。
- **修改** 能力表检查的渲染部分（`planProblems` 等按步骤遍历处）对模板步骤照旧检查。

### 点 3 — 能力表（`compile/features.ts`）

- **修改** `checkParticleChildren`：`eventfollow` 不再报；`eventspawn`、`eventdeath` 照报（步骤 3）。

### 点 4 — 回放工具（`.claude/skills/kbp-tools/ts/replayLib.ts`、`ignore/p4/cases/e2.*`，Claude 做）

- 回放按新的 `forEachDrawn` 起名：模板路径经 `kbp-meta.json` 的 `children` 换成系统名，同一模板按出现先后记 `名字`、`名字#2`…，**只数有存活粒子的**（WPE 存活数为 0 的系统不画，draws 认法与 points 认法都看不到它）。
- `p4e-follow`、`p4e-follow2` 的轨迹改用 points 认法重新提取（draws 版改名留着）。
- 新案例 `e2`：`p4e-follow` fps 60、`p4e-follow2` fps 60 与 fps 20 的 `probability 1` 系统逐粒子比；`f-prob` 跳过（随机流不同，读码与统计已在步骤 0 核对）；fps 10 日志缺帧，照 `e1` 不进案例，两遍模式由 fps 20 覆盖。

### 验收

- 子代理：tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过（已知的 P5a 那一条除外），Prettier。新增单测：实例矩阵四种组合、上限满了不抽不建、`probability` 0 / 1、父粒子死亡那帧停跟随停发射、持续发射的实例不回收、结束的实例回收并按后进先出复用（复用时序号与系统时间归零、不重新初始化控制点）、预热期间不建、不可见时销毁活跃实例保留空闲表、`setInstance` 递归到实例、绘制先序（实例 1 → 它的 static 子孙 → 实例 2）、池里的 draw 按需建与复用、快照每对象一次、存活数为 0 的实例不画。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest 自跑；变异检查（不乘 `L` / 不加 `T(p)`、父世界时不乘 `top⁻¹`、不按父粒子本帧位置重算 `X`、父粒子死后照常发射、上限不检查、满了照样抽、回收不复位、预热期间建实例、绘制顺序按模板分组）。
  2. `kbp regress`（HEAD 快照 ↔ 步骤 2 快照，现有案例含 `e1`）逐字节相同；语料只去掉 `particle:children:eventfollow`，覆盖 72 → 82（165 张口径），能渲染多 `3811798465`。
  3. 回放 `e2` 在限内。
  4. `3811798465` 对 WPE：统计量（每个实例一次绘制的个数、粒子数、尺寸）与整帧目视；带 `eventfollow` 的语料场景用 dev 强制渲染记帧时间（实例最多的那张，以及子系统 `maxcount 20000` 的那几张的显存）。
- 过后请用户看 `3811798465` 的预览与桌面，再提交。

### 步骤 2 实施记录（2026-11-12）

子代理在 HEAD `182fbc94` 的快照 `ignore/p4/e2/ov` 里实现点 1–3，Claude 做点 4 和验收。之后 HEAD 又进了 P5b 步骤 3（`013499e0`）与 P6b 1b（`0926f756`），补丁在 `graph.ts`、`scene.ts` 打不上，改用逐文件三方合并（`git merge-file`，当前文件 / 快照基线 / 快照），12 个文件都没有冲突；合并后逐文件的增删行数和补丁相同。合并前的文件在 `ignore/p4/e2/pre-merge/`，补丁 `ignore/p4/e2/step2.patch`（14 个文件，+1949 / −293）。

**和计划的差异（子代理报告，Claude 核对后接受）：**
1. `forEachDrawn(callback, object = I)`：参数顺序和计划相反，这样旧调用（`track.ts`、回放库的 `forEachDrawn((system, node) => …)`）不用改。回调多给一个模型矩阵，返回 `false` 时跳过子树，渲染器用它跳过没有 pass 的子树。
2. 新增 `drawTransform(object)`：自底向上算一个系统的模型矩阵，和 `forEachDrawn` 是同一串运算，逐位相同。就地刷新（对象变换、视差、相机）时按 draw 现算，不用遍历整棵树。
3. 存活数为 0 的实例不占 draw，出现次数只数有存活粒子的，和 WPE 不画这类系统、回放的起名一致。非实例化的模板（顶层与 static）照旧每帧一个 draw，和步骤 1 相同。
4. 实例化 draw 的顶点缓冲按存活数分配：最少 64 个粒子，不够时翻倍，最多到容量。计划写的是按容量，但容量 20000 的子系统每个实例要约 4 MB。
5. 编码时才新建或换了实例的 draw 当场写 uniform（`update` 已经在这一帧之前跑过，补上这一帧的每帧量）。
6. 只有 static 的粒子层也改成一个 `particle-tree` op，计划里不再有快照步骤，改了 `render/particles.test.ts`、`compile/refract.test.ts` 等几处已有断言。绘制、uniform、快照位置和步骤 1 相同（regress 逐字节相同）。
7. 两处读码没写清、按推断做的【推】：运行中新建或复用实例时，实例预热用这一帧的场景时间 `T` 与图层时间；复用时只跑实例自己的预热循环，static 孙辈不再预热。语料里带 `starttime` 又用噪声 / remap 的事件子系统才看得出差别。
8. `probability` 抽本对象的随机源（同计划，不复刻 WPE 的 MT19937）。

**Claude 验收时补的：**
- 单测：不可见时销毁**顶层**自己的活跃实例。子代理写的那条在隐藏时顶层池已经回收空了，变异检查（`hide-keeps-instances`）没检出。
- `render/events.test.ts` 的图层字面量补 P5b 步骤 3 新加的 `fullscreen`、`fullscreenSize`（快照基线比那次提交早）。
- 案例 `e1`：`p4e-static2` 不再报 `particle:children:eventfollow`，期望改为空；原来跳过的 `st-order-f` 放开一起比。
- 案例 `e2` 用 `p4e-follow2` 的 fps 20（两遍模式），不用 fps 10：fps 10 的日志同 `e1` 一样缺帧。
- 回放库：子系统每帧沿系统树现列、按出现先后起名，只数有存活粒子的，旧签名照样能用。
- kbp mutate：单测检出方把盘符转成大写。小写 `d:` 时快照里的 vitest 被加载成两份、每个文件 0 个用例，第一轮变异的单测检出因此作废、重跑。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest | 快照：tsc 0 error，72 个文件 1864 个用例，只有已知的 `3830255100: 219 次请求`（P5a）失败。合并后的工作区：74 个文件 1915 个用例，同样只有这一条失败；本步文件 tsc 通过（工作区另有 P6b 会话改了一半的 `wpefont/index.test.ts` 报 `cbox`，不是本步的）；Prettier 通过 |
| `kbp regress`（HEAD 快照 ↔ 步骤 2 快照，13 个案例 + 语料） | 12 个旧案例逐字节相同。`e1` 只差 `p4e-static2` 的期望不支持项那一行（改案例后 `e1` 全过，`st-order-f` 的 4 个实例和 WPE 对上）。语料 173 张只在 19 张里去掉 `particle:children:eventfollow`，没有新键 |
| 覆盖（`ignore/p4/e1/cov_e1.py ignore/p4/e2/out/regress`） | 165 张口径 72 → 82、152 张口径 67 → 75，和计划相同；能渲染多 `3811798465`，没有变少的 |
| 回放 `e2`（`p4e-follow` fps 60、`p4e-follow2` fps 60 与 fps 20） | 全过：每个实例逐帧的粒子数和 WPE 相同，位置最大 4.9e-4，尺寸、颜色、alpha 差 0；「我们有粒子而 WPE 没画」为无。`f-prob`（`probability 0.5`）跳过，随机流不同 |
| 变异（`ignore/p4/e2/mutate_e2.py`，14 处） | 全部检出：`X` 不加 `T(p)`、不乘 `L`、父世界不乘 `top⁻¹`（后两处只有单测看得出：本地实例的粒子存实例坐标）、不按本帧位置重算 `X`、父死后照常发射、上限不检查、满了照样抽、复用不复位、不回收、预热期间建实例、不可见不销毁顶层实例（补单测后）、绘制按模板分组、存活数 0 的实例占 draw、换实例不重写 uniform；还原后整树哈希相同 |
| `3811798465` 对 WPE（fps 20，抓帧 `A:\p4e\real-3811798465-fps20`，回放合成时间线 dt 0.05） | 绘制结构相同：樱花、尘埃、跟随光标的樱花，两个萤火虫父系统各自后面紧跟一串实例。父 A：WPE 8 个粒子、6–7 个实例；我们 10 个、8 个。父 B：WPE 10 个、9–10 个实例；我们 8–9 个、7–8 个。两边都是实例数 ≈ 父粒子数减 1–2。每个实例 5–10 个粒子，尺寸 0–22，alpha ≤ 0.39，世界坐标的范围两边相同（A 组 x 约 −200…850，B 组 x 约 2500…3820）。第 277 帧整帧目视一致，花丛附近的萤火虫与火星放大对照也一致（`ignore/p4/e2/out/real/`）；画面中心那团粉色是跟随光标的樱花，回放光标固定在中心 |
| 帧时间（屏外宿主 `renderFrame` 连跑 600 帧，强制渲染） | `3811798465`：均值 3.9–4.3 ms、p95 5.9–6.6 ms，粒子模拟 0.22 ms、写顶点 0.06 ms。实例最多的 `2974757317`（86 个 eventfollow 条目，600 帧后 129 个实例 draw、432 个实例粒子）：均值 11.1–12.2 ms、p95 16.5 ms，粒子模拟 0.76 ms、写顶点 0.13 ms；它强制渲染时带 39 个不支持项、渲染目标 286 MB，帧时间主要不在粒子上。`3219908811` 12.4 ms，`3560756264` 21.2 ms（带 puppet、文本等，79 个子系统 draw）。`3243449890` 强制渲染报 `render:texture-missing:48`，和粒子无关 |
| 容量 20000 的事件子系统 | 600 帧后画出的事件子系统容量最大 32，容量 20000 的没有建出实例，显存留到步骤 3 测。实例的顶点缓冲按存活数分配（见差异 4），模拟列照 WPE 按容量 |

**结论：** 每实例一次绘制（「决定」1）不用合并：实例最多的场景里粒子 CPU 开销不到 1 ms。

**待用户：** `3811798465` 在图库预览与桌面上看一眼（萤火虫周围的火星跟着萤火虫走，数量和 WPE 一致，没有闪烁或缺失）。2026-11-12 用户看过，没有问题，提交 `f0abb228`。

## 步骤 3 — `eventspawn` 与 `eventdeath`

### 思路

实例池、实例矩阵、步进、回收、绘制在步骤 2 都已做好，三种事件类型共用；`eventspawn`、`eventdeath` 和 `eventfollow` 只差**什么时候取实例、`X` 用哪个位置、之后跟不跟**。所以本步只动模拟器里的两个挂点，渲染器、轨迹与回放的起名都不用改（事件条目下的模板本来就按实例化处理）。

`eventspawn` 和 `eventfollow` 走同一个挂点（发射之后，4.3）：条目在外、新粒子在内，满了整条不抽，`X` 用新粒子 operator 之前的位置，只在建立时写一次，之后不重算、父粒子死了也不停。`eventdeath` 是新挂点，在判死之后、控制点之前，和停跟随同一个循环（4.2）：死粒子在外、条目在内，`X` 用死粒子上一帧末的位置（判死只把寿命清零，位置列还是上一帧的）。它的上限不是逐条目判的：本帧开头把各 eventdeath 条目的「`maxcount` − 活跃数」加起来得到 `cap`，循环里只看 `cap` 是不是恰好为 0，建了实例后某条目「活跃数 == `maxcount`」才跳到下一个死粒子。单条目时上限严格成立，多条目时会失守（「决定」4 照 WPE 复刻，实测 `ed-max2` 两个条目各 60、59 个实例）。

预热的规则要细一点（4.8）：预热期间不记新粒子、不为事件收集死亡，所以 eventspawn 不建；但父系统带 rope 类 renderer 时判死照样收集死亡槽号（rope 表要用），建 eventdeath 实例的循环只看死亡表和 `cap`，于是预热里也会建，这些实例要到预热之后的第一个正常帧才步进（实测 `ed-rope` 比 `ed-sprite` 多 1 个实例）。所以 `advance` 的事件开关要拆成两个：「这一帧的环境」（建实例与实例预热用，预热时也有）和「是不是预热」（只关新粒子与事件的死亡收集）。

几个关键决定：
- **`followSlot` 三种类型都写**（4.2、4.3 的 `inst+0x478 = b / d`）：本步没有读者，留给 `inheritinitialvaluefromevent`（7.2，语料没用到）。停跟随与重算 `X` 只看 eventfollow 条目，不受它影响。
- **不可见时**：对象不可见、子系统以 `emit = false` 步进时，判死照常，eventdeath 照常建实例（`emit` 只管发射器的调用，判死与事件处理不看它，【推】自代码结构，同步骤 2 的停跟随）。
- **随机数**：同步骤 2，`probability` 抽本对象的随机源，不复刻 MT19937；`ed-order` 的抽取顺序只在单测里按读码核对。

### 现状锚点

**a. 发射之后只给 eventfollow 建实例**（`particles/system.ts` 的 `spawnInstances`）
```ts
for (const pool of this.events) {
  if (pool.entry.type !== "eventfollow") continue; // 现状：eventspawn 的池建了但从不触发
  const { maxcount, probability } = pool.entry;
  if (pool.active.length === maxcount) continue;
  // …逐新粒子抽 uA、takeInstance、followSlot = slot、满了 break
}
```

**b. 判死之后只停跟随**（`advance`）
```ts
this.ageAndKill(dt, events !== null && this.watchesDeaths);
this.sequenceFrames();
if (events) this.stopFollowing(); // 现状：eventdeath 的池建了但从不触发；预热时 events 为 null，什么都不做
```

**c. 预热把事件整个关掉**（`prewarmLoop`）
```ts
for (let t = 0; t < end; t = f32(t + step)) this.advance(step, 0, 1, inputs, true, env.object, null); // 现状：null = 不处理事件
```

**d. 能力表照报两种类型**（`compile/features.ts` 的 `checkParticleChildren`）
```ts
// eventfollow 已实现（P4e 步骤 2）；eventspawn、eventdeath 的触发在步骤 3
if (entry.type === "eventspawn" || entry.type === "eventdeath") unsupported.add(`particle:children:${entry.type}`);
```

### 点 1 — 模拟：两个触发点（`particles/system.ts`）

- **修改** `advance` 的事件参数拆成环境与预热位：
```ts
private advance(dt, frameDt, passes, inputs, emit = true, object = inputs.world,
  env: PrewarmEnv | null = null,   // 修改：这一帧的环境（建实例、实例预热用）；null 只在没有子系统的调用里
  prewarming = false,              // 新增：预热（`sys+0x41 = 0`，4.8）：不记新粒子、不为事件收集死亡
): void {
  this.ageAndKill(dt, !prewarming && this.watchesDeaths);   // rope 照旧总收集
  this.sequenceFrames();
  if (env) this.handleDeaths(inputs, env);                  // 修改：停跟随 + eventdeath（4.2），预热里也走（死亡表只有 rope 时非空）
  // … 控制点
  if (emit) {
    this.emit(dt, env !== null && !prewarming && this.watchesBirths);
    if (env && !prewarming && this.born.length) this.spawnInstances(inputs, env);  // eventfollow + eventspawn
  }
```
- **修改** `prewarmLoop` 传 `env` 与 `prewarming = true`。
- **修改** `watchesDeaths` 只认 eventfollow / eventdeath（现状如此），`watchesBirths` 只认 eventfollow / eventspawn（现状如此），不变。
- **修改** `stopFollowing` → `handleDeaths`（4.2，`0x140237129`–`0x1402376f6`）：
```ts
// 本帧开头算一次，可以是负数（多条目时上限失守，「决定」4）
let cap = Σ_{eventdeath 池} (entry.maxcount − active.length);
for (const d of this.dead) {                       // 升序
  // 停跟随（步骤 2 的 stopFollowing，逐死粒子同一个循环）
  if (cap === 0) continue;
  for (const pool of eventdeath 池（条目顺序）) {
    if (this.random.a() > pool.entry.probability) continue;   // 每个（死粒子，条目）抽一次
    const inst = this.takeInstance(pool, d, inputs.world, inputs.pointer, env);   // X 用死粒子当前列里的位置（上一帧末）
    inst.followSlot = d;
    pool.active.push(inst);
    cap -= 1;
    if (pool.active.length === pool.entry.maxcount) break;   // 跳到下一个死粒子
  }
}
```
- **修改** `spawnInstances`：条目类型放开到 `eventfollow` 与 `eventspawn`（4.3），其余不变；`followSlot = b` 两种都写。
- **修改** 文件头与各处注释里「本步只有 eventfollow 会被触发」的说法。

### 点 2 — 渲染（不改）

事件条目下的模板已经是实例化的（`visitParticleTemplates` 对非 static 条目给 `instanced`），draw 池、现排、快照都不用动。验收时核对 rope 父系统（`ed-rope`）与 spritetrail 子系统（烟花预设）的实例能画。

### 点 3 — 能力表（`compile/features.ts`）

- **修改** `checkParticleChildren`：不再报 `particle:children:<type>`，只剩条目字段与 `controlpointstartindex` 的检查；注释改成「三种事件类型都已实现（P4e 步骤 2、3）」。

### 点 4 — 回放工具与案例（Claude 做）

- `p4e-event`、`p4e-event2` 的 fps 60 轨迹改用 points 认法重新提取（draws 版改名 `-draws.json` 留着，已做）。
- 新案例 `e3`：两个工程 fps 60 逐粒子比；钩子同 `e2`（反方向核对「我们有粒子而 WPE 没画」）。rope 父系统 `ed-rope` 的父粒子不是按粒子认的绘制，跳过它本身、只比实例。两遍模式不另抓：事件每帧只建一次（4.8），`e2` 的 fps 20 已覆盖实例在两遍模式下的步进。

### 验收

- 子代理：tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过（已知的 P5a 那一条除外），Prettier。新增单测：
  - eventspawn：`X` 用 operator 之前的出生位置、之后不跟父粒子、父粒子死了不停；满了不抽不建；持续发射的实例永不回收（`es-max`）；
  - eventdeath：`X` 用上一帧末的位置（判死帧父粒子不再前进）；单条目上限严格成立；两个条目时 `cap` 失守、每个死粒子各条目都建（`ed-max2` 的读码推演）；`cap` 为 0 时不抽；抽取顺序「死粒子在外、条目在内」（`ed-order`）；
  - 预热：无 rope 时预热里不建、有 rope 时建，且预热里建的实例预热期间不步进；
  - 不可见时 eventdeath 照常建（子系统以 `emit = false` 步进）；
  - 复用实例时 mapsequence 序号归零（`es-recycle`）。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest 自跑；变异检查（eventspawn 每帧重算 `X`、eventspawn 父死时停、eventdeath 用当前帧位置、`cap` 逐条目判满、`cap` 判 `≤ 0`、预热里有 rope 也不建、预热里不论 rope 都建、嵌套顺序反了）。
  2. `kbp regress`（HEAD 快照 ↔ 步骤 3 快照，现有 14 个案例）逐字节相同；语料只去掉 `particle:children:eventspawn`、`eventdeath`，覆盖 82 → 87（165 张口径）、75 → 80（152 张口径），能渲染多 `1514925620`。
  3. 回放 `e3` 在限内。
  4. `1514925620` 对 WPE（统计量与整帧目视）；烟花预设（`3570308528`、`3832133196`，多 eventdeath 条目、容量 20000 的 spritetrail 子系统）强制渲染记帧时间、实例数与内存。
- 过后请用户看 `1514925620` 的预览与桌面，再提交。

### 步骤 3 实施记录（2026-11-12）

子代理在 HEAD `f0abb228` 的快照 `ignore/p4/e3/ov` 里实现点 1、3，Claude 做点 4 和验收。之后 HEAD 进了 P5b 步骤 4（`920b5548`），工作区的 `features.ts` 另有别的会话未提交的改动，所以照步骤 2 逐文件三方合并：7 个文件都没有冲突，逐文件和合并前比的增删行数与补丁相同。合并前的文件在 `ignore/p4/e3/pre-merge/`，补丁 `ignore/p4/e3/step3.patch`（7 个文件，+379 / −72）。

**和计划的差异：** 没有。子代理报告一处单测上的发现：只挂 eventspawn 的系统没有死亡表（`watchesDeaths` 为假，对应 WPE `sys+0x41 & 0x14`），单独一个 eventspawn 条目看不出「父死停不停」，所以 `es-pos` 用例另挂一个 eventfollow 作对照。渲染器没改，事件条目下的模板本来就按实例化画。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest | 快照：tsc 0 error，74 个文件 1925 个用例，只有已知的 `3830255100: 219 次请求`（P5a）失败（Claude 自跑同子代理）。合并后的工作区 tsc 0 error |
| `kbp regress`（HEAD 快照 ↔ 步骤 3 快照，14 个旧案例 + `e3` + 语料） | 14 个旧案例逐字节相同（含 `e1`、`e2`：带 rope 的系统预热时也走死亡处理，没有 eventdeath 条目时不抽随机数、不建实例）。语料 173 张只在 8 张里去掉 `particle:children:eventspawn`（7）、`eventdeath`（3），没有新键；干净 46 → 47 |
| 覆盖（`ignore/p4/e1/cov_e1.py ignore/p4/e3/out/regress`） | 165 张口径 82 → 87、152 张口径 75 → 80，和计划相同；能渲染多 `1514925620`，没有变少的 |
| 回放 `e3`（`p4e-event`、`p4e-event2` fps 60，轨迹改用 points 认法重提） | 全过。`p4e-event` 38 个系统，位置最大 4.6e-5；`p4e-event2` 159 个系统，`ed-max2` 两个条目逐帧对上（这几帧到 62、61 个实例，复刻的上限失守）；`ed-rope` 比 `ed-sprite` 多出预热里建的那个实例。最大差是 `es-recycle-c`（mapsequence 环）0.0159，在近似三角函数的包络 0.022 内。尺寸、颜色、alpha 差 0；「我们有粒子而 WPE 没画」为无 |
| 变异（`ignore/p4/e3/mutate_e3.py`，12 处） | 全部检出：eventspawn 不触发 / 每帧重算 `X` / 父死时停、eventdeath 在 operator 之后建、`cap` 逐条目判满、`cap` 判 `≤ 0`、`cap` 为 0 照样抽、嵌套反了、预热里有 rope 也不建、预热里都建、不可见不处理死亡、预热里建 eventspawn；还原后整树哈希相同。重算 `X` 与 operator 之后建只有单测看得出（本地实例的粒子存实例坐标，同步骤 2） |
| `1514925620` 对 WPE | 原场景闪电平均 5 s 一道、光晕实例只活 0.1 s，抓帧碰不到。解包成测试副本 `ignore/p4/proj/real-1514925620-kbp`（`kbp content unpack --instrument`，不动工坊原件），把 Thunderbolt 的 `instanceoverride.count` 从 0.2 改成 5 再抓（`A:\p4e\real-1514925620-kbp-fps20-1920x1066`，导入 dev 库为图片 14372）。按 WPE 的帧时间日志回放第 250–254 帧：光晕实例「有、有、有、无、有」和 WPE 完全相同，都在实例坐标 (0, 250)、alpha 0.26；第 250 帧尺寸 14.2 对 14.1、alpha 0.027 对 0.027，第 254 帧 150.4 对 150.0（中间两帧是 `sizerandom` 的随机值不同）；两个雨系统逐帧粒子数和 WPE 完全相同。整帧目视一致，闪电形状相同、落点随机。原场景（图片 13530）不支持项为空 |
| 雨丝亮度（顺带发现，和本步无关） | 天空区域雨丝的亮像素总数时多时少，但最亮的一档（局部残差 > 16）WPE 每帧 80–130 个像素，我们个位数。粒子数、尺寸、alpha、位置都一致，判断是渲染分辨率：WPE 按窗口 1920×1066 直接画，我们按场景 2400×1332 画再缩，2.1 宽的细线峰值被摊薄。是 P1 起「场景目标按场景分辨率」的既有做法 |
| 烟花预设（多 eventdeath 条目、容量 20000 的 spritetrail 子系统） | `3560756264` 强制渲染 600 帧：两个烟花对象各同时 5 个实例，单个实例最多 8500 个粒子，实例粒子合计 25567；WPE 抓帧（`A:\p4e\real-3560756264-fps20`）同样有两个正好 8500 个粒子的实例、其余几百到两千多，每帧粒子总数 3.3–3.6 万，数量对得上。帧时间均值 43 ms、p95 60 ms，其中写顶点 28 ms（spritetrail 每粒子约 1.1 µs）、模拟 5.8 ms。`3570308528` 强制渲染报 `render:texture-missing:0`、`3832133196` 的烟花对象默认隐藏，都没测到 |

**风险（新增）：** 烟花预设的粒子量下，CPU 写 spritetrail 顶点约 28 ms/帧。带这套预设的 3 张场景在本步之后都还有别的不支持项、不会渲染，暂时影响不到用户；它们解锁之前要把写顶点的开销降下来（如 GPU 上展开拖尾，或只写可见的粒子），记到收尾或 P4f。

**待用户：** `1514925620` 在图库预览与桌面上看一眼（偶尔的闪电带一团光晕，雨与雾正常）。测试副本（图片 14372）闪电频繁，方便看光晕，看完由 Claude 用 `projects_remove` 移除。2026-11-12 用户看过，没有问题，提交 `69214a05`（测试副本在提交前已不在库里）。

## 步骤 4 — `audioprocessing*` 与场景频谱

### 思路

音频对粒子只是一个系数 `f ∈ [0, 1]`，乘在五类模块的某个量上（rea-p4e-audio 第 5 节）；`f` 由一个无状态函数从**这一帧的 16 段归一化频谱**算出（第 1 节）。所以这一步分两半：模拟器这边加取值函数与五个作用点，频谱从哪里来交给宿主；宿主这边把「原始频谱 → 归一化 → 64 / 32 / 16 段」做成场景的一份状态，每帧在粒子步进之前推进一次，粒子、脚本（「决定」5）与将来的 `g_AudioSpectrum*` uniform（P11）都读它。

**频谱的形状照 WPE 分三层。** 最底层是采集线程的原始输出：左右各 64 段线性幅值（rea 3.2：每攒够约 29 ms 的样本做一次 FFT，按 bin 取最大、乘频率倾斜）。中间层是渲染线程每帧的自适应归一化（3.3）：64 段每 8 段一组、16 组各有一个慢慢跟随的峰值，每段除以本组峰值，再一阶低通与每帧限幅，静音时整块清零。最上层是逐级取最大得到 32 段、16 段与左右平均。中间层和上层是纯计算，放在场景宿主（TS）里，每个场景一份状态；最底层要读回环，只能在 Rust 的 `WpeMediaHub` 里。（下面这段是按「已定」1 最初的 (c) 写的；2026-11-13 改为方案 B：Hub 同时算两份，网页壁纸照旧拿自定频谱，WPE 原始频谱随 `raw` 只给场景，见「步骤 4 实施记录」。）Hub 现在给网页壁纸的是我们自定的频谱（Hann 窗、换成 dB 再映射到 0–1），和 WPE 的线性幅值不同；归一化是按组相对的，dB 压缩会让非峰值段读数明显偏高（比峰值低 20 dB 的段，WPE 读 0.1，dB 映射后约 0.67），`bounds "0.8 1"` 这类设置下发射会多很多。所以 Hub 的频谱整体换成照 rea 3.2 的原始频谱（「已定」1）：网页壁纸本来拿到的就是 WPE 采集线程的原值（rea 3.4），之前的自定算法是疏漏，一起改；场景在宿主里再做归一化。

**开关只有 `project.json` 的 `supportsaudioprocessing`**（rea 4.1）：没声明、非 Windows、订阅被拒或还没收到数据时，频谱全 0，`f(0) = 0`（语料的 `bounds` 下界 ≥ 0、`exponent` > 0），带音频的发射器不发、速度项为 0（「决定」3）。宿主在「声明了开关，且场景里有 `mode ≠ 0` 的音频字段或脚本注册了音频缓冲」时订阅 Hub。暂停与补画帧（帧时间 0）不推进频谱，同 WPE 整帧跳过时冻结（3.5）。预热在加载期、频谱还是 0，带音频的发射器预热里不发。

几个关键决定：
- **频谱是场景的一份状态，不是每个系统一份。** 取值函数只读数组，一帧里各系统、各遍读到的值相同（3.5、第 5 节），所以模拟器只需要一个所有系统共用的只读引用，由渲染器在 `stepParticles` 之前写好。回放与 dev 探针直接往这份数组里填抓帧读到的值。
- **脚本改读归一化频谱**（「决定」5，2026-11-12 已定）：`registerAudioBuffers` 的 16 / 32 / 64 段 left / right / average 直接取这份状态（`average` 是 `A` 段：先平均再逐级取最大，3.3），不再自己从 Hub 的原值段内取最大。这会改变现有脚本音频场景的画面，要过脚本场景的回归。
- **`g_AudioSpectrum*` uniform 不在本步**（P11），但数据已经就位，P11 只剩把数组写进 uniform。

### 现状锚点

**a. 音频字段只放行 `mode 0`**（`particles/modules.ts:363`，`sphererandom`、`boxrandom`、`turbulentvelocityrandom`、`vortex`、`vortex_v2`、`turbulence` 六个模块展开它）
```ts
const AUDIO_FIELDS: Record<string, ParticleFieldDef> = {
  audioprocessingmode: int(0, (value) => value === 0),   // 现状：非 0 报 `…:audioprocessingmode`
  audioprocessingexponent: num(2),
  audioprocessingbounds: { type: "string", default: "0.8 1.0" },
  audioprocessingfrequencystart: num(0),
  audioprocessingfrequencyend: num(1),
};
```

**b. 发射数不乘系数**（`particles/emitters.ts` 的 `emissionCount`）
```ts
let rate = fields.rate as number;            // 现状：直接用 rate
if (alive < capacity && !state.ended && state.delay <= 0) {
  if (flags & 4) { /* 周期发射 */ }
  // …
  const x = f32(f32(rate * dt) + state.acc);
```

**c. 脚本音频缓冲取 Hub 的原值、段内取最大**（`script/audio.ts` 的 `fillAudioBuffers`，`host.ts:389` 的 `subscribeAudio`）
```ts
// host.ts：只在脚本注册缓冲时订阅；收到的 128 个原值直接交给脚本
if (message.type !== "audio" || !message.data) return;
this.scriptApi?.applyAudioFrame(message.data);
// script/audio.ts：left[band] = max(frame[段内])，average = (left + right) / 2   —— 现状：没有归一化
```

**d. Hub 的频谱是自定算法**（`src-tauri/kabegame/src/wpe_media/spectrum.rs`）
```rust
//! WPE 的具体算法没有公开资料，这里自定：Hann 窗 → 2048 点实数 FFT → 64 个对数间隔频段（30 Hz – 16 kHz，
//! 不超过奈奎斯特）取段内最大幅值 → 换成 dB、加高频补偿后线性映射到 0–1（可略超 1）→ 上升即时、下降按帧衰减。
```

**e. 渲染器一帧的顺序**（`render/renderer.ts`）
```ts
scene.sync(state);
scene.stepParticles(frametime, wrapped, state, cursor);   // 现状：之前没有频谱推进
// … 声音、脚本（beforeFrame）、update、encode
```

**f. `scene.json` 的 `general.supportsaudioprocessing` 照报**（`compile/features.ts:338`）
```ts
if (active(g.supportsaudioprocessing)) unsupported.add("general:supportsaudioprocessing"); // 现状：WPE 不读这个键（rea 第 6 节）
```

### 点 1 — 取值函数与作用点（`particles/audio.ts` 新增、`particles/modules.ts`、`particles/emitters.ts`、`particles/system.ts`）

- **新增** `particles/audio.ts`：
```ts
/** 一帧的 16 段归一化频谱（`ctx+0x2d0` 的 L16、R16），全场景各系统共用、只读；全 0 表示没有音频。 */
export interface ParticleAudio { left: Float32Array /* 16 */; right: Float32Array /* 16 */ }
/** 音频字段解析后的形态（rea 第 2 节：bounds 第二个数缺省 0、start / end 按无符号钳到 ≤ 15、end < start 时交换）。 */
export interface AudioParams { mode: number; exponent: number; lo: number; hi: number; start: number; end: number }
/** 取值函数（`FUN_14022a8a0`，rea 第 1 节）：mode 1 左、2 右、3 是 0.5·max(L + R)，其它 0；再 clamp01((v − lo)/(hi − lo))（NaN 当 1）、
 *  smoothstep、powf(·, exponent)、clamp01（NaN 当 1）。全按 float32。 */
export function audioCoefficient(audio: ParticleAudio, params: AudioParams): number;
```
- **修改** `AUDIO_FIELDS`：`mode` 放开（任意整数，非 0 才生效；4 及以上、负数 `v = 0`）；解析出 `AudioParams` 挂在模块字段上（`bounds` 只认字符串，数字 0 得 `(0, 0)`，其它非字符串照报 `…:audioprocessingbounds`）。
- **修改** 五个作用点（rea 第 5 节，都是 `mode ≠ 0` 才取，`f` 在前）：
  - 发射器（`emissionCount`）：进门（存活数 < 容量、没结束、`delay ≤ 0`）之后、周期发射之前 `rate = f32(f · rate)`；帧尾判结束仍用原 `rate`；`instantaneous` 不乘。
  - `turbulentvelocityrandom`：每个新粒子取一次，乘相位范围（`f·(phasemax − phasemin)`）。
  - `turbulence`：三轴掩码全 0 时整条跳过（连取值也不调，现状如此）；否则 `f·speedmin`、`f·range`，再乘 `k·mask`。
  - `vortex`：`f·speedinner`、`f·range` 再乘 `k`。`vortex_v2`：`(speedinner·f)·k`、`(Δspeed·f)·k`（乘法顺序不同，照抄）。
  - 两遍模式下 operator 每遍各取一次（值相同）。
- **修改** `ParticleSystem` / 模块上下文多一个 `audio: ParticleAudio` 引用（构造时缺省全 0 的共用数组，渲染器建树时换成场景的那份），子系统与事件实例沿用父的。

### 点 2 — 场景频谱（`audio/spectrum.ts` 新增）

- **新增** `SceneSpectrum`：照 rea 3.3 逐行写，状态 `S1[128]`、`S2[128]`、`peak[16]`（加载时清零），输出 `L64/R64/A64`、`L32/R32/A32`、`L16/R16/A16`（`Float32Array`，就地更新、引用不变）：
```ts
/** 每帧一次（粒子步进之前）：`raw` 是 Hub 最近一次的 128 个原始值（左 64 + 右 64），没有时传 null（当全 0）；`dt` 是这一帧的帧时间。
 *  dt = 0（暂停、补画）时什么都不做（同 WPE 整帧跳过，3.5）。 */
advance(raw: ArrayLike<number> | null, dt: number): void;
/** 关掉音频（没声明开关、订阅被拒）：三块清零，之后 `advance` 不再改它们。 */
disable(): void;
```
  - 组峰值目标 `max(0.333·M, 组最大)`、升 `min(dt, |d|)`、降 `0.5·min(dt, |d|)`、差 ≤ 1e-4 直接到位；`peak[0] ≤ 1e-4` 且 `M ≥ 1e-4` 时 16 个峰值重置为 1。
  - 倒数用精确的 `1 / max(peak, 0.001)`，不复刻 `rcpps`（相对误差 ≤ 3.7e-4，同「近似倒数不复刻」的一贯做法）。
  - 低通 `α = min(20·dt, 1)`、限幅 `±min(40·dt, 1)`；`M < 1e-4` 时输出整块 0、`S1`、`S2` 不动。
  - 之后 `A64 = (L + R)/2`，32 段、16 段相邻两段取最大逐级得到（两个分支都走）。
  - 麦克风路径（不归一化）不做：Hub 只开回环。

### 点 3 — 宿主接线（`host.ts`、`render/renderer.ts`、`render/scene.ts`、`script/api.ts`、`script/audio.ts`）

- **修改** `host.ts`：
  - 编译结果带一个「场景用音频」位：`project.json` 声明了开关，且 bundle 里有 `mode ≠ 0` 的音频字段（编译期统计，进 `SceneBundle`）。为真时加载就订阅 Hub；脚本注册缓冲时照旧订阅（开关没声明时 Hub 会拒，频谱保持 0）。
  - Hub 的音频消息照旧是 `data`（128 个值，点 4 之后就是 WPE 的原值），宿主只存最近一份；`SceneSpectrum` 归渲染器所有。
- **修改** `render/renderer.ts`：帧开头、`stepParticles` 之前 `spectrum.advance(latestRaw, frametime)`（补画帧 `frametime = 0` 不推进）。
- **修改** `render/scene.ts`：建粒子树时把 `spectrum.L16 / R16` 交给根系统（子系统与实例沿用）。
- **修改** `script/api.ts`、`script/audio.ts`：`registerAudioBuffers(n)` 返回的 left / right / average 每帧从 `SceneSpectrum` 的同分辨率块拷进去（时机同现在：Hub 来一帧拷一次 → 改为渲染器每帧推进后拷一次）；`fillAudioBuffers` 删除。
- **修改** dev 探针：`renderFrame` / `particleTrack` 的回放参数收逐帧 `audio`（16 段左右），直接写进粒子用的数组（不经归一化）；`host.audio()` 另报归一化后的 16 段。

### 点 4 — Rust：Hub 的频谱换成 WPE 的原始频谱（`src-tauri/kabegame/src/wpe_media/`，「已定」1）

> 2026-11-13 改为方案 B：下面的算法放进新文件 `wpe_spectrum.rs`（内容不变），`spectrum.rs` 还原成原版自定频谱，`audio.rs` 同一批样本喂两份，消息多一个 `raw`，`Cargo.toml` 同时依赖 `realfft` 与 `rustfft`。详见「步骤 4 实施记录」。

- **修改** `spectrum.rs` 的 `Spectrum` 整体换成照 rea 3.2 的算法（删掉 `SpectrumTuning`、Hann 窗、dB 映射与按帧衰减）：
  - `r = max(sr/44100, 1)`、`fftSize = int(r·64·30)`、`ns = fftSize − fftSize/3`（截断照 WPE：44.1 kHz 为 1920 / 1280，48 kHz 为 2089 / 1392）、`N = 640`；每攒够 `ns` 个新样本做一次长度 `fftSize` 的复数 FFT（`rustfft`，任意长度），不加窗、不重叠，`[ns, fftSize)` 保持 `(127, 1/127)`；输入 `re = 127·s + 127`、`im = 1/re`。直流铺满整个缓冲，只落在不用的 bin 0（步骤 0 的抓帧里 L16[0] 有声时也约为 0，和这一点一致）。
  - bin 1..639：`m2` 遇 inf / NaN 置 0；`b = int(powf((k−1)/639, 0.25)·64) % 64`、`idx = min(idx + 1, b)`；`w = 0.501 − cos(π(k−1)/639)·0.499`；`out[idx] = max(out[idx], sqrt(w·m2))`；最后乘 `0.001·(640/(fftSize·0.5))`（增益按缺省 `audioinputvolume 50` → 1.0，阈值 0）。
  - 输出是最近一次 FFT 的结果（左 64 + 右 64），两次 FFT 之间不变；单声道时右 = 左。
  - 静音照 WPE：数据包带 SILENT 时立即清零；连续 1 s 收不到数据包时清零（现在的「缺的样本按静音补」去掉，缺包期间保留上一次的结果）。
- **修改** `audio.rs` 的采集循环跟着改：每 33 ms 照旧推一帧给订阅方（同 WPE 网页窗口线程每 33 ms 取一次，rea 3.4），推的是最近一次 FFT 的结果。
- **修改** `Cargo.toml`：`realfft` 换成 `rustfft`（锁文件里已有 6.4.1，`realfft` 本来就依赖它，不新增 crate），仍在 `wpe` feature 下。
- **单测**：P6a 实测的 7 个频率落段（64 段 4 / 10 / 21 / 32 / 38 / 46 / 54），44.1 / 48 kHz 两种采样率；满幅正弦落在 bin 中心时约 `54·A·√w`；攒不够 `ns` 个样本时输出不变；SILENT 立即清零、缺包 1 s 后清零。
- **怎么做（避免打断 dev）：** 桌面 dev 是 `tauri dev`，改 `src-tauri` 的源码会自动重编、重启应用。所以先在 `ignore/p4/e4/spectrum-crate/`（独立小 crate，只依赖 `rustfft`）里写 `spectrum.rs` 并跑单测，`audio.rs` 的改动写成补丁；合并进 `src-tauri` 时会触发一次重编重启，Claude 先问用户再动，之后跑 `deno task check -c kabegame` 与 `wpe_media` 的测试。
- **文档：** `cocs/wpe/WPE_IMPORT.md` 里「自定频谱算法常数在 `SpectrumTuning`」等描述改成 WPE 的原始频谱；网页壁纸的频谱观感会变，进收尾的回归与 changelog。

### 点 5 — 能力表（`compile/features.ts`）

- **修改** `mode ≠ 0` 不再报（由模块表生成，改 `AUDIO_FIELDS` 即可）。
- **修改** `scene.json` 的 `general.supportsaudioprocessing` 改为中性（WPE 不读，rea 第 6 节；语料只有默认工程 `audiophile`）。

### 点 6 — 回放工具与案例（Claude 做）

- 回放库：轨迹帧带 `audio` 时（`kbp rdc track` 已记下 CLK 读到的 `g_AudioSpectrum16Left/Right`），每帧步进前写进系统共用的 `audio` 数组；帧之间（日志补出的帧）沿用前一帧的值。
- 新案例 `e4`：`p4e-audio` fps 20（30 帧）与 fps 60（40 帧）逐粒子比；`p4e-audio-off` fps 20 比「全 0、带音频的发射器没有粒子」。

### 验收

- 子代理：tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过（已知的 P5a 那一条除外），Prettier；Rust 部分 `deno task check -c kabegame` 与 `cargo test` 相关测试。新增单测：
  - 取值函数：rea 第 1 节的系数表逐格（float32）、mode 1 / 2 / 3 / 4、`hi = lo` 三种、`exponent` 0 与负数、频段钳制与交换；
  - 五个作用点各一条（`f = 0` 时发射为 0 且余数保留、恢复后接着累积；`turbulence` 掩码全 0 不取值；两遍模式取两次）；
  - `SceneSpectrum`：稳态纯音收敛到 1、起音时第一帧等于原值后逐帧上升、静音当帧清零且 `S1`/`S2` 不动、`dt = 0` 不变、20 / 60 fps 的 `α` 与限幅、32 / 16 段逐级取最大、`A` 段先平均后取最大；
  - 脚本缓冲读到归一化值、引用不变。
- Claude 独立验收：
  1. `git status` 查越界；tsc、vitest、cargo 测试自跑；变异检查（mode 3 取 A16、`f` 乘在加余数之后、帧尾判结束用乘过的 rate、`turbulentvelocityrandom` 乘错量、`vortex_v2` 乘法顺序、峰值升降速率互换、限幅去掉、静音时清 `S1`、逐级改成平均）。
  2. `kbp regress`（HEAD 快照 ↔ 步骤 4 快照，现有 15 个案例）：不带音频的案例逐字节相同；语料只去掉各模块的 `audioprocessingmode` 与 `audiophile` 的 `general:supportsaudioprocessing`，覆盖 87 → 93（165 张口径）、80 → 83（152 张口径），不新增能渲染的场景。
  3. 回放 `e4` 在限内。
  4. Rust：独立 crate 的单测自跑；合并后 `deno task check -c kabegame`、`wpe_media` 的测试。
  5. 真机：`p4e-audio` 在 Kabegame 预览里自己放声，`host.audio()` 读到的 16 段和 WPE 抓帧读到的同一工程的 16 段比（稳态时左 1 kHz 在 L16[8]、右 250 Hz 在 R16[2] 收敛到约 1，其余段的量级）；带脚本音频的已能渲染场景放音乐目视（「决定」5 的回归）；一张带音频可视化的网页壁纸放音乐目视（频谱换成原值之后条形的高度与动态）。
  6. 音频响应的工坊场景（用户 2026-11-12 提议）：`3809965824`（图片 13616），音频粒子用到发射器（`boxrandom`、`sphererandom`）、`turbulentvelocityrandom`、`turbulence` 四个作用点；除音频外缺的是实例覆盖绑属性、两个光标回调与视频纹理，不碰音频部分，用 dev 强制渲染。Kabegame 与 WPE 放同一段音乐，比随节奏的发射量与扰动（同一时刻的 WPE 抓帧统计量对我们的 `host.particles` 统计量，加整段目视）；静音时两边带音频的发射器都不发。
- 过后请用户在一张带脚本音频的场景上放音乐看一眼，再提交。

### 步骤 4 实施记录（2026-11-12）

两个子代理并行：TS（点 1、2、3、5）在 HEAD `a261a3b9` 的快照 `ignore/p4/e4/ov` 里做；Rust（点 4）在独立小 crate `ignore/p4/e4/spectrum-crate/` 里做（只依赖 `rustfft`，`--offline`），`audio.rs`、`Cargo.toml` 写成补丁，不碰 `src-tauri`，免得 `tauri dev` 中途重编。Claude 做点 6、验收与合并：TS 照前两步逐文件三方合并（29 个文件、没有冲突，工作区里另有别的会话未提交改动的 `bundle.ts`、`features.ts`、`model.ts`、`render/scene.ts` 保留了它们的改动，合并前的文件在 `ignore/p4/e4/pre-merge/`，补丁 `ignore/p4/e4/step4.patch` +1600 / −186）；Rust 经用户同意后放进 `src-tauri`（`spectrum.rs` 整体替换、`audio.rs` 与 `Cargo.toml` 打补丁，`Cargo.lock` 随之去掉 `realfft`），`tauri dev` 重编重启一次。

**和计划的差异（子代理报告，Claude 核对后接受）：**
1. 起音第一帧不等于原值：rea 3.3 的伪代码与汇编（`0x140111cd2` 写 1.0 之后，`0x140111daa` 起同一帧照常更新峰值）都是峰值重置后当帧再降一步，第一帧读数是 `raw/(1 − 0.5·min(dt, 1 − raw))`（20 fps 约 `raw/0.975`）；计划与 rea「起音」条的「等于 raw」是简写。按汇编做，单测照它写。
2. 场景频谱归渲染器所有，跨重编译保留（同视差点），重编译时预热读到当时的值（rea 3.5【推】）；`disable()` 只在 Hub 订阅被拒时调，没订阅时原值一直为 null，输出本来就是 0。
3. 脚本缓冲在 `beforeFrame` 里、只在实时帧从场景频谱拷，暂停时冻结；刚注册的缓冲到下一个实时帧才有值。
4. Rust 自定的几处：FFT 前减掉常量 `(127, 1/127)`（只落在不用的 bin 0，全 0 输入得到精确的 0；和字面写法的差 ≤ 3.2e-7）；按包即时处理（WPE 一轮轮询末尾处理，差不超过一轮）；缺包计时用实际经过的时间（WPE 加名义间隔）；声道数变化时这一批从头攒；`−1.0` 的样本让该声道整批为 0（照 WPE，16 位格式削波时会遇到）。`ns` 的截断（48 kHz 为 1392）已对汇编核实。
5. Claude 验收时补：`bounds` 的 `lo`、`hi` 与 `exponent` 转 float32（WPE 存成 float，`"0.8 1.0"` 不是 float32 精确数，阈值附近才和 `subss` 逐位相同）；`host.audio()` 加 `raw`（最近一帧 Hub 原值），核对原始频谱量级用。

**验收结果：**

| 项 | 结果 |
|---|---|
| tsc / vitest | 快照：tsc 0 error，81 个文件 2059 个用例，只有已知的 `3830255100: 219 次请求`（P5a）失败（Claude 自跑同子代理）。合并后的工作区 tsc 0 error、Prettier 通过；`compile/conditions.test.ts` 4 条失败属 P7d 会话未跟踪的新文件（`constant:slots`，本步没碰） |
| Rust | 独立 crate 17 个单测自跑全过（7 个频率落段 44.1 / 48 kHz、满幅正弦量级、对 f64 直接 DFT、静音与缺包、单声道等）；合并后 `tauri dev` 重编通过、应用正常起来 |
| `kbp regress`（HEAD 快照 ↔ 步骤 4 快照，15 个旧案例 + `e4` + 语料） | 15 个旧案例逐字节相同；`e4` 在 HEAD 上跑不下去（没有 `setAudio`），属预期。语料 173 张只在 12 张里去掉音频键（各模块的 `audioprocessingmode` 与 `audiophile` 的 `general:supportsaudioprocessing`），没有新键 |
| 覆盖（`ignore/p4/e1/cov_e1.py ignore/p4/e4/out/regress`） | 165 张口径 87 → 93、152 张口径 80 → 83，和计划相同；能渲染不变（45） |
| 回放 `e4`（新案例：`p4e-audio` fps 20 / 60、`p4e-audio-off` fps 20，轨迹改用 points 认法重提） | 全过。8 个音频发射系统用产品的 `emissionCount` 与取值函数、每帧喂 CLK 读到的频谱，两种 fps 下都存在能让窗口内每帧出生数和 WPE 相同的余数初值（可行 91–2894 / 4096；阶跃与缺省参数的两个两边都 0）；`p4e-audio-off` 的 `a-vortex` 逐粒子在包络内、音频发射系统没有粒子。测试工程的 CLK 读 `g_AudioSpectrum*` uniform（P11）照报，写进期望 |
| 变异（`ignore/p4/e4/mutate_e4.py`，11 处） | 全部检出：mode 3 改两边各取最大、`f` 乘在加余数之后、帧尾判结束用乘过的 rate（这三处 `e4` 也抓到）、`turbulentvelocityrandom` 乘错量、`turbulence` 只乘速度差、`vortex_v2` 先乘 k、组峰值升降互换、去掉限幅、静音清 `S1`/`S2`、逐级改平均、`dt = 0` 也推进 |
| 原始频谱对 WPE（系统里放 `p4e-audio` 的 WAV，读 Hub 原值） | 量级合理论式：左 1 kHz 振幅 0.2 的 L16[8] 原值 1.04（`54·A·√w` 加扇贝损失约 1.1），振幅 0.05 的一段 0.26，正好四分之一。频段形状和 WPE 起音帧（读数 ≈ 原值）在两位小数内一致：右 250 Hz 的 R16[0..3] 我们 0.017 / 0.031 / 0.272 / 0.062、WPE 0.02 / 0.03 / 0.28 / 0.06，左邻段比 L16[7]/L16[8] 0.135 对 0.13。绝对值 WPE 两声道都约是我们的 0.52 倍，判断是 WPE 播放这个声音对象时的音量（工程写 1.0，WPE 再乘自己的壁纸音量）【推】，不是算法差；归一化按组相对，对粒子与场景脚本没有影响 |
| 音频响应场景 `3809965824`（用户提议） | 原场景主角立绘是视频纹理，强制渲染也报 `render:texture-missing:0`，所以解包成测试副本 `ignore/p4/proj/real-3809965824-kbp` 并删掉立绘对象（写死不可见的图层本身仍建资源）。系统里循环放合成测试音乐（底鼓、和弦、镲片），Kabegame 实时预览对 WPE 抓帧（原场景，粒子系统相同）：不带绑定的 `notes1_audio_responsive`（`boxrandom` 发射乘系数）我们 7–8 个、WPE 6–8 个；不带音频的 `Blinking Stars` 237–246 对 233–241；`鼠标音乐` 7–9 对 14–24，它的 `count` / `rate` / `size` / `speed` 都挂脚本（实例覆盖脚本是 P4f，强制渲染用静态值），和音频无关。停掉音乐后两边带音频的两个系统都不再发射（我们频谱当帧清零、粒子按寿命降到 0；WPE 静音时每帧少了这两次绘制）。测完删掉了 dev 的强制渲染开关、移除了测试副本 |

**改为方案 B（2026-11-13）：** 用户在网页壁纸上比较后觉得之前的自定算法观感更好。WPE 原始频谱改名 `wpe_spectrum.rs`（内容不变，17 个单测随它），`spectrum.rs` 还原成原版；`audio.rs` 同一批样本喂两份（自定频谱照旧按静音补零，WPE 原始频谱照 WPE 立即清零 / 缺包 1 s 清零），`on_frame(网页壁纸的, WPE 原始的)`；`WpeMediaMessage::Audio` 多一个 `raw`；`Cargo.toml` 同时依赖 `realfft` 与 `rustfft`。场景宿主改读 `raw`（只有 `data` 的消息不算）。合并前在独立小 crate 里编译检查（windows 0.52）、两份频谱共 22 个单测通过。上面「原始频谱对 WPE」与音频响应场景的对照用的就是这份 WPE 原始频谱，结论不变；网页壁纸观感回到步骤 4 之前。

**文档：** `cocs/wpe/WPE_IMPORT.md`（依赖、音频段落）与 `cocs/README.md` 的摘要补写场景用的 WPE 原始频谱（`raw`），网页壁纸的描述不变。

**已知差异：** 「音频录制」属性没做（已定 2）；场景的 `g_AudioSpectrum*` uniform 是 P11；网页壁纸拿到的是自定频谱，不是 WPE 给网页壁纸的原值（已定 1，用户选的观感）。

**待用户：** 2026-11-13 用户看过网页壁纸后改为方案 B（见上）。

### 已定（步骤 4，2026-11-12 用户）

1. **原始频谱：** 2026-11-12 先选 (c)（Hub 的频谱整体换成 WPE 的原始频谱，网页壁纸与场景共用）；2026-11-13 用户比较后觉得网页壁纸用之前的自定算法观感更好，改为 **B**：Hub 同时算两份，网页壁纸照旧拿自定频谱（`data`），WPE 原始频谱（`wpe_spectrum.rs`）随同一条消息的 `raw` 只给场景，场景在宿主里再做归一化。
2. **「音频录制」属性先不做：** 缺省就是开，和现在的行为相同，记成已知差异（WPE 关掉时频谱立即清零，rea 4.2）。

## P4e 收尾（2026-11-13）

收尾不改产品代码的行为（只改一处注释，见收尾 A 结论）。A 走查各步按推断实现的几条，语料用得到的用 WPE 实测；B 写文档与覆盖数。

### 收尾 A — 按推断实现的几条

先扫语料看哪几条会被用到（`ignore/p4/e5/scan_unverified.py`，结果 `out/scan_unverified.txt`），只对用得到的做实验：

| 推断 | 语料用量 | 结论 |
|---|---|---|
| 运行中建实例、按自己的 `starttime` 预热时，场景时间 `T` 取这一帧的 `g_Time`（步骤 2 差异 7） | 事件子系统带 `starttime` 且读 `T` 的模块（`turbulence`、`turbulentvelocityrandom`、`remap*`）3 处 / 2 张（`3560756264`、`3813473025`） | **实测成立**，见下 |
| 同上，图层时间取这一帧的值 | 同上 | 仍是【推】：测试工程不读图层时间，对照变体检不出（预期）；语料里读图层时间的只有 remap 的 `layertime` 输入，这 2 张没有 |
| 复用实例时 static 孙辈不再预热（步骤 2 差异 7） | 0 处 | 不测 |
| 不可见时照常建 eventdeath 实例（步骤 3「几个关键决定」） | 带 eventdeath 的对象可见性绑属性或挂脚本 8 处 / 3 张（烟花预设） | 碰不到：eventdeath 条目都挂在顶层系统上，顶层隐藏时有存活粒子就整体清空、不判死，没有死亡事件。不测 |
| `followSlot` 留给 `inherit*fromevent` | 0 处 | 不测 |
| 音频的绝对量级（步骤 4：WPE 原始值约是我们的 0.52 倍，推断是 WPE 的壁纸音量） | — | 不测：归一化按组相对，只经 `M < 1e-4` 的静音门起作用，对粒子与脚本没有影响；记进已知差异 |

**实验 `p4e-close`**（`ignore/p4/defs/p4e0.py`，fps 20，`FR_CURSOR`、每 10 帧刷日志）：父系统 `rate 0.5`、寿命 10，`pw-spawn` 挂 eventspawn、`pw-follow` 挂 eventfollow；子系统 `starttime 0.3`、发射 `duration 0.3`、`rate 20`、寿命 2，粒子全在实例建立时的预热里出生；`turbulentvelocityrandom` 相位收成 0、速度 100，出生方向只由 `T` 决定。抓帧 `A:\p4e\p4e-close-fps20`，轨迹 `ignore/p4/tracks/rd-p4e-close-fps20.json`（points 认法）。新案例 `e5`（钩子沿用 `e3`）按槽序逐粒子比：

| 项 | 结果 |
|---|---|
| 本实现（`T` = 本帧 `g_Time`） | 4 个系统全过：两个父系统位置差 0；两个子系统（每帧 6 个粒子，逐帧个数与 WPE 相同）位置 3.05e-5，差/限 0.031 |
| 变异「实例预热时 `T` 取 0」（`ignore/p4/e5/mutate_e5.py`） | 检出：两个子系统位置 9.51 像素，差/限 9514 |
| 对照「图层时间取 0」 | 检不出（工程不读，预期）；还原后快照树哈希与开始时相同 |

结论：推断成立，实现不用改。实测结果补进 rea-p4e-children 4.7；`particles/system.ts` 的 `PrewarmEnv` 注释同步（场景时间改为实测，图层时间注明仍是推断），这是收尾唯一的产品文件改动，只改注释。

### 收尾 B — 文档与覆盖数

- **文档：** `cocs/wpe/WPE_SCENE.md` 新增「粒子（P4e）」一节（条目与系统树、static、实例池、绘制、音频的取值函数与场景频谱、已知差异、语料与解锁、探针与对比台），顶部状态块与计划链接补 P4d、P4e，P4d 表里 `vortex_v2` 的「`audioprocessingmode ≠ 0` 照报」改指向 P4e；`cocs/README.md` 的场景文档条目加 P4e 摘要与适用场景；`versions/latest/changelog.md` 用户侧、开发侧各一行；`versions/latest/regression.md` 新增「场景壁纸 P4e」（E1–E17）；总计划 [phase-4-particles.md](phase-4-particles.md) 写完成情况、加风险 8。
- **覆盖数**（`ignore/p4/e5/cov_e5.py`，基线 `ignore/p4/d7/corpus.json`（HEAD `c22b66a2`）对收尾的扫描 `ignore/p4/e5/corpus.json`（HEAD `1e929b3b`），结果 `out/cov.txt`）：

| 口径 | 带粒子 | 粒子用法完全覆盖 | 能渲染 |
|---|---|---|---|
| 165 张 | 108 | 61 → 93（步骤 1–4 之后依次 72、82、87、93） | 38 → 45 |
| 152 张 | 95 | 57 → 83（67、75、80、83） | 38 → 45 |

  能渲染新增的 7 张：P4e 单独解锁 `3778592720`、`3811798465`、`1514925620`；`1333579536` 基线时差 `model:passthrough` 与 `particle:children`，P5b 与 P4e 一起解锁；`1923929928`（P5b）、`3822495444`、`3831518461`（着色器，P7）来自别的阶段。没有场景不再能渲染，没有少覆盖的。
- **还挡着粒子覆盖的键**（165 张，括号里是只差它的张数）：`particle:binding:instance:rate` 8（2）、`colorn` 5（2）、`count` 3、`size` 3、`speed` 2、`alpha` 2（1）、`lifetime` 1（都是 `{script}`，P4f）；`particle:instance:brightness` 3（3）；`particle:renderers` 1（1）。
- **没做的：** 10 张干净场景的画面哈希（P4d 的 D10）各步都没有单独量，同期别的会话也在改渲染器，事后没有干净的基线；回归文档里写明。

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
3. ~~**绘制次数**~~：步骤 2 实测，实例最多的 `2974757317`（129 个实例 draw）粒子模拟 0.76 ms、写顶点 0.13 ms，不用合并。
4. **音频回环的干扰：** 实测期间用户放的声音会进 WPE 的频谱；以 CLK 层读到的频谱为准回放，不假设输入。
5. **烟花预设的写顶点开销**（步骤 3 新增）：`3560756264` 单个 eventdeath 实例最多 8500 个 spritetrail 粒子，帧时间均值 43 ms，其中 CPU 写顶点约 28 ms。带这套预设的 3 张场景都还有别的不支持项；解锁之前要先降下来（GPU 上展开拖尾，或只写可见的粒子），记在总计划风险 8。
6. **两条仍是推断、语料没用到的行为**（收尾 A）：复用实例时孙辈不再预热、不可见时照常建 eventdeath；运行中建实例预热用的图层时间也仍是推断。将来语料里出现时要先实测。
