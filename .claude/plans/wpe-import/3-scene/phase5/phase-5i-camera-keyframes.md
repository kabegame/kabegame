# P5i：相机对象字段上的关键帧

> 起因（2026-11-19，wpe p6 d/e 的语料清扫转来，用户让转给 P5）：`value:animation:camera` 挡住 `3554161528`（工坊，只差这一个键）与
> `3841310696`（myprojects，另有 P12 的 `puppet:draw-order`）。两张都是相机对象（`camera: "default"`、`fov 50`）的 `origin` 与 `zoom`
> 挂了联动的单次关键帧（开场推镜：zoom 3 / 0.4 → 1，同时平移）。P10a 时对相机对象的关键帧照报。

## 总体设计思路

相机对象的变换（`origin` / `angles` / `scale`，相机的 eye 取它的世界矩阵平移）是图层字段，`fov` / `zoom` 是 P5d 的就地目标 `{ kind: "camera" }`；
两者都已经有运行时状态（`SceneState.layers` 与 `SceneState.cameras`），属性绑定和脚本都写它们，渲染器每帧求相机时读。关键帧只是第三种写入方
（P10a），所以只要在关键帧收集里不再把相机对象整体照报，而是像灯对象（P13f2）那样按字段给就地目标：变换字段走 `layer`，`fov` / `zoom` 走
`camera`。

时序照 WPE（步骤 0 实测）：相机在帧开头求（脚本、关键帧之前），关键帧写的相机 origin 与 zoom **下一帧**才进视图——和 P10a 里关键帧写
`general.zoom` 晚一帧同理。我们的渲染器已经是「先求相机、后跑关键帧」，写进状态后自然晚一帧，不用另做。

关键决策：不新建相机专用的动画通道，复用 P10a 的播放器与 `SceneState.write`；`path` / `queuemode`（相机自己的路径条目）不在本步。

## 步骤 0 结果（2026-11-19）

工程 `ignore/p5/proj/p5i-cam`（生成器 `ignore/p5/h/gen_h.py`）：正交 1920×1080，相机对象 CAM 的 `origin` x 关键帧 0 → 600、`zoom` 1 → 2
（同一时钟：60 帧、loop、fps 30）；REF 方块的 `origin` x 挂同一份关键帧（+300），它这一帧画在哪就是这一帧的关键帧值。WPE 抓帧
`A:\p5i\cam\cam-frame205..207.rdc`，常量 `ignore/p5/h/cam-consts.json`，分析 `ignore/p5/h/cam_lag.py`。

| 帧 | 相机 zoom 反算的关键帧位置 | 相机 eye 反算的关键帧位置 | REF 本帧的关键帧位置 |
|---|---|---|---|
| 206 | 8.27 | 8.27 | 9.70 |
| 207 | 9.70 | 9.70 | 12.24 |
| 208 | 12.23 | — | 15.01 |

相机第 N 帧用的值 = REF 第 N−1 帧的值：origin 与 zoom 都晚一帧。

## 现状锚点

```ts
// compile/animations.ts collectWith 的 add
    if (isRecord(object) && isCameraObject(object)) {
      if (parsed) unsupported.add("value:animation:camera");   // 现状：相机对象上的关键帧一律照报
      return;
    }
```

## 点 1 — 关键帧收集（`compile/animations.ts`）

- 删掉相机对象整体照报；`targetOf` 对相机对象：变换字段（`origin` / `angles` / `scale` 等图层字段）给 `{ kind: "layer" }`，`fov` / `zoom` 给 P5d 的
  `{ kind: "camera", object, field }`；其余（`camera`、`path`、`queuemode` 等）落到 `value:animation:other`。参照灯对象的写法（`isLightObject` 那条）。
- 联动（`options.parent.key`）照常：语料两张都是 origin ↔ zoom 联动。

## 点 2 — 播放器写入

- 确认 `SceneAnimations` / `SceneState.write` 能写 `{ kind: "camera" }` 目标（P5d 的属性绑定已写它；若播放器的写入路径不认这个 kind，补上），
  变换字段写图层状态；相机求值（`render/camera.ts` 的相机对象）读状态，不读编译期值。

## 点 3 — 测试

- 收集：相机对象 origin / zoom / fov 的关键帧进列表（目标正确），`camera` 等其它键照报 `other`，不再有 `value:animation:camera`。
- 播放：写进状态后，下一帧的相机帧（`sceneCameraFrame`）用新值（晚一帧）。
- 只跑相关测试文件。

## 验收

- tsc、相关测试、变异（相机对象仍照报、fov/zoom 目标错成 layer）。
- `p5i-cam` 导入 dev，`render_scene` 按 WPE 日志（`[kbp]`）回放到 206、207、208 帧与 WPE 逐像素比；语料 `3554161528` 变干净、`3841310696` 只剩 `puppet:draw-order`。

## 实施记录（2026-11-19）

执行代理（sonnet）按本计划实现，Claude 独立验收。

**改动**（`apps/wpe-scene/src/`）
- `compile/animations.ts`：删相机对象整体照报的分支；`targetOf` 的 `camera` 参数传 `isCameraObject(object)`（`targetOf` 本来就支持）。变换字段走图层目标，`fov` / `zoom` 走 `{ kind: "camera" }`，`camera` / `path` / `queuemode` 落到 `value:animation:other`；联动不变。
- 过时注释：`compile/bundle.ts`、`compile/features.ts`、`compile/scripts.ts`。
- 播放器（点 2）**没改代码**：`animation/player.ts` 经 `SceneState.write` 写 `{ kind: "camera" }`，P5d 的属性绑定已在用这条路；`activeCameraObject` 读状态。
- 测试：`compile/animations.test.ts`（目标、登记顺序 fov / origin / zoom、值类型、联动、`other`、普通图层的 `zoom` 仍报 `other`）；`render/p5d3-camera.test.ts`（`SceneAnimations` 对真实 `SceneState` 跑一帧：写之前相机读旧值、写之后读新的 zoom 与 eye）。

**验收**
- tsc 0 错；相关测试通过（同 P5h 那一轮）。
- 变异 3 处全部检出：相机对象仍照报、`targetOf` 不传相机标志、`fov` / `zoom` 目标错成 layer。
- 画面：`p5i-cam` 按 WPE 日志与轨迹（`gap: "split"`，201–205 帧平分）回放到 206、207、208 帧，三帧都和 WPE 上屏帧整帧 0 差（屏蔽 FR / CLK）；我们的 206 对 WPE 的 207 有 95% 像素不同，比较是灵敏的。探针给出的关键帧位置 9.706 / 12.24 / 15.01 与步骤 0 的 REF 列一致。
- 语料：`3554161528` 变干净；`3841310696`（myprojects，默认语料不含，按目录单独扫）只剩 `puppet:draw-order`。
