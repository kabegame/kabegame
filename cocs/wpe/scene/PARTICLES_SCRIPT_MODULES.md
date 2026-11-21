# 场景壁纸：粒子：脚本接口与其余模块

> [场景壁纸文档](../WPE_SCENE.md) 的一章：脚本接口与多 renderer、颜色 initializer、boids、粒子光照、`layerimage` 发射器（P4f–P4j）。总体形态、各阶段状态与全部章节的索引在总览里。

## 粒子（P4f）

P4f 让脚本能控制粒子系统，顺带补完粒子上剩下的两件事。四块都落在 P4a–P4e 已有的接口上：
- **字段脚本挂在 `instanceoverride` 上**（`{"rate": {"script": "…", "value": 1}}`）：和用户属性改值是同一件事，写回目标接到就地目标 `particle-instance`；`rate` 另有一条不置脏的路。
- **HDR 下的 `instanceoverride.brightness`**：乘新粒子出生时的实例颜色。
- **粒子层的脚本方法**（WPE 的 `IParticleSystem`）：`play` / `pause` / `stop` / `isPlaying` / `emitParticles(n)` 与只读字段 `instance`（24 个字段的代理）。
- **一个系统多个 renderer**：一个系统按 renderer 数组各画一次。

做完之后带粒子的场景里粒子用法全部覆盖；深度与剔除（`cull:*`、`depthtest:*`、`depthwrite:*`）不在这里，由 P5d 步骤 1 做完（不分图层种类，P4f 已定 1），见 [CAMERA.md](CAMERA.md)「透视相机、相机对象与深度（P5d）」。

依据：
- 读码：[rea-p4f-script](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4f-script.md)（方法表、`play` / `pause` / `stop` / `isPlaying`、`emitParticles` 的门与欠账、`instance` 的读写与生效时机、字段脚本、`brightness`、多 renderer 的变体材质与绘制循环）；
- 确定性工程的实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4f 语义的实测核对」；
- 逐步的验收数据与没测到的项：[子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4f-script.md)「步骤 0–4 实施记录」「没测到的」「P4f 收尾」。

验收照 P4a–P4e：随机范围收成 min = max，按 WPE 日志的 dt 回放、逐粒子和 RenderDoc 抓帧比。回放案例 `ignore/p4/cases/f1`（字段脚本）、`f2`（`brightness`，按「超高」与「关闭」两档编译）、`f3`（脚本方法，钩子按 WPE 日志里 `[kbpx]` 事件的 `engine.runtime` 在对应帧的脚本阶段调产品入口）；多 renderer 用离线四角与整帧。每步 `kbp regress` 现有案例逐字节相同；变异检查每步一组（共 34 处，步骤 3 的 `no-capacity` 是等价变异），只靠单测的几条在子计划里写明。

### 实例覆盖挂字段脚本与 `rate`

WPE 的字段脚本、脚本赋值、用户属性改值走同一个 setter：写进实例覆盖、置脏，下一帧对象更新开头从基值重算（读码 5.2、5.3、6.2）。我们的用户属性早就是这条路（`SceneState` 写 `particle-instance`，下一次 `sync` 在 `stepParticles` 之前调 `ParticleSystem.setInstance`），所以只是把 `instanceoverride/<键>` 的字段脚本写回目标接过来（`compile/scripts.ts` 的 `targetOf`），时机自然对上：第 N 帧写的值第 N + 1 帧生效（实测 `p4f-instance`）。

| 项 | 规则 | 依据 |
|---|---|---|
| 能挂脚本的键 | `SCRIPT_INSTANCE_KEYS`：7 个系数（`alpha`、`size`、`count`、`speed`、`lifetime`、`rate`、`brightness`）、`colorn`、`controlpoint0..7`、`controlpointangle0..7`，共 24 个；别的键挂脚本照报 `particle:binding:instance:<键>` | 读码 1.3 |
| 每帧写 | 字段脚本每帧都写、不比较；重算从基值乘，每帧写同一个值和不写结果相同 | 读码 6.2、6.4；实测 `i-count-const`、`i-count-static` |
| `rate` | 没有改值回调：单写它不置脏、不钳制，下一帧直接用 `dt′ = dt·rate`（写 0 整棵树冻结）；湍流类的 `timescale` 不跟，要等别的系数被写、置脏重算时才跟上，那时把 `rate` 钳到 0.01 并写回实例覆盖。用户属性改 `rate` 同一条路（`ParticleSystem.setRate`，`sync` 里先于 `setInstance`） | 读码 5.4；实测 `b-rate0`、`rt-1`、`rt-2` |
| 加载 | 建系统时 `rate` 钳到 0.01 并写回状态（`SceneState.fromBundle`、系统构造、单图层重建三处） | 读码 6.1 |
| 冻结帧 | `dt′ ≤ 0` 时系统时间与图层时间不动、模拟跳过、控制点不更新；写顶点、子系统照常 | 读码 |
| 子系统 | 不单独登记，值从根系统递归；子系统构造时实例值取根的当前值 | 同 P4e |

- **控制点**（P4f 步骤 3 起）：运行中写 `controlpointN` / `controlpointangleN`（属性、字段脚本、`instance` 对象）在置脏重算时写进 `cp[N]` 的 base：平移替换、角度按 Z·Y·X 换 3×3，`flags & 0x10005` 的点（指针、父控制点、remap 输出）跳过，递归到 static 子系统与池里的实例（读码 5.5、rea-p4e-children 3.4）。
- 顺带修掉的 bug：以前 `instanceoverride/alpha`、`brightness` 的字段脚本会落到图层自己的 `alpha` / `brightness` 上。

### HDR 下的 `brightness`

重算实例覆盖时 `k = (HDR && !(flags & 8)) ? brightness : 1`，出生颜色初值 `instColor = colorn·k`（`colorn` 生效时）或 `(k, k, k)`，颜色 initializer 再乘上去（读码第 7 节，`particles/colorn.ts` 的 `instanceBrightness`，乘在 `applyColorn` 里）。

- 只乘颜色三通道、不乘 alpha、不钳制，有没有颜色模块都乘，在 `colorn` 之后（实测 `p4f-bright`：超高档 `b-05` / `b-2` / `b-2-cn` / `b-2-a` 和 WPE 逐粒子相同，`b-2-f8` 与关闭档不变；真机预览与 WPE 超高档上屏画面差 0–2 个色阶）。
- HDR 只在加载时判定（P3 K3），编译期写进每个系统的 `SceneParticle.hdr`，子系统与事件实例各看自己的 `flags & 8`。
- 运行中改值就地：置脏、下一帧重算 `instColor`，**只影响之后出生的粒子**（收尾补测 `p4f-bright2`：WPE 里把绑定的属性从 2 改回 1，最近出生的 4 颗是 1 倍、更老的保持 2 倍，`flags 8` 不变；Kabegame 预览里改同一个属性，同样一刀切开）。

### 粒子层的脚本方法与 `instance`

WPE 的粒子对象有一张自己的反射表（读码 1.1，`FUN_14024cb00`）：五个方法和只读字段 `instance`；子系统与事件实例脚本拿不到（1.5）。我们照 P6a 给声音对象登记 `ISoundLayer` 的做法，只在粒子对象的图层代理上登记（`script/api.ts` 的 `installParticle`），落点是渲染器上这一层的根系统（`GpuScene.particleScript`）。编译期的「宁可多报」规则（`PARTICLE_LAYER_METHODS`）随之删掉：粒子层与声音层的同名方法都有了，按对象类型在运行时分派。

| 方法 | 我们的做法 | 依据 |
|---|---|---|
| `pause()` | 根上置脚本暂停位，整棵树共用（新建、复用的事件实例同样带上）：发射函数整段不跑，`delay`、`duration`、周期计时、余数都冻结，eventspawn / eventfollow 不建；模拟、判死、eventdeath 照常 | 读码 2.1；实测 `a-pause`、`b-pause-dur` |
| `stop()` | 根与 static 子孙的发射器标结束、计时复位，图层时间清零，清全部粒子，销毁活跃事件实例（空闲池保留），不清暂停位；当帧不画 | 读码 2.3；实测 `a-stop`、`a-tree` |
| `play()` | 清暂停位；整棵树不活跃时复位发射计时、清结束位、重开（递归 static），不预热；还活跃时只清暂停位 | 读码 2.2；实测 `a-stop`、`a-emit-stopped` |
| `isPlaying()` | 没暂停且 `isActive()`（还有没结束的发射器、存活粒子或活跃的子孙） | 读码第 3 节；`f3` 回放和 WPE 日志逐条相同（724 条） |
| `emitParticles(n)` | 整数原样，0、非整数、缺参数当 1，负数不发（实测 `()`、`(0)`、`(2.7)` 都是 1，`(-3)` 是 0）。脚本阶段当场发：每个发射器各发 n 个，每条现算「容量 − 存活数」、满了丢弃；没被挡的发射器连同待发的 `instantaneous` 记欠账（`acc −= pending + n`），被挡的（结束、暂停、`delay > 0`）不动计时。照常触发 eventspawn / eventfollow | 读码 4.1–4.5；实测 `a-emit*`、`b-debt`、`b-args` |
| `instance` | 24 个字段的代理：写走和属性、字段脚本同一个 setter（下一帧生效，`rate` 走单独的路），读状态里的覆盖值，当场读得回（没设过的控制点 x 是 3.4028235e38，`colorn` 是 (−1, −1, −1)）；整体赋值忽略 | 读码 1.3、5.1；实测 `a-inst`、`a-inst-cp` |

- **脚本发出的粒子本帧不画**：WPE 写完顶点才跑脚本，它们下一帧先增龄 `dt′` 再画（读码 4.4）。我们的帧序是脚本之后才写顶点，所以给这批粒子记「本帧脚本出生」（`ParticleSystem.scriptBorn`），写顶点、rope / ropetrail 的段、轨迹快照都跳过，下一次 `step` 开头清掉；脚本阶段新建的事件实例连同子孙同样本帧不画。实测 `b-spawn`、`b-emit-alpha`。
- **首次加载**：脚本 `init` 早于渲染器建场景，这期间调的方法按顺序记下、`beforeFirstFrame` 补调；`isPlaying` 按记下的暂停 / 停止回答。重编译与单图层重建时新树沿用旧树的暂停 / 停止（`adoptScriptControl`），否则重建后会自己重新发射【推】。
- **和 WPE 有意不同的三处**（P4f 已定 5–7，WPE 的行为按 bug 处理，只有单测）：
  1. 自然结束后 `play()` 重新发射：WPE 只清结束位、不复位计时，`duration` 型发射器停在 −1 不再发、`isPlaying()` 却恒真；我们先复位计时再重开。
  2. `stop()` 之后改实例系数不重新发射：WPE 置脏重算会重开 `rate > 0` 的已结束发射器，之后计数下溢、`isPlaying()` 恒真；我们让 `stop` 造成的结束只有 `play()` 能解除（自然结束的照旧会被重算重开）。
  3. 脚本 `emitParticles` 建事件实例用对象的 `W`：WPE 在脚本阶段的模型栈顶是单位阵，父或子是世界空间时实例偏一个 `W`。
- **按推断实现的**（只有单测）：参数越出 int32 当 0 再按 1 发；`stop` → `play` 时复位计时（WPE 停止期间 `delay` / `duration` 照样倒数）；「被 stop 停下」只在 `play()` 真的重开时解除。

### 一个系统多个 renderer

WPE 对一个系统的 renderer 数组逐条各画一次：每条用同一个基础材质按 renderer 类型加宏建一个变体材质，绘制前按这一条的 `orientation` / `axis` 算 `g_Orientation*`，拖尾那条另写 `g_RenderVar0.xyz`；sprite 与 spritetrail 共用一份每帧写一次的顶点缓冲（读码第 8 节）。我们一个系统出几个 draw，各写各的顶点：画面相同（同一批存活粒子、同一个槽序，速度为 0 的粒子 sprite 那次画、拖尾那次照 `trailDrawable` 跳过），单 renderer 的系统逐字节不变，代价是多 renderer 的系统多写一次顶点。

| 项 | 规则 | 依据 |
|---|---|---|
| 解析 | `SceneParticle.draws`：表内的每个 renderer 一项（JSON 顺序），`renderer: []` 为空，只有表外类型时按缺省 sprite 一项；`renderer` 改为模拟用的那条（有 rope 类取第一个 rope 类，rope 表与拖尾历史跟它建） | 读码 8.1、8.2 |
| 变体材质 | 每项一份 pass：第 0 项沿用 `objects/<i>/particle/passes/<k>`，第 r 项（r ≥ 1）是 `…/particle/renderers/<r>/passes/<k>`（子系统接在自己的键后）；材质常量的属性绑定两份都登记 | 读码 8.1 |
| 厚格式 | 看整个系统：有 spritetrail（或槽 0 是帧表）时同系统的 sprite 变体也写 `THICKFORMAT`、`TEX0FORMAT` 按厚格式规则（`particleThick`），轨迹的 `thick` 列同样 | 读码 8.1；T8：sprite 那次有 `THICKFORMAT`、没有 `TRAILRENDERER` |
| 绘制 | 计划里一个 renderer 一个步骤；渲染器的模板池每次出现一组 draw，同一系统的整组按数组顺序连着画、再走子系统；快照仍是每对象至多一次 | 读码 8.3、8.4 |
| `g_RenderVar0` | 每个 draw 自己的；sprite 写 0。WPE 是全局、没写的分量留着上一次绘制的值，sprite 变体不读它，不复刻【推】 | 读码 8.3 |
| 照报 | rope / ropetrail 和别的 renderer 混挂仍报 `particle:renderers`：rope 类的缓冲、rope 表、拖尾历史是系统级的，多条 rope 类记录各自的参数怎么作用到同一份缓冲上没追、没抓帧，语料 0 处。强制渲染时只画模拟跟着建的那条 rope 类 | 读码 8.2 |

- **验收**：离线四角对 T8、T8r（两种顺序）、`p4f-multi` 的 `m-st-zero`（拖尾那次 WPE 四角是 NaN，我们不写）、`m-ss`（第二个 sprite `fixed`、`axis 1 0 0`）、`m-child-c`（子系统上的两个 renderer），65 个系统全部吻合；真机按 WPE 的帧时间回放，`p4c-trail` 与 `p4f-multi` 整帧 0 差异（时间线不用平分的帧）。
- **真实场景没确定**：语料里唯一的 `3465215190` 的 `Snow`（sprite + spritetrail）只看了强制渲染的一帧（这张另差 18 项、不能渲染），代码里在 `compile/features.ts` 的规则处标了 `TODO:[WPE_SCENE]`。

### 语料与覆盖

口径同 P4e（带粒子的场景里不报任何 `particle:*` 键的场景数）。

| 口径 | 带粒子 | 粒子用法完全覆盖 | 能渲染 |
|---|---|---|---|
| 165 张 | 108 | 93 → 108；步骤 1、2、4 之后依次 104、107、108（步骤 3 不改覆盖） | 不变：P4f 去掉的键在每张场景里都不是最后一项 |

- **去掉的键**：`particle:binding:instance:*` 11 张（步骤 1）、`particle:instance:brightness` 3 张（步骤 2）、`script:api:particle.play` 39、`stop` 30、`pause` 16、`isPlaying` 8 与 `layer.emitParticles` 1（步骤 3）、`particle:renderers` 1 张（步骤 4）。没有新增的键。
- **用到脚本方法的真实场景测不了**：`emitParticles` 的两处调用都在光标回调里（`3286859278` 的 `Thunderbolt` 要 `input.cursor*`，`3570560686` 的按钮挂在 `cursorClick` 上），这两个 API 还没实现；代码里在粒子层脚本方法的落点标了 `TODO:[WPE_SCENE]`。
- **真机对照**：`3809965824` 的「鼠标音乐」（`count` / `rate` / `size` / `speed` 挂音频脚本）放同一段音乐时 19–24 个、尺寸 18–36，WPE 14–24 个、16–29，用静态值时只有 7–9 个。

### dev 探针与对比台的增补

| 探针 | P4f 增补 |
|---|---|
| `particleCorners` | 每个粒子层按顶层系统的 `draws` 每条各出一项，第 r 项（r ≥ 1）带 `renderer: r` |
| `GpuScene.particleProbe` | 第 4 个参数 `renderer`（缺省 0） |

对比台在 `ignore/p4/`：
- 确定性工程：`defs/p4f0.py`（`kbp gen p4f0`）出 `p4f-instance`、`p4f-api`、`p4f-api2`、`p4f-api3`、`p4f-bright`、`p4f-multi` 与收尾的 `p4f-bright2`。脚本事件写进 WPE 的 log.txt：`[kbpx] <对象名> <engine.runtime> <事件>`（FR 的 `[kbp]` 解析不认这个前缀）。
- 回放案例 `cases/f1.json`–`f3.json`；kbp-tools 的案例多了 `postprocess` 字段（按档位编译），`observe` 钩子多第 6 个参数（这一帧的控制点输入）；`kbp corners offline` 认 `名字#<r + 1>` 为第 r 条 renderer，并按 `forEachDrawn` 比 static 子系统。
- WPE 参照在 `A:\p4f\`。各步的快照、补丁与变异清单在 `f0/`–`f4/`。

## 粒子（P4g）

P4g 补两个出生时的颜色 initializer：`hsvcolorrandom`（类型 4）与 `colorlist`（类型 5）。和 P4b 的 `colorrandom` 同一类：在模块表里登记字段，出生时算一个颜色**乘**到初值颜色列上（`particles/initializers.ts`）；系统色与 `colorn` 的重算各多一种记录（`particles/colorn.ts`、`compile/particles.ts` 的 `particleColorSystem`）。语料里没有场景用到，起因是 WPE `myprojects` 里 5 张「followed by mice」场景只差 `hsvcolorrandom`（`colorn` 绑用户属性「颜色可调」）。

依据：读码 [rea-p4g-color](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4g-color.md)；确定性工程的实测 [报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4g 语义的实测核对」（读码各条成立，两处以实测更正）；验收数据 [子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4g-color-modules.md)「步骤 0、1 实施记录」。

### `hsvcolorrandom`

| 项 | 规则 | 依据 |
|---|---|---|
| 键与缺省 | `huemin` 0、`huemax` 1、`huesteps` 6、`saturationmin` 0.5、`saturationmax` 1、`valuemin` 0.5、`valuemax` 1；不钳制，`huesteps` 截成整数、取 `max(0, ·)`；字符串 `huesteps` 照报 | 读码 |
| 步长（编译期，`normalizeHsvColor`） | `s ≤ 1` 时没有步长（色相恒为 `huemin`）；否则 `d = huemax − huemin`（可为负），`span = d == 0 ? 1 : d`，整圈（`|d mod 1| < 1/360`）时 `div = s`、否则 `s − 1`，`step = span / div` | 读码；`s ≤ 1` 的 span 为 0 是实测更正 |
| 出生 | 档位 `k = min(trunc(r/32767·(s+1)), s)`，共 s + 1 档，非整圈时最后一档越过 `huemax`；色相 `huemin + k·step`，不取模（负色相落进 `hsv2rgb` 的「其它」分支得灰色）；之后 S、V 各抽一次 `R`；`hsv2rgb` 后乘到初值颜色 | 读码；实测 `hsv-fwd` / `hsv-rev` / `hsv-neg` 等 |
| 档位随机数 | WPE 是 MSVC CRT 的 `rand()`（渲染线程启动时用 QPC 播种，和声音选文件共用），**不复刻**：用一个独立的随机源（`particles/random.ts` 的 `HueSource`，种子派生，不占 `R`）。验收时档位确定的组逐粒子比，分档的组比取值集合与比例 | 读码；同 P4a 起「随机数不复刻」 |

### `colorlist`

- **键**：`colors`（数组）、`huenoise` / `saturationnoise` / `valuenoise`（缺省 0）。`colors` 只认能切出三个数的字符串项，不 ÷255、存成 HSV；单个字符串当一项；别的形状照报 `particle:initializer:colorlist:colors`。
- **缺省**：不写 `colors` 键时是**一项白色**（缺省值字符串 `"1 1 1"` 被当成一项，实测更正）；`[]` 或没有一项有效时补纯红 HSV (0, 1, 1)。
- **出生**：下标一次 `R`、H / S / V 各一次 `R`（区间 `[max(x − noise, 0), min(x + noise, 1)]`），每粒子 4 次；加上 `colorn` 的平移后色相取小数、S / V 钳到 [0, 1]，乘到初值颜色。

### 系统色与 `colorn`

- **系统色**：initializer 按顺序、后者覆盖前者。`hsvcolorrandom` 取三个区间中点（各钳到 [0, 1]）的 `hsv2rgb`；`colorlist` 取第一个有效项的 RGB，没有有效项时不改系统色。语料写法「`colorrandom` 在前、`hsvcolorrandom` 在后」取后者。
- **记录 0xd（`hsvcolorrandom`）**：生效时 `huemin' = (hc − (span·0.5 + huemin)) + huemin`（色相按区间中点平移到 `colorn` 的色相，不取模），S / V 区间居中到 `colorn` 的 S / V 并钳到 [0, 1]、超出 1 时截短 range；**步长与档数不重算**。
- **记录 0xe（`colorlist`）**：生效时出生的平移是 `colorn` 的 HSV 减第一项的 HSV。
- `flags & 8` 不建记录；运行中改 `colorn`（绑属性）就地重算，只影响之后出生的粒子（实测 `p4g-live`）。

### 验收与覆盖

- 确定性工程 `ignore/p4/defs/p4g0.py`（`p4g-hsv` 13 组、`p4g-hsv5` 6 组、`p4g-list` 8 组、`p4g-live` 2 组），WPE 参照 `A:\p4g\`；dev 应用里 `particle_track` 按 WPE 时间线回放、`ignore/p4/g1/cmp_colors.py` 比颜色：档位确定的组逐粒子颜色差 0，分档的组取值集合相同、比例在采样误差内，S / V 连续随机的组色相档位与区间一致。没有建回放案例（颜色取值集合由脚本比）。
- 变异检查 7 处全部被单测检出（`ignore/p4/g1/mutate_g1.py`）。
- 覆盖：165 张口径不变（语料 0 张用到）；myprojects 的 5 张（`3841315879`、`3841322784`、`3841330265`、`3841337134`、`3841390912`）不支持项从 1 项到 0 项。

## 粒子（P4h）

P4h 补粒子 operator `boids`（类型 17，「鸟群」三规则：对齐、聚合、分离）。它是**第一个粒子之间互相读的 operator**，结果取决于遍历顺序、写回时机和 WPE 的一处缺陷，所以全部照读码逐行做（`particles/boids.ts`）。语料里没有场景用到，起因是 WPE `myprojects` 里的滴水场景 `3826719942` 只差它（`alignmentfactor 5`、`cohesionfactor 5`、`separationfactor 0`、`neighborthreshold 150`、`flags 0`，世界空间系统，`ropetrail` 绘制）。

依据：读码 [rea-p4h-boids](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4h-boids.md)；实测 [报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4h 语义的实测核对」（读码各条都成立）；验收数据 [子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4h-boids.md)「步骤 0、1 实施记录」。

| 项 | 规则 | 依据 |
|---|---|---|
| 键与缺省 | `separationthreshold` 20 / 0.02、`neighborthreshold` 50 / 0.2、`maxspeed` 500 / 1（正交 / 透视场景），`separationfactor` 15、`alignmentfactor` 1、`cohesionfactor` 2、`flags` 1（只看 bit0 = 限速）；不钳制，不登记实例覆盖 | 读码 1.2、1.3；实测 `def30` / `def15` |
| 遍历 | 槽 4 个一组（SIMD），组升序；每组对全部组（含自己）比 16 对，lane `l` 的邻居是 `j + ((l − k4) mod 4)`；没有网格、没有上限 | 读码 2.3 |
| 存活判定（WPE 缺陷，**照抄**） | 邻居「活着」看的是 `life[j + l]`（和被更新粒子同 lane 的槽），不是邻居自己；所以同组里未出生的槽（位置 0）与死槽会被当成邻居，两颗粒子的系统就会触发；被更新的粒子死了也照算 | 读码 2.4；实测 `sep50`（两颗都被原点的未出生槽推开，不照抄差 1400 像素）、`dead` |
| 一对的计算 | `d2 = (dy² + dx²) + dz²`，`d2 = 0`（自己、重合）两项都不算；邻居 `d < nbT`、分离 `d < sepT`，严格 `<`；分离权重 `sepT/d − 1` | 读码 2.4；实测 `thr-in` / `thr-out`、`same` |
| 速度增量 | `Δv = ((v̄ − v)·A' + (Σw·Δp / nS)·Sep') + (p̄ − p)·C'`，`X' = S·X·k`（`k` 是 drag 用的那个系数，不是 `h`；两遍模式各一半）；只改速度、不改位置，不乘实例 `speed`；实例 `rate` 经 `dt'` 进来 | 读码 2.5、第 5 节；实测 fps 20 下乘 `h` 差 4.6、乘 `k` 0.0008 |
| 写回 | 一组 4 颗算完立即写速度，后面的组读到前面组的新速度（只影响对齐项） | 读码第 3 节；实测 `order8`（全快照差一倍多） |
| 限速 | `flags & 1` 时 `new² > max(old², maxS²)` 才压到 `maxS`（旧速度已超限、新速度没变快就不管） | 读码 2.6；实测 `lim-a` / `lim-c` |
| 槽范围 | WPE 的 operator 循环到 `⌈hw/4⌉·4`：带 boids 的系统 operator 的 `count` 取到那里（`movement` 也积分未出生的槽），其它系统不变 | 读码 2.3、rea-framework Q5 |
| 分帧 | `hw ≥ 200` 时 `S = floor(hw/200) + 1`，一帧只更新 1/S 的组、系数乘 S；帧计数器初值未知，从 0 起（`TODO:[WPE_SCENE]`，语料用不到） | 读码 2.2、2.7 |
| 空间 | 在列所在的空间里算：本地系统用本地坐标，世界系统用世界坐标（发射器偏移不经对象缩放，同 P4c）；每个系统实例各自独立 | 读码第 4 节；实测 `local-s2` / `world-s2` |

**近似运算不复刻**（用户 2026-11-20 决定，同 P4a 起的惯例）：WPE 的距离用 `rsqrtps`、平均值的 1/n 用 `rcpps`，我们用精确值。已知差异：
- 「距离正好等于阈值」的判定取决于硬件 `rsqrtps`（`thr-eq`：本机 WPE 判成有作用）。
- `rcpps(1)` 偏小约 2⁻¹²，在世界坐标（几百到几千像素）里让质心向原点慢慢加速：`world-s2` 11 s 漂 23 像素；滴水场景粒子只活 0.5–1 s，估计不超过约 3 像素。

### 验收与覆盖

- 确定性工程 `ignore/p4/defs/p4h0.py`（`p4h-a` 13 组、`p4h-b` 7 组，每颗粒子一个只发一次的发射器），WPE 参照 `A:\p4h\`（fps 20 / 60）；读码阶段的参考模型 `ignore/p4/h0/model.py` 按 WPE 日志逐帧模拟、和抓帧逐粒子比，并排除了五种别的读法。
- 回放案例 `ignore/p4/cases/h1.json`：18 组逐粒子比全部通过（近似运算包络）；`thr-eq` 跳过，`thr-out` / `speed2` 放宽 pos——发射器给速度归一化的 `1/Math.sqrt` 不在近似包络里，WPE 的近似让速度差约 2.2e-4，和 boids 无关。
- 变异检查 10 处全部检出（`ignore/p4/h1/mutate_h1.py`；「组内逐 lane 立即写」是等价变异，换成「全快照」）。
- 走查：滴水场景解包成 `ignore/p4/proj/3826719942-kbp` 在 dev 应用里回放，和 WPE 抓帧比水流区域，形状、走向、粗细一致（随机发射，不逐粒子比）。
- 覆盖：165 张口径不变（语料 0 张用到）；myprojects 的 `3826719942` 不支持项从 1 项到 0 项。
- 对比台注意：WPE 的 log.txt 各会话共用，同时开着别的会话的测试窗口时 `[kbp]` 行会交错（行首进程号不同），回放工具会报「帧号重复」；按进程号拆开（`ignore/p4/h0/split_log.py`，原件留 `*-log.raw.txt`）。

## 粒子（P4i）

P4i 放行粒子光照：粒子材质的 `LIGHTING`（材质写的或着色器缺省值）与它的子开关 `DOUBLESIDEDLIGHTING`。之前能力表报 `particle:lighting` / `particle:combo:DOUBLESIDEDLIGHTING`（`compile/features.ts` 的 `checkParticleProgram`）。语料没有场景用到，起因是 WPE `myprojects` 的 `3823357259` 只差它：工坊 `3778352003` 的雷电预设给每个雷电系统挂一个光晕子系统，材质是 `genericparticle` + `LIGHTING: 1`（additive、`particle/halo`），场景没有灯、环境光 0.3。

**不新增渲染逻辑。** WPE 的粒子光照全在着色器里，引擎侧要给的东西和图层、模型的光照（[LIGHTING.md](LIGHTING.md)「光照（`#require LightingV1`）」）完全共用，P4i 只拿掉能力表的门：

| 项 | 规则 | 我们这边 |
|---|---|---|
| 着色器 | 顶点多输出 `v_WorldPos`、`v_WorldRight = right · g_ModelMatrix`（3×3）与视线 `g_EyePosition − worldPos`；片元法线取视线方向，有法线图（`NORMALMAP`）时按 `v_WorldRight` 与视线搭切空间，没有法线图时强制 `DOUBLESIDEDLIGHTING 1`；`color = CombineLighting(PerformLighting_V1(…), g_LightAmbientColor · color)`，之后才乘 `g_Overbright`、走折射与雾。`g_LightSkylightColor`、`g_ViewRight`、`g_ViewUp` 声明了不读 | WPE 原件翻译（`genericparticle.*`；rope 的 `genericropeparticle` 几何着色器展开进顶点着色器，同 P4d） |
| 灯 | `#require LightingV1` 按 `LIGHTS_*`（`general.lightconfig`）生成，灯光缓冲每帧按视线排序写；没有灯时 `sum = 0`，颜色就是环境光 × 颜色 | 开了光照的程序让 bundle 带 `lights`（`bundle.ts` 的 `sceneLights`，粒子 pass 同样调），粒子 draw 与图层同一个构建函数、每帧写灯光数组 |
| 模型矩阵 | 本地系统是对象世界矩阵，世界空间系统是单位阵 | P4c 的规则，不变 |
| HDR | `CombineLighting` 的 HDR 分支（`saturate(ambient + light) + light · overbright`）随全局 `HDR` 宏 | `engineDefines`，不变 |
| 阴影 | 阴影灯在场时粒子读 `_rt_shadowAtlas`（只接收，不投射） | 同模型 |

依据：WPE `assets/shaders/genericparticle.*`、`genericropeparticle.*`、`common_pbr_2.h` 原文；实测 [报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4i 语义的实测核对」（读码各条都成立）；验收数据 [子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4i-particle-lighting.md)「步骤 0」。

### 验收与覆盖

- 确定性工程 `ignore/p4/defs/p4i0.py`（11 个，每格一颗静止粒子：环境光、换色环境光、点光、平行光 + 聚光、对象变换与世界空间、亮灯、HDR + 泛光、雾、rope、拖尾 + 法线图、阴影图集），WPE 参照 `A:\p4i\`，和 dev 渲染整帧逐像素比：3 组 0 差异，其余最大差 1（浮点舍入）；HDR + 泛光最大差 2，全在泛光渐变（WPE 后备缓冲的 f16 存储量化，同 P13h）。
- 已知差异：rope 有 1 个三角形边缘像素覆盖不同（WPE 没画）。像素中心离边 0.00085 px，比光栅化的 1/256 px 吸附网格还小，WPE 顶点的 x 离吸附边界只差 1 个 float32 ulp；我们把几何着色器展开进顶点着色器，指令顺序与 FMA 融合和 fxc 不同，顶点末位不同就会翻面，不复刻。
- 零星差 1 的像素是着色器舍入：`p4i-spot` 一格 76800 个分量里两边只差 2 个（约 1–2 个 float32 ulp，fxc 与 Tint / DXC 的指令顺序、FMA 不同）；拖尾的差异只出现在带法线图的拖尾上（四角在几何着色器 / 顶点着色器里末位不同，`drop_normal` 的陡梯度把它放大），白色拖尾 0 差异。
- 最终走查（FINAL_CHECK）：复制工程 `3823357259-iso`（只留雷电 259，随机项与音频模式换成固定值，光晕材质与结构不动），WPE 连抓 24 帧逐帧比：13 帧逐像素相同，光晕帧与只有绳的 11 帧差异全部来自 `rcpps` / `rsqrtps` 不复刻（绳的漂移是 `maintaindistancebetweencontrolpoints` 的 `rsqrtps`，本机 e = −1.409e-4；光晕 alpha 是 `alphafade` 的 `rcpps`），临时换成本机硬件值后 24 帧逐像素相同。
- 单测 `compile/p4i1.test.ts`（假翻译器与真翻译器：`3823357259` 的光晕材质原样、点光、rope）；变异检查 4 处全部检出（`ignore/p4/i1/mutate_i1.py`）。
- 覆盖：语料不变（0 张用到）；myprojects 的 `3823357259` 不支持项从 1 项到 0 项。

## 粒子（P4j）

P4j 补发射器 `layerimage`（类型 3）：粒子的出生点不在球 / 盒里随机，而是在**另一个图层的画面**上按像素抽。被抽的图层由粒子对象的 `dependencies` 指定（`{id, type: "emitterimage", index, mask}`）。语料里没有别的场景用到，起因是 WPE `myprojects` 的 `3834803915`（战锤 40k 雨景：水花落在人物身上，人物的遮罩图层 229 就是候选区）。

表是 **GPU 读回**来的：WPE 把被依赖图层的合成 RT 用 WPE 原件 `materials/util/downsample_quarter` 降到约 1/4，读回后 alpha ≥ 127 的像素按列优先入表，每颗粒子用场景的 MT19937 无偏地抽一项。所以我们这边分三块：编译期解析依赖并绑定（`compile/dependencies.ts`）、运行时建表（`particles/layerImage.ts` 的状态机 + `render/emitterImages.ts` 的降采样与读回）、按表发射（`particles/emitters.ts` 的 `layerImage`）。

依据：读码 [rea-p4j-layerimage](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4j-layerimage.md)；确定性工程的实测 [报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4j 语义的实测核对」（读码各条都成立，一处更正）；验收数据 [子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4j-layerimage.md)「步骤 0–4 实施记录」。

### 依赖与绑定（编译期）

| 项 | 规则 | 依据 |
|---|---|---|
| 依赖的三道门 | `id` 是 uint64、`index` 是 uint32 且不能缺、`type` 是字符串，大小写敏感：`emitterimage` → 1、`collisionmodel` → 3，别的丢掉 | 读码 1.4 |
| 并集 | 过了门的 `id` 进对象依赖的并集（同图层依赖， [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图层依赖」一节），被引用的图层强制走合成路径、隐藏也画 | 读码 1.4 第 8 条（更正 rea-p8-render） |
| 槽 | `index` 是本系统里同类型槽的序号，子系统各自从 0 数；同槽多条取**最后一条**；`id 0` 永远绑不上 | 读码 1.5 |
| `mask` | 纹理路径，降采样时 `mask.r` 乘 alpha（材质加 `OPACITYMASK`）；读不到时退回不带遮罩的变体 | 读码 2.3 |
| 照报 | 被引用的是 puppet（`particle:layerimage:puppet`，骨骼号的分配没读全）或文本层（`particle:layerimage:text`）；运行中新建的、场景里第一个用发射图的粒子对象报 `particle:layerimage:runtime`（片段没有场景级增量通道，同 `bloom`）；`collisionmodel` 只进并集，用它的 operator 照报 `particle:operator:collisionmodel`；引用的对象不存在或别的类型时中性（WPE 永远不发） | 用户 2026-11-21 定 |

### 发射器的键

`speedmin` 0.1、`speedmax` 0.2、`offsetmin` / `offsetmax`（正交 ±5 5 0、透视 0）；`flags` 缺省 **0x10000**，四个位：0x10000 颜色乘像素、0x20000 每秒重建表、0x40000 出生速度取像素点的移动速度、0x80000 三轴抖动；这四个位与发射器通用的低 3 位之外的位照报。

### 候选表（运行时）

- **尺寸**：被依赖图层的合成 RT 宽或高超过 3840 × 2160 时先按宽高比压（float32、截断），`w4 = max(2, W′/4)`、`h4 = max(2, H′/4)`；降采样画到 RGBA8 的 `w4 × h4`（`WRITEALPHA`，有 `mask` 时加 `OPACITYMASK`）。GPU 上正好 `.5` 的值往下取（127.5 → 127）。
- **建表**：`s = W / w4`（只算 x 方向，y 也用它）；x 外层、y 内层，alpha < 127 跳过，一项一个像素：`x′ = trunc((s·x − (W >> 1)) + s/2)`，y 同式（`H >> 1`），逐步 float32。表项另存像素 rgb。
- **状态机**（每个 `(id, mask)` 一条共享记录）：过门 → 渲染拷贝 → 读回建表，前两个发射帧不发、**不记欠账**；预热只过门，所以有 `starttime` 预热时只丢 1 个发射帧（实测更正）。同一帧里后调的发射器接着推进同一条记录，比先调的早一帧拿到表。
- **快照时机**：每帧末对过了门的记录拍快照；状态 0 锁定**上一帧末**的快照（没有就是本帧末）。
- **`0x20000`**：计时器在**每个发射器**上（`rec+0x7c`），严格大于 1 时取 `fmodf`、让共享记录重建；重建期间照用旧表。
- **产品与回放的差别**：WebGPU 的读回是异步的（`mapAsync`），WPE 是第 3 个发射帧同步 `Map`。产品里表晚到就晚几帧开始发射（**已知差异**，只影响开场几帧）；dev 探针回放时每帧等读回，和 WPE 同帧。

### 每颗粒子

| 项 | 规则 | 依据 |
|---|---|---|
| 数量 | 同 `sphererandom`（存活 < 容量才算、发射欠账）；没拿到表时整批丢掉 | 读码 3.1、rea-p4b A1 |
| 抽取顺序 | 表项下标（MSVC `uniform_int_distribution`：Lemire 乘法加拒绝，每次取一个原始 u32，`uniformIndex`）→ 抖动 x、y、z（`0x80000`，各一次 `uA`）→ 速率（`0x40000`，一次 `uA`）→ 照常的 `R` 与各 initializer；全部从系统的同一个随机源取 | 读码 3.3、3.10 |
| 出生点 | `P = A·p`，`p = (x′ + jx, −y′ + jy, jz)`；`A` 本地系统是 `M⁻¹·L`、世界系统是 `L`。`L` 是被依赖图层本帧的绘制矩阵（世界矩阵含父链、`angles`、`scale`，再右乘 `alignment` 偏移），只在状态 2 与建表时刷新进记录；`M⁻¹` 照 GLM 的 4×4 求逆（float32），乘法按 3.5 的括号顺序 | 读码 3.2–3.5 |
| 颜色（`0x10000`） | 实例颜色先乘 `像素 / 255`（float32），再进 initializer | 读码 3.6 |
| 速度（`0x40000`） | 用**上一次取到表时**的 `L`（`rec[0xb8]`，每个发射器一份，初值单位阵，取到表的发射帧末尾写回）算出生点在这一帧里的移动，除以不含实例 `rate` 的帧时间，再乘 `uA·(speedmax − speedmin) + speedmin`；第一次取到表那帧是单位阵，速度会异常大，同 WPE | 读码 3.7 |
| 传给 initializer 的 `M3` | 本地系统单位阵，世界系统 `mat3(M)` | 读码 3.2 |

### 注入 WPE 的随机数（步骤 4）

WPE 一个场景只有一个 MT19937（按时间播种，播种只在渲染器构造里一处，取数没有内联副本），粒子的全部随机抽取都从它来。随机发射只有让两边吃同一串随机数才能逐颗比，所以做成了工具（用户 2026-11-21 要求）：
- **WPE 侧**：`wpe-renderdoc` MCP 的 `open_wallpaper` / `capture_wallpaper` / `capture_sweep` 的 `seed`。开窗之前用 Frida 在 `wallpaper64.exe+0x17D6BC`（`mov [rdi+0x1cd4], edx`）把种子换掉，一次性，命中后读回 `x[0]`、`x[1]` 核对（见 MCP 的 README「换随机数种子」）。
- **我们这边**：dev 探针与 kabegame-dev MCP 的 `replay.mt19937`、kbp 回放的 `mt19937`：全场所有粒子系统（含子系统与事件实例）共用一个 `SeededRandom(mt19937(种子))`，预热与每帧步进都按对象表顺序从同一串里取（`ParticleOptions.mt19937`，只给 dev 用，产品路径不引用）。
- **管不到的**：场景脚本的 `Math.random`（V8 自己的）、`hsvcolorrandom` 的档位（CRT `rand()`）。流程见 kbp-tools SKILL「注入 WPE 的随机数」。

### 验收与覆盖

- **确定性工程**（`ignore/p4/defs/p4j0.py`：`p4j-li-map` / `-xform` / `-large` / `-jit` / `-move` / `-flags0`，WPE 侧各注入种子 1001–1006，参照在 `A:\p4j\`）：回放案例 `ignore/p4/cases/j3.json`，6 个工程 8 个系统、7778 颗逐颗对上，逐帧粒子数相同，位置、颜色、尺寸逐位相同（`li-move` 位置差 1.2e-4，脚本移动图层的 `sin`）；候选表和参考模型 `ignore/p4/j0/model.py` 的预测逐项相同（`li-large` 8381 项连颜色 SHA-256 一致）。
- **雨景走查**（FINAL_CHECK，解包副本 `ignore/p4/proj/3834803915-kbp`，WPE 注入种子 1007，252–254 帧，1920×1080）：三个粒子系统的逐帧数量（含水花的事件实例 59 / 63 / 63）全部相同；整帧差异逐个落到 draw 与数值，都不是 P4j 的问题：
  - 人物头部一块：对象 10 `rotate2dmask` 的 `noisevalue` 来自 SharedNoise 脚本的 `Math.random()`；
  - 一条离镜头很近的透视雨滴错开不到 1 像素：位置相对差 ≤ 4.3e-4，近似倒数不复刻，透视放大；
  - 一个水花环暗一半：`t = 0.49999` 卡在 `fadeintime` 0.5 的边上，`alphafade` 的按位或（照抄的 WPE 缺陷）把 `rcpps` 的末位差放大。
- **变异检查**：步骤 1 9 处、2 7 处、3 6 处、4 4 处，全部检出（`ignore/p4/j1/`–`j4/` 的 `mutate_*.py`）。
- **覆盖**：缺省 233 张不变（0 张用到）；myprojects 的 `3834803915` 不支持项从 2 项（`particle:dependencies`、`particle:emitter:layerimage`）到 0 项。
