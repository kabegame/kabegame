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

### 步骤 1 — 容器时长（2026-11-13）

在独立工作树里实现（`ignore/p9/p9b/wt`，基点 `3c4f723b`），子代理写、我复核。
- **新增** `video/container.ts`：
  - MP4：顶层盒子与 `moov` 的子盒子只读头，`mdat` 按大小跳过，找到 `mvhd` 读前 32 字节，v0 / v1 各取 timescale 与 duration。
  - Matroska：读到 `Segment` 开头往后 64 KiB，在内存里找 `Info`。
  - 上限：顶层盒子与 `moov` 子盒子各 64 个，EBML 头 4 KiB。
  - 超出计划的一处：`duration` 为 0（分片 MP4）也当读不出，不给脚本一个 0。
- **修改** `SceneVideoSource` 加 `duration?`；`parseTex` 在要解码时填它。
- **单测**：`container.test.ts` 与 `tex.test.ts`，覆盖：
  - 构造的 MP4 / Matroska 各种形态与畸形输入；
  - 散文件与 pkg 条目的完整读序列；
  - `decode` 为假不读；
  - 编译后 bundle 里带 `duration`。
- **复核**：
  - 改动范围：工作树里 5 个文件（3 改 2 新增），没有越界；
  - tsc 0 error；container / tex 两个测试文件 65 个全过；
  - 全量 vitest 唯一失败是 `pipeline.test.ts` 的「3830255100：219 次请求」，HEAD 基线同样失败，这张场景没有视频；
  - Prettier 通过。
- **语料**：60 段视频（59 MP4 + 1 Matroska），TS 读出的时长和 `durations.py` 的 `mvhd` / Matroska 结果逐段相同，差值全是 0（`ignore/p9/p9b/step1/corpus.ts`，我重跑过）。
  - 每段读 4 次的 38 段、6 次的 21 段（就是 `moov` 在 `mdat` 之后的那 21 段）、Matroska 2 次；
  - MP4 每段 80 或 112 字节，Matroska 约 64 KiB。
- **请求数**：`pipeline.test.ts` 的语料编译（173 张）在工作树与主工作区各跑一次，逐场景比 `calls` / `misses` / `bytes` 全部相同。
  - 退回的场景不读时长；
  - 能渲染的视频场景读的那几段头落在已经缓存的 pkg 窗口里。
  - 主工作区里别的会话有未提交的粒子改动，所以有 11 张的不支持项不同，都是 `particle:binding:*`，与本步无关。
- **变异检查**（`ignore/p9/p9b/step1/mutate.py`），8 个全被单测抓到：
  - v0 / v1 的 timescale 偏移；
  - 不按大小跳过盒子；
  - TimecodeScale 缺省值；
  - 4 字节 Duration；
  - 未知长度的 Segment；
  - `decode` 为假也读；
  - 区间不加 mip 偏移。

我改了子代理的一处：它让 `decode` 为假时也读时长，理由是「纹理描述和能渲染时一致」。可那时场景已确定退回、不渲染、脚本不跑，没有人用时长，和编译的快速路径相反，改成只在要解码时读。

### 步骤 2 — `IVideoTexture`（2026-11-13）

工作树挪到 `3552dba5` 后，子代理实现点 2–4，我复核并补了两处。
- **播放器**（`video/player.ts`）：
  - 时长取容器时长、结束时报容器时长、写入上界按容器时长；
  - 不想放时不交帧（标志留到 `play()` 之后）；
  - `isPlaying` 不看 `failed`、`fail` 清 `wantPlay`。
- **包装对象**（`script/api.ts`）：
  - 每个图层都有 `getVideoTexture`，「是不是视频图层」用 `layerVideoSource` 只看 bundle；
  - 成员按 WPE 的顺序，类型照实测；
  - 结束回调登记在当时取到的播放器上，经 `ScriptRuntime.callFor`（新类别 `ended`，出错不禁用）进入登记它的脚本的上下文。没有播放器（语料诊断）或没有当前脚本时不登记。
- **宿主**：
  - `video` 落点：按 `this.scriptBundle` 找视频源，再经 `SceneVideos.playerFor` 按区间键取；
  - `dev/scriptErrors.ts` 的回调前缀加上 `ended`，dev 语料按根因归类时不算成 other。
- **我补的一处**：「清空脚本存储」重启脚本时，播放器原样保留，上一轮脚本设的 `loop`、`rate`、暂停和结束回调也都还在。新脚本拿到的包装对象却是缺省值，两边对不上，旧回调还拖住旧的脚本环境。
  - 加了 `VideoTexturePlayer.resetScriptState` / `SceneVideos.resetScriptState`：清回调、`loop` 真、`rate` 1、想放、判定重装，不 seek；
  - 宿主在 `restartScriptsWithClearedStorage` 里调。
- **复核**：
  - 13 个文件（12 改 1 新增），没有越界；tsc 0 error；Prettier 通过；
  - 全量 vitest 2698 个只挂基线那一条（3830255100 的 219 次请求）。
- **变异检查**：子代理 10 个全抓到。我另做 11 个（`ignore/p9/p9b/step2/mutate.py`）抓到 10 个，漏的是「宿主按新 bundle 而不是脚本在用的 bundle 找视频」。原因是宿主测试里那个图层在新旧 bundle 里指向同一段视频。补了一个「重编译让图层换了视频」的用例之后抓到。
- **挪到 `ef452f49`**：P8 步骤 3 在 `layer()` 同一位置加了 `alignment`，两边都留；其余文件不重叠。挪完 tsc、全量 vitest 结果同上。
  - 提交前又挪到 `905b4a78`（P6b 1e-2 改了 `host.ts`），没有冲突；tsc 0 error，全量 vitest 2767 个只挂基线那一条。再挪到 `2edac843`（P11 在
    `host.ts` 加了两行注释），没有冲突；tsc 0 error，视频 / 脚本 / 宿主的测试 238 个全过。
- **留给步骤 3 的提醒**：这 6 张场景已经不报 `script:api:layer.getVideoTexture`，但都还报 `script:api:particle.play` / `pause` / `stop`。原因是有粒子层的场景里，这几个名字不论接收者都按 `PARTICLE_LAYER_METHODS` 报，视频包装对象上的调用也算进去了。要等 P4f 实现粒子层的这几个方法后才消失；P9b 不改这张表。

### 步骤 3 — 真机对照（2026-11-13）

**做法：**
- **Kabegame 版工程**：六个测试工程各生成一份（`ignore/p9/p9b/kbvariant.py` → `proj-kb/`），脚本里的 `console.error(...)` 改成写进脚本环境的数组。原因是宿主对 `console.error` 按脚本每分钟限 10 条，逐帧记录会被吞掉。测完经 dev 探针从脚本 realm 读出。
- **拷贝记录**：用一行临时插桩（`// DEBUG-p9b`，在 `dev/install.ts` 把宿主实例交给探针，已删）从外面包住宿主的 `videoSink.drawn`，记录每次拷进纹理时的场景时间与元素时间。
- **运行环境**：在主窗口预览里跑（用户同意暂时关掉开着的 13543 预览，测完恢复）。
- **6 张语料场景**：用 dev 的强制渲染。标记只在打开预览前一刻设上，新宿主读到后立即删掉；应用背景 14317 没有不支持项，不受影响。

**测试工程和 WPE 比（WPE 真值见 p9-REPORT「P9b 步骤 0 的补测」）：**

| 工程 | 结果 |
|---|---|
| `p9b-api` | 类型逐项相同：`isPlaying()` 布尔、`loop` 数字、`duration` 2.5169999599456787、自有属性与顺序、同一对象、`play.length` 0、回调 `arguments.length` 0。暂停、stop、`rate = 5`（每帧 0.23–0.24 / 0.048 s）、`loop` 为假停在 2.517、结束后 `play()` 回 0、seek 2.0 后再结束，都和 WPE 一致 |
| `p9b-api2` | 暂停 8.00 s 到 `play()` 9.50 s 之间一次拷贝都没有，9.5015 s 那一帧拷进 1.8；第二次暂停期间连 seek 两次，12.0015 s 那一帧拷进 2.0；stop 后画面停在 stop 之前那一帧，13.6053 s `play()` 那一帧拷进 0；同一帧 seek 1.0 再暂停，画面停在 seek 之前，15.2026 s 那一帧拷进 1.0 |
| `p9b-long` | `duration` 2.549999952316284；时钟走到 2.55 才绕回；`loop` 为假停在 2.55 |
| `p9b-real` | `duration` 10.005332946777344；`loop` 为假停在 10.005333（报的是容器时长）；绕回在 9.983（Chromium 的结尾，WPE 10.005，已知差异 22 ms） |
| `p9b-switch` | 被暂停那段的时间当帧冻结、`isPlaying` 假；切回来那一帧显示冻结时的画面，之后接着走、不追赶 |
| `p9b-preset` | `init` 读到 2.549999952316284、时间 0；之后每帧 `play()`，`isPlaying` 恒真，`alpha` 1、可见；每次时间到 `duration − frametime` 时脚本自己跳回 0，和 WPE 同一条规则（我们 60 Hz 在 2.52–2.53 跳，WPE 20 fps 在 2.50 左右跳）；没有脚本报错 |

**和 WPE 不同的地方：**
- **离当前位置不到一帧的 seek**：我们生效（0.3、0.5），WPE 忽略。已定不复刻。
- **报错文字与原型**：写 `duration` 抛的 `TypeError` 文字不同；包装对象的原型是 `Object.prototype`，WPE 是一个只有 `constructor` 的类原型。
- **`loop` 改回真后立即 `play()`**：这一帧读到 0，WPE 读到 2.517，下一帧两边都从开头放。原因是 Chromium 的 `play()` 在结尾处直接回到 0。
- **seek 后读回的精度**：Chromium 只到微秒，读到 1.549999，WPE 是 1.550000。
- **视频比场景时钟早**：场景开始时视频已经走了 0.3–1.4 s，WPE 约 0.02 s。原因是 P9a 的「第一次 ready 前等首帧」，加载期间视频已经开始放；3326873240 里另 4 段在被脚本暂停前多放了约 1.4 s。不是 P9b 引入的。
- **恢复播放后第一帧要等约 255 ms**（新发现，见下）。

**语料 6 张（强制渲染）：**
- **3326873240**（13574）：20 点时，脚本选中的「dusk」那段在放、图层可见，另 4 段被暂停、隐藏。报错全是别的未实现接口（`getParent`、`getTransformMatrix`、`getTextureAnimation`、`input`），没有和视频有关的。
- **3470764447**（13592）：脚本用 `>=` / `<` 判时段，20 点落到「night」，只有它在放、可见。
- **3361965869**（13581）：经宿主把速度属性改成 2.5，播放器速率随之 2.5，视频每秒前进 2.501 s；测完改回 1。
- **3276911872**（14287）：预设脚本挂在对象 96「2」上，它的槽 0 是普通图片 `人物.tex`，`getVideoTexture()` 返回 `null`，`init` 的 `video.stop()` 与 `update` 的 `getCurrentTime()` 报错。在 WPE 测试窗口里开同一张，`log.txt` 里正是同样两条（`line 202` / `line 117`，列号差 1）。场景里真正的视频照常放。
- **3243449890**（13569）：强制渲染时建管线失败（顶点输出 location 16 超出 WebGPU 上限），整张退回，和视频无关。它的预设脚本和 3276911872 逐字相同，已由 `p9b-preset` 验过。
- **3605722997**（14296）：两段视频脚本里唯一的报错是 `input is not defined`（未实现的 `input`）。画到的两段在放，没画到的两段照 30 帧规则暂停（`wantPlay` 仍为真）。
- 计划里「3326873240 在 WPE 测试窗口目视比当前时段」没做：时段由脚本按本地时间选，两边跑的是同一段脚本，上面已核对选中的是哪段。

**语料扫描**（`kbp corpus scan`，快照 `2edac843` → `187f41c9`，只差步骤 2）：173 张里只有这 6 张各去掉 `script:api:layer.getVideoTexture`，没有新键，干净的 57 张不变。脚本诊断的语料对比没跑。

**新发现：恢复播放后第一帧要等约 255 ms。**
- **轮换场景里**：`p9b-switch` 录到的 9 次切换里有 4 次，恢复播放后第一帧要过 0.264–0.27 s 才拷进来。这期间纹理停在冻结的那一帧，之后跳到跟上的位置；其余 5 次在切换那一帧就接上了。
- **主窗口页面里的对照**（同一段测试视频，暂停后恢复，量到第一次 `requestVideoFrameCallback`）：

| 元素 | 暂停 0.7 s | 暂停 2 s |
|---|---|---|
| 不挂 DOM（现在的做法） | 2–21 ms | 前 3 次 1–7 ms，之后 252–257 ms |
| 挂 DOM、2 px、`opacity: 0.01` | 1–22 ms | 3–21 ms |
| 挂 DOM、`opacity: 0` | — | 7 次里 5 次 253–257 ms |

- **原因**：看不见的视频（不在 DOM 里，或完全透明）在暂停一两秒之后恢复，要等 Chromium 视频合成器的后台渲染（约 250 ms 一次）才出第一帧。
- **影响范围**：P9b 的多段切换，以及 P9a「图层隐藏超过 30 帧暂停、再显示时恢复」。
- **修正**（2026-11-13 用户同意，`video/player.ts` 的 `attachToDocument`）：每个元素挂进宿主页面，放在最上层（`z-index` 最大），左上角 2 px、1% 不透明、不接收指针，多段视频按已挂的个数横向错开 2 px。释放时撤下。
  - 先按「最底层」做了一版：宿主里 12 次恢复仍有 6 次约 255 ms。原因是视频被场景的 WebGPU 画布整个盖住，合成器把它裁掉不画，又落回后台渲染。
  - 在同一个宿主里把层级调到画布上面，12 次都是 6–28 ms；改成最上层、重建宿主后，`p9b-switch` 15 次恢复都在 5–12 ms 内出第一帧。
  - 混进画面的只有左上角 2×2 像素、1% 不透明，8 位输出里最多差 3 级。
  - 单测：注入的 `attach` 构造时调一次、释放（dispose 或失败）时撤下一次；`attachToDocument` 的样式、标记、错开与没有 `body` 时不挂。全量 vitest 2769 个只挂基线那一条。
  - 没验：
    - 壁纸窗口：用户当前的壁纸 14317 没有视频，不能替用户换壁纸；
    - P9a「隐藏超过 30 帧再显示」的恢复：走的是同一个元素与同一条 `play()`，没另测。
  - 测完删了测试行 14444。主窗口恢复到 13543 的预览之后，被别的会话换成了 14448 的预览，没再动。

**我的失误：**
- 生成 Kabegame 版时排除了整个 `shaders` 目录，本意是不拷 WPE 生成的缓存，结果测试工程自带的 `kbp_clk` 着色器也没了，场景退回（`shader:kbp_clk:missing`）。改成照拷。
- `p9b-api2` 里对 `video.getAnimation` 的探测让编译期扫描报 `script:api:object.getAnimation`（它按名字认 `IObject.getAnimation`），整张退回。Kabegame 版去掉了这句，视频对象上的 `getAnimation` 由单测覆盖。这个名字只在视频对象上调用时是误报，语料里没有这样用的。
- `p9b-switch` 的拷贝记录装得晚，前几次切换没录到，之后补录了 12 次。

### 步骤 4 — 收尾（2026-11-13）

- `cocs/wpe/WPE_SCENE.md` 视频纹理一节：
  - 编译、播放器、脚本、宿主四行补上 P9b；
  - 播放规则加暂停期间不取帧与容器时长；
  - 新增「元素挂进宿主页面」一段与「脚本 `IVideoTexture`」小节（成员表、属性顺序、`null` 的情形）；
  - 已知差异改写时长一条，并加入 seek、脚本细节、视频比场景时钟早三条；
  - 语料一段补上 6 张的结果。
- `cocs/README.md`：视频纹理条目补 P9b 的要点，适用场景接上脚本相关的排查。
- `versions/latest/regression.md`：新增「场景壁纸脚本控制视频（P9b）」W0–W8。W7（桌面上的视频恢复）、W8（清空脚本存储）待测。
- `versions/latest/changelog.md`：开发侧一条。用户侧不加：用到脚本控制视频的 6 张仍退回预览图；恢复不停顿属于还没发布的「场景壁纸支持视频」那一条。
- 总计划与 `PLAN.md` 的 P9 一句。

留给 P9c：
- 多实例开销（回归 V7）；
- 674 MiB 级视频每次加载整段落盘。

其余未做：
- 时钟跑到 `mvhd` 的那 22–40 ms（决定 1，不补）；
- 视频比场景时钟早（P9a 的首帧等待）。
