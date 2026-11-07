> 逆向原始记录，代理写的，地址按 Ghidra。**已被实测修正：** 预热固定一遍，不受 `fps` 分支影响；`obj+0x854` 是 `instanceoverride.rate`，不是 `speed`。结论以 [p4-particles-REPORT.md](p4-particles-REPORT.md) 为准。

# WPE 粒子运行时静态逆向（代理报告原文，2026-11-07）

### 头部

- 目标：`wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致，只分析 scratchpad 副本。
- 方法：REA（Ghidra 12.1.4，从 `wallpaper64-2.8.42-sync.rea-snapshot` 打开）+ `llvm-objdump` 全量反汇编。`FUN_1401c5490` 太大，Ghidra 反编译不了，读汇编。
- 地址基址 `0x140000000`，函数名是 Ghidra 自动名。
- 「已确认」= 读到代码，只说明代码这么写，除标了「与测量一致」的项外都没实测。

对象命名：
- `R` = 渲染器。
- `ctx` = `R + 0x10`（`0x140181b82` 传给场景构造函数，场景存在 `+0xd8`，`0x1401901f3` 取出来传给粒子对象）。
- `session` = 渲染循环的 `r15`（虚表 `0x1404897b8`）。
- `obj` = 粒子对象（虚表 `0x1404915b0`）。
- `sys` = `obj + 0x2c0`，粒子系统本体。

### Q1 积分

`movement` 是 operator 类型 1，入口 `0x14023fdc9`，粒子循环 `0x14023ff30`–`0x14023ffb3`。一遍 operator 的参数是 `(h, k)`，每个粒子：

1. `v' = v + g·h`
2. `x' = x + v'·h`（用更新后的速度）
3. `v'' = v' · (1 − min(drag·k, 0.99999988))`

- `g`：记录里的 `gravity`。若 `movement.flags` bit0 置位且 `sys+0x20` bit0 未置位，先用当前矩阵变换一次（`0x14023fde2`–`0x14023fe2e`；用途推断是把世界方向转进本地空间）。
- 上限常量在 `0x140492700`，字节 `feff7f3f` = 0.99999988，不是 1，所以 drag 再大也保留约 1.19e-7 的速度。
- 粒子没有加速度列。

遍数决定（`FUN_140236cd0` 的 `0x140237720`–`0x140237793`）：

1. `k0 = pow(min(1, 0.025 / ctx.dt), 0.7) · dt'`。`ctx.dt` 是 `ctx+0x14c` = `R+0x15c`，即当帧 `g_Frametime`；常量 `0.025`（`0x140492630`）、`0.7`（`0x1404926c8`）。
2. `fps = ctx+0x148` = `R+0x158`。若 `1 ≤ fps ≤ 20`（`dec eax; cmp eax, 0x13; ja`，无符号，`fps = 0` 不进）：`h = dt'/2, k = k0/2`，先调一遍 `FUN_14023fbc0(sys, h, k)`。
3. 再调一遍 `FUN_14023fbc0(sys, h, k)`（未减半时 `h = dt', k = k0`）。

`fps` 来自 `session+0x18c`：`0x1401114e5` 每帧抄到 `R+0x158`，默认 20（`0x14010dc14`），由 `FUN_1401154c0` 读配置 JSON 的 `"fps"` 键（`0x1401154e4`）。`0.025` / `0.7` 只影响 drag，不决定遍数。

和测量对照：
- 两遍 `Δx = dt·v + 0.75·a·dt²`，一遍 `Δx = dt·v + a·dt²`，正好是 c = 0.75 和 1。
- 用你给的两组 dt 按 float32 回放：`fps=10` 两遍 c = 0.75000，`fps=60` 一遍 c = 1.00000。
- dt 0.061 与 0.064 落在不同 c：两组设置 fps 不同，与 dt 无关，完全符合。
- 测量残差 8.6e-5 / 4.9e-5，回放残差约 2e-6 / 3e-7。差距我归因于 dt 取自 `g_Frametime` 的测量精度，这是**推断**。

两遍模式的连带后果：
- 两遍作用于整个 operator 流，不只 `movement`（已确认）。
- 年龄在两遍之前只更新一次，两遍看到的 `age` 相同（已确认）。
- `FUN_14023fbc0` 开头把当前值重置为初始值（`size ← size0`，有对应列时 `rgb ← rgb0`、`a ← a0`，`0x14023fc08`–`0x14023fcb2`），所以乘性的 `alphafade` 等跑两遍结果不变（已确认）。
- `oscillateposition` 用 `sin(ω·t) − sin(ω·(t−h))` 加到位置（`0x1402404c0` 起）。两遍时 `t` 不变、`h` 减半，等于同一增量加两次，和一遍 `h = dt` 结果不同（路径已读，幅度差异是**推断**，未实测）。
- 现有测量 drag 都是 0，所以 `k0` 没有实测覆盖。

### Q2 dt 上限（全部已确认）

1. 原始帧时间：`FUN_1400604d0` 取 QPC 差（`0x140111310`），上次时间存 `session+0x160`。
2. 第一次钳制：`raw = clamp(raw, 0.0001, 0.25)`（`0x140111355`–`0x14011136b`）。
3. 暂停淡变：`session+0x170`（下称 `pauseRate`，默认 1）向目标（暂停 0、否则 1）靠拢。差 < 0.01 时直接等于目标，否则 `pauseRate += (目标 − pauseRate)·min(1, 6·raw)`（`0x14011137f`–`0x1401113d7`）。
4. 第二次钳制：`speed = session+0x190 · pauseRate`（`session+0x190` 是场景 `rate` 属性，`0x140115296`，默认 1，写到 `R+0x164`）；`dt = clamp(speed·raw, 0.0001, 0.25)`（`0x1401114c3`–`0x14011150f`）。
5. 帧函数 `FUN_14017fa70(R, dt)`：`R+0x160 = 旧 dt`、`R+0x15c = dt`、`R+0x148 += dt`（double）、`R+0x140` 是 float 副本，超过 432000 归零（`0x14017fc9e`–`0x14017fcf6`）。
6. `FUN_1401891a0(scene, dt)` 对每个对象调虚函数 `+0x48`（`0x1401891f9`）。
7. 粒子对象 `FUN_140230650`（虚表槽 `0x1404915f8`）：`dt' = dt · obj+0x854`（粒子 `speed`，`0x1402307ff`）。仅在脏标志 `obj+0x928` 置位时做 `speed = max(0.01, speed)`。
8. `FUN_1402308a0(sys, dt', emit)`，`dt' > 0` 才进 `FUN_140236cd0`。

- 上限 0.25、下限 0.0001 都在渲染循环这一层，常量在 `0x14049268c` / `0x1404925fc`。
- 粒子路径没有再钳 dt，LWE 的 `min(dt, 0.1)` 不存在，符合测量。超过 0.25 的帧测量里没出现过。
- 例外：`starttime` 预热用固定步长，`FUN_14022f430` 在 `maxcount < 500` 时步长 0.05，否则 0.2（`0x14022f44f`）。预热同样受 Q1 的 fps 分支影响。

### Q3 帧内顺序（全部已确认）

对象层 `FUN_140230650`：
1. 可见性判定（`obj+0x120` bit0 + 虚函数）决定 `emit`。不可见时 `emit = 0`；还有存活粒子就清空系统和子系统（`0x14023068e`–`0x1402307b8`）。
2. 脏标志置位时重算 instanceoverride（`FUN_14022bd40`）。
3. 算 `dt'`，取世界矩阵，调 `FUN_1402308a0`。

系统层 `FUN_1402308a0`：
4. `sys+0x3f0 += dt'`，调模拟 `FUN_140236cd0`。
5. 写顶点（`0x140230911` 起，存活数为 0 跳过）：按槽序 `0..高水位`，跳过 `life == 0`。
6. 更新子系统（`0x140236396` 起）。

模拟 `FUN_140236cd0`：
1. 清死亡索引表 `sys+0x420`。
2. 所有槽 `age += dt'`；`life < age && life != 0` 判死：`life = 0`，存活数减一（`0x140236d70` 循环）。
3. `flags & 0x1000000` 且 `animationmode == 0` 时 `frame = age · rcpps(life) · sequencemultiplier`（`0x140237022`）。`rcpps` 是近似倒数。
4. 死粒子从 rope 索引表移除，处理死亡相关子系统（类型 2 / 4）。
5. 更新控制点 `FUN_14022e3e0`。
6. `emit` 时发射 `FUN_1402378a0(sys, dt', 0)`，用完整 `dt'`，不受 Q1 减半影响。
7. operator 一遍或两遍。
8. 控制点 current 抄到 previous（`0x140237798`）。

发射内部（`FUN_1402378a0` → `FUN_14023b340`）：按流顺序遍历 emitter，算本帧数量（`rate·dt + 累积余数`，受容量限制）。每个新粒子：线性扫描第一个 `life == 0` 的槽 → 写位置、速度 → 写默认值 → 按流顺序跑 initializer → 写拖尾初值 → 存活数加一，槽号等于高水位时高水位加一。

和测量对照：
- 测量 3：发射在 operator 之前，新粒子当帧 `age = 0`，紧接着走完整的 operator，所以首帧 `x = origin + v·dt`。两遍模式下两次 `h = dt/2` 相加仍是 `v·dt`。
- 同帧出生位置相同：`sphererandom` 分支里没有按子帧错开出生时间（`boxrandom` / `layerimage` 分支没细读）。
- 判死是严格大于（`age > life`），且出生帧 `age` 不增长。

### Q4 operator / initializer 顺序（已确认）

- 解析：`FUN_1401c5490` 用 JSON 迭代器按序遍历 `operator` 数组（`0x1401cb14a` begin、`0x1401cc44d` 自增、`0x1401cc460` 比较 end），命中名字就在缓冲区尾部追加一条记录（写指针 `[rsp+0x38]`，容量 `0x8000`）。`initializer` 同样（写指针 `[rsp+0x48]`）。
- 定型：`FUN_1401c2e70` 只是 `memcpy` 加结束标记。流存到 `def+0x58`（emitter）、`+0x68`（initializer）、`+0x78`（operator）、`+0x88`（renderer）；`sys` 里偏移加 0x18。
- 执行：operator 解释器 `FUN_14023fbc0` 取 `sys+0x90`，跳转表 `0x14024bb58`，每条结束 `r14 += word[r14+2]`，读到类型 0 结束（`0x140240279`）。initializer 解释器 `FUN_14023b340` 取 `sys+0x80`，跳转表 `0x14023fa78`，同样推进（`0x14023f942`）。
- 看不到按类型重排。`"movement"` 字符串只有一处引用，没有分类型的多遍扫描。
- `jsoncpp` 数组内部保持索引序：库代码没细读，这一点是**推断**。

测量 4 判断不了顺序的原因：`alphafade` 与 `oscillatealpha` 都乘到 `a`，`movement` 与 `oscillateposition` 都往 `x` 上加且后者不读速度，代数上可交换。建议用不可交换的组合验证：
- operator：`movement` + `capvelocity`，后者改速度，先后会改变当帧位移。
- initializer：两个不同值的 `lifetimerandom`，它是绝对写入（`0x14023b631`），后者胜出。

模块类型表：
- emitter：1 sphererandom、2 boxrandom、3 layerimage。
- initializer：1 lifetimerandom、2 sizerandom、3 colorrandom、4 hsvcolorrandom、5 colorlist、6 alpharandom、7 velocityrandom、8 inheritcontrolpointvelocity、9 turbulentvelocityrandom、10 rotationrandom、11 positionoffsetrandom、12 angularvelocityrandom、13 mapsequencearoundcontrolpoint、14 mapsequencebetweencontrolpoints、15 remapinitialvalue、16 inheritinitialvaluefromevent。
- operator：1 movement、2 angularmovement、3 alphafade、4 sizechange、5 colorchange、6 alphachange、7 oscillateposition、8 oscillatealpha、9 oscillatesize、10 controlpointattract、11 maintaindistancetocontrolpoint、12 maintaindistancebetweencontrolpoints、13 reducemovementnearcontrolpoint、14 turbulence、15 vortex、16 vortex_v2、17 boids、18 capvelocity、19 remapvalue、20 inheritvaluefromevent、21 collisionplane、22 collisionsphere、23 collisionbox（跳转表直接指向「下一条」，空操作）、24 collisionbounds、25 collisionquad、26 collisionmodel。
- renderer：1 sprite、2 spritetrail、3 rope、4 ropetrail。

### Q5 每粒子字段（已确认）

没有粒子结构体。`FUN_1401d3780` 一次 `_aligned_malloc(列数 × 4 × n, 16)`，`n` 是 `maxcount` 向上取到 4 的倍数，每列是连续 float32，列指针从 `sys+0x258` 开始共 29 个槽，循环按 4 个一组 SIMD。

列数由 `sys+0x24` 的 5 个位决定：基础 17 列，bit0 +2、bit1 +3、bit2 +3、bit3 +3、bit4 +1。

| 列指针 | 含义 | 存在条件 | 出生默认值 |
|---|---|---|---|
| `+0x258` | age | 基础 | 0 |
| `+0x260` | lifetime；0 表示空槽 | 基础 | 1.0 |
| `+0x268` | frame | 基础 | 0；`randomframe` 时等于 `R` |
| `+0x270` | size 当前值 | 基础 | 每遍 operator 开头从 size0 复制 |
| `+0x278` | size0 | 基础 | 0.5 |
| `+0x280` `+0x288` `+0x290` | 旋转 x y z | `+0x280` 基础；后两列要 bit0，否则三个指针别名到同一列 | 0 |
| `+0x298` `+0x2a0` `+0x2a8` | 角速度 x y z | bit1，否则 NULL | 0 |
| `+0x2b0` `+0x2b8` `+0x2c0` | 位置 x y z | 基础 | 发射器写 |
| `+0x2c8` `+0x2d0` `+0x2d8` | 速度 x y z | 基础 | 发射器写 |
| `+0x2e0` `+0x2e8` `+0x2f0` | 上一步位置 | bit2，否则 NULL | 等于位置；`movement` 开头刷新 |
| `+0x2f8` `+0x300` `+0x308` | 颜色当前值 | bit3，否则别名到初始值列 | 实例颜色 |
| `+0x310` | alpha 当前值 | bit4，否则别名到初始值列 | 实例 alpha |
| `+0x318` `+0x320` `+0x328` | 颜色初始值 | 基础 | `sys+0x3e0..0x3e8` |
| `+0x330` | alpha 初始值 | 基础 | `sys+0x3ec` |
| `+0x338` | 每粒子随机数 `R` | 基础 | `ctx+0x20` 区间随机数（`FUN_1401f87a0`） |

- 没有加速度列。
- 标志位来源：
  - bit0：rotationrandom、angularmovement。
  - bit1：angularvelocityrandom、angularmovement。
  - bit2：controlpointattract（条件：记录 `+0xa0` bit0）、collisionquad。
  - bit3：colorchange、remapvalue。
  - bit4：alphafade、alphachange、oscillatealpha、remapvalue。
- 计数：`sys+0x340` 高水位（解析与模拟里只增不减，循环上界）、`sys+0x344` 存活数、`sys+0x348` 容量、`sys+0x34c` 取整后的 n。
- 死槽不压缩，operator 照常在死槽上跑，写顶点时跳过。**顶点顺序是槽序，不是年龄序**，新粒子填洞。
- 顶点布局与测量一致（`0x1402358db`、`0x140235b3c`）：
  - 44 字节：`x y z, rotx roty rotz, size, r g b a`。
  - 52 字节每粒子 4 顶点：`x y z, u v, rotz, size, rotx roty, r g b a`。
- `sizerandom 40 → 20`：`size0` 默认 0.5，`sizerandom` 乘上去（`0x14023b690`）。

模块私有状态：
- `oscillate*` 没有逐粒子状态，频率、相位、幅度都用 `基础值 + R·范围` 现算（`0x140240f50`、`0x1402404f0`）。**所有模块共用同一列 `R`**，所以同一粒子的频率、相位、幅度彼此相关。
- 另外用到 `R` 的 operator：`oscillatesize`、`turbulence`、`remapvalue`。26 个 operator 碰到的列都在上表内（`cols.py` 按解释器分段统计，分支跳出分段的情况没有逐一排除）。
- operator 记录不拥有堆内存：`FUN_1401c4000` 释放 operator 流时不逐条遍历；只有 emitter 3 和 initializer 5 要逐条释放 vector，那是配置数据。
- 模块级状态在流记录里：operator 只有 collisionplane / sphere / quad 回写记录；emitter 记录存累积余数（`+0x24`）、周期计时（`+0x40`）、连发计数（`+0x3c`）。`FUN_1401c4220` 对 5 条流都 `FUN_1401c2e70` 复制，所以每实例一份。
- 拖尾另有逐粒子环形缓冲：`sys+0x230`（位置）、`+0x238` `+0x240`（u16），长度 `sys+0x248`，只有 trail 渲染器才有，分配位置没追。

对模拟器的含义：定长 float 列 + 按标志开关，不需要模块级可变列。要对齐 WPE，`R` 必须是一列共用。

### Q6 暂停

路径（已确认）：
1. `FUN_140008270` 把 `pause` / `stop` / `play` / `mute` / `unmute` 映射成 `0x3e8`–`0x3ec`（`0x1400083f0` 起），直接跳到发送段，不解析 `-location`、`-monitor`，不带 JSON。经 `WM_COPYDATA` 发给主实例。
2. 主窗口 `FUN_140021e50` 在 `0x1400222da` 分发：`0x3e8` 未暂停时调 `FUN_14006eaf0(mgr, 1)`，给全局 `0x1404e52e4` 置 bit0；`0x3ea`（play）清掉。
3. `FUN_1400739a0` 遍历 `0x1404e5330`（普通壁纸表），对每个实例调虚函数 `+0x28 setPaused(全局 flags & 0x21 或该显示器暂停位)`、`+0x30 setMuted`。
4. 场景实例 `+0x28` 是 `FUN_14010f500`：窗口存活时 `SendMessageTimeoutW(hwnd, 0x40b, paused, 0, 1, 0)`，否则直接写 `session+8`。
5. 窗口过程 `FUN_140115b90` 处理 `0x40b`（`0x140115e6c`）：`session+8 = (wparam == 1)`；**`wparam == 0` 时先调 `FUN_1400604d0` 重置计时器**。

作用范围（已确认）：
- 全局，没有按窗口的 pause。`-location` 对 `-control pause` 无效：发送端不读，接收端也不读 payload。
- `-playInWindow` 不受影响的原因：带 `playinwindow` 时走 `FUN_140070dd0`（`0x140022604`），实例进 `0x1404e6268` 那张 map；普通实例进 `0x1404e5328`。`FUN_1400739a0` 只遍历后者，紧接的 `FUN_14006e0c0` 只管音频捕获。与测量 5 一致。
- `-location` 可用于 `openWallpaper` 等带 payload 的命令，弹窗名写入 `location` 键（`0x1400225af`）。
- `0x140074cc1` 有另一处对弹窗表调 `+0x28`，在 `FUN_1400740d0` 里（调用点 `0x140065b63`、`0x14006a53c`），不在 pause 路径上，`dl` 来源没追。
- `openWallpaper` 会先清掉全局暂停（`0x140022558`–`0x140022571`），在普通实例上做暂停实验时，打开壁纸要排在 pause 之前。
- `-control stop`（`0x3e9`）走 `FUN_14006eb10`，不是单纯暂停，细节没追。

暂停期间（`0x140111310`–`0x1401114be`，已确认）：
1. `paused = flags1b8.bit0 && (session+8 || (session+0x188 > 0 && raw < session+0x188))`。
2. 淡出：`pauseRate` 指数下降，时间常数约 1/6 s。这期间继续渲染和模拟，`g_Time` 和粒子都在减速。
3. `pauseRate` 距 0 小于 0.01 时直接归零，触发 `flags1b8 |= 0x8000000` 和 `FUN_140181960(R, 1)`，之后每轮 `Sleep(250)` 回到消息循环，不调帧函数。`R+0x148`、`g_Frametime`、粒子都不走，计时器仍每轮更新。

恢复后第一帧（代码推导，未实测）：
- `wparam == 0` 时计时器被重置，第一轮 `raw` 极小，钳到至少 0.0001。
- `pauseRate = min(1, 6·raw)`，同样极小。
- `dt = max(0.0001, rate·pauseRate·raw)`，所以**第一帧 dt = 0.0001**。
- 之后每帧 `pauseRate += (1 − pauseRate)·min(1, 6·raw)`，约 0.77 s 后差值小于 0.01，直接变成 1。
- 不会补上暂停时长，也不是 0.25。依赖「消息在同一轮先于 `FUN_1400604d0` 派发」，从循环结构看成立。

两个副作用（代码推导，未实测）：
- `WM_PAINT` 清 `flags1b8.bit0`（`0x140115c15`）但**不重置计时器**。暂停中收到它时 `raw` 约 0.25，`pauseRate` 直接回到 1，这一帧 dt 可达 0.25，之后重新淡出。这是暂停路径上唯一可能出现大 dt 的地方。
- `FUN_1400739a0` 无论状态是否变化都调 `setPaused`，`mute` / `unmute` 也走这里（`0x14006ed7b`）。未暂停时收到 `setPaused(0)` 同样重置计时器，所以 `-control mute` 可能让普通实例下一帧 dt 变小。

`session+0x188 = min(scene+0x3b8, 300)`（`0x140114cf4`）是第二条暂停条件，形状像静态场景只在 `WM_PAINT` 时重绘，`scene+0x3b8` 的来源**未知**。

### 和测量的对照

| 测量 | 代码解释 | 状态 |
|---|---|---|
| 1 `linear` 走满 dt | 粒子路径无钳制，帧层上限 0.25 | 一致 |
| 2 c = 0.75 / 1.0 | fps ∈ [1,20] 两遍，否则一遍 | 一致，回放确认 |
| 2 dt 0.061 与 0.064 不同 c | 由设置 fps 决定 | 一致 |
| 3 新粒子首帧 `origin + v·dt`，同帧同位置 | 发射在 operator 前，无子帧错开 | 一致 |
| 4 两种 JSON 顺序逐位相同 | 两对代数可交换，流保持 JSON 顺序 | 不矛盾，判断不了顺序 |
| 5 `-playInWindow` 暂停时帧连续 | 弹窗实例不在暂停遍历的表里 | 一致 |
| 6 顶点布局 44 / 52，`sizerandom 40 → 20` | 见 Q5 | 一致 |

### 未解决 / 没查

- fps 边界没实测：代码说 20 两遍、21 一遍、0 一遍。
- drag 没实测：`k0` 公式只读到代码，建议在 fps=10 和 fps=60 各测一次 drag ≠ 0。
- 两遍下 `oscillateposition` 的幅度差异没实测。
- `FUN_14041e350` 是 powf：**推断**，依据是双参数、带 FMA 分派，且 initializer 用它算 `pow(rand, exponent)`（`0x14023b611`）。
- `session+0x188` 的完整语义、拖尾缓冲分配位置、`FUN_1400740d0` 里的 `dl`：未追。
- `0x140241080` 那段带 `[r14+0x70]` 区间衰减的 `oscillatealpha` 循环，`wp.asm` 里找不到直接跳转来源，入口未确认，模块公式留给后续章节。
- rope 路径 `0x1402309f8` 也读 `fps`，没展开。
