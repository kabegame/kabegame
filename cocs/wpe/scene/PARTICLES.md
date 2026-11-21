# 场景壁纸：粒子：底座、纹理与控制点

> [场景壁纸文档](../WPE_SCENE.md) 的一章：粒子底座、纹理与发射时序、控制点与拖尾（P4a–P4c）。总体形态、各阶段状态与全部章节的索引在总览里。

## 粒子（P4a）

粒子对象是一种图层，和图像层共用 `objects` 顺序。三层按「谁碰 GPU」划分：

- **编译期**把粒子 JSON 解析成纯数据，放进 `layer.particle`，不碰 GPU；
- **模拟器** `apps/wpe-scene/src/particles/` 是纯 TS，只用 TypedArray，能单测，也能脱离渲染器直接和 WPE 的轨迹比；
- **渲染层**把列写成顶点，粒子是图层计划里的一种步骤。

模拟放在宿主主线程同步跑，脚本与属性写入同一帧生效（与 3b 脚本同步运行的决定一致）。P4a 覆盖档 1：12 个模块加 `sprite`、透视粒子、`starttime` 预热、`instanceoverride`；其余模块按 P4b–P4f 补，见[总计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4-particles.md)「范围与覆盖」。

证据等级照[报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)：**实测**是 RenderDoc 抓帧或 WPE 日志读到的值，**读码**是逆向 WPE 2.8.42（`wallpaper64.exe` SHA-256 前缀 `40e2ce02`）读到的代码；linux-wallpaperengine 不作证据。粒子带随机，真实样本只比统计量；逐帧、逐像素对比用把随机范围收成 min = max 的确定性工程。

### 编译

- **模块表是唯一事实来源**（`particles/modules.ts` 的 `PARTICLE_MODULES`）：每个模块一条记录，含字段表（形状、正交 / 透视两套缺省值、本节支持的取值、乘哪一项 `instanceoverride`）、用到的列与列标志、执行函数 `run`。解析（`compile/particles.ts`）、能力表（`features.ts` 的 `checkParticleFeatures`）和模拟器分发读同一张表，能力表不会和实现漂移。
- **档 1**：emitter `sphererandom`；initializer `lifetimerandom`、`sizerandom`、`velocityrandom`、`colorrandom`、`rotationrandom`、`angularvelocityrandom`；operator `movement`、`angularmovement`、`alphafade`、`oscillateposition`、`oscillatealpha`；renderer `sprite`（P4a 只认 `orientation: "screen"`；P4c 起 `upright` / `fixed`、`axis`、`flags` 都支持，另加 `spritetrail`，见「粒子（P4c）」）。
- **`layer.particle`**（`SceneParticle`）：`maxcount`、`starttime`、系统 `flags`、按 JSON 顺序的 emitter / initializer / operator（不排序）、renderer、`instanceoverride` 的值，以及粒子材质的 `passes`（不进 `layer.passes`）。`renderer` 缺键或不是数组时补一个 `sprite`，写成 `[]` 不补（读码：WPE 只在不是数组时补）。
- **两套缺省值**（读码）：`general.orthogonalprojection` 是对象，且 `auto: true` 或宽高都非 0 才算正交（`isOrthographic`），字段缺省值按它选。
- **`TEX0FORMAT`**：粒子材质经 `ShaderCompiler` 的 `defines` 参数写，并进缓存键；图层材质的缓存键逐字不变。P4a 时无条件写；P4b 起照 WPE 只在槽 0 纹理是格式 8–11 时写，格式 0、4 时着色器分支相同、画面不变。P4c 起非厚格式的 `sprite` 只要朝向不是 `screen`，对任何格式都写（汇编 `0x1401d3189`），对 `genericparticle` 不影响画面；厚格式（帧表、拖尾）仍只在格式 8–11 时写。
- **`PARTICLE_UNIFORMS`**：`g_OrientationUp/Right/Forward`、`g_ViewUp/Right`、`g_RenderVar0/1`。粒子 pass 的程序检查把它们当引擎 uniform，渲染器在粒子 draw 里写（`render/uniforms.ts` 的 `particleBuiltins`，单测核对两边一致），图层材质里照报 `uniform:*`。
- **COMBO**：粒子材质放行 `WORLDBLUR`、`USERCOLORBLEND`（`shimmering_particles` 自带 `particle` 着色器的分支），P4b 起另放行 `REFRACT`、`CUTOUT`、`NORMALMAP`（见「粒子（P4b）」）。着色器注解的缺省值不算：`genericparticle` 的 `FOG` 缺省 1，只在引擎宏 `FOG_DIST` / `FOG_HEIGHT` 下起作用，渲染器不定义它们。

**能力键**（`features.ts` 的 `checkParticleFeatures` / `checkParticleProgram` / `checkParticleInstance` / `checkObjectFeatures`，模块部分从模块表生成；值为 null 的键当缺键）：

| 键的形态 | 何时报 |
|---|---|
| `particle:<类别>:<名字>` | 表外模块，例如 `particle:renderer:rope`、`particle:initializer:mapsequencearoundcontrolpoint`（P4c 收尾时；`spritetrail`、`controlpointattract` 在 P4c 进表） |
| `particle:<类别>:<名字>:<字段>` | 表内模块的未知字段、形状不对或本节不支持的取值，例如 `particle:emitter:sphererandom:audioprocessingbounds`（P4e）；P4a 时的 `particle:renderer:sprite:orientation` 在 P4c 去掉 |
| `particle:binding:<类别>:<名字>:<字段>`、`particle:binding:system:<键>` | 模块字段、系统级键写成 `{user}` / `{script}` |
| `particle:system:<键>` | 系统级未知键；`emitter` / `initializer` / `operator` 不是数组 |
| `particle:flags:<位值>` | 系统 `flags` bit8 起的高位；bit0–7 支持（bit1 关混帧，P4b 起；bit0 世界空间，P4c 起，原先报 `particle:flags:world`） |
| `particle:children` | 子系统（P4e）。P4a、P4b 时控制点有实际内容报 `particle:controlpoint`，P4c 起控制点全部支持或中性，不再报 |
| `particle:renderers` | P4f 起只在表内 renderer 多于一个、且其中有 `rope` / `ropetrail` 时报（任意条数的 `sprite` / `spritetrail` 支持，见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」）；P4c–P4e 多于一个就报。P4a 时帧表的 `particle:animationmode`、`particle:sequencemultiplier` 也在这一行，P4b 起支持 |
| `particle:combo:<名字>`、`particle:effects` | 粒子材质放行范围以外的 COMBO（如 `SPECULARMAP`）；带 `effects` 的粒子对象（本机 0 个）。开了光照的 `particle:lighting` 与 `particle:combo:DOUBLESIDEDLIGHTING` P4i 起不报 |
| `particle:object:<键>` | 粒子对象上的 `alpha` / `color` / `brightness` 取非默认值或绑了属性 / 脚本（WPE 怎么用没测，语料 0 张） |
| `particle:instance:<键>`、`particle:binding:instance:<键>` | `instanceoverride` 的未知键；`color` 绑了属性（`particle:instance:color:user`）、`colorn` 带条件（`particle:instance:colorn:condition`）；`color` 等 24 个键（`SCRIPT_INSTANCE_KEYS`）以外的键挂了 `{script}`。`colorn` 本身 P4b 起支持；`controlpoint*` 的静态值 P4c 起支持（原先整个报 `particle:instance:controlpoint`）；P4f 起 HDR 下的 `brightness`、`controlpoint*` 绑属性、24 个键挂 `{script}` 都不再报 |
| `particle:parse:<文件>` | 粒子 JSON 读不出来 |

模块字段写成关键帧报 `value:animation`（见 [COMPILE.md](COMPILE.md)「能力表」）。P4a 收尾时，语料（149 个工程）里挡住场景最多的粒子键：`controlpoint` 48 张、`turbulentvelocityrandom` 41、`animationmode` 38、`boxrandom` 37、`sizechange` 34、`sequencemultiplier` 34、`children` 31、`alpharandom` 31。粒子材质与纹理第一次进编译，在带粒子的场景上另带出 `tex:animation`（49 张）、`tex:alpha-priority`、`tex:format`、深度等非粒子键。

### 模拟器（`particles/`）

照 WPE 的形状写，不照 linux-wallpaperengine：LWE 在列、`R`、模块顺序、重置这几处都不同。

| 项 | 做法 | 依据 |
|---|---|---|
| 列（`columns.ts`） | 一块 `Float32Array`：基础 17 列（age、life、frame、size、size0、旋转 x、位置、速度、颜色与 alpha 初始值、`R`）加 5 组按标志开关的列（旋转 yz、角速度、上一步位置、颜色当前值、alpha 当前值）；没开的别名到同一列或初始值列，所以没有 bit3 时「重置颜色」是空操作。容量 `maxcount` 向上取到 4 的倍数，`life == 0` 是空槽 | 读码；顶点布局实测 |
| 共用 `R` | 每粒子一列随机数，`oscillate*` 的频率、相位、幅度都由它现算，没有逐粒子的模块状态 | 读码；`oscillateposition` 的 y 偏移实测 |
| 随机数（`random.ts`） | 可设种子的 mulberry32，不复刻 MT19937（WPE 按时间做种，本来不可复现）；保持两个区间 `[0, 1)`、`[1e-5, 1)` 与各模块的抽取顺序 | 读码 |
| 模块顺序 | emitter、initializer、operator 都按 JSON 数组顺序，不排序 | 实测 |
| 帧内顺序（`system.ts` 的 `ParticleSystem.step`） | 年龄增长与判死（`life < age`，严格大于）→ 按 emitter 发射、新粒子填编号最小的空槽、跑 initializer（当帧 `age = 0`，走完整个 dt）→ operator 一或两遍，每遍开头把 `size`、`rgb`、`a` 重置为初始值，乘性模块跑两遍结果不变。P4b 起判死之后先算帧表的 frame 列，P4c 起发射之前更新控制点、全部 operator 之后 `previous ← current`（见「粒子（P4c）」） | 新粒子首帧实测；全序读码 |
| dt | 当帧 `g_Frametime` × `instanceoverride.rate`（下限 0.01），粒子路径不另钳 | 实测 |
| 两遍模式 | WPE 设置 `fps` 在 1–20 时 operator 每帧跑两遍（`h = dt/2`），否则一遍；我们接宿主帧上限 `maxFps`（`particlePasses`，缺省 60，所以一遍）。发射用完整 dt | 实测（fps 5–20 与 21–60 两组） |
| float32 | 列是 `Float32Array`，累加全用 `Math.fround`（`f32.ts`） | 预热步数的实测证明需要 |
| 预热 | 加载时一次跑完 `while (t < starttime)`：步长 `maxcount < 500` 时 0.05、否则 0.2；**固定一遍**；步数按 float32 累加（`starttime 2.5`、步长 0.05 是 51 步，不是 50）；步长不乘 `rate`；**工作量封顶**（2026-11-17 用户定：预热要在 1 s 内跑完）：每步记 `max(存活数, 1) × (1 + 模块数)`，累计到 `PREWARM_WORK_BUDGET`（200 万）就提前结束，等于把 `starttime` 缩短到已跑的那一段 | 步长、遍数、步数实测。读码曾以为预热也受 `fps` 分支影响，被实测推翻；`rate ≠ 1` 的预热没测。封顶是有意不同：WPE 原生代码照跑全程，我们在主线程用 JS 跑，`starttime 100000` 的 starfield 预设（15030）要 50 万步、建 GPU 场景 39.6 s（超过应用页 30 s 的超时、被卸掉），封顶后约 490 步、0.66 s；标定见 `system.ts`（Node 下最重的实测组合约 0.5 µs / 单位）；结果按工作量算、可复现；碰到上限时随机序列与长 `delay` / `duration` 的发射时序和 WPE 不同，渲染器记一条 warning「预热到工作量上限」 |
| 发射欠账 | 按帧成批，同帧新粒子位置相同；数量 `rate·dt + 累积余数`，受容量限制。`instantaneous` 从累积余数里扣，之后要还债 | 实测：突发 3 个后停 `(1 + 3) / rate` 秒 |
| `instanceoverride` 静态值 | 构造时按基值乘进模块字段（`resolveParticleFields`），预热也用乘过的值；系统 `flags` bit4–7 禁用对应项 | 字段与倍数实测；预热用乘过的值没测 |

几处公式和直觉不同（详见 `rea-p4a.md`）：

- `movement` 是半隐式欧拉，drag 的 `k0 = pow(min(1, 0.025 / dt), 0.7)·dt`，每遍 `v *= 1 − min(drag·k, 0.99999988)`。实测。
- `oscillateposition` 的 ω 就是 `frequency`，不乘 2π；y 比 x、z 多 `2π·R` 的时间偏移。实测。
- `sphererandom` 的距离用 `|p|` 不是 `r`；`colorrandom` 三通道共用一个 t；`velocityrandom` 三轴独立，抽取顺序 z、y、x；`oscillatealpha` 的幅度里多乘一次 `R`。读码。
- WPE 的 `rcpps` 近似倒数不复刻，alpha 因此差约 2.4e-4。

**验收**（回放 WPE 日志的 dt，限 1e-3，坐标过 1000 时 2e-3）：档 1 全部系统在限内，`burst` 1.1e-3，其余 ≤ 9.2e-4；尺寸、颜色、旋转差 0，alpha ≤ 2.4e-4，粒子数逐帧一致。坐标约 1.1e4 的预热样本差到 9.8e-3，判定为输入精度：这个坐标上 float32 一个 ulp 是 9.8e-4，dt 在日志精度内扰动后能得到逐位相同的结果。dt 要用日志的累计时间差分，逐帧累加日志的 dt 列会超限。变异检查：改掉帧内顺序、`R` 共用、`Math.fround`、两遍判断、预热遍数等，各有用例失败。

### 绘制

- **`ParticleStep`**（`render/graph.ts`）：粒子层按 `objects` 顺序和图像层混排，在同一个场景 render pass 里直接画到场景目标；泛光、双缓冲不清屏照走现有路径。`g_ModelViewProjectionMatrix` = 视图投影 × 对象世界矩阵（粒子位置在对象空间）；P4c 起世界空间系统的模型矩阵是单位阵（见「粒子（P4c）」）。
- **顶点**（`particles/vertices.ts` 的 `writeVertices`）：WebGPU 没有几何着色器，每粒子 4 个顶点、6 个索引（`0 1 2 0 2 3`），角点 UV 依次 (0,0)、(0,1)、(1,1)、(1,0)。按槽序写、跳过 `life == 0`，不按年龄排；尺寸、颜色、alpha 取当前值。P4c 起拖尾系统另跳过退化的粒子（`trailDrawable`）。
  - 输入：`a_Position`（位置）、`a_TexCoordVec4`（u、v、旋转 z、尺寸）、`a_TexCoordC2`（旋转 x、y）、`a_Color`（rgba）。
  - 偏移按翻译器反射的 `attributes` 经 `vertexPacking` 排，不写死；现在的顺序是位置、`a_TexCoordVec4`、颜色、`a_TexCoordC2`，步长 52，与 WPE 项目自定义 `particle` 的实测步长相同。认不得的输入报 `render:particle-attribute:<名字>`。
- **缓冲**：每层一个顶点缓冲（按容量建）、全场一份索引缓冲；`encode` 里只传存活的那部分再 `drawIndexed`。步进 P4a、P4b 在 `GpuScene.update` 里，P4c 步骤 4 起挪到 `GpuScene.stepParticles`，由渲染器在脚本之前调用（见「粒子（P4c）」的「世界空间与帧顺序」）。
- **透视粒子**（系统 `flags & 4`，`layout.ts` 的 `particleViewProjection`）：相机在 `(w/2, h/2, d)` 看向 −z、上方 +y，`d = (h/2) / tan(fov/2)`，fov 取 `perspectiveoverridefov`（缺省 95°），所以 z = 0 平面和正交画面重合，+z 朝向相机；反向 Z，near 5、far `max(15000, d + 1000)`。实测：fov 95 / 60、z = 0 / 300 四角最大差 1.7e-4 像素，`w` 逐位一致。
- **正交深度 ±2000**：`ORTHO_DEPTH` 从 10000 改成 2000，深度 = `0.00025·z + 0.5`（反向 Z），图像层与正交粒子相同，与 WPE 抓帧读到的 MVP 一致；|z| > 2000 被裁掉，WPE 同样。
- **帧时钟**（`render/clock.ts` 的 `FrameClock`）：帧时间钳到 `[0.0001, 0.25]`，`g_Time` 累加钳后的值，脚本的 `engine.runtime` / `engine.frametime` 用同一时钟；补画帧的帧时间为 0，粒子不步进。实测：WPE 在 `fps=5` 启动时连续三帧恰好 0.25。LWE 的 `min(dt, 0.1)` 在 WPE 里不存在。这条改了全部场景的时钟，只在单帧超过 0.25 s 时有差别。
- **粒子 uniform**：P4a、P4b 时朝向写死单位基（P4a 实测的工程里 WPE 写的就是单位基；P4c 补测确认对象带 x / y 旋转时不是）；`g_ViewUp` / `g_ViewRight` / `g_RenderVar0/1` 档 1 的两个着色器都不读（抓帧里 `referenced: false`），照语义给，`g_RenderVar*` 写 0。P4b 起帧表系统写 `g_RenderVar1`，折射着色器读视图轴，实测值与 WPE 相同（见「粒子（P4b）」）。P4c 起朝向按 renderer 与绘制用的模型矩阵在 CPU 上现算，拖尾系统写 `g_RenderVar0 = (length, maxlength, minlength, 0)`，其余系统仍写 0（见「粒子（P4c）」）。
- **验收**（风险 7：WPE 的内置 `genericparticle` 走 `PointList` + 几何着色器，我们走顶点展开）：我们翻译出的顶点路径对 WPE 的 `gs_out` / `vs_out`，含三轴旋转（`rot-gs`、`rot-vs`），一帧四角逐位相同，另一帧最大差 5.7e-5 像素。整帧像素（回放 WPE 日志的 dt）：WPE 有内容的 6382 个像素里 6214 个逐字节相同，`util/white` 自然得到 249/255（mip 1–3 是 252，RGB 与 alpha 各乘一次）；其余全在 `capvelocity` 的两行（当时没实现，P4b 步骤 3 补上）。

### `instanceoverride` 就地生效

- **绑定**：`alpha`、`size`、`count`、`speed`、`lifetime`、`rate`、`brightness`（`INSTANCE_FIELDS`）的 `{user}` 登记成就地目标 `{ kind: "particle-instance", object, field }`（`compile/bindings.ts`）；值存在 `SceneState.particleInstances`，`GpuScene.sync` 交给 `ParticleSystem.setInstance`，下一帧生效。
- **从基值重新乘，不累乘**：存活粒子保留出生时的 life、颜色、尺寸、alpha；`size`、`lifetime`、`alpha`、发射速度只影响之后出生的；`rate`、`count` 以及 `speed` 乘的 operator 字段（重力、角力、振荡频率）下一帧就用新值；已结束、新 `rate > 0` 的 emitter 重新打开。实测（`p4a-life`）：已有 54 个仍是旧尺寸、alpha 与出生时的速度，新的 10 个用新值，`rate` 立刻作用于全部粒子。WPE 同样不清粒子。
- **`brightness`**：只在场景 HDR 且系统 `flags` 没有 bit3 时生效，乘出生时的实例颜色（P4f 步骤 2 实现，见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」；P4a–P4e 时 HDR 下登记成重编译、非默认值照报）；LDR 或有 bit3 时中性。一律就地。
- **`colorn` / `color`**：P4b 起实现，就地生效，见「粒子（P4b）」的「`instanceoverride.colorn`」。
- **控制点**：`controlpoint0..7`、`controlpointangle0..7` 的静态值 P4c 起支持，建系统时生效（见「粒子（P4c）」的「控制点」）；P4f 起运行中改值（绑属性、字段脚本、脚本 `instance.controlpointN`）也就地写进 `cp[N]`（见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」）。P4a 时整个报 `particle:instance:controlpoint`。
- **挂 `{script}`**：P4f 起 24 个键都接到同一个就地目标（`rate` 另有一条不置脏的路），见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」；P4a–P4e 时报 `particle:binding:instance:<键>`。
- **整场重编译时粒子重来，含预热**。重编译只有 `general.hdr`、`colorBlendMode`、`size` 三种原因，都很少见。
- **真机**：`shimmering_particles` 改 `count`、`glow`、`style` 各一次，`applied` 0 → 3，`recompiled` 0。

### 生命周期

| 情形 | 行为 | 依据 |
|---|---|---|
| 不可见（含祖先） | 不发射、不步进；还有存活粒子就清空，并复位 emitter 计时（`ParticleSystem.suspend`） | 实测（`p4a-life`：隐藏前 42 个，重新显示约 3 秒后只有 7 个新粒子、间隔 0.5） |
| 重新可见 | 照常发射，**不重新预热** | 同上：重新预热的话会立刻有 20 个 |
| 暂停、`document.hidden` | 时钟冻结，不步进；补画帧也不步进 | 实测：WPE 暂停期间 `g_Time` 不前进 |
| 切换壁纸、整场重编译、卸载 | 粒子缓冲随 `GpuScene` 释放；新场景重新建模拟器并预热 | — |

### 性能

- **真机帧时间**（600 帧）：`shimmering_particles`、`3062029089`、`3304642534` 均值都是 3.2–3.4 ms；每个粒子层模拟加写顶点约 0.1 ms。
- **主线程预算**：Node 实测每个存活粒子每帧约 1 µs 模拟、0.12 µs 写顶点，60 fps 下约 1.5 万个存活粒子。
- **P4a 不设 `maxcount` 上限**：语料最大的 10 万（`3173418061`、`3351163962`）、62.5 万（`2582765611`）都还有别的不支持项挡着，到它们快解锁时再定：设上限，或把模拟挪进 Worker / GPU。
- **预热开销**：`shimmering_particles` 的 3 个 `small_motes` 各预热 200 秒，加载时主线程约 1 秒；默认样式下它们不可见，第一帧就被清空。超长 `starttime`（15030 的 starfield 预设 100000 秒）由工作量上限封顶（见上表「预热」），每个系统 1 s 以内。

### 解锁

- **`shimmering_particles`**：没有不支持项；`dust motes` 200 个，尺寸 43–996（WPE 200 个、40–999），位置、alpha 范围相近；3 个 `small_motes` 被 `style` 隐藏，WPE 同样只画一个系统。
- **工坊 `3062029089`**：没有不支持项；雪 600 帧均值 333 个（WPE 344，容量 360），尺寸 1.02–14.97（WPE 1.02–14.88）。
- **工坊 `3304642534`**：`alphawriting` 修正后能力表一度为空、静态画面和 WPE 一致，但音频条不动（原因见 [SCRIPT.md](SCRIPT.md)「场景脚本（P3b）」的「脚本 API 检查」）。现在报 `script:api:thisScene.createLayer`、`script:api:thisScene.sortLayer`，仍退回预览图。
- **基线**：10 张原本能渲染的场景 × 三档后处理，30 组画面哈希每一步都与 P4a 之前相同（含 `ORTHO_DEPTH` 与帧时钟的改动）。

### dev 探针与对比台

development 构建的 `window.__kabegameSceneProbe`：

| 探针 | 作用 |
|---|---|
| `particleTrack({ projectDir, sceneAssets, dts, frames, passes, seed? })` | 编译后按给定 dt 序列步进模拟器，输出和 RenderDoc 轨迹同格式的数据，交给 `cmp_track.py` 比 |
| `renderFrame({ …, particles: { dts, seed?, passes? } })` | 建场景（含预热）后按 dt 序列确定性回放再读回；种子缺省 1，第 i 个粒子层用 `seed + i`；可逐帧给指针（`pointers` 连同抓帧窗口 `window`，按 `fill` 推出控制点光标，P5a 收尾，`particleCorners` 同样收，`particleTrack` 的 `cursors` 也带 `window`）。带 `profile` 时另给每个粒子层的模拟 / 写顶点 / 上传开销（`particleMs`） |
| `particleCorners` | 把翻译后的粒子顶点 WGSL 改写成计算着色器，读回我们实际算出的每粒子四角裁剪坐标，和 WPE 的 `gs_out` / `vs_out` 比 |
| `host.particles({ profile? })` | 当前场景的粒子数与分布、开销记录（`profile: true` 开始、`false` 停止）、当前 `instanceoverride` |
| `renderFrame({ …, trace })` | 逐 draw 轨迹（2026-11-13 起）：读回那一帧每个 pass、每个 draw 的目标、管线、绑定、uniform（按反射解码）、索引与顶点，可选读回指定 pass 的目标，和 WPE 的 RenderDoc 抓帧逐 draw 对照；用法与字段见 kabegame-chromium skill 的「逐 draw 轨迹」 |

对比工具是 `kbp-tools` skill（`.claude/skills/kbp-tools/`，入口 `kbp.py`：`kbp gen` 生成确定性工程、`kbp rdc track` 从抓帧提取轨迹、`kbp replay` / `regress` 按 WPE 时间线回放对照、`kbp cmp` 比较、`kbp sample` 采样），数据在 `ignore/p4/`（不入库：工程 `proj/`、轨迹 `tracks/`、日志 `out/`、回放案例 `cases/`；P4a 各步骤原来的脚本与验收在 `step1/`–`step5/`，照旧能跑）。P4a 逐帧比较的长程阈值：位置 0.5 场景像素、尺寸 0、透明度 0.004。抓 WPE 帧用 `wpe-renderdoc` MCP（`.claude/mcps/wpe-renderdoc/`，用法见 `wpe-renderdoc` skill）：`capture_wallpaper` 一步开窗抓帧并在本会话回放进程里打开，`capture_sweep` 抓一组工程 × 设置；P4a 的真值在 `A:\p4-0\`、`A:\p4a\`，对齐用脚本帧号 = RenderDoc 帧号 + 1。驱动 Kabegame（渲染、粒子轨迹与四角、画面哈希、导入测试工程）用 `kabegame-dev` MCP。产品单测用的夹具与常量表的生成脚本在 `apps/wpe-scene/scripts/fixtures/`。

## 粒子（P4b）

P4b 在 P4a 的底座上沿三条线扩展，底座的形状不变：
- 纹理格式：全局放开，图像层也受益；
- 粒子帧表与档 2 模块：照 P4a 的模块表加记录，能力表跟着少报；
- `genericparticle` 自带的折射与裁切分支。

另把 P4a 留下的 `instanceoverride.colorn` 做完。

依据：
- 步骤 0 的读码：[rea-p4b-modules](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4b-modules.md)、[rea-p4b-render](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4b-render.md)；
- 确定性工程的实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4b 语义的实测核对」；
- 逐步的验收数据：[子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4b-tier2.md)「实施记录」。

验收照 P4a：随机范围收成 min = max，按 WPE 日志的 dt 回放，逐粒子、逐像素和 RenderDoc 抓帧比。

**近似倒数不复刻**：WPE 在 `rcp` / `rsqrt` 的位置用 `rcpps` / `rsqrtps`，结果随 CPU 厂商不同。我们按精确值算，`particles/f32.ts` 的 `rcp`、`rsqrt` 只用来标出这些位置。验收时把它们换成乘 (1 ± 3.7e-4) 的版本，算出误差包络加到限值上；按帧数累积的（`vortex` 每帧一次 `rsqrt`）也照此放宽。

### 纹理格式

| 项 | 规则 | 依据 |
|---|---|---|
| 支持的格式 | `compile/tex.ts` 的 `TEXTURE_FORMATS` 是唯一来源，编译期、渲染器、能力表都读它。<br>- 格式：0 RGBA8888、4 DXT5、6 DXT3（`bc2`）、7 DXT1（`bc1`）、8 RG88（`rg8unorm`）、9 R8（`r8unorm`）、12 BC7（`bc7-rgba-unorm`，2026-11-21 起），都不是 sRGB；<br>- 不在表里的报 `tex:format:<n>`；<br>- FreeImage 形态仍只收格式 0 | 读码：`.tex` 枚举直接查表转 DXGI，加载时不转通道。BC7：`ignore/p11/defs/p11f.py` 的四个工程（`3816948983` 的两张真实 BC7 纹理，一张带 LZ4；不透明、半透明、透明块）1:1 和 WPE 整帧逐像素相同 |
| 单、双通道 | 原样上传，不做 CPU 转换。D3D 与 WebGPU 采样单、双通道纹理时，缺的通道都补 0、alpha 补 1。通道换算由着色器按 `TEX<n>FORMAT` 做，翻译器只给声明了 `formatcombo` 的槽位写这个宏 | 实测：R8、RG88、DXT3 的图像层与粒子逐像素相同；DXT1 粒子、R8 / RG88 图像层个别像素差 1 个色阶 |
| alpha-priority | 头标志 `0x80000` 中性，不再报 `tex:alpha-priority` | 实测 0 个像素不同 |
| NPOT | `g_Texture0Resolution = (纹理宽, 纹理高, 图像宽, 图像高)`；粒子四角 UV 固定 0 / 1，填充区会被采到 | 读码；实测 NPOT 粒子 0 个像素不同 |
| 粒子 `TEX0FORMAT` | 只在槽 0 是格式 8–11 时写（`particleWritesTex0Format`） | 读码 |

顺带修了两处取值，各自有专门的说明：
- 翻译器按材质键拆分两阶段同名 uniform。起因是 `foliagesway` 的顶点 `g_Speed` 与片元 `g_Speed` 绑的是不同的材质键。见 [wpesl2wgsl README](../../../src-tauri/wpesl2wgsl/README.md)「两阶段同名 uniform」。
- 材质常量的取值对齐 WPE 的 setter，见 [RENDERER.md](RENDERER.md)「渲染器」的「材质常量的取值照 WPE」。

### 帧表

| 项 | 规则 | 依据 |
|---|---|---|
| TEXS 解析 | 每帧 32 字节的矩形与时长进 bundle（`TexFrame`）。v1 坐标按 i32 读，v2 / v3 按 f32 读，都按所在图像的第 0 级 mip 归一化 | 读码 |
| 帧表语义只看槽 0 | 材质槽 0 的纹理带帧表时（WPE 的系统标志 `0x1000000`），模拟器维护 frame 列，顶点写 `a_TexCoordVec4C1`（`SceneParticle.spriteSheet`）。其它槽位的帧表纹理（如帧表法线图）当普通纹理，片元用同一个帧内 UV 采它 | 读码；`p4b-refract2` 实测 |
| 宏 | `particleSheetDefines` 写下面三个宏，值为 0 也写键：<br>- `SPRITESHEET` 一定伴随 `THICKFORMAT`；<br>- `SPRITESHEETBLEND` = 系统 `flags` 没有 bit1，且不是 `randomframe`；<br>- `SPRITESHEETBLENDNPOT` 只比宽度（图像宽 < 纹理宽） | 读码 + 实测 |
| `g_RenderVar1` | 只用第 0 帧：`(帧宽 / 纹理宽, 帧高 / 纹理高, 帧数, (纹理高 / 纹理宽) · (帧高 / 帧宽))`（`particleBuiltins(sheet)`） | 读码 + 抓帧常量 |
| frame 列 | 放在判死之后、发射之前算：<br>- `sequence`：`rcp(life)·age·sequencemultiplier` 的原值，大于 1 不回绕，小数部分由着色器取；<br>- `randomframe`：出生时写 `R`，之后不变，不混帧 | 实测：frame 相对差 2.4e-4，是 WPE `rcpps` 的固定偏差；注入 WPE 的 `R` 后逐位相同 |
| 顶点 | `a_TexCoordVec4C1 = (速度 xyz, frame 原值)`，偏移仍按反射布局排 | 读码 + 抓帧 |
| 不支持 | 没有帧报 `tex:animation:empty`。P6e 之前一张纹理有多个图像报 `tex:animation:multi-image`、图像层与 effect 材质的帧表纹理报 `tex:animation`；P6e 起都支持（见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图像层帧表（P6e）」）：粒子 draw 同样经 `bindSheets`，多图像帧表绑共享计时器当前格所在的那张图像、粒子各自的格仍在这张图像里取，并推进这张纹理的共享计时器（同 WPE，rea-p6e-sheet 2.3；语料没有这种粒子） | — |

### 发射时序与档 2 模块

模块全部照 P4a 的模块表加记录（字段表、两套缺省值、列、列标志、执行函数），能力表从表生成。

- **发射**：在 `particles/emitters.ts`，`sphererandom` 与 `boxrandom` 共用 `EMITTER_FIELDS`。
  - `duration`、`delay`。
  - emitter `flags` bit1：每帧至多 1 个，`instantaneous` 的欠账照样要还。
  - bit2 周期发射：两态计时，时长从流 A 抽，不补零头；满容量或 `delay > 0` 时整段跳过、计时冻结。
  - `instantaneous` 不乘 `instanceoverride.count`；`maxtoemitperperiod` 乘完再截断。
  - 实测：每帧的粒子数和出生帧都和 WPE 逐个对上。
- **`boxrandom`**：
  - 位置、速度都按 z、y、x 的顺序抽；
  - `distancemin` / `distancemax` 是向量，只收字符串；
  - `distancemin` 非 0 时，粒子只落在盒子四角的块里（实测）。
- **档 2 模块**：
  - initializer `alpharandom`：写 alpha 初值列。
  - operator `sizechange`、`alphachange`、`colorchange`：按生命比例插值，`minps` / `maxps` 遇到 NaN 的行为照 WPE；`colorchange` 的两端是 0–1 的倍数。
  - `sizechange` 的两端乘 `instanceoverride.size`。和 `sizerandom` 同时存在时，尺寸按 `size²` 变（实测）。
  - `oscillatesize`：幅度也乘 `R`。
  - `vortex`：乘 `k`；中心是控制点平移加 `offset`，`offset` 不旋转；`flags` bit0 是圆柱。
  - `capvelocity`：截后速度 WPE 是 99.993（`rsqrtps`），我们是 100.000。
- **噪声类**：在 `particles/noise.ts`、`noiseTables.ts`。
  - `snoise1` / `snoise2` / `snoise3` 逐位移植 WPE 自己的实现与常量表。不能用开源版：二维噪声的梯度条件、三维噪声第 4 个角的哈希都不同。
  - 场景时间 `T` 进模拟器（`ParticleSystem.step(frameDt, time)`）：取**本帧**的 `g_Time`，舍入成 float32，不乘 `rate`。预热期 `T = 0`（实测）。
  - `turbulence` 乘 `k`，不读 `phasemin`。
  - `turbulentvelocityrandom` 用 CRT 的 `sinf` / `cosf`，没测出和 `Math.sin` 的差。
  - `positionoffsetrandom` 的 `octaves` 钳到 [1, 8]。
  - `turbulence` 用短程强制回放验收：湍流场对输入敏感，把日志里 6 位小数的 dt 扰动一下，我们自己的模拟就会发散到上百像素。所以从 WPE 抓帧的 float32 原值出发只走 4 帧，差 ≤ 3.1e-4。
- **照报**：模块上的 `audioprocessing*` 字段（P4e）。`vortex` 用非 0 控制点在 P4b 时照报，P4c 步骤 1 起支持（中心加控制点平移，见「粒子（P4c）」的「控制点」）。

### `REFRACT`、`CUTOUT`、`NORMALMAP`

数学全在 `genericparticle` 的着色器里，引擎只负责三件事。这三件都在 `p4b-refract`、`p4b-refract2` 上和 WPE 逐像素比过，差异最大 1 个色阶。

- **COMBO**：
  - `REFRACT`、`CUTOUT` 是材质写的普通 COMBO。
  - `NORMALMAP` 是采样器 COMBO：槽 1 按名字绑了纹理就定义，WPE 运行时不读注解里的 `require`。
  - `g_Texture1` 声明在 `#if REFRACT || LIGHTING` 里，所以没开折射时 `NORMALMAP` 不起作用。实测：绑与不绑法线图逐像素相同。
- **快照**：粒子层计划在本层前面放一个 `snapshot`，和 WPE「每个折射对象画之前拷一次」的时机相同。
  - WPE 的场景目标开了 MSAA，快照是 `ResolveSubresource`。轴对齐、落在整像素上的四边形覆盖率只有 0 或 1，Resolve 前后相同。
  - 存活数为 0 时 WPE 不拷，我们照拷。读快照的每一层在读之前都会自己重拷，所以画面不受影响。
- **视图轴**：正交、透视粒子都是 `g_ViewRight = (1, 0, 0)`、`g_ViewUp = (0, 1, 0)`（抓帧实测）。`g_RefractAmount`、`g_Cutout*` 是普通材质常量。

### `instanceoverride.colorn`

`colorn` 有两种作用方式，可以同时生效。实现在 `particles/colorn.ts`，依据 rea-p4b-render 7.1–7.4。

- **系统色**（`compile/particles.ts` 的 `particleColorSystem`）：加载时从粒子 JSON 原文推出。
  - 按 initializer 顺序找，后面的覆盖前面的：`colorrandom` 取 `((max − min)·0.5 + min)·0.003921569`，min、max 是 0–255 原值。P4g 起 `hsvcolorrandom`、`colorlist` 也参与（见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4g）」）。
  - 一个 initializer 都没命中时，取第一个 operator `colorchange` 的 `startvalue`。
  - 都没有时是 (1, 1, 1)，`hascolor` 为假。
  - 结果经 `%.5f` 往返一次。
- **生效**：要同时满足三条：
  - `colorn` 已设（r ≥ 0）；
  - 不是三个分量都和系统色差 < 0.9/255；
  - 系统 `flags` 没有 bit3。
  - `color`（0–255）加载时 ÷255 后经 `%.5f` 往返成 `colorn`。两个键都写时取 `color`。
- **平移**：每个颜色模块的颜色加上「`colorn` 与系统色的 HSV 差」再转回 RGB。
  - 色相取模到 [0, 1)，饱和度、明度钳到 [0, 1]；`rgb2hsv` 全用 float32 除法，`hsv2rgb` 的两次 `fmod` 是双精度。
  - `colorrandom`：min、max 两端各自平移，再插值。
  - `colorchange`：`startvalue`、`endvalue` 两端各自平移。WPE 的 0xc 记录写的是 start 与 Δ；我们换两端，每帧按 `f32(end − start)` 算 Δ，结果相同。
  - `hsvcolorrandom`（0xd）、`colorlist`（0xe）：P4g 起，规则不同（区间搬到 `colorn` 上、出生时加 HSV 差），见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4g）」。
- **实例颜色**（WPE 的系统标志 `0x200000`）：
  - 置位条件：scene.json 根的 **`version` < 5**（缺键为 0），或没有颜色模块。
  - 置位且生效时，新粒子的颜色初值是 `colorn`，颜色模块再乘到它上面。
  - 读码原以为这一位看的是设备档位，P4b 步骤 6 补读后改正。本机语料里用 `colorn` 的 60 张场景，有 29 张 `version` < 5：平移之后还要再乘一次 `colorn`。
- **运行中改值**：`colorn` 绑颜色属性时，登记成就地目标（`particle-instance`，字段 `colorn`）。改值时从基值重算，不累加、不重编译。
  - `colorrandom` 和没有颜色模块的系统，只有之后出生的粒子换色。
  - `colorchange` 是每帧跑的 operator，存活粒子下一帧就换成新渐变。
  - 实测：`p4b-colorp2` 把寿命设成 16 s，让改值前出生的粒子活到抓帧；逐槽和 WPE 相同。
- **照报**：
  - `color` 绑了属性报 `particle:instance:color:user`，`colorn` 带 `condition` 报 `particle:instance:colorn:condition`。这两种 WPE 怎么处理没读到，语料里都是 0 处。
  - 挂脚本、HDR 下的 `brightness`：P4f 起支持（见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」），之前照报。
  - 父系统不生效时子系统一律不生效。这条留给子系统（P4e）。
- **验收**：
  - 确定性工程覆盖了 `version` 3、5、缺键，以及运行中改值：逐粒子最大差 3e-8（限值 2e-6）。
  - 整帧像素只有 `colorchange` 的个别粒子差 1 个色阶，因为 WPE 算 t 时用了 `rcpps`。

### 语料与解锁

- **语料**（152 个工程）：
  - 能渲染的场景 14 → 20。
  - 带粒子的 95 张里，粒子用法完全覆盖（不报任何 `particle:*` 键）的从 5 张到 22 张。
- **新解锁**：
  - 步骤 1 的纹理格式解锁 `2854083091`、`3799426930`、`3812822229`、`3829603837`；步骤 3 解锁 `1504316159`、`3820104696`。
  - `3799426930`、`3812822229`、`3829603837` 都用 `foliagesway`，和 WPE 逐像素比只有 0.03%–0.07% 的像素差 1。修正前的 1.3%–35%，是翻译器把两阶段同名 uniform 合并造成的。
  - `2854083091` 的构图和画面与 WPE 一致。
  - `1504316159`、`3820104696` 的雾、雨线和 WPE 的统计量一致。
- **还挡得最多的粒子键**：
  - `particle:controlpoint` 48 张、`particle:children` 32、`spritetrail` 29、`controlpointattract` 28、`rope` 22、`particle:flags:world` 21，分别属 P4c–P4e（其中控制点、`spritetrail`、`controlpointattract`、世界空间在 P4c 全部去掉，见「粒子（P4c）」的「语料与解锁」）；
  - 纹理只剩 `tex:video` 35 张、`tex:animation`（图像层帧动画）14 张。
- **基线**：10 张原本能渲染的场景 × 三档后处理，共 30 组画面哈希。
  - 步骤 2–6 每一步都和前一步相同。
  - 步骤 1 补充的翻译器修正只改了 `2418800402`（凝光，自带 `foliagesway`）。按 WPE 抓帧核对，这是修正带来的。
- `1838478131` 的控制点 0 跟随指针，从 P4b 移到 P4c，已在 P4c 步骤 2 解锁。

### dev 探针与对比台的增补

| 探针 | P4b 增补 |
|---|---|
| `renderFrame` | `pointer`（`g_PointerPosition`，和 WPE 抓帧比时填抓帧里的值）；`particles.random`（按 `objects` 下标、按出生顺序顶替 `R`） |
| `particleTrack` | `times`（每帧的场景时间 `T`，回放 WPE 时填日志的累计时间）；`random` 同上 |
| `particleCorners` | 同样收 `particles.random` |

对比台仍在 `ignore/p4/`：
- `gen_b.py`：生成 P4b 的确定性工程（`p4b`、`p4b-emit`、`p4b-tex`、`p4b-refract`、`p4b-color` 等）。
- `sweep_b.py`：一次会话抓多个工程，另认 `fps,键=值` 与窗口尺寸。
- `rdc_track_b.py`：按 `kbp-meta.json` 认系统，并保存厚格式的 `TEXCOORD1`。
- 各步骤的验收脚本在 `b1/`–`b6/`、`b2v/`–`b5v/`，WPE 参照在 `A:\p4b\`。

## 粒子（P4c）

P4a、P4b 的粒子系统是封闭的：控制点 0 当单位阵，粒子都在对象本地空间，绘制时乘对象的世界矩阵。P4c 给它接上外部输入，底座的形状不变：
- 控制点：成为系统的一份状态，读控制点的模块经执行上下文取值；指针是控制点的一种输入。
- `controlpointattract`：一个普通的 operator，按到控制点的距离改速度。
- 世界空间：坐标系的切换，不是新模块；同时把一帧里粒子的步进挪到脚本之前。
- 拖尾 `spritetrail` 与 `sprite` 的朝向：只碰几何，不碰模拟。

依据：
- 步骤 0 的读码：[rea-p4c-sim](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4c-sim.md)（控制点、指针、`controlpointattract`、世界空间）、[rea-p4c-render](../../../.claude/plans/wpe-import/3-scene/phase4/rea-p4c-render.md)（`spritetrail`、`sprite` 朝向）；
- 确定性工程的实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4c 语义的实测核对」（22 条读码结论全部成立），以及其中的「步骤 2 补测」（指针）、「步骤 5 补测」（对象带 x / y 旋转时的朝向）；
- 逐步的验收数据：[子计划](../../../.claude/plans/wpe-import/3-scene/phase4/phase-4c-controlpoints.md)「实施记录」。

验收照 P4a、P4b：
- 控制点、指针、吸引、世界空间：随机范围收成 min = max，按 WPE 日志的 dt 回放，逐粒子和 RenderDoc 抓帧比，近似倒数照旧按误差包络放宽。
- 拖尾与朝向比每个粒子的四角：
  - 离线：把 WPE 的顶点列喂给我们翻译的顶点着色器（Deno 的 WebGPU）；
  - 真机：屏外宿主自己模拟，dev 探针 `particleCorners` 读回 GPU 算出的四角。
- 每一步：变异检查代理与 Claude 各做一组、互不重复，没检出的只有步骤 2 的一处（dev 探针回放帧的 `cursor` 固定在中心，探针没有单测），步骤 4 的一处补用例后检出；以前的回放（`b3`、`b4`、`b6`、`c1`–`c4`）改动前后输出逐字节相同。

### 控制点

实现在 `particles/controlpoints.ts`（`ControlPointSet`），解析在 `compile/particles.ts`（`readControlPoints`）。

| 项 | 规则 | 依据 |
|---|---|---|
| 个数 `n` | `n = max(模块的 controlpoint + 1)`（`controlPointCount`，只数模块表里带 `controlpoint` 字段的模块）。没被引用的控制点不存在，JSON 里给它写什么都不起作用，能力表也不报。只被表外模块（如 P4d 的 `reducemovementnearcontrolpoint`）引用的点在 `n` 之外，模块进表后自动计入 | 读码 1.1 |
| 存储 | 每个点存 `base`、`current`、`previous` 三份仿射变换（3×3 加平移；WPE 每份是 4×4，第 4 行恒为 0 0 0 1） | 读码 1.1 |
| 初值 | `base = I + offset`，`current = previous = base`。JSON 的 `angles` 运行时不读。`offset` 只在是字符串时解析，切分逐字照 WPE：第一个分量从串首 `atof`，之后先跳过非空格、再跳过空格（只认 0x20），所以 `" 5 6 7"` 是 (5, 5, 6)，`"1,2,3"` 是 (1, 0, 0) | 读码 1.2、1.3，`offset` 的切分对过汇编；实测：控制点 1 写 `angles "0 0 1.5708"`，出生点不旋转 |
| 更新时机 | 每帧一次（两遍模式也只一次），在序列帧之后、发射之前；全部 operator 之后 `previous ← current`。加载时先按加载时的 `W` 更新一次、拷 `previous`，再预热，预热每步照常更新 | 读码 1.3、1.5 |
| `instanceoverride` | `controlpointN` 替换 `base` 的平移，不加到 `offset` 上；`controlpointangleN` 替换 3×3（`eulerBasis`，`Rz·Ry·Rx`，弧度）。指针点、`flags 4` 的点、remap 输出的点（`flags & 0x10005`）上不生效。只做静态值，建系统时生效一次；绑了属性报 `particle:instance:controlpoint:user`（语料 0 处） | 读码第 2 节；实测：覆盖 `"0 200 0"` 时出生点 (1060, 740)，`flags 4` 的点覆盖没生效 |
| 发射器（`sphererandom`、`boxrandom`） | 读自己那个控制点的 `current`：出生点加上平移；3×3 只在「世界空间或 `controlpoint ≠ 0`」时旋转出生点和回退方向，但总是交给 initializer 当 `M`，`velocityrandom`、`turbulentvelocityrandom` 乘它 | 读码第 3 节；实测：本地系统里控制点 0 带角度时出生点不转，速度变成 (0, 50) |
| `vortex` | 中心是控制点平移加 `offset`，轴和 `offset` 不旋转 | 读码第 3 节；实测：控制点 1 带角度时粒子 z 一直为 0 |
| 模块的 `controlpoint` 字段 | 取整后按无符号与 7 取小，负数得 7 | 读码（`cmp eax, 7; cmovb`） |
| `flags` 的取值 | 照 jsoncpp 取无符号整数：布尔取 1 / 0，数字取整后取低 32 位（−1 是 `0xFFFFFFFF`）；字符串 WPE 抛异常，这里取 0 | 读码 |

`flags` 各位（优先级 `0x10000` > bit0 > bit2 > 缺省）：

| 位 | 作用 | 依据 |
|---|---|---|
| 1 | 跟随指针，见下「指针」 | 读码 1.6；实测 |
| 2 | `base` 是场景坐标：本地系统 `current = inverse(W)·base`；世界系统里控制点 0 忽略这一位 | 读码 1.5；实测：对象 `scale 2`、`angles 0.5` 时出生点仍在场景 (200, 100) |
| 4 | 父控制点。顶层系统没有父，走缺省更新，唯一的作用是让实例覆盖不生效 | 读码 1.8；实测 |
| 8、`parentcontrolpoint` | 只在父分支里有用，归 P4e（子系统，`particle:children` 照报） | 读码 1.8 |
| 16 | 没有读者 | 读码（有界）；实测和 `flags 0` 相同 |
| `0x10000` | 内部位：remap 模块写的点，`update` 跳过（P4d） | 读码 1.2 |

中性、不报的：JSON 控制点的 `angles`、`locktopointer`（WPE 2.8.42 二进制里没有这个字符串，实测写 `true` 也不跟随）、`parentcontrolpoint`、bit3、bit4，以及下标 ≥ `n` 的点。`W` 奇异时 WPE 是除以 0 得 inf / NaN，这里写 NaN（粒子不画）。

### 指针

控制点 `flags` bit0 的点每帧的平移是「光标下的场景点」`F`。

| 项 | 规则 | 依据 |
|---|---|---|
| 指针点 | `current = base` 后整体覆盖平移，`offset` 被丢弃，3×3 是单位阵（不吃实例覆盖）。本地系统乘 `inverse(W)`（和 `flags 2` 共用一次求逆，`W` 奇异时平移写 NaN），世界系统直接是 `(X, Y, 0)`、不乘 `W`。用本帧的指针 | 读码 1.6；实测：对象 `scale 2` 时世界组和本地组的出生点正好差 100（本地组的 (100, 0) 经对象放大成 200），`angles 0.7`、`scale 2` 的本地组偏移和预测一致；补测：跟随点和当帧指针换算的值差 ≤ 0.02，和上一帧的差几十像素 |
| 反投影（`pointerScenePoint`） | 照 WPE 逐步 float32：`x = 2px − 1`、`y = 2(1 − py) − 1`，用场景的正交 `P·V`（`sceneViewProjection`，不裁切）的逆，把 NDC z = 0 的点反投影；1920×1080 的场景就是 `(px·1920, (1 − py)·1080)`。求逆没按 float32 复刻，回放里 y 最大差 6.9e-5 | 读码 1.6；实测：指针 (1.4115, 0.7398) 那一帧粒子出生在 (2810, 281)，y 不翻转的式子差 518；光标在窗口外照样外推 |
| 光标下的场景纹理坐标（`render/layout.ts` 的 `sceneCursor`） | 画布指针按当前样式的铺放反算：<br>- `fill`：等于 WPE 把居中盖满裁切做进投影的结果，和 WPE 一致（窗口与场景比例不同时反投影不再经它，改用裁过的 `P·V` 与窗口指针，见 [SCRIPT.md](SCRIPT.md)「交互（P6c）」的「`fill` 裁切」；比例相同时仍走这里）；<br>- `fit` / `center`：Kabegame 自己的样式，按同一原则，留白处线性外推（不钳制）；<br>- `stretch`：恒等；<br>- `tile`：取所在那一块（小数部分） | 补测：1920×800、1440×1080 窗口下 WPE 的跟随点都是 `inverse(P·V)` 作用在窗口指针上，即光标下的场景点，朴素换算差 12–45 像素 |
| 和 `g_PointerPosition` 的关系 | 不是一个量。`g_PointerPosition` 照 P2a 不变：`fill` / `stretch` 是画布归一化坐标（补测：WPE 裁切时也仍是窗口坐标），其余样式换算到场景上（`scenePointer`）。两者只在 `fill` 下不同 | 补测 |
| 透视粒子与透视场景 | 透视粒子（系统 `flags & 4`）不用另算：WPE 模拟时栈上是场景的正交投影，透视粒子的 z = 0 平面和正交画面重合。透视场景当时（P4c）照报，所以 `P·V` 只有正交一种；P5d 起透视场景能渲染，透视粒子（`flags & 4`）在透视场景里照报 `camera:perspective:particle`。P5a 起它带抖动与缩放、不带视差，而且是上一帧交给场景的相机，见 [CAMERA.md](CAMERA.md)「相机：视差、抖动与缩放（P5a）」的「一帧里的顺序」 | 读码 1.6；P5a 实测 `p5a-shakepar`、`p5a-zoomx*` |

**数据流**：
- 宿主 `pointermove` → `SceneRenderer.setPointer` 只记画布上的原始坐标；
- 开场指针（P5a 收尾）：`interactive` 时 `WpeSceneView` 在 iframe `load` 与宿主 ready 时各问一次 `wpe_scene_cursor`（`tauri-plugin-cursor` 的 `position_in_window`：Windows `GetCursorPos` + `ScreenToClient` + DPI，macOS 未实测；Linux `null`，退回父页面最近一次 `pointermove` / `pointerdown`），按 iframe 显示矩形换成归一化坐标（不钳制），经 `kabegame:wpe-scene-pointer` 交给宿主当初值；宿主收到过真实 `pointermove` 后初值作废（`scenePointerFeed`）。`SceneHost` 记住最近的指针，渲染器建好时先于 `load` 带进去，没有场景时原样记下的指针在 `load` 里按新场景铺放换成 `g_PointerPosition`，所以预热与第一帧就用真实光标；
- 每帧在 `syncPlacement` 之后按当前样式现算 `cursor`，放进 `FrameInput.cursor`，改样式、改尺寸下一帧就对；
- `GpuScene.stepParticles` 每次调用反投影一次，作为 `ControlPointInputs.pointer` 交给每个系统。模拟器只收场景坐标，不知道样式；
- 加载时按新场景的尺寸（`sceneTargetSize`）算一次 `cursor`，给加载时的更新与预热；
- 暂停时照记坐标、不画，恢复后的第一帧用最新值。WPE 暂停时指针冻结、恢复后读当时的光标，效果相同。

**已知差别**：WPE 用全局光标（`GetCursorPos`），光标在窗口外也跟踪，`g_PointerPosition` 可以出 0…1。我们开场取一次真实光标（见上，不交互时不取），之后只在宿主收到 `pointermove` 时更新，两样都没有时 `cursor` 取场景中心 (0.5, 0.5)。2026-11-15 起预览与桌面都由 Rust 按全局光标直接注入宿主 iframe（见 [WPE_IMPORT.md](../WPE_IMPORT.md)「鼠标」），光标在 iframe 外、应用窗口外、另一块屏上也跟踪，但钳到「frame 中心到光标的连线」与 frame 边界的交点：视差与跟随鼠标的粒子停在边缘，不像 WPE 那样外推（用户定的）。Linux 拿不到全局光标，只在 iframe 上跟踪。

### `controlpointattract`

实现在 `particles/operators.ts` 的 `controlPointAttract`（普通版与 blend 版共用），模块记录在 `particles/modules.ts`。

| 字段 | 缺省（正交 / 透视） | 说明 |
|---|---|---|
| `scale` | 512 / 20 | 乘 `instanceoverride.speed`（系统 `flags` bit4 时不乘）；为负时排斥 |
| `threshold` | 512 / 5 | 不乘覆盖 |
| `deletethreshold` | 15 / 0.5 | 按平方比较（WPE 解析期存 float 平方） |
| `flags` | 2 | bit0 删除判定，bit1 钳制，其余位没有读者。缺省 2 即钳制开 |
| `controlpoint` | 0 | 读这个点 `current` 的平移；钳到 0–7 |
| `offset` | `"0 0 0"` | 解析了，执行和删除判定都不读 |
| `origin` | — | WPE 不读这个键（解析段没有它），中性：登记成不参与计算的字段（`vec3str`，写成数字也不报），免得按表外字段报。语料 50 处 |

公式（照 `0x140241554` / blend 版 `0x14024172d` 的汇编）：
```
C  = cp[controlpoint].current.t；ks = k·scale；rT = rcp(threshold)
每槽（含死槽）：d = p − C；L = sqrt((dz² + dy²) + dx²)
  active = L < threshold 且 FLT_MIN < L         （两个都是严格小于；L 为 NaN 时不生效）
  f = (1 − L·rT)·ks；flags & 2 且 L < f 时 f = L；blend 版钳制之后再乘 b
  active 时按 y、z、x 的顺序 v −= (d/L)·f      （逐步 float32）
```
- 只改速度，不改位置。乘的是 drag 系数 `k`，不是步长 `h`；两遍模式每遍 `k/2`，删除判定每遍都做。`scale < 0` 时 `f < 0`，永远不钳。读 `current`，不读 `previous`。
- **删除判定**（`flags` bit0，`attractDelete`）：线段 `[上一步位置, 位置]`（`movement` 每遍开头把位置抄进上一步位置，出生时是出生位置）上离 `C` 最近的点到 `C` 的距离平方不大于 `deletethreshold²` 时 `age = life`（比较是 `!(dt² < |e|²)`，NaN 也删）：本帧照画，下一帧判死。乘加顺序照汇编：先算 `u = r·d`，`s = ((Cz − P0z)·uz + (Cy − P0y)·uy) + (Cx − P0x)·ux`，`e = C − (s·u + P0)`；rea 4.3 按 Ghidra 写的顺序不对，有 1 ulp 的边界用例钉住。上一步位置列只在 bit0 时分配：模块表新增按字段算的列标志 `columnFlagsOf`。
- **控制点个数**：本模块进表后，只被它引用的控制点开始存在，这些点上的指针、实例覆盖从此生效。语料里这样的点 42 处（指针 30、实例覆盖 12），所在场景当时都还因别的键退回。
- **实测**：缺省 `flags` 是 2（不写和写 0、`scale 1e6` 时完全不同）；`origin`、`offset` 中性；`threshold` 严格小于、`scale` 为负排斥、`scale` 乘 `speed`。语料 62 处全用缺省 `flags`，没有 blend 和 `deletethreshold`，43 处排斥；删除判定和 blend 只由读码与单测钉住，回放里 `a-delete` 只核对了粒子数。
- **回放**：`p4c-attract` 的 fps 60（一遍，抓帧拖慢后 dt ≈ 0.074，`k ≠ h`）与 fps 10（两遍）两组，10 个系统里 9 个在限内（差 / 限 0.12–0.97）。`a-default` 两组都超出包络（差 / 限 1.15、28.7）：
  - 单步核对（只用 WPE 自己相邻帧的位置预测下一帧）残差 4.6e-3 / 3.8e-3，在 `rcpps` 量级内；不钳制的假设残差 1.7e3，所以公式成立。
  - 超限来自钳制下每帧减掉整个 `L`，近似倒数的逐值误差一路累积；fps 10 那组还叠上 151–155 帧的 dt 没有记录。
  - 用户接受这处超限（2026-11-08），不改包络、不重抓。

### 世界空间与帧顺序

系统 `flags` bit0 时粒子存世界坐标。

| 项 | 规则 | 依据 |
|---|---|---|
| 模拟 | 控制点缺省更新 `current = W·base`（控制点 0 忽略 bit1），指针点 `(X, Y, 0)`；出生点 `mat3(W·base)·q + (W·base.t + origin)`，**`origin` 不经 `W`**；`velocityrandom`、`turbulentvelocityrandom` 乘 `mat3(W·base)`（含缩放）；`vortex` 的轴固定在世界；已发出的粒子在对象移动、旋转后留在原地 | 读码 5.2、5.5；实测：脚本移动、旋转对象时 5 个世界空间粒子都落在出生时刻的 `W(t)·(100, 0)` 上（残差 ≤ 0.05）；对象转 90° 时 `origin` 不转 |
| 绘制 | WPE 把模型矩阵栈顶换成 `ctx+0xaf0`，平时是单位阵，所以世界空间系统只乘视图投影：`GpuScene.particleModel` 给单位阵，`g_ModelMatrix` 是单位阵、MVP 等于视图投影。对象变换改了照常重写 uniform，仍是单位阵。组合层离屏时 WPE 把它临时设成模型矩阵，我们没有组合层（`model:passthrough` 等照报） | 读码 5.3 |
| `movement` 的 `flags` bit0 | 本地系统里重力先变换成 `g = Mᵀ·g`（`M` 是模拟用的 `W` 的 3×3，含缩放、不归一化；在乘 `h` 之前，两遍模式每遍都做），世界系统不变换。执行上下文的 `model` 每次（含预热每步）从控制点输入的 `W` 取前三列。其余位没找到读者，照报 | 读码 5.4（取 3×3 的 `FUN_1400dd7d0` 原为【推】，步骤 4 对过汇编后为【确】）；实测：`flags 0` 时本地组的重力随对象转，`flags 1` 与世界组沿世界 −y。语料 0 处 |

**粒子先于脚本**：
- 预研：`p4c-world` 的 `w-stay-*` 由脚本每帧平移、旋转对象。按「第 N 帧用第 N 帧的对象变换」回放，世界空间粒子差 2.54 像素，正好是对象一帧的位移；用第 N − 1 帧的，差 0.016。
- 同时日志里脚本读到的 `engine.runtime` 和同帧 `g_Time` 完全相等，P3b 测过脚本写的变换当帧就作用到图层上。所以不是脚本时钟慢一帧，而是 WPE 一帧里先模拟粒子、后跑脚本。
- `SceneRenderer.render` 一帧的顺序因此是 `sync` → `stepParticles` → 脚本（`beforeFrame`）→ `sync` → `update`（只写每帧 uniform，不再步进）→ `encode`。脚本仍在 `try` 外，脚本自己的错误不走 `render:frame` 退回。dev 探针 `renderFrame`、`particleCorners` 同样先 `stepParticles` 再 `update`。
- 效果：脚本移动对象时，世界空间粒子的出生点、本地系统里指针点与 `flags 2` 点用的是脚本运行之前（上一帧）的对象变换，和 WPE 一样晚一帧；绘制照旧用当帧（脚本之后）的对象矩阵。可见性判断也用脚本之前的状态（没有实测）。
- 步进之前的那次 `sync` 把两帧之间写进 `SceneState` 的属性改值推给模拟器，属性改值的延迟不变。
- 加载时的预热照旧用建场景时的 `W`；加载期脚本 `init` 和预热谁先谁后没有实测。
- **验收**：`p4c-world` 13 个系统各 30 个粒子，差 / 限 0–0.587；`w-grav1-l` 从预研时的 1.73e3 降到 2.29e-2；「本帧变换」的变体在 `w-stay-w` 上差 / 限 236，顺序被钉住。`p4c-ptr` 的 `p-world`（世界空间加跟随指针）三组窗口差 / 限 0.62–0.67。应用里的帧循环 2026-11-09 实测：预览 `3832772446`、应用背景 `1838478131` 1.5 秒内 rAF 216 次、粒子在动；`razer_bedroom` 的 6 个脚本 1.5 秒内 `update` 增加 540 次，没有报错、没有被禁用的回调。

### 拖尾与 `sprite` 朝向

| 项 | 规则 | 依据 |
|---|---|---|
| `spritetrail` 字段 | `length` 0.05、`maxlength` 10、`minlength` 0（缺省函数不补这个键，读成 0）；正交、透视一套缺省，原样存，不钳制、不排序（`minlength > maxlength` 时着色器的 `max` 在外层，`minlength` 胜） | 读码 6.1 |
| 宏 | `THICKFORMAT = 1`、`TRAILRENDERER = 1`（`compile/bundle.ts` 的 `particleRendererDefines`），槽 0 带帧表时照旧再写 `SPRITESHEET*`。`sprite` 不写朝向宏，`TEX0FORMAT` 的条件见下 | 读码 6.2、7.8 |
| `g_RenderVar0` | 拖尾系统写 `(length, maxlength, minlength, 0)`，其余仍是 0。WPE 的 `.w` 保留上一次绘制写的值，`genericparticle` 不读 | 读码 6.3 |
| 拖尾几何 | 全在翻译后的着色器里：`L = max(minlength, min(‖v‖·length, maxlength))`，四边形以粒子为中心、沿当帧速度拉长，宽 `size`，宽向 `normalize(cross(p − eyeLocal, v))`，离开视轴时变窄。和帧时间、历史位置无关；模拟器不为拖尾多做任何事，速度照 P4b 写进厚格式顶点。透视粒子的拖尾仍用场景眼位 | 读码 6.4；实测：12 组长度都吻合（含截顶、托底、两者冲突），`v = (60, 80)` 四角逐位相同，宽度正是 `10·2000/√(2000² + dy²)` |
| 朝向解析（`particles/orientation.ts` 的 `readOrientation`） | `orientation` 只认精确的 `"upright"` / `"fixed"`（区分大小写），其它都是 `screen`；`axis` 精确零（−0 也算）换成 (0, 1, 0)，否则归一化（`"0 0 0.000001"` 得 (0, 0, 1)）；派生 `t`（`axis.x == axis.z == 0` 时是 (0, 0, −1)）；`flags` 只存低 8 位，只有 bit0 有读者。拖尾共用这段解析，但几何不读朝向 | 读码 7.1、7.6、7.7，汇编核对 |
| 朝向向量（`orientationVectors` / `orientationBasis`） | 照 `FUN_1402298b0` 在 CPU 上算 `g_OrientationForward / Right / Up`：<br>- `screen`：法线朝相机；bit0 时上方向取相机上方向，否则取对象 Y 轴，再对法线做一次 Gram-Schmidt；<br>- `upright`：绕 `axis` 的圆柱公告板，bit0 时上方向固定为 (0, 1, 0)、`axis` 被忽略；<br>- `fixed`：法线固定为 `axis`、上方向是 `t`，bit0 时两者是世界向量。<br>输入是这次绘制的模型矩阵（本地系统是对象世界矩阵，世界空间系统是单位阵）与正交场景的相机（`VIEW_FORWARD = (0, 0, −1)`、`VIEW_UP = (0, 1, 0)`，透视场景照报） | 读码 7.2、7.4；实测：24 组四角全部吻合，对象转 0.5 弧度时 `flags 0` 随对象转、`flags 1` 保持直立 |
| 何时算 | 朝向只在模型矩阵变化时变，变化会标脏，所以放在静态 uniform 里（`particleUniformValues`）；对象变换就地刷新时重写这三个名字（`PARTICLE_REFRESH_UNIFORMS`，材质值照样优先） | — |
| 退化不画 | WPE 里速度为 0 或平行于视线的拖尾、轴平行于视线的 `upright` 算出 NaN，不画。WGSL 没有可靠的 NaN 判断，`normalize(0)` 各后端不同，都在 CPU 上处理：<br>- 拖尾写顶点时跳过这些粒子（`particles/vertices.ts` 的 `trailDrawable`，照着色器的式子在 float32 里判 `v·v == 0` 或 `c·c == 0`（`c = cross(p − eyeLocal, v)`）；`eyeLocal` 由 `g_EyePosition` 与模型矩阵的逆算，`trailEye`）；<br>- 朝向算出 NaN 时这次绘制整个跳过（draw 的 `hidden`），uniform 照写原值 | 读码 6.4、7.4；实测：速度为 0 的拖尾（`T6`）与轴平行于视线的 `upright`（`S7`），WPE 的 `gs_out` 四角都是 NaN |

- **一个系统多个 renderer 继续报 `particle:renderers`**（2026-11-09 用户定；P4f 步骤 4 起支持 sprite / spritetrail 的任意组合，见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」）：
  - WPE 对多个 renderer 按数组顺序各画一次，共用一份顶点、各绑自己的变体材质（实测两种顺序都是两次绘制）。
  - 我们一个粒子层只有一次绘制。支持它要拆成一个系统多次绘制：顶点布局能不能共用、每次绘制各自的 uniform、快照「每对象至多一次」、四角探针按绘制输出。
  - 语料里这样的系统一个都没有；步骤 0 抓的 `T8`、`T8r` 留给以后。
- **`TEX0FORMAT`**：见「粒子（P4a）」的「编译」，非厚格式 `sprite` 的非 `screen` 朝向对任何格式都写。
- **没改的边界**：`renderer: []` 仍按缺省 sprite 画（WPE 不画）；`orientation` 写成非字符串照报（比 WPE 严）。
- **对象带 x / y 旋转**（步骤 5 补测，`proj/p4c-rot`，17 个系统）：
  - 朝向改成现算以后，挂在带 x / y 旋转对象上的 `screen` sprite 不再是写死的单位基。WPE 里 x 旋转 0.6 的 `screen` sprite 是 40×40 的正方形、朝向相机，跟随对象的 `fixed` 是 40×33.01（cos 0.6），和现算一致，写死单位基是错的。
  - 四角离线最大差 1.90e-4 像素，真机（含我们自己模拟的累积）6.87e-4。
  - 干净场景里受影响的只有 `shimmering_particles` 的 3 个 `small_motes_copy1` 层（透视粒子，和单位基最大差 0.391）。它们在默认样式下不可见（屏外宿主实测 `visible` 都是 false，`encode` 整段跳过），默认样式的画面不受影响；`style` 改成 1 时这三层朝向相机。补测照抄了这三层的角度、z 偏移与缩放，和 WPE 吻合。
- **四角验收**：`p4c-trail`、`p4c-sprite` 32 个系统 × 3 帧，离线与真机都和 WPE 最大差 1.14e-4 像素（限 0.01）；`T6`（速度为 0）不写顶点，`S7`（`upright` 轴平行于视线）整次跳过；透视粒子加拖尾（`T10`）用场景眼位，四角同样吻合；`p4c-trail` 只报 `particle:renderers`（`T8`、`T8r`）。

### 语料与解锁

- **语料**（152 个工程，按 P4b 的口径重算：`ignore/p4/c5/coverage_p4c.py`，结果 `out/coverage-p4c.txt`）：
  - 能渲染的场景 20 → 22。
  - 带粒子的 95 张里，粒子用法完全覆盖（不报任何 `particle:*` 键）的从 22 张到 44 张；步骤 1–5 之后依次是 22、26、31、32、44。
  - P4c 去掉的键：`particle:controlpoint` 48 张、`particle:renderer:spritetrail` 29、`particle:operator:controlpointattract` 28、`particle:flags:world` 21（34 个系统）、`particle:instance:controlpoint` 7、`particle:renderer:sprite:flags` 6、`particle:renderer:sprite:orientation` 2。步骤 1 新增的 `particle:controlpoint:pointer`（32 张）在步骤 2 去掉，收尾时没有新增的 `particle:*` 键。
- **新解锁**：
  - `1838478131`（步骤 2）：控制点 0 的 `flags 1` 跟随指针。场景是 3441×2465，桌面 16:9 下 `fill` 正好裁切，这正是要按铺放反算的情形。没有和 WPE 逐帧比这张场景的画面：跟随规则由 `p4c-ptr` 三种窗口的回放核对（WPE 的跟随点和我们的逐帧差 ≤ 0.02），用户在预览和桌面上看过，没有问题（2026-11-08）。
  - `3832772446`（步骤 5，还要步骤 1–3）：20 个透视粒子，`sphererandom` + `alphafade` + 排斥的 `controlpointattract`，renderer 是 `sprite` `flags 1`。被排斥的是控制点 1，它的平移来自 `instanceoverride.controlpoint1`，不跟指针；场景也没有着色器读 `g_PointerPosition`。和 WPE 比画面（2026-11-09，3840×2160 窗口，抓 3 帧）：
    - 静态部分（按抓帧的 `g_Time` 渲染、不步进粒子）：差值大于 32 的像素只占 0.15%，全部落在 WPE 的 20 个粒子上，粒子以外逐像素一致；
    - 粒子（按「前 2061 帧均匀走到抓帧前、抓到的三帧各 0.25 s」回放，比统计量）：粒子数 20 / 19 / 20 对 20 / 19–20；位置范围、尺寸（WPE 53–284，我们 54–292）、屏幕上的四边形边长与中心分布一致。alpha 均值 WPE 0.43，我们 24 个种子均值 0.504、标准差 0.072，WPE 在一个标准差以内，是随机波动。
  - `1923929928` 做完本节只差 `object:perspective`，不算本节解锁。
- **还挡得最多的粒子键**：
  - `particle:children` 32 张（P4e）；
  - `particle:renderer:rope` 22、`ropetrail` 8、`mapsequencearoundcontrolpoint` 8（P4d）；
  - 模块上的 `audioprocessing*` 字段各 4–7 张（P4e）；
  - `particle:binding:instance:rate` 7、`particle:binding:instance:colorn` 5（`{script}`，P4f）。
- **基线**：10 张原本能渲染的场景 × 三档后处理，共 30 组画面哈希，步骤 1–5 每一步都和前一步相同（步骤 1 对 P4b 步骤 6 的记录）。

### dev 探针与对比台的增补

| 探针 | P4c 增补 |
|---|---|
| `particleTrack` | 用全部图层按 `worldMatrixOf` 算每个粒子层的 `W`（静态，不跑脚本），传给预热与每步（步骤 1）；`cursors`（每帧光标下的场景纹理坐标，和 `dts` 等长，回放 WPE 时填轨迹里的 `g_PointerPosition`，抓帧窗口和场景同尺寸时两者相同；第 1 项也用于预热）与 `size`（场景的投影尺寸，给了 `cursors` 时必填；只给 `size` 时跟随点是场景中心，都不给时是 (0, 0)）（步骤 2）；拖尾系统输出速度与 frame（步骤 5） |
| `renderFrame` | `pointer` 同时作 `cursor`，加载时也用它（步骤 2）；先 `stepParticles` 再 `update`（步骤 4） |
| `particleCorners` | `cursor`（缺省场景中心）；每层多给 `drawn`（朝向是 NaN 时为 false，四角照算，同 WPE 的 `gs_out`），`count` 去掉拖尾的退化粒子（步骤 5） |

对比台仍在 `ignore/p4/`：
- `gen_c.py`：生成 P4c 的确定性工程 `p4c-cp`、`p4c-attract`、`p4c-world`、`p4c-trail`、`p4c-sprite`，以及补测的 `p4c-ptr`（步骤 2）、`p4c-rot`（步骤 5）。
- `rdc_track_b.py`：加了指针记录（时钟图层的着色器同时读 `g_PointerPosition`，WPE 当帧用的指针进轨迹）、`gs_out` 四角读取与同系统多次绘制，对 P4b 的工程兼容。
- 读数脚本 `ana_c.py`、`ana_c2.py`、`ana_ptr.py`、`ana_ptr2.py`、`ana_c_render.py`。
- 各步骤的验收在 `c1/`–`c5/`：
  - 每个目录有本步的 `replay.test.ts`、语料 `corpus.test.ts` 与 `corpus_diff.py`、变异检查 `mutate.py` / `mutate_claude.py`，以及以前各步回放的拷贝（`replay-b3/b4/b6/…`），用 HEAD 导出的源码（`head/src`）对工作区逐字节比；
  - 另有：`c1/scan_cp.py`（控制点语料扫描）；`c3/scan_attract.py`、`consts.py`（从 exe 读缺省值与 `FLT_MIN`）、`claude_onestep.py`（单步核对）；`c4/prestudy.test.ts`（帧顺序预研）、`live_*.ts`（应用里的帧循环）；`c5/corners-offline.*`（离线四角）、`live_corners.ts`（真机四角）、`rot_shape.py`、`orient-scan.test.ts`；
  - 收尾和 WPE 比 `3832772446`：`c5/cmp_scene.py`、`wpe_particles.py`、`ours_particles.ts`、`cmp_particles.py`、`alpha_seeds.ts`；覆盖数 `c5/coverage_p4c.py`。
- WPE 参照在 `A:\p4b\p4c-*`、`A:\p4b\3832772446-fps60`，用 `wpe-renderdoc` skill 抓，结束后按字节还原 WPE 的 `config.json`、放回桌面壁纸。新的抓帧用 `wpe-renderdoc` MCP（`.claude/mcps/wpe-renderdoc/`）的 `capture_wallpaper` / `capture_sweep`：WPE 常驻不强杀，改过的设置由 `capture_sweep` 经 `restart_wpe` 改回。

步骤 4、5 与收尾在应用里的验收经 kabegame-dev（`.claude/skills/kabegame-chromium/SKILL.md`）做：
- `projects_import` / `projects_remove` 把确定性工程导入 dev 库、用完移除，并核对没有残留的行与任务；
- `hash_baseline` 跑 10 张干净场景三档的画面哈希；
- `render_scene` 看单张场景的固定时刻画面（不步进粒子）；
- 客户端的 `hostParticleCorners` / `hostRender`（`apps/kabegame-dev-mcp/src/client.ts`）在屏外宿主里按给定 dt 回放后读四角、渲染整帧。
