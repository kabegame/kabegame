# P6 实测报告

> 上级：[phase-6-script-text-sound.md](phase-6-script-text-sound.md)。读码在 `rea-p6*.md`，那里的结论没有实测；这里记实测核对，结论以本文件为准。每节写清工程、取数方法、读数脚本和结果。

## P6a 声音语义的实测核对（2026-11-11）

读码在 [rea-p6a-sound.md](rea-p6a-sound.md)。

**工具：**
- **工程：** 由 `ignore/p6/defs/p6a.py`（`kbp gen p6a --data ignore/p6`）生成，放在 `ignore/p6/proj/p6a-*`。声音文件是自己生成的单声道 16 位 44.1 kHz 纯音 WAV，每个文件一个频率。每个工程有一个 PROBE 层：脚本在模块顶层 `engine.registerAudioBuffers(64)`，每帧记帧号、`engine.runtime`、各声音层的 `isPlaying` 与 64 段频谱，每 5 帧 `console.error('[p6a] …')` 一行；要调方法的工程另有 CTRL 层，按 runtime 调 `play` / `pause` / `stop`，写 `[p6c] runtime 名 方法 调前 调后`。
- **WPE：** `wpe-renderdoc` MCP 开本会话的测试窗口（1280×720，fps 20，用户设置没改），`apply_properties` 运行中改壁纸音量与用户属性。没有抓帧。
- **取数：**
  - 日志：`ignore/p6/a0/cut_log.py` 从开窗游标起直接读 WPE 的 `log.txt`，`flags.py` 看 `isPlaying` 的变化点；
  - 录音：`ignore/p6/a0/rec.py` 用 WASAPI 回环录默认扬声器的混音（`uv run --with soundcard --with numpy`），`ana_rec.py` / `ana_segs.py` / `amps_at.py` / `ana_pan.py` 用 Goertzel 按频率量幅度、切段、分声道。录音和 runtime 用脚本动作造成的空档对齐。
- 结果在 `ignore/p6/a0/out/`。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 测试窗口出声，回环能采到 WPE 自己 | `p6a-calib`：7 个纯音逐个在频谱里出现，静音段读数为 0 | 成立。频段：125 Hz → 第 4 段、250 → 10、500 → 21、1 k → 32、2 k → 38、4 k → 46、8 k → 54 |
| 加载时就开始放，不等第一帧 | `p6a-calib`：文件开头 0.5 s 静音，第一个音在 runtime 0.63 s 出现 | 成立（开始时刻在 runtime 0.13 ± 0.05 s 内，含频谱的一帧延迟） |
| 单文件 `loop` 无缝循环 | `p6a-calib`：周期 9.27 s（文件 9.25 s），段间没有空隙 | 成立 |
| 增益 = `min(1, volume² × G)`，G = 壁纸音量 / 100 | `p6a-vol2`：5 个对象不同频率同时放。A（幅度 0.2、`volume` 0.5）/ B（0.05、1）= 1.00；C / B = 2.0、E / B = 9.0（输出与文件幅度成正比）；D（0.05、`volume` 3）/ B = 2.0 | **平方成立，钳制成立**。D / B = min(1, 9G) / G = 2 反推缺省 G = 0.5 |
| 运行中改壁纸音量立即生效 | `apply_properties({volume: 50})` 没有变化；改 25 后 A、B、C、E 减半，D 不变（D / B = 4 = 1 / 0.25） | 成立。**测试窗口的缺省壁纸音量是 50**；钳制在 `volume² × G` 上，不是先钳 `volume²` |
| `loop` 多文件：每个放一遍、带放回随机换下一个，中间不留空 | `p6a-loopmulti`：1 / 1.5 / 2 s 三个文件，40 s 内每段都是整个文件长或它的整数倍（连选同一个），段间空隙 0–0.06 s | 成立。空隙落在帧边界（20 fps） |
| `random`：从开始播放算起，等「时长 + U(mintime, maxtime)」 | `p6a-random`：Q（1 s、min = max = 1）开始到开始恰好 2.00 s；R（1 s ×3、0.5 / 3）12 个间隔在 1.70–3.94 s，均值 2.82（理论 [1.5, 4)、均值 2.75） | 成立 |
| `random` 的 `isPlaying` 在间隙里仍为真 | `p6a-random`：两个对象 1065 帧全是真 | 成立 |
| `single` 放一遍后 `isPlaying` 变假 | `p6a-single`：0–2.05 s 为真，之后假 | 成立 |
| `single` 放完后 `pause` 再 `play` 会从头重放，`isPlaying` 仍为假（陷阱） | `p6a-single`：7 s 的 `play` 出了一整段 2 s 的声音，`isPlaying` 调前调后都是 0；12 s 再 `play` 为真 2 s | 成立 |
| `play` 在放的时候：停掉、从头放 | `p6a-play`：5.0 s 时 500 Hz 那半已放 1 s，又从头放 1 s，连成 2.02 s | 成立 |
| `pause` → `play`：从原处续播 | 9.7 s 暂停（500 Hz 放了 0.7 s），10.7 s 恢复后再放 0.3 s 500 Hz 接 1000 Hz | 成立 |
| `stop` → `play`：从头放 | 14.9 s 停（500 Hz 放了 0.92 s），15.9 s 恢复后 500 Hz 完整 1 s | 成立 |
| `isPlaying`：`pause`、`stop` 后假，`play` 后真；重复 `pause` 无害 | 日志调前调后逐条吻合 | 成立 |
| `startsilent`：不放、`isPlaying` 假，直到 `play` | `p6a-silent`：T 在 4.0 s `play` 之前不出声、为假 | 成立 |
| 音量为 0 时不开始；变成正数时才从头放 | `p6a-silent`：Z 的 `volume` 绑属性 `zvol`（缺省 0）一直不出声、`isPlaying` 假；`apply_properties({zvol: 1})` 后才出声，从文件开头放 | 成立 |
| 自身或父层不可见不停 | `p6a-misc`：V 挂在 `visible: false` 的分组下，从头就在放；W 在 3 s 被脚本设为不可见，幅度不变 | 成立 |
| 多个声音同时开始 | `p6a-misc`：P1、P2 开头的 0.1 s 脉冲同一个 10 ms 窗口出现 | 成立 |

**读码没写、实测得到的：**
- **单声道源的声像：** 单声道 0.2 的文件左右声道各 0.0622 = 0.2 × 0.5 × 0.622；立体声每声道 0.2 的文件左右各 0.0999 = 0.2 × 0.5。单声道源居中、每个前置声道约 −4.1 dB。本机输出设备是 8 声道（HECATE G1500 BAR），OpenAL Soft 多半把一部分分给中置，系数随设备布局变，不是固定的等功率律。Web Audio 把单声道原样复制到两个声道，同一文件在我们这边会响约 4 dB。
- **脚本频谱带自适应归一化：** `registerAudioBuffers` 的数组不是绝对幅度。纯音持续时读数逐帧上升，`1 / 读数`每帧减一个常数（分母线性衰减）；读数超过 1 时分母立刻追上、读数压回 1.000，起音那一帧可以到 3–4（`p6a-vol` 的第 32 段）。所以它只能认频率，不能比音量。这条留给 P9（`g_AudioSpectrum*`）。

**没测：**
- **WPE 暂停时的淡出（`k = min(1, 6·dt)`）：** MCP 不能让测试窗口进入暂停，桌面壁纸不碰。只能人耳核对。
- `volume` 写成负数、`playbackmode` 写成未知字符串：语料没有。
