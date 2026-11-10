> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`；`mediaextensions64.dll` 基址 `0x180000000`），全部没有实测。P6a 步骤 0c 实测核对后以报告为准。

# WPE 2.8.42 声音对象静态逆向（加载、播放模式、时机、暂停、音量、解码输出、`ISoundLayer`、三维声音）

**概括**
1. **加载：** JSON 里有非 null 的 `sound` 键就建声音对象（`FUN_14018ff60` 的 `0x140190554` 分支）。描述符表 `FUN_1401f7090` 只有 `volume`（缺省 1）、`mintime`（1）、`maxtime`（5）、`attenuation`（1）、`mindistance`（1）、`playbackmode`（`loop` / `random` / `single`，缺省 `loop`）、`muteineditor`、`startsilent`、`spatialization`（三个布尔，缺省假）。`volume` 加载时不钳制。声音文件**不在加载时读**，第一次「开始播放」时才读；读不到的文件从列表里删掉，不报错。`muteineditor` 在播放器里没有读取点，`solid` / `origin` / `parent` 只在开了 `spatialization` 时有用。
2. **播放模式：** 三种模式都**随机选文件**（CRT `rand()`，可以连续选到同一个）。`loop` 单文件：循环播放。`loop` 多文件：放一遍，到时长后换一个随机文件，中间不留空。`single`：随机选一个放一遍，之后不再自动重放。`random`：随机选一个放一遍，从开始算起等「时长 + U(mintime, maxtime)」秒再选下一个，U 是均匀分布，单位秒，随机数取自场景共用的 mt19937。
3. **时机：** 在对象的加载虚函数 +0x40（`FUN_1401f4f20`）里，`startsilent` 为假就当场同步读文件并开始播放。所以声音按对象顺序在场景加载时依次启动，没有同步机制，可能早于第一帧【推】。`startsilent` 为真时什么都不读，等脚本 `play()`。
4. **暂停与可见：** WPE 暂停（以及静音）走全局音量：每帧把全局音量淡到 0，到 0 时暂停各声音，恢复时从原处接着放。淡变按指数，k = min(1, 6·dt)，差小于 0.01 时直接取目标值。`single` / `random` 在全局音量为 0 时若已放完，会被停掉。声音对象的更新不看 `visible`，构造函数还把对象的可见位清掉了，所以父层或自身隐藏都不影响声音【推】。场景卸载时析构释放全部实例；消息 `0x469` 会把所有声音卸掉，并记住哪些正在放，之后重新加载并从头放【推：用于音频设备切换】。
5. **音量：** OpenAL 源增益 = `volume² × 全局音量`，**对象音量取平方**。全局音量 = 设置里的 `volume / 100` × 暂停 / 静音淡变系数。OpenAL Soft 把源增益钳到 `AL_MAX_GAIN`（缺省 1），所以 `volume` 2.0 只在全局音量小于 0.25 时比 1.0 响【推：钳制行为来自 OpenAL Soft】。属性或脚本改 `volume` 立即生效，没有渐变。
6. **解码与输出：** 不走 Media Foundation（exe 里的 MF 给视频用）。`mediaextensions64.dll` 静态链了 SFML Audio 2.6（`sf::Music`，读取器只有 WAV、OGG Vorbis、FLAC、MP3（minimp3））和 OpenAL Soft 1.21.1（WASAPI 后端）。整个文件读进内存，`sf::Music` 从内存流式解码。重采样和混音由 OpenAL Soft 完成。
7. **`ISoundLayer`：** `play` 是完整的「开始」：暂停中就续播；否则停掉当前文件、重新随机选、从头放（`random` 在等待计时没归零时什么都不做）。`stop` 停止并回到开头。`pause` 暂停。`isPlaying`：`single` 看剩余时长，`random` 看等待计时，其余看「有实例的状态不是 stopped 且没被脚本暂停」。实例状态是包装层自己记的，自然放完不会变。`volume` 写入不钳制，立即生效。
8. **三维声音：** 只有 `spatialization: true` 才生效：对象世界位置减 `g_EyePosition`，投到相机的右 / 上 / 前轴，作为 OpenAL 源位置；`attenuation` → `AL_ROLLOFF_FACTOR`，`mindistance` → `AL_REFERENCE_DISTANCE`，距离模型是 OpenAL 缺省值。OpenAL 只对单声道源做空间化。**语料 161 个声音对象里没有一个打开 `spatialization`**（唯一写了这个键的 `3832133196` 写的是 `false`），所以 `attenuation` / `mindistance` 在语料里全部不起作用，步骤 3 可以不做。

**元数据**
- 目标：
  - `D:\Applications\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe`（2.8.42）。开工时只读核对 SHA-256 前缀 `40e2ce021e935232`，一致（全值 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`）。
  - 另看了 `bin\mediaextensions64.dll`，SHA-256 `898ffaa06ac56f46b7ac7e182fc0b6c750fc585f8554606713e0468977e0dbc3`，声音引擎实际在这里。
  - `bin\scenescript64.dll` 拷了副本（SHA-256 `58039ef9…`），**没有分析**。`ISoundLayer` 的成员由 exe 的方法表 `DAT_1404e85a0` 反射提供（p3-script-REPORT C 节「图层与对象成员由 wallpaper64 反射提供」），JS 侧声明取自 WPE 自带的 `ui/dist/monaco/autocomplete/lib.sceneScript.d.ts:1509`。
- 没运行、没附加 WPE，没写 Steam / WPE 目录。
- 方法：
  - 反编译：REA（Ghidra 12.1.4）打开 exe 副本，用的是 `p4b-mod` 快照副本；之后打开 dll 副本。
  - 汇编：exe 按地址切 `ignore/p4/rea/wp.asm`，dll 用 `llvm-objdump` 现反。
  - 常量和字符串：用脚本直接读副本。
  - 语料：读 `ignore/p6/out/objects-new.json`（P6 0a 的扫描结果）；样本 `3832133196` 的 `scene.json` 用 kbp-tools 读过一次。
- 工作文件 `ignore/p6/rea/sound/`：
  - 副本：`wallpaper64.exe`、`mediaextensions64.dll`、`scenescript64.dll`。
  - 汇编摘录：
    - `ctor_140190554.asm`：构造与缺省值；
    - `script_desc_1401f6e60.asm`：脚本方法与描述符表；
    - `volcb_1401f4c20.asm`：音量回调；
    - `dtor_init_update_1401f4e00.asm`：析构、加载虚函数、每帧更新；
    - `spatial_play_1401f5460.asm`：三维与开始播放；
    - `globalvol_1401816d0.asm`：全局音量；
    - `fade_140111300.asm`：暂停与静音淡变；
    - `msg469_140116176.asm`：卸载与重载消息；
    - `dll/iface_180003484.asm`：dll 接口。
  - 反编译：`f_1401f5980.c`（开始播放），`dll/dec/*.c`（dll 接口槽）。
  - 脚本：`strs.py` / `wstrs.py` / `strs_mx.py`（字符串）、`rd.py`（常量）、`imports.py` / `exports.py`、`xr.py` / `grepfn.py` / `slice.py` / `fn.py`（`wp.asm` 交叉引用与切片）、`vtscan.py` / `vtdump.py`（虚表）、`ext.py` / `extb.py`（抽 REA 结果）、`scan_spatial.py`（语料键统计）。
  - 没做标注。快照副本用完已删。
- 标记：【确】反编译或汇编直接看到；【推】由代码推出，或依赖 SFML / OpenAL Soft 的上游行为，没有逐行确认；【确，有界】在注明范围内搜过，范围外没排除。

**命名**
- `S`：声音对象（0x320 字节，虚表 `0x140490ae8`，类型号 7，虚函数 +0x60 = `FUN_1401f4c10` 返回 7）。
- `ctx = *(S+0xc8)`：渲染上下文（`R+0x10`，同 rea-p5-mesh）。用到的字段：
  - `ctx+0x158`：音频引擎接口；
  - `ctx+0x2d8`：全局音量 `G`（`R+0x2e8`，缺省 1）；
  - `ctx+0x2dc`：实例号（构造时从全局计数器原子取，`0x14017d55a`）；
  - `ctx+0x154`：场景 `rate`（`R+0x164`，rea-framework Q2）；
  - `ctx+0x1898`：资源文件系统；
  - `ctx+0x1cd0`：mt19937；`ctx+0x20 / +0x24`：均匀分布的上下界 0 / 1【推：构造时 `0x14017c704` 写 0 和 1.0，没核对基址】；
  - `ctx+0x68`：`g_EyePosition`；`ctx+0x160 / +0x16c / +0x178`：`g_ViewForward / Right / Up`。
- `S` 的字段（缺省值见构造 `0x1401905d0`–`0x140190645`）【确】：

| 偏移 | 含义 | 缺省 |
|---|---|---|
| `+0x1b0` | 对象 JSON（`sound` 从这里读） | — |
| `+0x2c0..+0x2d0` | 条目向量，每项 0x38：文件名串、`+0x20` 数据缓冲、`+0x28` 播放实例、`+0x30` 时长（秒，float） | 空 |
| `+0x2f0` | `volume` | 1 |
| `+0x2f4` / `+0x2f8` | `mintime` / `maxtime` | 1 / 5 |
| `+0x2fc` | 等待计时 `T`（到 0 时再开始一次） | 0 |
| `+0x300` | 剩余时长 `Rm` | 0 |
| `+0x304` / `+0x308` | `attenuation` / `mindistance` | 1 / 1 |
| `+0x30c` | `playbackmode`：0 loop、1 random、2 single（枚举表 `0x1404e9760`，`0x1401f7aa5` 起） | 0 |
| `+0x310` | 标志 `F`，初值 `0x88000000` | 见下 |

- `F` 的位【确】：
  - bit0 `muteineditor`（`FUN_1401e1a90`，置 / 清 `0x1`）；
  - bit1 `startsilent`（`FUN_14019b4e0`，`0x2`），兼作「还没自动开始过」；
  - bit2 `spatialization`（`FUN_14019bfa0`，`0x4`）；
  - bit27：初值置位，`pause` / `stop` 清掉，没找到读取点【确，有界：`0x140000000`–`0x140430000` 搜 `0x310]` 的立即数测试】；
  - bit28：卸载前是否在放；bit29：已卸载（消息 `0x469`）；
  - bit30：被脚本暂停；bit31：已停止。
- 引擎接口（exe 调 `ctx+0x158` 的槽 → dll 接口虚表 `0x1802dcc70` 的槽，偏移恒差 0x60）【推：映射按语义对上，`+0xe0` / `+0xe8` / `+0xd0` / `+0xb8` 四处参数与 dll 实现逐一吻合，没找到 exe 侧的转发虚表】：

| exe 槽 | dll 槽 / 实现 | 语义 |
|---|---|---|
| `+0x78` | `0x18` `0x1800034a0` | 按键取 / 建数据缓冲（键 = `"<ctx+0x2dc>/<文件名>"`）【推：缓存】 |
| `+0x80` / `+0x90` | `0x20` / `0x30` `0x180003dd8` | 释放缓冲 / 销毁实例（状态不为 0 先停） |
| `+0x88` | `0x28` `0x180003cd0` | 建实例：`new sf::Music` + 从内存打开，时长 = `getDuration().asSeconds()` 存实例 `+0x8`，状态 `+0xc` = 0 |
| `+0x98` | `0x38` `0x180003e60` | 取时长 |
| `+0xa0` / `+0xa8` / `+0xb0` | `0x40` / `0x48` / `0x50` | 状态 == 2 / == 1 / == 0（播放 / 暂停 / 停止）。**只读包装层自己记的状态，不查 SFML** |
| `+0xb8` | `0x58` `0x180003e80` | `setLoop(arg)`（`FUN_18000db10` 写 `+0x48`）+ `play()`，状态 = 2 |
| `+0xc0` / `+0xc8` | `0x60` / `0x68` | `pause()` 状态 = 1 / `stop()` 状态 = 0 |
| `+0xd0` | `0x70` `0x180003fdc` | `setVolume(v·100)` → `alSourcef(AL_GAIN, v·100·0.01)`（`0x18000e5d0`） |
| `+0xe0` / `+0xe8` | `0x80` / `0x88` | `alSourcef(AL_ROLLOFF_FACTOR 0x1021)` / `alSourcef(AL_REFERENCE_DISTANCE 0x1020)`（`0x18000e520` / `0x18000e530`） |
| `+0xf8` | `0x98` `0x18000422c` | 对 n 个实例设同一个 `AL_POSITION`（`0x18000e580`） |

- 函数：`P` = 开始播放 `FUN_1401f5980`；`U` = 每帧更新 `FUN_1401f4f50`（虚函数 +0x48）；`V` = 音量回调 `FUN_1401f4c20`；`X` = 停掉全部 `FUN_1401f58e0`（清 bit30、置 bit31、`T` = 0，对状态不为 0 的实例 `stop`）。

---

## 1. 加载

### 1.1 谁是声音对象【确】
- 场景对象工厂 `FUN_14018ff60` 在 `0x140190554` 查 `sound` 键，值不为 null 就 `new` 0x320 字节，调基类构造 `FUN_1401ddbb0`，再挂虚表 `0x140490ae8`。值是空字符串或空数组也算声音对象，只是没有文件。
- 构造清掉 `+0x120` 的 bit0（`0x1401905fa`，`and word ptr [rdi+0x120], 0xfffe`）【确】。rea-p5-camera 里相机图层用这一位判可见，所以这是可见位【推】。

### 1.2 键表与缺省值【确】
描述符表 `DAT_1404e8560`，由 `FUN_1401f7090` 登记：

| 键 | 偏移 | 类型 / 解析函数 | 缺省 | 备注 |
|---|---|---|---|---|
| `volume` | `+0x2f0` | float `FUN_1401a4b00` | 1 | 改值回调 `V`（描述符 `+0x58`）；数字或 `{user, value}`；**不钳制**（`0x1401a4b2b` 直接写） |
| `mintime` | `+0x2f4` | float | 1 | 没有回调 |
| `maxtime` | `+0x2f8` | float | 5 | 没有回调 |
| `attenuation` | `+0x304` | float | 1 | 只在开了 `spatialization` 时用（第 8 节） |
| `mindistance` | `+0x308` | float | 1 | 同上 |
| `playbackmode` | `+0x30c` | 枚举 `FUN_1401f7d00` | `loop` | 没有回调，运行时改了不重排 |
| `muteineditor` | `F` bit0 | bool `FUN_1401e1a90` | 假 | 播放器里没有读取点【确，有界】→ 中性 |
| `startsilent` | `F` bit1 | bool `FUN_14019b4e0` | 假 | 没有回调，运行时改了不生效【推】 |
| `spatialization` | `F` bit2 | bool `FUN_14019bfa0` | 假 | 见第 8 节 |

- 布尔解析器只认 JSON 布尔（类型 5）或 `{value: 布尔}`（`0x1401e1a9d`、`0x1401e1aec`）【确】。
- `sound` 不在描述符表里：`P` 从 `S+0x1b0` 的 JSON 读，可以是字符串（类型 4）或数组（类型 6）（`0x1401f5a22` 起）【确】。
- `solid` 是基类描述符的键（`FUN_1401e0530`），声音代码里没用【确，有界：声音函数 `0x1401f4c10`–`0x1401f7b9a`】。
- `origin`、`parent`、`angles`、`scale` 只经世界矩阵（虚函数 +0x80）进三维声音（第 8 节）【确】。

### 1.3 文件读取（在 `P` 里，惰性）【确】
- 只在条目向量为空时读，所以第一次 `P` 才读（`0x1401f5a00`）。
- 每个文件：
  1. 键 = 十进制的 `ctx+0x2dc` + `/` + 文件名（`f_1401f5980.c` 第 470–515 行）。
  2. 先用 `引擎+0x78(键, 0, 0)` 取已有缓冲。
  3. 没有就经资源文件系统 `ctx+0x1898` 按文件名打开（`+8`），取大小（`+0x18`），**整个读进内存**（`+0x10`），关闭（`+0x20`），再 `引擎+0x78(键, 数据, 大小)` 建缓冲。
- 有缓冲就建实例（`+0x88`）、记时长（`+0x98`）。
- 任何一步失败：释放缓冲（`+0x80`），把这个文件**从列表里删掉**，接着处理下一个（`0x1401f6640` 之后的搬移循环）。没看到写日志【推：没专门搜日志调用】。
- 全部失败时列表为空：`P` 的各模式分支都要求列表非空，所以什么都不放，`isPlaying` 为假。
- 文件名经资源文件系统解析：先散文件，再 `scene.pkg`，再 `assets`【推：沿用其它资源的查找顺序，没在这里逐行核对】。同一实例号下键相同，所以同一场景里两个对象引用同一个文件时，可能共用数据缓冲，各自有实例【推】。

---

## 2. 播放模式

### 2.1 `P`（`FUN_1401f5980`）的流程【确】
1. 若 `volume² · G ≤ 0` 或 bit29：清 bit31、bit30、bit1，返回（`0x1401f59a0`–`0x1401f59d0`、`0x1401f6d6f`）。
2. 条目为空就读文件（1.3）。
3. bit2：做一次三维更新，并设 `attenuation` / `mindistance`（`FUN_1401f5460(S, 1)`）。
4. `loopFlag = (n < 2 且 mode == loop)`。
5. bit30（被暂停）：清 bit30，找**第一个**状态为 1（暂停）的实例，`play(loopFlag)` 续播，返回（`0x1401f6953` 之后）。
6. 否则按模式（下面的「随机选文件」见 2.2）：
   - **loop**：`X`，随机选文件，设音量 `volume²·G`，`play(loopFlag)`。n > 1 时 `T` = 该文件时长，否则 `T` = 0（`0x1401f6c6b`–`0x1401f6d54`）。
   - **random**：只在 `T == 0` 时动作：`X`，随机选，设音量，`play(不循环)`，`Rm` = 时长，`T = u·(maxtime − mintime) + mintime + 时长`，u ∈ [0, 1)（`FUN_1401f4bc0`，`0x1401f6b3c`–`0x1401f6c4c`）。`T ≠ 0` 时什么都不做。
   - **single**：`X`，`T` = 0，随机选，设音量，`play(不循环)`，`Rm` = 时长（`0x1401f6a2a`–`0x1401f6b05`）。
7. 清 bit31、bit1（`& 0x7ffffffd`）。

### 2.2 随机选文件【确】
- 下标 = `min(int(rand() / 32767.0 · n), n − 1)`，再钳到 ≥ 0。`rand()` 是 CRT 的 LCG：`x = x·0x343fd + 0x269ec3`，取 `(x >> 16) & 0x7fff`（`FUN_1402c97a0`）。
- 三种模式都这样选，**单文件以外都可能连续选到同一个**，没有去重。末一个文件只多出 `rand() == 32767` 这一个值的概率。
- `random` 的等待用另一个随机源：`FUN_1401f4bc0` 取 `ctx+0x1cd0` 的 mt19937（`FUN_14007f5b0`，常量 `0x9908b0df`、624）的 32 位输出，右移 8 位、乘 2⁻²⁴，再映射到 `[ctx+0x20, ctx+0x24)`。这个引擎和粒子发射共用（`FUN_1402378a0` 也调 `FUN_1401f4bc0`），所以和粒子的随机序列交织【确：同一函数同一 `ctx`】。

### 2.3 每帧更新 `U`（`FUN_1401f4f50`）【确】
- bit30 或 bit31 置位时整个跳过：计时不走，三维也不更新（`0x1401f4f61`–`0x1401f4f7e`）。
- `dt' = dt / rate`（`ctx+0x154`，大于 1.19e-7 才除，否则 0）。传进来的 `dt` 已经乘过 `rate · pauseRate`（rea-framework Q2），所以 `dt'` = 被钳到 [0.0001, 0.25] 的原始帧时间 × `pauseRate`【推：`rate` 很小时钳制会让两者不严格相等】。场景 `rate` 不影响声音的计时。
- 若 `volume²·G > 0` 且 `T > 0`：`T −= dt'`，`T ≤ 0` 时 `T` = 0 并调 `P`（`0x1401f4fad`–`0x1401f4ff1`）。
- 若 `G > 0` 且 `Rm > 0`：`Rm −= dt'`（`0x1401f4ffc`–`0x1401f5021`）。
- bit2：三维位置更新（第 8 节）。

### 2.4 各模式的结果
- **loop 单文件：** `sf::Music` 循环【确】。循环有没有缝取决于 SFML 的流式实现：它在流线程里 seek 回开头接着填缓冲，WAV / FLAC / OGG 应该无缝，MP3 有编码器延迟，可能带出一小段静音【推】。
- **loop 多文件：** 每个文件不循环地放一遍，`T` = 时长到 0 时 `P` 停掉旧的、再随机选一个。等于带放回的随机连播，中间不留空，切换落在帧边界上（晚 0–1 帧）【确：代码；时间量化是推论】。
- **single 放完：** 不再自动重放（`T` = 0）。实例的包装状态仍是 2（第 7 节），`Rm` 递减到 0 后 `isPlaying` 才变假。
- **random：** 「等放完之后再等 U(mintime, maxtime) 秒」，计时从开始播放算起，单位秒，均匀分布【确】。语料 `mintime` / `maxtime` = 1 / 1 时间隔就是固定 1 秒。`T` 只在 `volume²·G > 0` 时走，所以音量为 0 时等待也冻结。

---

## 3. 时机

- 加载虚函数 +0x40 = `FUN_1401f4f20`：先调基类 `FUN_1401de470` 应用属性，`F` 的 bit1（`startsilent`）为 0 就 `P`（`0x1401f4f29`–`0x1401f4f3f`）【确】。
- rea-p5-modelflags 已核实 +0x40 是「属性解析 / 资源加载」阶段，在构造之后【确：调用顺序】。`P` 在这里同步读文件、建 `sf::Music`、`play()`，SFML 随即起流线程出声。所以：
  - **不等第一帧**，加载期间就开始放，可能早于画面出现【推：没核对第一帧之前还有多少加载工作】；
  - 同一场景的多个声音按对象处理顺序依次启动，每个都要先同步读完整个文件，**没有同步机制**，先后差的是读文件和建解码器的时间【推】。
- `startsilent` 为真：`P` 不被调，条目不读，`isPlaying` 为假，直到脚本 `play()`（第一次 `play()` 才读文件）【确】。另外，因为初值 bit31 置位，`U` 在第一次 `P` 之前直接跳过【确】。
- 加载时 `volume²·G ≤ 0`（对象音量为 0，或 WPE 全局音量为 0）：`P` 早退，什么都不读，同时清掉 bit31 / bit1。之后对象音量或全局音量变成正数时，`V` 或全局音量设置会再调 `P`，这时才读文件并从头放（第 5 节）【确】。

---

## 4. 暂停与可见

### 4.1 WPE 暂停 / 静音【确：代码；触发条件是推】
- 渲染循环（`FUN_140111085` 段）每帧算两个淡变量：
  - `pauseRate`（`session+0x170`）：rea-framework Q2 已记，暂停时目标 0、否则 1；
  - 音量系数 `session+0x174`：目标 = `pauseRate 的目标 × (静音 ? 0 : 1)`。静音条件是 `session+0x9`（消息 `0x40c` 置）或 `session+0x1b8` 的 bit6（`0x1401113e0`–`0x1401113f5`）。
- 淡变：`cur += (目标 − cur) · min(1, 6·raw)`，差小于 0.01 时直接取目标，没变就不调（`0x14011141e`–`0x140111434`）。之后 `G = cur × session+0x178`（设置里的 `volume / 100`）→ `R.setGlobalVolume`（`FUN_1401816d0`，`0x14011144d`）。
- `FUN_1401816d0`：值变了才写 `R+0x2e8`，然后对场景对象列表里类型 7 的每个对象执行与 `V` 相同的逻辑（`0x140181740`–`0x1401818f2`，见 5.2）：
  - `G` 降到 0：对状态为播放的实例 `pause`；`single` / `random` 若 `Rm ≤ 0`（已放完），再 `stop`。
  - `G` 回到正数：对未被脚本暂停、状态为暂停的第一个实例 `play(mode == loop)` 续播，**从原处接着放**。
- 暂停期间 `T`、`Rm` 都冻结：`T` 要求 `volume²·G > 0`，`Rm` 要求 `G > 0`。
- 淡出过程中声音逐渐变小，不是瞬间切断。
- 疑点【推】：WPE 真正暂停时渲染循环可能不再跑，淡变也就停了；淡变是在进入暂停之前做完，还是暂停期间降低频率继续跑，没核对。

### 4.2 「其它程序出声时」选项【确：解析；作用是推】
- `config.json` 的 `playbackaudio` 由 `FUN_140141880` 解析：`mute` = 1、`pause` = 2、`pauseall` = 3、`stop` = 4、其它值（包括 `run`）= 0，结果存全局 `0x1404e53d4`（`0x14006c5a2`）。
- 它最终应当落到会话的暂停（消息 `0x40b`，`session+0x8`）或静音（消息 `0x40c`，`session+0x9`），再经 4.1 影响声音【推：没跟到监测线程】。
- `stop` 档可能是卸载壁纸，没查。
- Kabegame 的宿主自己管暂停和音量，这一档不用复刻。

### 4.3 可见性【确，有界】
- `U`、`P`、`V`、脚本方法都不读可见位；场景每帧对全部对象调 +0x48，不判可见（rea-p5-camera 已记，`0x1401891f0`）。所以 `visible: false` 或父层隐藏都**不停**声音。
- 声音对象的可见位在构造时就被清掉（1.1）。

### 4.4 卸载、重载【确】
- **析构** `0x1401f4e00`：对每个条目 `引擎+0x90`（销毁实例，状态不为 0 先 `stop`），再 `+0x80`（释放缓冲）。换壁纸、关场景都走这里，声音立即停。
- **消息 `0x469`**（会话虚表 `0x140489738` 槽 `0xd8` = `0x14010fbe0`，用 `SendMessageTimeout` 发，窗口过程 `FUN_140115b90`，`0x1401161c0` 起）：
  - wParam 1：对每个声音对象，bit28 = 当前 `isPlaying`，置 bit29，销毁全部实例并释放缓冲、清空条目。
  - 其它 wParam：清 bit28 / 29；原来在放的再调 `P`（重新读文件，重新随机选，从头放）。
  - 推测对应设置 `reloadaudio`（音频设备变化时重载，`0x14006cb9e` 读这个键）和「音频驱动崩溃」提示（`0x1404730e0`）【推】。
- **属性重载**：用户属性改了只走各键的回调，只有 `volume` 有回调，场景不会重启声音【确】。

---

## 5. 音量

### 5.1 公式【确】
- 每次设音量都传 `S.volume² × G`：`0x14018180d` 是 `mulss xmm2, xmm2`，再 `mulss [ctx+0x2d8]`；`P`、`V` 同样。dll 侧乘 100 进 `sf::Music::setVolume`，SFML 再乘 0.01 写 `AL_GAIN`（`0x18000e5d0`）。
- **对象音量是平方关系**：`volume` 0.5 对应增益 0.25（−12 dB）。
- `G` 的组成：
  - `session+0x178` = 设置 JSON 里 `volume` 的值 / 100：消息 `0x466` → `FUN_140115280`，键 `volume`，数字或 `{value}`，`0x14011533f`；同一 JSON 还有 `rate`（`/100`，下限 0.1）和 `audioprocessing`。用户的 `config.json` 里有 `"volume" : 24`【推：就是这个全局滑块；`config.json` 到消息 `0x466` 的链路没跟】。
  - `session+0x174` = 暂停 / 静音淡变系数（4.1）。
- OpenAL 侧：dll 里没有设 `AL_MAX_GAIN`（`0x100e`）或 `AL_GAIN_LIMIT`。监听器增益是 SFML 缺省的 100%（`0x18000f02d`）【确，有界：dll 低段 `0x180001000`–`0x180160000`】。
- OpenAL Soft 1.21 计算源参数时把 `AL_GAIN` 钳到 `[AL_MIN_GAIN, AL_MAX_GAIN]` = [0, 1]，所以实际是 `min(1, volume²·G)`【推：OpenAL Soft 源码行为，二进制里没核对】。
- `volume` 2.0（`3173418061`、`3605722997`）：等于 4·G 再钳到 1。WPE 音量 ≥ 25 时与 1.0 一样响，低于 25 时才更响。

### 5.2 运行时改 `volume`（用户属性、脚本写 `thisLayer.volume`）：回调 `V`【确】
1. 模式不是 `single` 时：
   - 若模式不是 `random`，或 `T > 0`：只要有实例状态不为 0，就不再触发开始（被脚本暂停时也一样）。
   - 否则，若 bit30、bit1、bit31 都没置位，调 `P`（从头开始）。
   - 例：对象音量从 0 改成正数，且之前没放过、不是 `startsilent`，这时才开始。
2. 对每个实例：`setVolume(volume²·G)`，立即生效，**没有渐变**。若 `G > 0`、未被脚本暂停且实例处于暂停：`play(mode == loop)` 续播，然后返回（后面的实例不再设音量。一次只有一个实例在放，影响不大）。若 `G ≤ 0`：暂停在放的；`single` / `random` 已放完的再 `stop`。
- 对象 `volume` 改成 0 时，`V` 只把增益设成 0，**不暂停**（`G` 仍大于 0）。`T` 冻结（`U` 要求 `volume²·G > 0`），`Rm` 照走。

---

## 6. 解码与输出

- **不是 Media Foundation**【确】。
  - exe 导入 `MFCreateSourceReaderFromURL` / `FromByteStream`，延迟导入 `MFStartup` 等，引用点 `0x1400f1fa0`、`0x1400f2952`、`0x140120050` 都在视频 / 媒体墙纸的类里（虚表 `0x140489d68`、`0x140489fe0`），和声音对象无关。
  - 声音对象的引擎调用全部落到 `mediaextensions64.dll`（导出 `CreateMediaExtensions`，接口虚表 `0x1802dcc70`）。
- **dll 里的库**【确：字符串与 RTTI】：
  - SFML Audio，有 `sf::Music`、`sf::SoundStream`，读取器 `SoundFileReaderWav` / `Ogg` / `Flac` / `Mp3`。`Mp3` 读取器和 `LoopPoints` 文案说明是 2.6。
  - OpenAL Soft `1.21.1`（`0x1402b4258`），后端有 `WasapiBackendFactory`、`NullBackendFactory`、`LoopbackBackendFactory`。
  - 另有 libFLAC、libvorbis。
- **支持格式：** WAV、OGG Vorbis、FLAC、MP3【确：读取器清单】。没有 Opus、AAC / M4A。语料里的 mp3 / flac / wav / ogg 都在内。
- **解码方式：** 文件整个读进内存（1.3），每个实例是一个 `sf::Music`，从内存流式解码（`0x180003cd0`：`new` 0xe0 字节、`FUN_18000a070(数据, 大小)`、`getDuration`）【确：调用；`FUN_18000a070` 等于 `openFromMemory` 是推】。
  - 返回值 2 时建一个没有 `Music` 的实例，时长 0，`play` 什么都不做。返回 0 是成功，其它值是失败【确】。2 的含义没查。
- **输出：** OpenAL Soft → WASAPI 共享模式【推：后端默认选择】。重采样到设备采样率由 OpenAL Soft 做，缺省重采样器没查。声道按文件原样：单声道源会做空间化（没开 `spatialization` 时源位置是 (0, 0, 0)，与监听器重合，等于居中），立体声和多声道源不做空间化。

---

## 7. 脚本 API（`ISoundLayer`）

- **登记：** `FUN_1401f7090` 末尾向方法表 `DAT_1404e85a0` 登记 4 个方法：`play` = `0x1401f6e50`（直接 `jmp P`）、`stop` = `0x1401f6e60`、`pause` = `0x1401f6f00`、`isPlaying` = `0x1401f6fb0`（返回类型 2 = 布尔）。`volume` 是描述符字段，可读写。JS 声明见 `lib.sceneScript.d.ts:1509`：「Play or resume playing」「Stop all sounds」「Pause all sounds」「Check if we're playing any sound」【确】。
- **`play()` = `P`**【确】：
  - 被暂停（bit30）：续播第一个暂停的实例，从原处接着放，同一个文件。
  - 否则 `loop` / `single`：先 `X` 停掉，**重新随机选**文件，从头放。正在放时调 `play()` 也会这样重来。
  - `random`：只在 `T == 0` 时开始，`T > 0`（在放或在等）时什么都不做。
  - `volume²·G ≤ 0` 时什么都不做，只清 bit31 / bit30 / bit1。
- **`stop()`**【确】：清 bit31 / 30 / 27，再置 bit31；`T` = 0；对状态不为 0 的实例 `stop`（SFML 停止会回到开头）。`Rm` **不清零**。之后 `play()` 走 `P`，从头放、重新选文件。
- **`pause()`**【确】：清 bit27；没被暂停、也没停止时，置 bit30，并对状态为 2 的实例 `pause`。已停止时什么都不做。
- **`isPlaying`**（`0x1401f6fb0`，与原生 `0x1401f6da0` 同逻辑）【确】：
  - `single`：`Rm ≤ 0` → 假；
  - `random`：`T ≤ 0` → 假；
  - 否则：存在状态不为 0 的实例且没有 bit30 → 真，其余为假。
- **由此得到的值**【推：由上面的逻辑和「包装状态在自然放完时不变」推出】：
  - `startsilent` 且从未 `play()`：条目为空 → 假。
  - `loop`：放着为真；`pause` / `stop` 后为假；对象音量为 0 但已在放时仍为真。
  - `single`：放的时长内为真，`Rm` 走到 0 后为假；`stop()` 后为假（状态 0）。
  - `random`：**整个周期都为真，包括两段之间的等待**（`T > 0`，且自然放完后实例状态仍是 2）；`stop()` 后为假。
  - 被脚本暂停：假。WPE 自身暂停（全局音量 0）：实例状态变成 1，仍不为 0，又没有 bit30，所以**仍为真**。
- **陷阱**【推】：
  - 包装层的状态只在 `play` / `pause` / `stop` 时改，SFML 自然放完不会回写。
  - `single` 放完后调 `pause()`：对已结束的 `Music` 调 `pause`，包装状态变成 1。再 `play()` 走续播分支，SFML 对已停止的流 `play()` 会从头放。所以「`pause` 再 `play`」在放完之后等于重放。
- **写 `volume`**：不钳制，经 `V` 立即生效（5.2），可以是负数（平方后为正）【确：解析器没有范围检查；负值平方是推论】。

---

## 8. 三维声音

- **开关：** `F` 的 bit2，即 JSON `spatialization: true`。只有它置位时，`P` 才调 `FUN_1401f5460(S, 1)`（设位置、`AL_ROLLOFF_FACTOR` = `attenuation`、`AL_REFERENCE_DISTANCE` = `mindistance`），`U` 才每帧更新位置（`0x1401f5029`）【确】。
- **位置**（`FUN_1401f5460`，`0x1401f5643` 起）【确】：
  1. `r` = 对象世界矩阵平移（虚函数 +0x80，含父链）− `g_EyePosition`（`ctx+0x68`）。
  2. 监听器空间坐标 `p = (r·Right, −(r·Up), r·Forward)`，三个轴取 `ctx+0x16c` / `+0x178` / `+0x160`。
  3. `ctx+0x118`（`R+0x128`）的 bit10 置位时：`p = normalize(p) · max(0, (Wi+Hi)/4 − 世界 z) / ((Wi+Hi)/4)`，其中 `Wi` / `Hi` = `ctx+0x84` / `+0x88`。这一位是什么没查。
  4. `ctx+0x144 == 0` 时 `p = (0, 0, 99999)`，这个字段是什么也没查。
  5. 对全部实例设同一个 `AL_POSITION = p`（dll `0x18000422c`）。
- **参照点：** 相机（`g_EyePosition` + 视图轴），不是场景中心，也不是指针。正交场景的 `g_EyePosition` 是 `(eye.x + W/2, eye.y + H/2, 2000)`（p3 L2）。
- **衰减：** OpenAL 缺省距离模型 `AL_INVERSE_DISTANCE_CLAMPED`：`gain = ref / (ref + rolloff·(clamp(d, ref, ∞) − ref))`，`ref` = `mindistance`，`rolloff` = `attenuation`。dll 没调 `alDistanceModel`，监听器在原点、朝 −z（SFML 缺省）【确，有界：dll 低段没见 `alDistanceModel` 调用；公式是 OpenAL 规范】。
- **声道：** OpenAL Soft 的 `AL_SOURCE_SPATIALIZE_SOFT` 缺省为自动，只对单声道源做空间化和距离衰减，立体声源原样播放【推：OpenAL Soft 行为】。
- **语料：** 161 个声音对象只有 `3832133196` 的一个写了 `spatialization`（`false`），另外两个键 `attenuation` / `mindistance` 也只这一个写（都是编辑器默认的 1.0）。所以三维声音**在语料里从不生效**，`attenuation` / `mindistance` 可以按中性处理，`spatialization: true` 照报一个新键即可（`scan_spatial.py`）【确：语料统计】。

---

## 未查清

1. dll `FUN_18000a070`（从内存打开）的返回值 2 是什么情况；`引擎+0x78`（`0x1800034a0`）是不是按键缓存、何时释放。
2. exe 侧 `ctx+0x158` 的转发虚表没找到，exe 槽到 dll 槽差 0x60 的映射是按语义推的。
3. `+0x40` 加载虚函数相对第一帧的确切时机，第一帧之前还有多少同步工作。
4. WPE 真正暂停时渲染循环还跑不跑：全局音量的淡出是在暂停之前跑完，还是暂停期间继续跑。
5. `playbackaudio` 各档怎么映射到会话的暂停 / 静音 / 卸载；`session+0x1b8` 的 bit6 是什么静音条件。
6. `config.json` 的 `volume` 到消息 `0x466` 的链路，以及它是全局滑块还是每张壁纸一份。
7. OpenAL Soft 的增益钳制（`AL_MAX_GAIN` = 1）、缺省重采样器、`AL_SOURCE_SPATIALIZE_SOFT` 的自动档，都按上游源码推断，没在二进制里核对。
8. `F` 的 bit27 的用途；`playbackmode` 写成未知字符串时取哪一档（枚举解析 `FUN_1401f7d00` 没读）。
9. 三维里 `ctx+0x118` 的 bit10 与 `ctx+0x144` 的含义（语料用不到）。
10. `scenescript64.dll` 没分析：JS 侧对 `play` / `stop` / `pause` 的参数、返回值包装，以及对 `volume` 写入有没有额外检查。

## 建议的实测

所有工程都放单声道纯音 WAV（每个文件不同频率，前后各留 0.2 s 静音），先关掉 WPE 的「其它程序出声时」联动（`playbackaudio` = `run`）。WPE 真值按子计划 0c 的两路取：脚本 `console.error` 写日志、`g_AudioSpectrum` 抓帧。

1. **音量是平方还是线性**（最优先）：两个 `loop` 对象轮流响，A：1 kHz 满幅文件、`volume` 0.5；B：同频文件，PCM 预先乘 0.25、`volume` 1。频谱读数相同即为平方；若 A 与 PCM 乘 0.5 的文件相同则为线性。
2. **`volume` > 1 钳制**：同一文件，`volume` 2.0 对 1.0，WPE 全局音量分别设 100 和 20（`restart_wpe` 改设置）。预期 100 时两者一样，20 时 2.0 比 1.0 响 4 倍（只要没触顶）。
3. **`loop` 多文件**：3 个文件，时长 1 / 1.5 / 2 s，频率各不相同。跑 2 分钟，逐帧认出正在响的频率。预期带放回的随机序列，同一文件可以连续出现，段与段之间无空隙，每段刚好放完一遍、不循环。
4. **`random` 间隔**：
   - 1 s 文件，`mintime` = `maxtime` = 1：预期每 2 s 开始一次，日志里 `isPlaying` 在间隙内仍为真；
   - `mintime` 0.5、`maxtime` 3：统计「上一段结束到下一段开始」的间隔，预期在 [0.5, 3) 上均匀。
5. **`single`**：2 s 文件，脚本每帧记 `isPlaying`。预期约 2 s 内为真、之后为假，不再重放。之后脚本 `pause()` 再 `play()`，预期从头重放（陷阱验证）。
6. **`play()` 语义**：用一个前 1 s 500 Hz、后 1 s 1 kHz 的文件做 `loop`。
   - 脚本在第 0.5 s `play()`：预期立即从头重来（又是 500 Hz）；
   - 在第 0.5 s `pause()`、第 1.5 s `play()`：预期从 0.5 s 处接着放；
   - 在第 0.5 s `stop()`、第 1.5 s `play()`：预期从头放。
7. **`startsilent` 与音量 0 起步**：`startsilent: true` 时 `isPlaying` 为假，脚本 3 s 后 `play()`，看出声时刻。另一个对象 `volume` 绑用户属性、初值 0，运行中 `apply_properties` 改成 1，预期此时才开始、从头放。
8. **可见性**：声音挂在 `visible: false` 的父层下，以及脚本中途把它自己的 `visible` 设为假。预期都照常响。
9. **WPE 暂停**：抓一段，期间让测试窗口进入暂停（或触发静音）。预期音量逐渐减小（时间常数约 1/6 s），恢复后从原处续播。若窗口暂停难以触发，这一项只做人耳。
10. **启动时机**：频谱 CLK 层的第 0 帧是否已经有声音，用来判断声音是否早于第一帧。
11. **多声音同步**：两个 `loop` 对象，文件开头都有一个短脉冲，看两个脉冲在频谱里的帧差。
12. （可选）**三维**：`spatialization: true`、单声道文件、脚本让对象左右移动。预期左右声道能量随位置变化；立体声文件则不变。语料不需要，只在要验证「立体声不空间化」时做。
