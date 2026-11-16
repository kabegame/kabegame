# P5e：脚本 `thisScene.getCameraTransforms` / `setCameraTransforms`

> 起因：wpe p6 d/e 转来（2026-11-15）。工坊场景 `2887099508`（dev 库图片 13554）的开场镜头靠这两个 API 滑动：
> `objects/52` 的混淆脚本每帧 `t = getCameraTransforms()`，第一帧记下 `eye − origin`、`center − origin`，之后
> `t.eye = origin + 记下的差`、`setCameraTransforms(t)`；52 号对象的 `origin` 有关键帧动画，所以相机跟着滑，同时
> `general.zoom` 的关键帧从 3 降到 1。我们没有这两个 API，脚本跑到 `getCameraTransforms` 抛「is not a function」，`update` 被停用：
> 缩放照样发生，但镜头不动，对准的是左上方的天空，下半部还露出本该在镜头外的半透明黑框。
> 混淆后的字符串调用词法扫描认不出，所以 `MISSING_SCRIPT_API` 没拦住，P6d3a 之后它被判成能渲染。
> 抓帧：`A:\p6d3\2887\`（t1-frame119 / t2-frame271 / t3-frame387 / t4-frame519，1280×720，约 25 fps）；
> 脚本源码与解混淆版 `ignore/p6/d3/out/2887/s52.js`、`s52-read.js`。

## 总体设计思路

WPE 的场景里有两套相机字段：**基准**（`G+0x118` eye、`+0x124` center、`+0x130` up、`+0x13c` zoom），加载时来自
`scene.json` 的 `camera`；**当前**（`G+0xf0`…`+0x114`），每帧由 `FUN_1401891a0` 按「相机对象 > 路径 > 基准」选来源算出，
再进 lookAt 与正交缩放。这两个脚本 API 读写的是**基准**四项，exe 实现就是逐字段拷贝（`0x14018da30` / `0x14018da90`，
四个指针各自可空）。所以要做的事是：把基准从「编译期常量」变成**场景运行时状态**，脚本经 API 读写它，相机求值每帧从它取。

我们现在把基准当常量处理，正交场景里更是直接假定视图为单位阵（WPE 加载末尾对「正交且没有路径」的场景把基准重置成
eye (0,0,0)、center (0,0,−1)、up (0,1,0)，p3 L2），只有相机对象才走 lookAt。改完之后，正交场景没有相机对象时也按基准
算视图：基准等于重置值时 lookAt 退化成单位阵，结果逐字节不变；脚本改过基准后，视图、`g_EyePosition`
（eye.xy + (W/2, H/2)，z = 2000）、视差中心（eye.xy）、总缩放（`general.zoom × 基准 zoom`）都跟着变，和相机对象那条路径
用的是同一个 `orthographicCameraObjectFrame`。透视场景本来就每帧 lookAt 基准，只是把基准的来源换成运行时状态；zoom 在透视下不起作用（rea-p5-camera 1.4）。

时序照 WPE：脚本在相机求值之后（`FUN_14017fa70` 第 7 步），所以 `update` 里 `set` 的值下一帧才进视图；`get` 返回基准的
当前值（含本帧之前 `set` 过的），不是路径、抖动、相机对象的结果，也不是 `general.zoom`。有相机对象或路径时基准不参与，
`set` 写进去但看不到效果，`get` 照样读回写入的值。

关键决策：基准放进 `SceneState`（和 general 字段同一层，脚本写、渲染读、重编译时随 `replayWrites` 恢复），不另开一份
相机状态；相机求值函数 `sceneCameraFrame` 的输入从 `SceneCameraJson` 换成状态里的基准，渲染器与 dev 探针共用，不分叉。

## 现状锚点

**a. 正交场景没有相机对象时不做 lookAt**（`render/camera.ts` `sceneCameraFrame`）
```ts
  const shake = shakeOffset(state.general, input.time, input.general.height);
  if (!active) return { camera: { shake, zoom: state.general.zoom }, eye: shake, path: null };   // 现状：视图恒为单位阵、基准 zoom 恒 1
```

**b. 透视基准取编译期 JSON**（同文件）
```ts
/** 基准姿态（没有路径时；基准 zoom 恒 1，透视场景里不起作用）。 */
export function baseCameraPose(camera: Pick<SceneCameraJson, "eye" | "center" | "up">): CameraPose {
  return { eye: [...camera.eye], center: [...camera.center], up: [...camera.up], zoom: 1 };   // 现状：常量
}
```

**c. 两个 API 在缺口表里**（`compile/scriptApi.ts`）
```ts
    ...methods("root", [
      "createLayer",
      "getCameraTransforms",   // 现状：报 script:api:thisScene.getCameraTransforms（词法扫描）
      "setCameraTransforms",
```

## 步骤 0 — 读码补齐与 WPE 实验（先做，结果写进本文件「步骤 0 结果」）

已确认（读码）：exe 两个槽是逐字段拷贝、四项可空；脚本晚于相机求值；`get` 读基准；正交无路径时加载末尾重置；基准缺省
eye (2,2,2)、center (0,0,0)、up (0,1,0)（不是字符串时保留缺省）。

**读码要补**（dll `0x181635540` / `0x1816359e0`，`ignore/p6/rea/layers/script/host.asm`）：
- `get` 返回的对象：普通对象还是类实例、键序、三个 Vec3 是不是 `Vec3` 实例（2887 调了 `t.eye.subtract`）、zoom 是 float→double；
- `set`：每项怎么判「合法」（`0x181620090` 读 x / y / z 的规则：缺分量、非数字、不是对象）、zoom 用什么转数字（`0x180016c70` / `0x1800254f0`）、
  参数不是对象 / 缺参时的行为（抛错还是返回）；返回值；
- 基准 zoom 的构造缺省值与 `scene.json` 里 `camera.zoom` 是否被读。

**实验**（`kbp gen` 生成正交 1920×1080 测试工程，带 FR / CLK 图层与 `[kbp]` 日志，`capture_wallpaper` 抓帧 + `log_since` 取日志）：

| # | 工程 | 要回答 |
|---|---|---|
| E1 | 正交、无路径，`init` 与前几帧 `update` 打印 `get()` 全部字段、`Object.keys`、`t.eye instanceof Vec3` | 返回值的形状与重置后的值 |
| E2 | 第 N 帧 `set({eye, center 平移 (200, 100)})`，第 N、N+1 帧打印 `get()` | 读回立即变、画面下一帧平移；方向与 `g_EyePosition` |
| E3 | `set` 只给 `zoom: 2`；再只给 `eye`；给 `eye: 5`、`eye: {x: 1}` 等非法项 | 各项独立、非法项跳过；zoom 绕中心缩放、与 `general.zoom` 相乘 |
| E4 | E2 + `cameraparallax` 开、`camerashake` 开 | 视差中心与抖动叠在基准上 |
| E5 | 有可见相机对象 / 有 `camera.paths` 时 `set` | 不生效，`get` 读回写入值 |
| E6 | 透视场景 `set` eye / center / zoom | 下一帧生效、zoom 无效 |
| E7 | 2887 的 `kbp content unpack --instrument` 副本 | 与 WPE 按日志光标逐帧对照（验收用） |

## 步骤 0 结果（2026-11-15）

**读码**（dll `ignore/p6/rea/layers/script/host.asm`，exe `ignore/p5/rea/camera/wallpaper64.exe`）【确】：
- `get`（`0x181635540`）：`Object::New` 一个普通对象，依次 `Set` `eye` / `center` / `up`（各由 `0x181624910` 建：新对象、原型取
  `Vec3.prototype`、`Set` x / y / z 三个 `Number`）与 `zoom`（float 转 double 的 `Number`）。键名在 `E+0x148…+0x160`。
- `set`（`0x1816359e0`）：`argc < 1` 或参数不是对象（`IsObject`，`null` 不是）→ 返回 `false`（根表 `+0x388`），不调宿主；否则
  四个键各 `Get` 一次，`eye` / `center` / `up` 只要是对象就交 `0x181620090` 转成 float3（x / y / z 各 `Get`，**是数字就转 float32、
  不是数字记 0**），不是对象传空指针；`zoom` 是数字才转 float32，否则空指针；调 `H+0x70`，返回 `true`（`+0x380`）。
- exe `0x14018da30` / `0x14018da90`：基准 `G+0x118`…`+0x13c` 逐字段拷贝，`set` 的空指针跳过该项。
- 基准 zoom 由加载函数 `FUN_140186c90` 在 `0x140186d51` 写成 1.0；`scene.json` 的 `camera.zoom` 不读。

**实测**（`ignore/p5/e/gen_e.py`，工程 `ignore/p5/proj/p5e-*`，抓帧 `A:\p5e\`）：

| # | 结果 |
|---|---|
| E1（p5e-a） | `get` 键序 `eye, center, up, zoom`，`Object.getPrototypeOf(t) === Object.prototype`，三个向量是 `Vec3` 实例、自有属性 `x, y, z`，`zoom` 是 number；每次调用都是新对象（`a === b`、`a.eye === b.eye` 都假），改返回的对象不影响基准。正交无路径时 update 里读到重置值 (0,0,0) / (0,0,−1) / (0,1,0)、zoom 1 |
| E2（p5e-a 第 161–163 帧） | 第 162 帧（方块颜色编码的脚本帧号）的 `g_EyePosition` = (1443, 862, 2000) = 第 161 帧 set 的 eye (483, 322) + (960, 540)：**set 下一帧进视图**；`get` 同帧读回新值 |
| E3（p5e-a） | `set()`、`set(5)`、`set('x')`、`set(null)` 返回 false，`set({})` 返回 true 且什么都不改；`{zoom: '3', eye: 5, center: 'a', up: null}` 全部跳过；`{eye: {x: 7}}` → (7, 0, 0)；`center: {x: '1', y: true, z: −1}` → (0, 0, −1)；`0.1` 存成 float32 0.10000000149011612，`1e40` 存成 Infinity；总缩放 = `general.zoom 1.25 × 基准 zoom 1.11` = 1.3875（MVP 的 x 缩放） |
| init（p5e-init-o / -p） | **init 里 `get` 读到构造缺省值**（eye (2,2,2)、center (0,0,0)、up (0,1,0)、zoom 1）：脚本 init 早于读 `scene.json` 的 `camera`。init 里 set 的 eye / center / up 随后被 JSON 的字符串覆盖（透视），正交无路径时被重置；**set 的 zoom 留下**（正交场景画面按 1.5 缩放） |
| E5（p5e-cam） | 有可见相机对象时 set 写进基准、`get` 读回，画面不受影响：`g_EyePosition` (960, 540)、总缩放 1.25 = general.zoom × 相机对象 zoom 1 |

E4（视差 / 抖动叠加）、E6（透视下 set）走的是现成的视差、抖动与透视相机代码，基准换成状态后自然覆盖，不单独实验，
放进验收的整帧对照（生成工程 + 2887 复制工程）。

## 点 1 — 基准进运行时状态（`render/state.ts`）

- **新增** `SceneState.cameraBase: CameraPose`。加载顺序照 WPE（步骤 0 的 init 实测）：
  1. 状态建好时是构造缺省值 eye (2,2,2)、center (0,0,0)、up (0,1,0)、zoom 1，脚本 `init` 读写的是它；
  2. 全部 `init` 跑完后套 `scene.json`：`eye` / `center` / `up` 是字符串的覆盖该项（不是字符串的保留 init 写的值）；
  3. 正交且没有路径 → eye / center / up 重置成 (0,0,0) / (0,0,−1) / (0,1,0)；
  4. zoom 不受 2、3 影响（init 里 set 的 zoom 留下）。
- **新增** `setCameraBase(partial)`：只改给出的项，值按 float32 存；写入登记进脚本写回，重编译时由 `replayWrites` 恢复。

## 点 2 — 相机求值读状态（`render/camera.ts`、`render/renderer.ts`、`dev/`）

- **修改** `sceneCameraFrame`：
  - 正交无相机对象 → 与相机对象同一个 `orthographicCameraObjectFrame({ pose: state.cameraBase, zoom: f(general.zoom × base.zoom), shake, … })`；
    基准等于重置值时与现状逐字节相同（单测钉住）；
  - 透视无相机对象且没有路径 → 基准取 `state.cameraBase`。
- **修改** `baseCameraPose` / `stepCameraSource` 的输入换成状态里的基准；`SceneCameraInput.state` 加 `cameraBase`。
- dev 探针（`particleCorners.ts` 等）同步，回放时脚本写入同样进状态。

## 点 3 — 脚本 API（`script/api.ts`、`compile/scriptApi.ts`）

- **新增** `installScene` 里两个 `sceneMethod`（顶层调用抛 `SyntaxError`，同其它 `thisScene` 方法）：
  - `getCameraTransforms()` → 新的普通对象，键序 `eye, center, up, zoom`，三个 `Vec3`（`this.vector(…, 3)`）与 number；
  - `setCameraTransforms(t)`：没有参数或 `t` 不是对象（`null` 不算）返回 `false`；否则 `eye` / `center` / `up` 是对象就取 x / y / z
    （数字转 float32，不是数字记 0），`zoom` 是数字才取，交 `setCameraBase`，返回 `true`。
- **删除** `MISSING_SCRIPT_API.thisScene` 里这两项，`compile/camera.ts` 顶部注释同步。

## 点 4 — 文档

- `cocs/wpe/WPE_SCENE.md` 相机节、P3b 脚本 API 清单；`rea-p5-camera.md` 补「更正与补充」；changelog 与回归文档各一条。

## 验收

- 宿主 tsc 0 error；只跑相关 vitest（camera / state / script api / probe）。
- 单测：基准为重置值时正交帧与现状逐字节相同；`set` 下一帧进视图；非法项跳过；有相机对象 / 路径时不生效；重编译后恢复。
- 变异：正交无相机对象改回单位阵、`set` 同帧生效、zoom 不乘、非法项不跳过，各自被抓住。
- WPE 对照：E1–E6 的生成工程两边整帧逐像素比；2887 复制工程按日志光标回放，与 `A:\p6d3\2887\` 的四帧比（镜头位置与黑框消失）。
- 测完移除自己导入的测试行。

## 合并注意

P6d3a 还没提交，改了 `render/state.ts`、`render/scene.ts`、`render/camera.ts`（相机对象按对象表取最后一个可见的）、
`script/api.ts`、`host.ts`。本阶段等它提交后基于新 HEAD 实现；若要并行，在 HEAD 快照里做再三方合并。

## 实施记录（2026-11-15）

**实现**（子代理按点 1–3，Claude 补探针）：
- `compile/bindings.ts`：`BindingTarget` 加 `{ kind: "camera-base"; field }`、类型 `CameraBaseField`。`compile/camera.ts`：`SceneCameraJson.given`（JSON 里是不是字符串），缺省当全给了。
- `render/state.ts`：`cameraBase` 与 `cameraLoaded`、`ORTHOGRAPHIC_CAMERA_BASE`、`constructedCameraBase()`、`beginScriptInit()` / `finishScriptInit()`、`write` 的 `camera-base` 分支（float32、不标脏）。
- `render/camera.ts`：`sceneCameraFrame` 正交无相机对象时基准是重置值且 zoom 1 走原快路径（`isOrthographicResetBase`），否则走 `orthographicCameraObjectFrame`；`stepCameraSource` 加可选 `base`。`SceneCameraInput.state.cameraBase` 是可选的（手写 state 的旧测试不带）。
- `script/api.ts`：`installCameraTransforms`；`script/runtime.ts` / `host.ts` / `script/stateWrite.ts`：目标键 `general/camera/<字段>`、读写；`host.ts` 首次加载（含清空脚本存储后重建）在 `fromBundle` 之后 `beginScriptInit`、`ensureRuntime` 之后 `finishScriptInit` 并 `forgetWrite` 被覆盖的字段（放在代数判断之前：被取代的加载也跑过 `init`）；`dev/probeScripts.ts` 同样包住 `init`。
- `compile/scriptApi.ts`：缺口表去掉两项。
- **偏离（Claude 验收时补）**：`dev/particleCorners.ts` 的 `probeCameraObjects` 原来没有相机对象时返回 undefined，探针回放就走旧的正交分支、不读基准（`p5e-a` 第一次回放镜头不动）。改成总返回（图层表为空），`sceneCameraFrame` 在空表、基准没改过时和旧分支逐项相同（单测钉住）；`p5d3-camera.test.ts` 的对应断言改成「图层表为空」。

**验收**：
- 宿主 tsc 0 error；相关测试（`p5e-camera-base` 26 条、相机 / 状态 / 脚本 API / 宿主脚本 / `src/dev` 全部）通过。`compile/scriptApi.test.ts` 的 2 条 3304642534 失败是既有的（期望里还有 P6d3a 已实现的 `sortLayer`），与本阶段无关。
- 变异（`ignore/p5/e/mutate_e.py`）：正交恒走快路径、基准 zoom 不乘、透视不取状态、非数字分量不记 0、null 当对象、收尾不覆盖、收尾不返回覆盖字段、init 前不换构造缺省、透视忽略 given、写入不转 float32，10 个都被抓住；API 层 zoom 不转 float32 没抓住，是等价变异（状态写入再转一次）。
- 和 WPE 整帧对照（`ignore/p5/e/out/`，抓帧 `A:\p5e\`）：`p5e-a`、`p5e-cam` 0 差；`p5e-persp` 屏蔽 FR / CLK 后 0 差；`p5e-par` 的 `g_EyePosition` 与缩放逐位相同，视差点差 7e-5，原因是日志只到第 150 帧、第 151–159 帧 dt 平分（视差平滑按 dt 累积），120 个像素是方块 B 的上下边；2887099508 解包副本按日志与逐帧光标回放，第 263 / 319 / 419 帧整体位移 0，81 段脚本无错，余差来自樱花粒子随机数与视频时刻。
- 测试行 15303–15307 已移除。
