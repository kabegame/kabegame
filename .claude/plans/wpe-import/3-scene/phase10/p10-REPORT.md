# P10 步骤 0 实测报告（2026-11-13）

> 上级：[P10 总计划](phase-10-keyframes.md)。读码见 [rea-p10-keyframes.md](rea-p10-keyframes.md)。
> 本报告是 WPE 一侧的实测：WPE 2.8.42，设置 fps 20，测试窗口 1280×720。没有改产品代码。

## 结论

1. **曲线**：
   - 每段是三次贝塞尔。一段从关键帧 (f₀, v₀) 到 (f₁, v₁)，两个控制点是：
     - P₁ = (f₀ + x₀·(f₁ − f₀)/2, v₀ + y₀)，(x₀, y₀) 是左端关键帧的 `front`；
     - P₂ = (f₁ + x₁·(f₁ − f₀)/2, v₁ + y₁)，(x₁, y₁) 是右端关键帧的 `back`。
   - 横向 x 以半个段长为单位，纵向 y 是值的绝对偏移。
   - 切线关着的一侧按 (0, 0) 算，控制点落在关键帧上；两侧都关就是直线。
2. **反解**：x 用读码给的步进搜索反解出 t。t 从 0 开始，步长 0.999，每步先减半再走；`|x − f| < 0.01` 帧或满 1000 次时停。
   - 手柄超出本段、x(t) 不单调时，结果由搜索的路线决定。例如 ±20 帧的平切线在段中点跳变。
   - 0.01 帧的停止容差给整数帧上的值带来最多约「斜率 × 0.01 帧」的误差。fps 0.9 的用例里这正好约 0.8 像素，第一版模型解释不了的偏差就是它。
3. **先算整数帧，再在相邻整数帧之间线性插值。** 证据是只开一侧长切线的用例：第 59–60 帧之间从 102 线性升到 700，而连续求值会一直停在 102 附近。
4. **时间**：
   - 每条动画一个 float32 时钟，每帧加 `rate × g_Frametime`，和 `g_Time` 只差 float 舍入。
   - `loop` 回绕时取余，第 `length` 帧不画，直接跳回第 0 帧。
   - `mirror` 的周期是 2·`length`。
   - `single` 停在 `length` 处、`isPlaying` 变假。停住后显示的值随 fps 不同：fps 14.5 / 1.2 停在第 `length − 1` 帧的值（float32 算术），fps 30 停在第 `length` 帧。
   - 首帧之前取首帧值，末帧之后取末帧值。
   - `wraploop` 在第 `length` 帧补一个首帧的值。这一段的终点手柄：首帧前切线开着时，取它的镜像；首帧前切线关着时，原来末帧的后切线照样生效。
   - `step` 看段的右端关键帧，整段保持左端的值。
5. **加载期规则**：
   - `startpaused` 时钟不走，但每帧照写第 0 帧的值，所以画面上是首帧值，不是 `value`。
   - `relative` 只对三段字符串的 `value` 生效，按分量加到 `c0`–`c2` 上；标量和两段字符串时忽略。
   - 关键帧的 `frame` 截断成整数，截断后不递增的那个丢掉。`back` / `front` 没写 `enabled` 时按开处理。
6. **通道与类型**：
   - 通道数必须等于分量数（float 1、vec2 2、vec3 3、vec4 4），否则整条不写、保持 `value`：向量只给 `c0`、标量写成两个通道都属此类。
   - `c0` 是空数组时，每帧写 0。
   - 布尔属性（`visible`）的动画不写。
   - `angles` 的关键帧是弧度，不换算。
7. **一帧里的顺序**：
   - 粒子与相机在动画之前算，所以动画写的 `general.zoom` 晚一帧生效（实测差正好一帧）。
   - 动画写值后，同一循环里派发事件，之后才是脚本的 `update(value)`。脚本拿到的是本帧的动画值；脚本的返回值本帧生效，下一帧动画再覆盖它。
   - `init(value)` 收到的是静态 `value`，它写回的值在第一帧被动画盖掉。
8. **`getAnimation` 与 `IAnimation`**：
   - **查找**：
     - 按 `options.name` 或**属性名**找，取登记顺序（`scene.json` 顺序）里第一个匹配的。
     - 对象上的版本只在本对象内找。不带参数时，用调用脚本所挂属性的属性名去找；找不到返回 `undefined`。
     - `thisScene` 版找全场景，找不到、不带参数都返回 `null`。
   - **只读成员**：`fps`、`frameCount`（= `length`）、`duration`（= `length / fps` 秒）、`name`。
   - **`rate`**：缺省 1，可写；负数会让时间一直减下去、没有下限。
   - **播放控制**：
     - `play()` 从下一帧起推进；在 `single` 播完之后调，时间先归零。
     - `pause()` 冻住时间。
     - `stop()` 把时间归零并暂停。
   - **帧号**：
     - `getFrame()` 返回带小数的帧号。
     - `setFrame(f)` 立即改时间：读回马上就是新值，画面要到下一帧才更新，暂停时也一样。
9. **事件**：
   - **触发时机**：时间越过事件帧的那一帧触发，按 `events` 的数组顺序。
     - `loop` 的回绕帧上，先发回绕前越过的，再发回绕后的；第 0 帧的事件在加载后第一帧和每次回绕时触发。
     - `mirror` 正向、反向各触发一次。
     - `single` 的第 `length` 帧事件在播完那一帧触发。
   - **回调**：回调是 `animationEvent(event, value)`。`event` 是作者写的整个事件对象，包括自定义键，数字保留 8 位有效数字。`value` 是接收脚本自己那个属性的值，返回值会写回。
   - **接收者**：动画所在对象上导出了 `animationEvent` 的全部脚本都会收到，别的对象收不到。
10. **联动**：
    - 子动画（`options.parent.key` 是同一对象上另一个属性的名字）完全用父的时钟，包括父的时间、模式、暂停状态和 `rate`。
    - 子的帧号超出自己的关键帧范围时停在末值。
    - 子自己的 `startpaused` / `events` / 脚本控制都不起作用，`children` 不读。
11. **隐藏不停**：图层 `visible` 为假时，动画照常推进、照常写值。

## 方法与工具

全部在 `ignore/p10/`（kbp 数据目录，`kbp gen p10 --data ignore/p10`）：
- **测试工程**：`defs/p10.py`，共四个确定性工程。
  - **写法**：每个用例一个小图层，材质用自定义着色器 `kbkf`，顶点阶段读 `g_ModelViewProjectionMatrix` 和 `g_Color4`。曲线多数写在 `origin` 的 x 上，y 是行位置。另有两个 effect 的常量：`kbkfx` 的 float `kfa` 与 vec3 `kfv`，`kbkfx2` 的 float `kfa` 与 vec2 `kfw`。脚本每帧往 `log.txt` 记一条，用 `console.error`，前缀 `[kf]`。
  - **`p10-curves`**：插值与模式，16 条 `origin` 曲线，外加 `alpha` / `color` / `angles` / effect 常量。
  - **`p10-script`**：
    - 修正后的标量与 `wraploop` 带切线；
    - 脚本并存三种、`getAnimation` 时间表、`single` 再播放、按名字查找；
    - 事件四种、联动两种、隐藏、四种非整数 fps。
  - **`p10-edge`**：读码推断而没实测的点。
    - `single` 末值与 fps、`step`、`wraploop` 的残留切线；
    - 子动画的脚本控制与事件、按属性名查找、`thisScene.getAnimation()`；
    - 事件的边界与接收者、`relative` 的值类型、`visible` 与通道数、关键帧解析细节；
    - 空通道、负 `rate`。
  - **`p10-zoom`**：`general.zoom` 和 `origin.x` 用同一条时间线，看 zoom 晚不晚一帧。
- **`kbp rdc consts`**：本步骤给 kbp-tools 新加的动作。逐帧读每次绘制被着色器读到的常量，时钟取法同 `track`。
- **分析脚本**：
  - 把常量换成每帧的值：`ana_curves.py`、`ana_script.py`、`ana_edge.py`、`ana_zoom.py`，其中 `origin` 由 MVP 平移反算，用静态参照层核对。
  - `kflog.py` 解析 `[kf]` 日志。
- **模型**：
  - 我的模型 `model_full.py`：插值用纯二分。除 fps 0.9 外和实测吻合。
  - 读码代理的 float32 模型 `rea/kfmodel.py`：照读码实现。
  - `verify_solver.py`：只把我的模型的反解换成读码的步进搜索，独立核对 fps 0.9 的偏差确实来自反解。
  - `check_edge.py`：用读码模型核对 `p10-edge` 里不带脚本的用例。
- **推导过程留下的脚本**（排除错误模型用）：
  - 时间基准：`fit_time.py`；
  - 控制点缩放、二分与整数帧烘焙：`bez_test.py`、`bez_enabled.py`、`fit_k.py`、`oneside.py`、`model.py`；
  - 回绕段：`check_wrapt.py`、`wrap_variants.py`；
  - fps 0.9 的偏差：`fit_frac*.py`、`frac_lag.py`、`tol.py`、`iter.py`。
- **抓帧**：
  - `A:\p10\p10-curves-fps20`、`p10-script-fps20`（时间表排晚了的一版）、`p10-script2-fps20`、`p10-edge-fps20`，各 100 帧；
  - `p10-zoom-fps20` 60 帧；
  - 语料真值：`A:\p10\corpus\{2251857160,3146703458,kabegame-sample}-fps20`，各 30 帧，留给 P10a 验收。

## 曲线（`p10-curves`，`p10-script` 的无脚本用例）

残差（像素，每条 100 帧）：

| 用例 | 内容 | 我的模型（纯二分） | 读码模型 |
|---|---|---|---|
| lin | 两侧切线都关 | ±0.10 | 0.0005 |
| flat / flat20 | 平切线 ±1 / ±20 | ±0.18 / 0.001 | 0.0007 / 0.0001 |
| slope | 前切线 (10, 200)、后切线 (−10, 0) | 0.008 | 0.0001 |
| oneside | 只开首点前切线 (20, 0) | 0.02 | 0.021 |
| three | 三点、混合切线 | 0.009 | 0.015 |
| inner | 关键帧在 15、45 | 0.26 | 0.0013 |
| tail / tailwrap | 末帧 40；`wraploop` | 0.12 / 0.23 | 0.0007 / 0.0011 |
| mirror / single / slow | | ≤ 0.1 | ≤ 0.0005 |
| relative / paused | | 0.06 / 0 | 0.0003 / 0 |
| fpsfrac | fps 0.9 | −0.79 … −0.47 | 0.0006 |
| onlyc0 | `origin` 只给 `c0` | 保持 `value` | 保持 `value` |
| wrapt | `wraploop`，回绕段两端切线开 | 0.58 | 0.0022 |
| frac09 / 12 / 145 / 75 | 非整数 fps | ≤ 0.009 帧 | ≤ 0.0006 |
| alpha / kfa / kfv | 标量、effect float / vec3 | | 0 / ≤ 0.00002 |

- 读码模型拿 `g_Time` 近似 float32 时钟，陡段（`oneside`、`three` 每帧约 600 像素）留下约 0.02 像素。
- 我的模型的残差主要来自没照 0.01 帧的反解容差；第一版报告草稿里把它当成了 ±0.0003 s 的「时间噪声」，是错的。

逐步排除过的模型：
- 关着的切线仍按存的 x、y 当手柄：差几十像素。
- 手柄缩放 k 为常数：`flat` 要 30、`inner` 要 15，所以是半个段长；纵向也乘半段长时 `slope` 差 597 像素。
- 取 x(t) 的第一个根：`flat20` 差 299 像素。
- 连续求值：`oneside` 最后一帧差 336 像素。
- 纯二分（固定次数 / 按容差停 / 三种取值）：都解释不了 fps 0.9 的偏差；读码的步进搜索一换上就吻合。

## 脚本（`p10-script`）

**控制时间表**（日志，`ctl`：`startpaused`、`loop`、`length` 60、fps 30）：

| 时刻（s） | 动作 | 当帧 `getFrame` | 下一帧 |
|---|---|---|---|
| 10.03 | `play()` | 0 | 1.500（+dt·30） |
| 10.63 | `pause()` | 18.054 | 不变 |
| 11.03 | `play()` | 18.054 | 19.589 |
| 11.43 | `stop()` | 0 | 0，值回到第 0 帧 |
| 11.63 | `setFrame(30)`（停着） | 30 | 值变成第 30 帧的 399.989 |
| 11.94 | `play()` | 30 | 31.508 |
| 12.24 | `rate = 2` | 39.077 | 42.076（+dt·60） |
| 12.59 | （回绕） | | 57.170 → 0.174 |
| 12.64 | `rate = 0.5` | 3.180 | 3.913 |
| 13.04 | `setFrame(10)`（播着） | 10 | 10.747 |
| 13.35 | `pause(); setFrame(45.5)` | 45.5 | 值 554.963 |
| 13.65 | `rate = 1; play()` | 45.5 | 47.124 |

`init` 里读到：`fps` 30、`frameCount` 60、`duration` 2、`name` "ctl"、`rate` 1、`isPlaying` 假、`getFrame` 0。
`single`（`ctls`）：12.04 s 播完，`getFrame` 60、`isPlaying` 假；12.54 s 再 `play()`，`getFrame` 立即为 0。

**并存**（抓帧）：
- `ovr`（每帧返回 x = 1500）画出来始终是 1500，下一帧脚本收到的仍是动画值。
- `ovrinit`（只在 `init` 返回 1500）和不挂脚本的同一条曲线逐帧相同。

**名字**：
- `names` 脚本挂在没有动画的 `nameB.origin` 上。`init` 里的结果：
  - `thisObject.getAnimation()` → `undefined`；
  - `thisScene.getAnimation('kfname')` → 找到；
  - `thisLayer.getAnimation('kfname')`（动画在别的层）→ `undefined`；
  - `thisScene.getAnimation('nosuch')` → `null`；
  - `getLayer('nameA').getAnimation()` → 找到（调用者属性名也是 `origin`）。
- 另一个对象的脚本按名字 `play()` 后，`nameA` 下一帧开始动。

**事件**：
- `ev` 和 `evn`（带不带 `name` 都一样）每 2 秒各触发两次，时刻是越过第 15、45 帧的那一帧。
- `evp` 在播放后 0.5 s 触发 `p15`，在播完那一帧触发 `p60`。
- `evother` 在别的对象上，一次也没收到。

**联动**：
- `link`：父 `startpaused single`，10.0 s 由脚本播放；子 `alpha` 长 30。父播放前子停在 0；播放后 `alpha = 父帧号 / 30`，父过了第 30 帧后子停在 1。
- `link2`：父 `loop`、子 `startpaused`，子照父的帧号走。

**隐藏**：`hid` 在 10.5–11.5 s 不画，11.53 s 重新出现时和 `pass` 同值。

## 读码推断的点（`p10-edge`、`p10-zoom`）

| 读码第 15 节 / 建议 | 实测 | 和读码 |
|---|---|---|
| `single` 末值（fps 14.5 / 1.2 / 30） | 0.96563 / 0.37958 / 1.0（曲线 (0,0)→(29,1)） | 与读码模型逐位相同；fps 14.5、1.2 停在第 `length − 1` 帧 |
| `step`（中间关键帧 / 首帧） | 残差 ≤ 0.0003 px | 吻合 |
| `wraploop` 残留的后切线 | 残差 ≤ 0.0002 px；当它不生效算差 133 px | 吻合：残留切线照用 |
| 子动画上的脚本控制、子的事件 | 子脚本 `pause` / `setFrame(0)` / `rate = 0` 后画面照父走、`getFrame` 一直 0；子的 `k10` 从不触发；父 `rate = 2` 后子每帧 +0.05（原来 +0.025） | 吻合 |
| 按属性名查找 | `thisScene.getAnimation('alpha')` 找到第一个登记的 `alpha` 动画，即排在前面的 `end145`，而不是想找的 `pa`；`end145` 已播完，`play()` 后从 0 重播、12.03 s 再停 | 吻合 |
| `thisScene.getAnimation()` 不带参数 | `null` | **读码推断为 `undefined`，实测是 `null`** |
| 事件边界 | 第 0 帧事件在第一帧和每次回绕触发；回绕帧依次 `b60`、`b595`、`b0`；`extra` 读到 1.2345679，键按字母序 | 吻合 |
| `mirror` 的事件 | 每 4 s 两次（0.53、3.51、4.51、7.51…） | 吻合 |
| 事件接收者 | 同一层 `origin` 的脚本和 effect 常量的脚本都收到，`argc` 2；常量脚本每次返回值 + 1，常量 3 → 10 | 吻合 |
| `relative` 的值类型 | 标量 `alpha` 与两段字符串的 vec2 都不加偏移 | 吻合 |
| `visible` 写成关键帧、vec2 只给 `c0` | 可见性不变；vec2 保持 (5, 6) | 吻合 |
| 关键帧解析 | `frame` 10.7、10.2 截断后第二个丢掉；没写 `enabled` 的 `back` 按开、y = 50 生效 | 吻合（残差 ≤ 0.0006 px） |
| `c0` 为空数组 | 每帧写 0 | 吻合 |
| 负 `rate` | 退过第 0 帧后继续变负（−1.8、−4.5…），值在第 0、1 帧的连线上锯齿，`isPlaying` 一直为真 | 吻合 |
| `general.zoom` 晚一帧 | 同一帧里 zoom 对应的帧号比 `origin` 的少 dt·30（比值 0.991–1.010） | 吻合 |
| 暂停淡变期间减速 | 没测：要全局暂停用户桌面上的 WPE | — |
| 作用域为 0 的绑定、`ctx+0x118` 门 | 没测：没有对应的 JSON 写法 | — |
| `instanceoverride` 晚一帧 | 没测：和 `zoom` 同一个原因（粒子在动画之前），语料 2 张 | — |

## 对计划的影响

- **P10c 并进 P10a**：
  - 联动只是「子借父的时钟」，登记时按属性名找同一对象上的父，`children` 不读。
  - `smoothing` / `stiffness` 运行时不读，按中性放开。
  - 这两项都很小，放进 P10a 的时钟里一起做。
- **P10a**：
  - **求值**照读码第 14 节逐位实现（float32，`Math.fround`），整数帧值按通道缓存。验收用读码模型 `rea/kfmodel.py` 和本报告的四个工程，逐帧比到 0.001 像素级。
  - **帧里的位置**：在粒子、相机之后，脚本之前。我们的帧循环是 `sync → stepParticles → setCamera → 声音 → 脚本 → sync → update`，插在声音与脚本之间：
    - 相机在帧开头读 `zoom`、粒子先模拟，所以「晚一帧」自然对上；
    - 隐藏的图层照常推进；
    - 暂停的动画照常写值。
  - **能力表**只给布尔类型的动画（`visible`）放开，它们不写、中性；其余照总计划报细分键。
- **P10b**：
  - **查找**：`getAnimation` 按 `options.name` 或属性名查找；对象上的版本找不到返回 `undefined`，`thisScene` 版返回 `null`。
  - **事件**：发给同一对象的全部脚本，回调带第二个参数，返回值写回。
  - **`setFrame`**：值在下一帧才更新，我们的写入在脚本之前，自然对上。
- **风险 1–3**（插值公式、时间基准、和脚本的先后）都已查清。

## 工具

- 新增 `kbp rdc consts`：代码在 `.claude/skills/kbp-tools/rdc/consts.py`，SKILL 已登记。
- `capture_wallpaper` 的 `frames` 上限是 100。
- 两次抓帧的开始时刻可能相差 4 秒（场景时间 13.4 s 与 9.3 s），时间表要按日志读、不要按抓帧窗口排。
- `capture_sweep` 的 `log_dir` 把带 `Error:` 的行都放进 `*-errors.txt`，`console.error` 记的 `[kf]` 行在那里。
- 我的失误：
  - `p10-curves` 的 `alpha`、`kfa` 把两个关键帧写成了两个通道，WPE 丢掉了整条动画。这两条留作「通道格式不对」的用例，正确的标量放进了 `p10-script`。
  - 第一版 `p10-script` 把动作排在 14.0–17.6 s，抓帧窗口在 9.3–14.4 s，大部分没录到；改到 10.0–13.6 s 重抓。
  - 一度以为第一版没有触发事件，其实是查看输出时截断了，两版都触发了。
  - 第一版报告草稿把纯二分模型的残差当成了时间噪声；读码的反解一换上，残差就到了 0.001 像素级。

## P10b 补测（2026-11-14）

> 子计划 [phase-10b-script.md](phase-10b-script.md)「步骤 0」。WPE 2.8.42，fps 20，测试窗口 1920×1080，只看 `[kf]` 日志（每行直接 `console.error`）。
> 工程：`ignore/p10/defs/p10.py` 的 `p10b-api`、`p10b-order`（生成代码的原文在 `ignore/p10/b0/p10b_api_defs.py.txt`、`p10b_order_defs.py.txt`）；日志 `ignore/p10/b0/s0-log.txt`、`s0-order-log.txt`。
> 动画按 `frameCount` 认（每条的 `length` 都不同）。

| # | 问题 | WPE 结果 | 和读码 / 推断 |
|---|---|---|---|
| Q1 | `getAnimation` 的对象范围 | effect 1 的 `kfa` 常量上，`thisObject.getAnimation()` 与 `getAnimation('kfa')` 都拿到**自己那条**（len 42），不是同图层先登记的 effect 0 那条（len 41）；`thisLayer.getAnimation('kfa')`、`thisLayer.getAnimation()` 都是 `undefined`；effect 1 的 `visible` 脚本（`thisObject` 是 effect）和图层 `origin` 脚本按 `kfa` 找也都是 `undefined` | **推翻推断**：范围不是图层，是绑定的属主，同联动（图层字段归图层，effect 常量归它所在的材质 pass，effect 的 `visible` 归 effect）。派发的范围仍是图层（Q3） |
| Q2 | 联动的属主 | 三种写法子都按自己的时钟走、不跟 `startpaused` 的父停住：同一 effect 的 pass 0 父 / pass 1 子；同一图层两个 effect；图层 `alpha` 子对 effect 常量父 | 和 P10a 的实现（属主按 pass）一致，TODO 可以删 |
| Q3 | 多个接收者的派发顺序 | 同一图层 `visible`、`origin`、`alpha` 与 effect 常量上的四段脚本都收到；顺序是 `alpha`、`origin`、`visible`、effect 常量（JSON 书写顺序是 `visible`、`origin`、`alpha`、`effects`） | 读码只说遍历脚本绑定链表。顺序见下面「登记顺序」 |
| Q4 | 包装对象的形状 | 见下面「`IAnimation` 的形状」 | 成员顺序、只读与转换规则读码里没有 |
| Q5 | 模块顶层调用 | `thisScene.getAnimation('q4')` 抛 `SyntaxError: getAnimation cannot be called from global scope.`；模块顶层 `thisObject` 是 `null` | 同 P3 报告记的 `cannot be called from global scope` |
| Q6 | 空名字与非字符串 | `thisScene.getAnimation('')` 拿到全场景第一条没写 `name` 的动画；`thisObject.getAnimation('')` 用属性名（`visible` 没有动画，`undefined`；同一对象上没写 `name` 的 `alpha` 动画没被拿到）；`thisScene.getAnimation(5)` 为 `null`；`thisObject.getAnimation(5)` 用属性名 | 吻合读码 |
| Q7 | 丢弃的动画 | `fps: 0` 与 `length: 0` 两条都能按名字找到：`fps` 读出 1、`frameCount` 是 `length` 截断后的值（52、0）、`duration` 0、`getFrame()` 0、`isPlaying()` 真、`rate` 1；`play()` 后 `getFrame()` 一直 0 | 吻合读码第 5 节（照样登记、`D = 0`）；字段值是新的：时钟没解析，`spf` 保持 1 |
| Q8 | 回调里控制别的动画 | `q8a` 的 `animationEvent` 里对 `q8b`（排在后面）、`q8c`（排在前面）调 `stop()`：`q8b` 的 `update` 当帧收到第 0 帧的值 100，`q8c` 下一帧才是 100 | 派发是同步的，在动画循环中间 |

**`IAnimation` 的形状**（Q4，`q4`）：
- 自有、可枚举的成员，`Object.keys` 顺序：`name`、`frameCount`、`duration`、`fps`、`rate`、`play`、`isPlaying`、`stop`、`pause`、`setFrame`、`getFrame`、`getAnimation`。`typeof` 依次是 string、number ×4、function ×7。
- 描述符：都是数据属性（V8 的原生数据属性）。`fps`、`frameCount`、`duration`、`name` 不可写，严格模式下赋值抛 `TypeError: Cannot assign to read only property 'fps' of object '[object Object]'`、值不变；`rate` 可写、可枚举、可配置。
- 原型只有 `constructor` 一个自有属性；`String(a)` 是 `[object Object]`。
- 同一条动画每次拿到同一个对象：`thisObject.getAnimation() === thisObject.getAnimation()`，也 `=== thisScene.getAnimation('q4')`。
- 初值：`rate` 1（number）、`getFrame()` 0、`isPlaying()` 假（`startpaused`）；`fps` 29.999998092651367、`duration` 1.6666666269302368（float32）。
- `rate` 只收数字：赋 `'2'`、`{x: 3}` 后读回仍是 1、推进速度不变；赋 `NaN` 照收，之后 `getFrame()` 与值都是 `NaN`。赋 `true` 后读回 1，和原值相同，分不出是忽略还是转成 1。
- `setFrame` 的参数不是数时按 0：`setFrame('30')`、`setFrame()` 之后 `getFrame()` 都是 0，下一帧从 0 往后走。

**登记顺序**（Q3 与 `p10b-order`）：
- 脚本：`init` 与第一次 `update` 的顺序相同，都是：
  1. `general` 的字段，按键名字母序（`ambientcolor`、`clearcolor`，书写顺序相反）；
  2. 按 `objects` 数组顺序，每个对象：
     - 先是自己的字段，按键名字母序（`alpha`、`angles`、`color`、`origin`、`scale`、`visible`，书写顺序相反）；
     - 再是 `effects`，按数组顺序；每个 effect 先 `visible`，再按 pass 顺序、每个 pass 的常量按键名字母序（`kfa` 在 `kfv` 前，书写顺序相反）。
- 动画：同一规则。`thisScene.getAnimation(名字)` 取到的第一条：`alpha` 先于 `origin`、`kfa` 先于 `kfv`、字段 `scale` 先于 effect 的常量、`general.zoom` 先于排在最前的对象。
- 本机语料 4381 个对象的键全部按字母序书写（WPE 写文件时排好的），所以和我们按书写顺序遍历的差别只在一处：effect 上的脚本和动画写在 `origin`、`scale`、`visible` 等字段之前，WPE 却登记在它们之后。语料里有 27 张场景的脚本顺序因此不同（`ignore/p10/b0/keyorder.py`）。

**工具**：`log_mark` / `open_wallpaper` 返回的游标里 `created` 超过 JSON 数的精度，原样传回 `log_since` 会被判成「日志被重写」。这次改为开窗前自己记日志字节数、之后按偏移读文件。
