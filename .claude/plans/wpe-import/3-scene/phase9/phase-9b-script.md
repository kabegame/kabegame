# P9b — 脚本控制视频（子计划）

> 上级：[P9 总计划](phase-9-video.md)「P9b」。依据：读码 [rea-p9-video](rea-p9-video.md) 第 6 节；实测 [p9-REPORT](p9-REPORT.md)「脚本 API」与「P9b 步骤 0 的补测」。
> 现状行号按 HEAD `35b96c9d`。`script/api.ts`、`script/runtime.ts`、`host.ts` 工作区里有别的会话（P4f）未提交的改动，实现在独立工作树里做，再三方合并（同 P9a 步骤 2–4）。

## 总体设计思路

在 WPE 里，脚本经 `thisLayer.getVideoTexture()` 拿到的 `IVideoTexture` 是挂在图层上的一个包装对象：
- 每个图层只建一次，之后返回同一个对象；
- `rate`、`loop` 是它自己的字段，写入时转给播放器；
- 其余成员直接调播放器：`play`、`pause`、`stop`、`setCurrentTime`、`getCurrentTime`、`isPlaying`、`duration`、`addEndedCallback`。

我们照这个结构做：
- **入口**：`ScriptApi.layer()` 给每个图层装上 `getVideoTexture`。图层基础材质的槽 0 是视频纹理时，第一次调用建包装对象、缓存在图层上；不是视频时返回 `null`。「是不是视频图层」只看 bundle，不看播放器在不在。这样语料诊断和 `realmProbe` 这些没有播放器的场合也拿得到对象，方法空操作，同声音层的写法。
- **播放器**：包装对象不持有播放器引用，每次调用经宿主按视频的磁盘区间现找。`SceneVideos` 本来就按这个区间键复用播放器，所以重编译换了 bundle、换了纹理下标也接得上，不新增状态。
- **结束回调**：经脚本运行时调用，进入登记它的那段脚本的上下文，出错只记诊断，同计时器。

P9a 已经把播放器的脚本接口备好：`play` / `pause` / `stop`、`rate`、`loop`、`currentTime`、结束回调与它的判定。这一节只补和 WPE 不一致的四处，依据都是步骤 0 的补测：

1. **时长**：
   - WPE 报的是 MP4 `mvhd` 里的时长，不看编辑列表。Chromium 的 `video.duration` 按各轨编辑之后算。语料 59 段里有 21 段要短 22–40 ms，其余有毫秒取整的差。
   - 脚本在 `init` 里就读 `duration`，WPE 会为此等最多 3 s 元数据。我们的脚本 `init` 跑的时候 Blob 多半还没读完（18–781 ms）。
   - 所以时长在编译期从容器头读出来，随 bundle 交给主线程，`init` 里同步可用。
2. **暂停期间的画面**：WPE 脚本暂停或停止之后不再取帧，期间 seek 读回的时间会变，画面不变，到 `play()` 那一帧才换。我们的播放器在 `seeked` 时置新帧标志，下次画到就拷。这里改成「不想放时不交帧」，标志留到 `play()` 之后。
3. **类型**：
   - `isPlaying()` 是布尔；
   - `loop` 读出来是数字 0 / 1；
   - `rate`、`duration`、`getCurrentTime()` 是 float32；
   - `duration` 只读；
   - 自有属性的顺序照 WPE，另有一个返回 `undefined` 的 `getAnimation`。
4. **解不了的视频**：`isPlaying()` 为假，脚本 `play()` 之后为真（WPE 探测失败时不置「想放」，`play()` 照常置）。P9a 是一律为假。

不复刻、写进已知差异的两处 MF 行为：
- **时钟跑到 `mvhd` 才绕回或结束**：这 22–40 ms 里 WPE 停在视频最后一帧，时钟继续走。Chromium 在自己的时长处绕回。语料里用脚本的场景都不靠时间走到结尾，见「决定」1。
- **seek 目标离当前位置不到一帧时被忽略**：规则只有两个样本，不猜。

## 现状锚点

**a. `getVideoTexture` 在缺失表里，用到就整张退回**（`compile/scriptApi.ts:130`）
```ts
    // 纹理动画、视频、动画层、骨骼与混合形状（W5 / P6）
    ...methods(
      "any",
      [
        "getTextureAnimation",
        "getVideoTexture", // 现状：报 script:api:layer.getVideoTexture
        "getAnimationLayerCount",
```

**b. 图层 API 对象只有字段和声音层的方法**（`script/api.ts:175`、`:238`）
```ts
  layer(object: number): ApiObject | null {
    // … name、id、size、LAYER_FIELDS
    if (this.isSoundLayer(index)) this.installSound(api, index);   // 现状：声音层的落点经 access.sound 现取
    this.layers.set(object, api);
    return api;
  }
  private installSound(api: ApiObject, object: number): void {
    const target = () => this.access.sound?.(object) ?? null;      // 现状：没有播放器时方法空操作
    this.method(api, "play", () => { target()?.play(); });
```

**c. 宿主只接了声音**（`host.ts:537`）
```ts
        // 声音层的 play / pause / stop / isPlaying（P6a 步骤 2）：每次调用现取，重编译重建的排期器也接得上
        sound: (object) => this.sceneSounds?.scheduler(object) ?? null,   // 现状：没有 video
```

**d. 视频的位置只有区间**（`video/player.ts:22`、`compile/tex.ts:371`）
```ts
export interface SceneVideoSource {
  path: string;
  start: number;
  end: number;     // 现状：没有容器时长
}
// tex.ts
  const video =
    flags & TEX_FLAGS.video && first
      ? { path: file.location.path, start: …, end: … }   // 现状：Worker 一个字节都不读
      : undefined;
```

**e. 播放器的时长、结尾、交帧、isPlaying**（`video/player.ts:195`、`:290`、`:319`）
```ts
  drawn(frame: number, hostPaused: boolean): HTMLVideoElement | null {
    // …
    if (!this.fresh || this.failed) return null;   // 现状：脚本暂停期间 seek 完也交帧，画面跟着变
    this.fresh = false;
    return this.element;
  }
  get currentTime(): number {
    return this.element.currentTime;   // 现状：结束时是 Chromium 的时长，不是容器时长
  }
  get duration(): number {
    return this.element.duration;      // 现状：元数据之前 NaN；之后按各轨编辑后的长度算
  }
  isPlaying(): boolean {
    return !this.disposed && this.wantPlay && !this.failed && !this.element.ended;   // 现状：失败后 play() 也是假
  }
```

**f. `SceneVideos` 只能按纹理下标取播放器**（`video/sceneVideos.ts:89`）
```ts
  /** 这个纹理下标的播放器（P9b 的 `getVideoTexture` 经它拿 `IVideoTexture` 的底层），没有时 null。 */
  player(texture: number): VideoTexturePlayer | null {   // 现状：下标随重编译变，脚本侧拿不稳
```

## 点 1 — 容器时长（新增 `video/container.ts`；修改 `video/player.ts`、`compile/tex.ts`）

- **新增** `containerDuration(read, length)`：
  - **MP4**：
    - 逐个读顶层盒子的 8 / 16 字节头，`mdat` 按头里的大小跳过、不读内容（语料 21 段的 `moov` 在 `mdat` 之后）；
    - 在 `moov` 里找 `mvhd`，按版本读 timescale 与 duration（v1 是 64 位），返回 `duration / timescale`。
  - **Matroska**：EBML 头 → `Segment` → `Info` 的 `TimecodeScale`（缺省 1000000）与 `Duration`（4 或 8 字节浮点），返回 `Duration × TimecodeScale / 1e9`。只看 `Segment` 开头 64 KiB 以内的顶层元素。
  - 头不认识、盒子越界、读不到：返回 `undefined`。不抛错，视频照常播放。
  - 一段视频最多十来次小区间读。
```ts
/**
 * 容器头里的时长（秒）：MP4 的 `mvhd`、Matroska 的 `Info.Duration`。WPE 的 `GetDuration` 就是它，不看编辑列表
 * （p9-REPORT「P9b 步骤 0 的补测」：3361965869 的原片 WPE 10.005333、Chromium 9.983333）。读不出时 undefined。
 */
export async function containerDuration(
  read: (start: number, end: number) => Promise<Uint8Array>,
  length: number,
): Promise<number | undefined>;
```
- **修改** `SceneVideoSource` 加 `duration?`。`videoSourceKey` 不变，仍是路径加区间。
```ts
export interface SceneVideoSource {
  path: string;
  start: number;
  end: number;
  /** 容器时长（秒，`containerDuration`，编译期读）；读不出时没有，播放器退回元素的时长（P9b）。 */
  duration?: number;   // 新增
}
```
- **修改** `parseTex`：有 `video` 且要解码时，用 `file.readRange` 相对 mip 0 起点读，填 `video.duration`。注释改成「只读容器头里的时长，视频字节由主线程读」。
  - `decode` 为假（场景已确定退回、不渲染、脚本不跑）时不读，同快速路径；dev 强制渲染时 `decode` 为真。

## 点 2 — 播放器（`video/player.ts`）

- **修改** `duration`：容器时长优先，没有时退回元素的。
```ts
  /** 容器时长（WPE 的 `GetDuration`，P9b 点 1），读不出时退回元素的（元数据之前 NaN）。 */
  get duration(): number {
    return this.source.duration ?? this.element.duration;   // 修改
  }
```
- **修改** `currentTime` 的读：结束时报容器时长。WPE 结束时读回正好等于 `duration`，脚本拿它和 `duration` 比。
```ts
  get currentTime(): number {
    const element = this.element;
    // 结束时 Chromium 停在它自己的时长（各轨编辑之后），WPE 停在容器时长（P9b 步骤 0）
    if (element.ended && this.source.duration !== undefined) return this.source.duration;   // 新增
    return element.currentTime;
  }
```
- **修改** `currentTime` 的写：上界用 `this.duration`（容器时长）减 0.005，元素自己再按它的时长钳。
- **修改** `drawn`：不想放时不交帧，标志留着，`play()` 之后第一次画到就交。
```ts
    // 脚本暂停 / 停止期间不取帧：seek 读回会变、画面不变，到 play() 那一帧才换（P9b 步骤 0，WPE 的 pause 结束工作线程）。
    // 空闲暂停（wantPlay 仍为真）照常交帧，同 WPE 工作线程照常取帧
    if (!this.fresh || this.failed || !this.wantPlay) return null;   // 修改：加 !wantPlay
```
- **修改** `isPlaying` 与 `fail`：失败时清 `wantPlay`，`isPlaying` 不再看 `failed`。
```ts
  isPlaying(): boolean {
    return !this.disposed && this.wantPlay && !this.element.ended;   // 修改：去掉 !failed
  }
  private fail(message: string, detail: unknown): void {
    // …
    this.wantPlay = false;   // 新增：WPE 探测失败不置「想放」、播放出错清掉它（rea 第 7 节）；之后脚本 play() 照常置真
```
- **修改** 文件头注释「留给 P9b」一条，改成实际的分工。

## 点 3 — `IVideoTexture`（`script/api.ts`、`script/runtime.ts`、`compile/scriptApi.ts`）

- **新增** `ScriptApiState.video` 与它的落点类型：
```ts
  /**
   * 视频纹理的播放器（P9b，宿主按图层槽 0 视频的区间从 `SceneVideos` 现取）：`IVideoTexture` 的方法接到它上面。
   * 不传或返回 null（语料诊断、播放器已释放）时方法空操作，`duration` 退回 bundle 里的容器时长。
   */
  video?(object: number): VideoScriptTarget | null;
```
```ts
/** `IVideoTexture` 的落点（`VideoTexturePlayer` 满足它）。 */
export type VideoScriptTarget = Pick<
  VideoTexturePlayer,
  "rate" | "loop" | "currentTime" | "duration" | "play" | "pause" | "stop" | "isPlaying" | "addEndedCallback"
>;
```
- **新增** `ScriptApi.layer()` 给每个图层装 `getVideoTexture`。
  - 写法：`this.method(api, "getVideoTexture", () => this.videoTexture(index))`；
  - 不是视频图层时返回 `null`，不缓存；WPE 也是每次重查。
- **新增** `videoTexture(object)`：缓存在 `videoTextures: Map<number, ApiObject>`。成员按 WPE 的顺序逐个 `define`，都可枚举。
  - **`duration`**：只读访问器，严格模式下写入抛 `TypeError`。值是 `Math.fround(落点.duration)`；没有落点时取 bundle 里的容器时长，再没有取 0。
  - **`loop`**：包装对象自己的字段，缺省真，读出 `1` / `0`。写入取 `Boolean(value)`，转给落点。
  - **`rate`**：包装对象自己的字段，缺省 1，读出 float32。写入取 `Math.fround(Number(value))`；不是有限数时不写，转给落点。
  - **`addEndedCallback(fn)`**：
    - 不是函数时抛 `TypeError`；
    - 登记时记下当前脚本，回调经运行时的 `callFor(脚本 id, fn)` 调用，不带参数；
    - 不去重，没有删除。
  - **`play` / `setCurrentTime(t)` / `stop` / `pause`**：转给落点，返回 `undefined`。`t` 取 `Number(t)`。
  - **`isPlaying()`**：落点的布尔值，没有落点时为假。
  - **`getCurrentTime()`**：`Math.fround(落点.currentTime)`，没有落点时为 0。
  - **`getAnimation()`**：返回 `undefined`。
- **新增** `ScriptRuntime.callFor(owner, fn)`：
  - 按脚本 id 找记录，走 `invoke(记录, "ended", fn)`：进入那段脚本的上下文、计时、出错记诊断；
  - 出错不禁用，同计时器；
  - 记录不在（已卸载）时不调。
- **新增** `ScriptApi.attachRuntime` 的参数类型加上 `callFor`。
- **删除** `compile/scriptApi.ts` 缺失表里的 `getVideoTexture`；`getTextureAnimation` 留着，归 P6。文件头的「已实现」一句补上 `getVideoTexture`。
  - 子对象的成员本来就不进表；
  - `api.test.ts` 的双向核对照常起作用。

## 点 4 — 宿主（`host.ts`、`video/sceneVideos.ts`）

- **新增** `SceneVideos.playerFor(source)`：按 `videoSourceKey` 取播放器，没有时 null。
- **修改** `SceneVideos.player(texture)` 的注释：脚本侧改用 `playerFor`，它只剩单测在用。
- **新增** `host.ts` 的 `video`：从 `this.scriptBundle` 按图层找槽 0 的视频源，再经 `playerFor` 取。重编译期间脚本还在用旧 bundle 时，区间键照样对得上。
```ts
        // 视频纹理的 IVideoTexture（P9b）：按脚本当前看到的 bundle 找图层槽 0 的视频，再按区间键取播放器，下标随重编译变也不受影响
        video: (object) => {
          const source = layerVideoSource(this.scriptBundle, object);
          return source ? (this.sceneVideos?.playerFor(source) ?? null) : null;
        },
```
- **新增** 纯函数 `layerVideoSource(bundle, object)`：图层 `passes[0].textures[0]` 指向的纹理带 `video` 时返回它。放在 `video/sceneVideos.ts`，`ScriptApi` 判「是不是视频图层」也用它。
- **修改** `dev/scriptCorpus.ts`、`dev/realmProbe.ts`：不传 `video`，包装对象照常建、方法空操作，语料诊断不会因为 `getVideoTexture()` 返回 null 多出报错。

## 决定（2026-11-13 用户：六条都按推荐）

1. **时钟跑到 `mvhd` 的那 22–40 ms**
   - 现状：语料 21 段 Chromium 比 WPE 早这么多绕回或结束，其中 9 段在 3326873240、3361965869、3470764447 里。这三张的脚本只 `play` / `pause` / 改 `rate`，不看时间走没走到结尾。
   - 推荐：**不补**，写进已知差异。结束时 `getCurrentTime()` 报容器时长（点 2），脚本拿它和 `duration` 比时结果和 WPE 一样。
   - 备选：播放器在这类视频上自己管循环。到 Chromium 的结尾后，用一个只在「在放」时走的虚拟时钟补到 `mvhd`，再 seek 回 0 或报结束。要多管一套状态，每轮绕回多一次 seek。
2. **暂停期间不交帧**
   - 推荐：照 WPE（点 2）。
   - 备选：保持 P9a，seek 完立即显示新画面。和 WPE 不同的只有脚本暂停期间那段时间显示的画面。
3. **类型照 WPE**
   - 推荐：照 WPE。`loop` 读出数字，`rate` / `duration` / `getCurrentTime()` 取 float32，`getAnimation` 返回 `undefined`。
   - 备选：`loop` 返回布尔，和 WPE 自带的 `.d.ts` 一致，但和实测的 WPE 不同。
4. **解不了的视频的 `isPlaying()`**
   - 推荐：照 WPE，脚本 `play()` 之后为真（点 2）。
   - 备选：保持 P9a 的一律为假。
5. **seek 目标离当前位置不到一帧时被忽略**
   - 推荐：不复刻，记已知差异（只有两个样本，规则说不准）。
6. **哪些图层有 `getVideoTexture`**
   - 推荐：所有图层都有，非视频图层返回 `null`。WPE 在文本、声音、粒子图层上有没有这个方法没查，语料只在视频图层上调。
   - 备选：只装在图像层上。

## 步骤与验收

### 步骤 1 — 容器时长（点 1）

- 单测（`video/container.test.ts`、`compile/tex.test.ts`）：
  - 构造的 MP4：`mvhd` v0 / v1、`mdat` 在前、64 位盒子大小、`moov` 里 `mvhd` 不在第一个；
  - 构造的 Matroska：`TimecodeScale` 缺省 / 给出、`Duration` 4 / 8 字节；
  - 截断、不认识的头：返回 `undefined`；
  - `parseTex` 给视频 `.tex` 填 `duration`。
- 我的验收：
  - 语料 60 段视频：TS 读出的时长与 `durations.py` 的 `mvhd` / Matroska 结果逐段相同；
  - 每段读了几次、多少字节，写进实施记录；
  - 语料扫描 `unsupported` 不变。

### 步骤 2 — `IVideoTexture`（点 2–4）

- 单测：
  - `player.test.ts`：容器时长、结束时的时间、暂停期间不交帧且 `play()` 后交、失败后 `play()` 的 `isPlaying`；
  - `api.test.ts`：
    - 非视频图层返回 `null`，同一图层同一对象；
    - 自有属性与顺序；
    - 各成员的类型与 float32；
    - `duration` 写入抛错，`rate` / `loop` 的写入转换；
    - 没有落点时空操作；
    - 结束回调在登记它的脚本上下文里调、不带参数、出错不中断；
    - 缺失表双向核对；
  - `host.test.ts`：重编译期间按旧 bundle 取到同一个播放器；
  - `sceneVideos.test.ts`：`playerFor`。
- 我的验收：
  - `git status` 查越界；
  - tsc、vitest 自跑；
  - Prettier；
  - 变异检查：去掉 `!wantPlay`、`currentTime` 不报容器时长、`loop` 改回布尔、回调不进脚本上下文。

### 步骤 3 — 真机对照（Kabegame 与 WPE 的真值）

- 六个测试工程（`ignore/p9/p9b/proj/`）导入 dev 库，在主窗口的预览里跑。脚本日志从宿主控制台取；显示的视频帧用临时插桩（`// DEBUG-p9b`，在 `copyVideo` 记每次拷贝时元素的时间），验完删。
  - `p9b-api` / `p9b-api2`：类型逐项相同。各动作后的时间、`isPlaying`、结束回调的时刻与次数和 WPE 一致。暂停期间 seek 后画面不变、`play()` 那一帧换。stop 后停在 stop 那一刻的帧。
  - `p9b-long`：时长 2.55、结尾 2.55，和 WPE 相同。
  - `p9b-real`：时长 10.005333 与 WPE 相同；结尾比 WPE 早 22 ms，是已知差异。
  - `p9b-switch`：冻结与切回接着放，和 WPE 一致。
  - `p9b-preset`：逐帧轨迹和 WPE 的 `log-preset.txt` 比：
    - 每次自己跳回开头的时刻与那时的时间；
    - `isPlaying`、`alpha`、`visible`；
    - 帧率不同（我们 144 Hz、WPE 20），按「跳回前最后读到的时间 ≥ duration − frametime」核对，不逐帧比。
- 六张语料场景在 dev 下强制渲染（`kabegame-dev-scene-force-render`）：
  - 脚本没有报错（宿主的脚本诊断）；
  - 3326873240、3470764447：当前时段只有一段在放，其余 30 帧后停，切换属性后换段；
  - 3361965869：改速度属性后播放器的速率跟着变；
  - 3326873240 在 WPE 测试窗口里同时开一次，目视比当前时段显示的是同一段。
- 语料扫描：6 张场景各少 `script:api:layer.getVideoTexture` 一个键，能渲染数不变（这 6 张还差别的节）。脚本诊断只在这 6 张上变。
- 测完删测试行（`projects_remove`），恢复「场景后处理」等设置，写进实施记录。

### 步骤 4 — 收尾

- `cocs/wpe/WPE_SCENE.md` 视频纹理一节加「脚本控制（P9b）」，写已知差异；`cocs/README.md` 的条目与适用场景补上脚本。
- 回归（`versions/latest/regression.md`）加 P9b 的项；changelog 开发侧一行（用户侧没有能直接看到的变化，这 6 张仍退回）。
- 总计划与本文件的实施记录，`PLAN.md` P9 一句。

## 和其它节的交界

- **P4f**：正在改 `script/api.ts`、`script/runtime.ts`、`host.ts`、`compile/scriptApi.ts`（粒子层的 `play` / `pause` 等）。
  - 粒子层的同名方法和视频无关。包装对象的 `play` 不在图层上，不撞名。
  - 实现在 HEAD 快照里做，再三方合并。
- **P6 的 `getTextureAnimation`**：WPE 里它和 `getVideoTexture` 共用图层上的同一个槽（rea 第 6 节），先调哪个，后调的就拿到前一个的对象。语料里一张纹理不会同时是视频和帧动画，这里各管各的。P6 实现 `getTextureAnimation` 时要看这一条。
- **dev 探针的确定性回放**：`renderFrame` 的 `videoTime` 换的是渲染器的 `VideoSink`，脚本对实时播放器的调用不影响回放的帧，这一节不改。

## 风险

1. **float32 让日志和现在不同**：`getCurrentTime()` 改成 float32 后，dev 探针与语料诊断里读到的时间末几位会变。这是照 WPE 的取值，不是回归。
2. **容器时长读不出**（不认识的封装）：退回元素的时长，`init` 里读到 NaN。语料 60 段都认得，没有这种情况。
3. **结束回调的时机**：在 `beginFrame` 里，早于粒子与脚本的 `update`，同 WPE。回调里改图层字段是写进 `SceneState`，和计时器回调一样，这一帧之内生效。

## 实施记录

### 步骤 0（2026-11-13）

补测见 [p9-REPORT](p9-REPORT.md)「P9b 步骤 0 的补测」。和 rea 第 6 节、总计划不同的结论：
- `loop` 读出来是数字；
- `getAnimation` 存在；
- 时长是 `mvhd` 而不是 Chromium 的值，语料 21 段差 22–40 ms；
- 暂停期间 seek 不换画面；
- seek 目标离当前位置不到一帧时被忽略。

我的失误（步骤 0）：
- 第一个工程 `p9b-api` 把暂停期间 seek 的目标设在 0.5，和暂停位置 0.4923 只差半帧，分不出生效没有；采样也是在开窗后几秒才开始，没采到那一段。`p9b-api2` 把动作推到 8 s 之后、目标离得远，开窗和采样在同一轮里发出，重测了一遍。
