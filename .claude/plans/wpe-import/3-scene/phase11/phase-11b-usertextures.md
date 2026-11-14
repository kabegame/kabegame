# P11b — 用户纹理（子计划）

> 上级：[phase-11-audio-media.md](phase-11-audio-media.md)「P11b — 用户纹理」。
> 调研：
> - 整节的步骤 0：读码 [rea-p11-textures.md](rea-p11-textures.md) 第 1、2 节，实测 [p11-REPORT.md](p11-REPORT.md)「属性纹理」。
> - 本节的补充调研（步骤 0b，2026-11-14 做完）：读码 [rea-p11b.md](rea-p11b.md)，实测 p11-REPORT「P11b 补测」。
>
> 开发照 P11a，在 HEAD 快照的副本里做（`ignore/p11/b/head` 基线、`ignore/p11/b/ov` 副本），做完 `kbp snapshot diff` 出补丁，`git apply --3way` 移进工作区。
> 现状行号按 HEAD `d58a7048`（`bundle.ts`、`features.ts`、`graph.ts`、`scene.ts` 工作区与 HEAD 相同；`host.ts` 工作区有别的会话的改动）。
> 语料清点：`ignore/p11/b/ut_slots.py` → `ignore/p11/b/ut_slots.json`（明细 `ut_detail.py`，解锁估算 `unlock.py`）。

## 总体设计思路

`usertextures` 让材质的某个纹理槽在运行中换成场景外的图。WPE 只有一套做法：
- 加载材质时，每个有效项登记成「槽号 → 来源」。来源有三种：用户属性、系统伪属性（封面）、快捷方式。
- 来源的值变了，setter 把材质记进待刷新集合。下一帧开头，材质管理器重跑这个材质的纹理解析。
- 解析时每个槽按当前值取纹理：
  - 值为空、文件不存在、读不出来都回缺省纹理，不保留上一张；
  - 取到的纹理是源图正中裁出的最大矩形，比例取「参考尺寸」，像素一比一；
  - 格式 `R8G8B8A8_UNORM`、1 级 mip。
- 槽 0 换了纹理时，图层的就绪回调重跑。

P11b 照这个形状做，三种来源一个机制，这一节只接属性来源。P11c 加封面，P11d 加图标，都只是往同一张来源表里放数据。

**编译期**只做两件事：
1. 解析 `usertextures`，每个生效的槽记一条 `UserTextureSlot`：
   - 来源与名字；
   - 参考尺寸的取法，四种：
     - 缺省纹理的图像尺寸，精灵表取帧尺寸；
     - instanced 取对象 `size`：WPE 把它写进 `instance.usertexturereference`，实测 M2；
     - 显式的 `usertexturereference`；
     - 缺省是被依赖图层的合成 RT 时取那张 RT 的尺寸，要到渲染期才知道，实测 M3。
   - 缺省纹理的寻址与过滤位：建出来的用户纹理沿用，GIF 另强制点采样。
2. 把来源名登记进绑定表，目标是一种新的就地目标 `user-texture`。用户改属性走就地路径，不重编译。

缺省纹理照旧编进 `ScenePass.textures`。

**运行时**由新模块 `src/usertex/` 持有来源表：
- 每个来源（属性名）一份当前值。
- 已裁好的 GPU 纹理按 WPE 的纹理名缓存：`值 + "x" + round(比例·10)`。比例四舍五入到 0.1 相同的槽共用一张，按先建的那个槽的精确比例裁。
- 读文件、解码、裁切在主线程异步做，做完交给 `GpuScene`，下一帧 `sync` 换上。
- `GpuScene` 解析纹理来源时多一层查找：槽上登记了用户纹理、当前有图，就用那张图和它的尺寸（图像尺寸 = 纹理尺寸 = 裁后宽高）；否则用缺省纹理。

换上之后要更新的东西分三类：
- **任一槽换图都要做的**：
  - 这一处的 bind group 和 `g_Texture<n>Resolution` = `(w, h, w, h)`；
  - 组合层（passthrough 模型）与 instanced 的 `g_Color4`、`g_Alpha`：这个 pass 有任一槽的用户纹理生效时强制为 1，回到缺省时恢复对象值。WPE 每次绘制现读这一位（rea-p11b 4.3）。
- **图像层的槽 0**（语料 121 项）：WPE 的就绪回调按新纹理重算：
  - UV 上界：图像尺寸 / 纹理尺寸，用户纹理是 1（实测 M1）；
  - UV 内缩：`0.15 / 新纹理尺寸`；
  - 合成 RT 与 effect fbo：instanced 的合成 RT 是裁后用户图的尺寸（M2）；
  - `fullscreen` 的尺寸；
  - 被依赖图层的独占 RT 清掉重建。

  这些都在建渲染计划时定，所以槽 0 换图走现成的整层强制重建 `rebuildLayer(…, { force: true })`，P6b 文本重排已经在用。`autosize` 的图层尺寸取参考尺寸，换图前后不变。
- **其它槽**（144 项，几乎都是 effect 实例 pass 的槽 1）：不重建，只换 bind group 和常量。

**数据通路**照网页壁纸的 `file` 属性：
- 后端 `user_props.rs` 认 `scenetexture`。值是绝对路径，照 WPE 统一成 `/` 分隔（rea-p11b 1.3），存进 metadata 的 `userProperties`。
- 面板给文件选择，过滤照 WPE：只有 `*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4`，rea-p11b 1.2。WPE 也只给这一条，所以没有「WPE 收、我们解不了」的格式。
- 场景宿主的 `file:` 范围加上库内场景各自选中的纹理文件，按当前 metadata 覆盖。
- 宿主照现有属性管线收到新值。`applyChanges` 按绑定表把它交给 `usertex`，同时照 WPE 进 `applyUserProperties`：UI 的增量带 `type`。

**解码**：
- 静态图用浏览器：`createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "from-image" })`，再 `copyExternalImageToTexture`。实测 M7：
  - 8 位 PNG（调色板 + `tRNS`、灰度 + alpha）、16 位 RGBA PNG（取高字节）、BMP、ICO 与 FreeImage 逐像素相同；
  - JPEG 的 EXIF 方向一致。
- **PNG 的 `gAMA`**：宿主自己读这一块。`|2.2·g − 1| ≥ 0.05` 时，对 RGB 查 libpng 的 8 位表 `floor(255·(i/255)^(1/(2.2·g)) + 0.5)`，实测 M9 与 WPE 逐像素相同。
- GIF 与视频的扩展名判断不分大小写，见步骤 4。

**关键决策：**
- **解码是异步的，WPE 是同步的。** WPE 在下一帧开头同步读文件、建纹理，同帧画出；我们解码完成后的下一帧才换上，晚几帧。这是浏览器里不可避免的差异，记为已知差异。
  - 首次加载：解码完才算 `ready`，第一帧就是新图；
  - 确定性回放：dev 探针等解码完再画。
- **已知差异**（解码库不同，补不出来）：
  - JPEG 的色度上采样：WPE 的 FreeImage 3.18 自带的 libjpeg，与浏览器的 libjpeg-turbo 不同。色块边界上差到几十级，照片上很小，P11c 的封面也是这样。
  - 16 位灰度 PNG：FreeImage 按 `[min(255, 最小值), 最大值]` 拉伸，浏览器只给 8 位。
- **旧纹理不立即销毁**，等没有槽引用再释放，来回切换不重复解码。
- **两种来源照报细分键**：`usertextures:system` 等 P11c，`usertextures:usershortcut` 等 P11d。

## 范围与语料

`ut_slots.py` 逐个有效项清点（173 个工程，37 张场景，265 项；只算 `textures[i]` 是非空字符串、`i < 10` 的槽）：

| 落点 | 属性 | 封面（system） | 快捷方式 | 参考尺寸 |
|---|---|---|---|---|
| 图像层材质槽 0（全是 `autosize`） | 23 | 19 | — | 缺省纹理图像尺寸 |
| instanced 的 `instance`（槽 0，`instanced` + `solidlayer`） | 4 | 11 | 64 | 对象 `size` |
| 粒子材质槽 0（缺省都是精灵表） | 3 | — | — | 帧尺寸 |
| effect 实例 pass（槽 1–3） | 67 | 72 | 1 | 缺省纹理；23 项缺省是 `_rt_imageLayerComposite_<id>_a`，取 RT 尺寸 |

- **槽 0 的 121 项**：缺省纹理 67 项非 2 的幂（如 `yoshi 2` 是 1162×1162 放在 2048×2048 里），换图后 UV 变（M1）；79 项带 effect，instanced 的合成 RT 会跟着变（M2）。
- **缺省是 RT 的 23 项**（property 12 项在 `3243449890`、`3276911872`、`3351072238`；system 11 项归 P11c）：
  - 运行中改值时按 RT 尺寸裁、替换掉 RT；
  - 加载时就有值则不生效（M8，rea-p11b 5.2：参考尺寸查不到）。

  照这两条实现。RT 没被依赖时（P8 绑棋盘格）读码只到【推】，照报 `usertextures:rendertarget:placeholder`。语料 0 处。
- **粒子 3 项**（`3799462430` 两项、`3812473896` 一项）照报 `usertextures:particle-sheet`，理由见「待定」3。
- **取值**：
  - `keepaspect` 0 项、`usertexturereference` 0 项。读码已清楚，顺手实现，照报细分键 `usertextures:keepaspect`、`usertextures:reference`，直到有实测；
  - pass 级的 `keepaspect` 键 WPE 不读，`material:keepaspect` 改中性；
  - 属性项指向的属性：`scenetexture` 89 项、没声明的 6 项（如 `imagevideoimport`）、`slider` 2 项。后两种照 WPE 永远是缺省纹理：值不是字符串就当空串。
- **解锁**：按 P11a 的语料（`ignore/p11/a/corpus-ov.json`，183 个工程），34 张带 `usertextures` 键，0 张只差它。它们还差脚本回调（媒体）、脚本 API、文本、关键帧等别的节。按总计划的口径，P4–P10 都做完时解锁 6 张（104 → 110）。步骤 1 用 HEAD 重扫。
- **走查样本**：只做 P11b 时不解锁真实壁纸。走查用生成工程，加真实壁纸的复制工程（`FINAL_CHECK.md` 原则第 5 条），步骤 5 选。

不做，照报：封面与快捷方式来源（P11c、P11d）、粒子精灵表槽、RT 占位槽。

## 现状锚点

**a. 材质 pass 上的三个键有效就报**（`apps/wpe-scene/src/compile/features.ts:1195`）
```ts
  for (const key of ["keepaspect", "usertextures", "usertexturereference"])
    if (active(pass[key])) unsupported.add(`material:${key}`); // 现状：三种来源同一个键，整张退回；pass 级 keepaspect WPE 本来不读
```

**b. effect 实例 pass 与 instanced 的 `instance` 同样报**（`features.ts:406`、`:882`）
```ts
const SUPPORTED_INSTANCE_PASS = new Set(["id", "combos", "constantshadervalues", "textures"]); // 现状：没有 usertextures → effect:<名>:pass:usertextures
// checkInstanceFeatures
    } else if (key === "usertextures") {
      if (active(value)) unsupported.add("material:usertextures"); // 现状
```

**c. 编译 pass 只看 `textures`，`instance` 只合并两个键**（`compile/bundle.ts:1454`、`:878`）
```ts
  async function compilePass(pass: MaterialPass, context: PassContext): Promise<ScenePass> {
    // …
    const names = (pass.textures ?? []).map(textureName); // 现状：usertextures 没人读
// instanceOverride
  const { combos, textures } = raw as Record<string, unknown>; // 现状：instance.usertextures 不合并，对象 size 也不当参考尺寸
```

**d. 纹理来源只有静态纹理一种**（`render/graph.ts:372`、`:288`、`:609`）
```ts
function passInputs(pass: Pick<ScenePass, "textures" | "layerComposites">): Record<number, TextureRef> {
  for (const [slot, index] of Object.entries(pass.textures)) inputs[Number(slot)] = { kind: "texture", index }; // 现状：编译期定死
// compositeSize：instanced 的合成 RT 取槽 0 纹理的图像尺寸
    : texture && !(layer.solidLayer && !layer.instanced) && !layer.passthroughModel
      ? [texture.width, texture.height] // 现状：只会是缺省纹理
// planImageLayer：UV 范围与内缩按槽 0 静态纹理
  const directInset = flat || layer.noPadding ? NO_INSET : uvInset(size, baseTexture); // 现状
```

**e. 建 draw 时纹理与尺寸定死**（`render/scene.ts:2397`、`:2460`）
```ts
    const sizeOf = (ref: TextureRef | undefined) => {
      if (ref.kind === "texture") return bundle.textures[ref.index]; // 现状：g_Texture<n>Resolution 只来自 bundle 纹理
// entries
          if (ref.kind === "texture") {
            view = this.textures[ref.index]!.createView();
            sampler = this.samplerFor(bundle.textures[ref.index]); // 现状：没有运行时换纹理的入口
```

**f. 后端跳过 `scenetexture`**（`src-tauri/kabegame-core/src/wpe/user_props.rs:71`）
```rust
                Some("file") => WpePropKind::File,
                Some("directory") => WpePropKind::Directory,
                // …
                _ => return None, // 现状：scenetexture、usershortcut 在这里被丢掉，面板看不到、宿主收不到
```

**g. 面板对场景去掉文件类属性**（`apps/kabegame/src/components/wallpaper/WpeWebPropertiesPanel.vue:204`）
```ts
/** 这张壁纸用得上的条目：场景去掉 `file` / `directory`（见 props 注释） */
const usableItems = computed(() => {
  return isScene.value ? items.filter((item) => item.kind !== "file" && item.kind !== "directory") : items;
}); // 现状：没有 scenetexture 这一类
```

**h. 场景宿主的放行只有场景目录**（`src-tauri/kabegame/src/wallpaper/wpe_scene_host.rs:467`、`wpe_web_dir_index.rs:185`）
```rust
    grants.extend(scene_dirs()); // 现状：WpeWebDirIndex::scene_dir_grants，库内全部场景目录
// wpe_web_dir_index.rs
    pub fn scene_dir_grants(&self) -> Vec<FileGrant> {
            .map(|maps| maps.scene_dir_by_image_id.values().cloned().collect()) // 现状：场景只存目录，不存用户选的文件
```

## 步骤 0b — 补充调研（2026-11-14，完成）

见「实施记录」。结论已回填进上面的设计与下面各步。

## 步骤 1 — 编译期：来源表、能力表、绑定

- **新增** `compile/usertextures.ts`：
```ts
/** 参考尺寸的取法（rea-p11-textures 2.2、rea-p11b 4.2 / 5.2，p11-REPORT M2、M3）。 */
export type UserTextureReference =
  | { kind: "size"; width: number; height: number } // 缺省纹理的图像尺寸（精灵表取帧尺寸）、instanced 的对象 size、显式 usertexturereference
  | { kind: "layer"; object: number }; // 缺省是被依赖图层的合成 RT：渲染期取那张 RT 的尺寸；加载时就有值不生效（M8）
/** 一个槽的用户纹理来源（rea-p11-textures 第 1 节；P11c / P11d 往 `kind` 里加数据，不改形状）。 */
export interface UserTextureSlot {
  slot: number;
  kind: "property" | "system" | "usershortcut";
  /** 属性名（属性来源）或伪属性名（`$mediaThumbnail` 等）。 */
  name: string;
  keepAspect: boolean;
  reference: UserTextureReference;
  /** 建用户纹理的采样标志：缺省纹理的点采样位与夹取位（GIF 另强制点采样，快捷方式另加夹取，P11d）。 */
  nearest: boolean;
  clamp: boolean;
}
/** 解析一个 pass（已合并 instance / effect 实例覆盖）的 `usertextures`：只认 `textures[i]` 是非空字符串、i < 10 的槽，null 与空名字跳过。 */
export function parseUserTextures(pass: MaterialPass, defaults: (slot: number) => DefaultTexture | undefined): UserTextureSlot[];
```
- **修改** `compile/bundle.ts`：
  - `ScenePass` **新增** `userTextures?: UserTextureSlot[]`，`compilePass` 在纹理解析之后调 `parseUserTextures`；
  - `instanceOverride` 与 effect 实例覆盖也合并 `usertextures`（按槽覆盖），instanced 的参考尺寸取对象 `size`；
  - 每个属性来源在绑定表登记一条 `{ kind: "user-texture"; name }`，同一属性多个槽也只登记一条；
  - `SceneBundle` **新增** `userTextures: string[]`：用到的属性来源名，宿主加载时据此预先解码。
- **修改** `compile/features.ts`：
  - `checkPassFeatures` 不再报 `material:usertextures`，改按来源报：
    - `usertextures:system`、`usertextures:usershortcut`；
    - `keepaspect` / `usertexturereference` 有效时报 `usertextures:keepaspect`、`usertextures:reference`；
    - 粒子材质槽 0：`usertextures:particle-sheet`；
    - 缺省是没被依赖的 RT：`usertextures:rendertarget:placeholder`。
  - pass 级 `keepaspect` 删出照报表，当中性键（rea-p11b「顺带」）。
  - `SUPPORTED_INSTANCE_PASS` 加 `usertextures`，同样按来源报；`checkInstanceFeatures` 同。
- **修改** `compile/bindings.ts`：`BindingTarget` **新增** `{ kind: "user-texture"; name: string }`，就地目标，不重编译。
- **测试**（`compile/p11b.test.ts`）：
  - 三种写法（字符串、`{name, type}`、null）与槽号；`textures[i]` 为空的槽、槽 ≥ 10 忽略；
  - 参考尺寸：普通、精灵表、instanced 的对象 `size`、`usertexturereference`、RT 缺省；
  - instance 与 effect 实例的合并；
  - 能力键按来源细分；
  - 绑定表每个属性一条。
- **语料**：`kbp corpus scan` 前后比。
  - `material:usertextures` 与 `effect:*:pass:usertextures` 只换成细分键，只有属性来源的项不再报；
  - `material:keepaspect` 去掉；
  - 其余场景逐张不变；
  - 能渲染数照实写。

## 步骤 2 — 运行时：来源表、换纹理、槽 0 重建（静态图）

- **新增** `src/usertex/`：
  - `crop.ts`：照 `FUN_1401702f0` 的取整：
    - `w/h ≤ a` 时高裁成 `trunc(w/a)`、起始行 `(h − h')>>1`；
    - 否则宽裁成 `trunc(h·a)`、起始列 `(w − w')>>1`；
    - 比例 0 时整张。

    纯函数，单测对实测表。
  - `png.ts`：从文件字节读 PNG 的 `gAMA`（不认 `sRGB` 之外的色彩块），给出 libpng 的 8 位校正表；不校正时返回 null。
  - `sources.ts`：`UserTextureSources`。按属性名存当前值。`request(name, value)` 异步做：
    - 读文件：`fetch(file:)`；
    - 解码：`createImageBitmap` 带上面三个参数，PNG 有校正表时读回 RGBA 查表；
    - 每个纹理名裁一次，结果缓存。

    值为空、读不出、解码失败时，这个来源记成「无图」，槽用缺省纹理，不报错，日志一条 debug。同一来源连续改值时只认最后一次，旧请求的结果丢弃。
- **修改** `render/graph.ts`：
  - `TextureRef` **新增** `{ kind: "user"; pass: TargetKey; slot: number; fallback: TextureRef }`，`fallback` 是缺省纹理（静态纹理或被依赖图层的 RT）；
  - `passInputs` 对登记了用户纹理的槽给这种引用；
  - `compositeSize`、UV 范围与内缩取槽 0 的「当前纹理尺寸」：由 `GpuScene` 解析用户纹理后传入，没有图时就是缺省纹理的尺寸。
- **修改** `render/scene.ts`：
  - `resolveTexture` 认 `user`：当前有图用那张纹理；否则用 `fallback`。用户纹理的采样器按槽的 `nearest` / `clamp`，线性、无各向异性、1 级 mip（p11-REPORT 第 4 条）。
  - `layer` 参考尺寸在这里解析：取被依赖图层合成 RT 的尺寸。加载时就有值的槽不生效，第一次改值之后才生效（M8）。
  - `sync` 收 `usertex` 交来的「来源换好了」：
    - 用到这个来源的 draw 重建 bind group、重写 `g_Texture<n>Resolution`；
    - 槽 0 所在的图层 `rebuildLayer(…, { force: true })`：合成 RT 尺寸变了时换（同文本层的独占做法，或从池里按新尺寸取，实现时定）。
  - `g_Color4`、`g_Alpha`：组合层与 instanced 的 draw 每帧按「这个 pass 有没有用户纹理生效」写 1 或对象值。
  - 纹理释放：没有槽引用的用户纹理在 `sync` 末尾销毁。
- **修改** `render/state.ts`：`SceneState.write` 处理 `user-texture` 目标，记下新值、标脏，交给宿主的 `usertex`。状态只存值，不存 GPU 资源。
- **修改** `host.ts`：
  - 加载时对 `bundle.userTextures` 的当前值预先解码，全部完成（或失败）才建场景，第一帧就是新图；
  - 运行中由 `applyChanges` 的就地路径交给 `usertex`；
  - 重编译保留已解码的缓存，同视频播放器跨重编译复用。
- **修改** dev 探针：
  - `renderFrame` 等确定性回放先等全部用户纹理解码完；
  - `host.userTextures()` 给每个来源的当前值、状态、尺寸、解码用时。
- **测试**：
  - `crop` 的取整；`png` 的 gAMA 表（对 M9 的数）；
  - 来源表：缓存键、竞态（后发先至）、失败回缺省；
  - `rebuild.test.ts`（假设备）：
    - 非槽 0 换图只换 bind group，`g_Texture1Resolution` 变；
    - 槽 0 换图整层重建：NPOT 缺省换图后 UV 上界为 1、内缩按新尺寸；
    - instanced 换图：合成 RT 尺寸跟着变，`g_Color4` / `g_Alpha` 变成 1；
    - RT 缺省：加载时有值不生效，改值后按 RT 比例；
    - 清空回到和没有用户纹理时逐字节相同的编码轨迹。

## 步骤 3 — 后端、面板与放行

- **修改** `user_props.rs`：
  - `WpePropKind` **新增** `SceneTexture`（序列化成 `scenetexture`），`parse_defs` 认它；
  - `extensions` 固定为 WPE 的过滤（`jpg jpeg jfif png gif mp4`），`project.json` 里没有 `filter`；
  - `normalize_value` 同 `File`：绝对路径、是文件、不是符号链接，空串表示清空。存之前照 WPE 把 `\` 换成 `/`、合并非开头的连续 `/`；
  - `user_file_grants` 收 `SceneTexture`。

  `usershortcut` 仍跳过，归 P11d。
- **修改** 面板：
  - `WpePropertyField.vue` 给 `scenetexture` 用和 `file` 相同的文件选择，加清空按钮；
  - `WpeWebPropertiesPanel.vue` 只在场景上显示它，网页壁纸上没有这个类型。
  - 场景的 `file` / `directory` 仍隐藏：场景渲染器不读它们。
- **修改** 放行：
  - `wpe_web_dir_index.rs` 的场景条目除目录外，再存 `user_file_grants`（同网页壁纸条目），`metadataId` 补丁到达时重算；
  - `scene_dir_grants` 改名为 `scene_grants`，返回目录和这些文件；
  - 宿主拉取状态返回前再写一次，照网页壁纸 `file` 属性的两个时机。

  宿主是一份文档，放行对全部场景宿主实例生效。文件都是用户自己选的，总计划已接受。
- **修改** 宿主拉取的状态：`scenetexture` 属性的值和别的属性一样进 `properties`，`mergeProperties` 不跳过它。
- **测试**：
  - Rust：定义与归一（含分隔符）、放行跟随 metadata、替换而不是追加；
  - 前端：面板的显示条件与写入。
- **真机**：
  - dev 里在面板上选图、换图、清空，场景就地换上，不重编译（`stats.recompiled` 不变）；
  - 选了文件后从库里删掉这张图片，放行随之撤销（`deny file:` 日志）。

## 步骤 4 — GIF 与视频（按「待定」1、2）

扩展名先转小写再判断（rea-p11b 改正第 2 条）。

- **视频**（`.mp4 .wmv .avi .m4v .mov .mkv .webm`）：用 P9a 的视频播放器，与 WPE 是同一个播放器类（rea-p11b 3.2）。
  - 循环、不出声、自己的时钟、30 帧没画到就暂停，这几条规则不变。
  - GPU 侧是按裁后尺寸 `(w', h')` 建的 `rgba8unorm`，`g_Texture<n>Resolution` 是裁后尺寸（M6）。
  - 裁切写在 `copyExternalImageToTexture` 的源矩形上，几何 UV 不变。WPE 的视频处理器在源矩形不落在整像素时会重采样，我们只按整像素取，记为已知差异。
  - 播放器建不起来时用缺省纹理，不是透明。
  - 面板只给 `.mp4`。别的扩展名只可能来自手输，同样认。
- **GIF**（`.gif`）：
  - 纹理按比例裁、点采样（M5）。
  - 只在被绘制时推进：用当帧的 `g_Frametime`，剩余时间减到 ≤ 0 才换下一帧，超出部分带到下一帧，一次最多前进一帧。
  - 延时 = 10 × GIF 的 delay（毫秒），不设下限；无限循环。
  - 图层隐藏、壁纸暂停时不推进，也不补时间（rea-p11b 2.2）。
  - 合成照 stb 的规则（rea-p11b 2.3）：
    - alpha > 128 才写；
    - disposal 2 / 3 只作用于上一帧写过的像素；
    - 背景色 R、B 互换；
    - `bgindex` 为 0 时不用背景色。

  解码器见「待定」1。
- **测试与真机**：M5、M6 的工程和 WPE 比几帧。GIF 另做一张覆盖 disposal 2 / 3、带背景色的测试图。

## 步骤 5 — 走查（按 `FINAL_CHECK.md`）

- **生成工程**：`p11b.py` 的 `p11-ut`、`p11-ut-ar`，`p11b2.py` 的 `p11b-npot`、`p11b-inst`、`p11b-rt`（含加载时有值的 `p11b-rt-init`）。
  - WPE 用 `apply_properties` 设成已知图片再连抓；
  - 我们按同一属性值回放，整帧逐像素比。
- **真实壁纸的复制工程**（`kbp content isolate`，属性设成一张已知图），候选：
  - 图像层槽 0：`3509243656` 的 `CUbg`，或 NPOT 的 `yoshi 2` 所在场景；
  - instanced：`3351163962` 的 `自定义背景纹理`（1000×1000 放在 1024 里，带 effect）；
  - effect 槽：`custom_user_texture`、`blendgradient`、`blend` 各一，其中一张是 RT 缺省（`3351072238`）。

  每张 WPE 连抓 4 帧，逐帧逐像素比，差异逐处解释。
- **语料**：`kbp regress --corpus` 两份源码，只差 `material:usertextures` / `effect:*:pass:usertextures` 换成细分键、`material:keepaspect` 去掉。

## 收尾

- `cocs/wpe/WPE_SCENE.md` 加「用户纹理（P11b）」一节，`cocs/README.md` 同步；`cocs/wpe/WPE_IMPORT.md` 的属性面板一段补 `scenetexture`。
- 回归文档与 changelog。
- 和别的会话的交界：
  - 共享文件：`bundle.ts`、`features.ts`、`graph.ts`、`scene.ts`、`state.ts`、`host.ts`、`bindings.ts`。新代码放 `compile/usertextures.ts` 与 `src/usertex/`，共享文件只加接线。补丁移进工作区前先看这几个文件的工作区状态。
  - 后端与面板：`user_props.rs`、`wpe_web_dir_index.rs`、`wpe_scene_host.rs`、两个 Vue 组件。

## 决定（2026-11-14 用户：「同意，但步骤1、2、3一次做，交给多个sonnet代理」，三条按推荐）

另定：步骤 1、2、3 一次做，分给几个 Sonnet 代理并行；GIF 与视频（步骤 4）在它们之后。

1. **GIF 的解码器**。推荐自己写一个 GIF 解码器，照 WPE 用的 stb 派生解码器的规则：LZW 加上步骤 4 那几条合成规则，代码量小，和 WPE 逐像素对得上。
   - 另一种：浏览器的 `ImageDecoder` 解帧，时序仍自己按 WPE 走。它按 GIF 规范合成，disposal 2 / 3 与背景色的处理和 WPE 不同，记为已知差异。
2. **GIF 与视频放在 P11b 里做（步骤 4）还是以后**。推荐放在 P11b：
   - 视频的播放器 P9a 已经有了，而且就是 WPE 的同一个类；
   - WPE 的面板就收这两类，用户选 GIF / 视频是常见用法。

   不做的话，面板先只给静态图。
3. **粒子精灵表槽**（语料 2 张 3 项）。推荐照报 `usertextures:particle-sheet`。WPE 的行为取决于加载时的值：
   - 加载时就是用户图：系统没有帧表，每个粒子画整张；
   - 运行中从精灵表换成用户图：帧表与 `g_RenderVar1` 沿用旧的，用户图被当成精灵表取格子（M4）。

   要做就得在编译前先解出加载时的用户图、按它定粒子变体，样本太少，不值。

## 风险

1. **槽 0 换图的连带重算**：读码与实测已列全（UV、合成 RT、fbo、被依赖 RT、`fullscreen`），实现时漏一项就是「换图后位置、裁切或颜色不对」。M1、M2 的工程专测这两种。
2. **解码延迟**：大图（6000×3000 实测照收）解码几十毫秒，换图那几帧还是旧图。首次加载要等解码，场景出现得更晚。
3. **显存**：用户纹理按原分辨率、只裁不缩（实测 6000×3000 → 3000×3000），一张 4K 方图 36 MB。WebGPU 缺省上限 8192，超出时回缺省纹理并记日志；WPE 的上限是 D3D11 的 16384（【推】）。
4. **共享文件**：同 P11a，在快照里实现、三方合并。

## 实施记录

### 步骤 0b — 补充调研（2026-11-14，完成）

**读码**：代理写 [rea-p11b.md](rea-p11b.md)。REA MCP 本会话没连上，用本机 Ghidra 无界面模式；新建 `ignore/p11/rea/tex/gh/projui`（wallpaperui）、`projfi`（FreeImage64），工作文件 `ignore/p11/rea/p11b/`。

**实测**：p11-REPORT「P11b 补测」M1–M9。
- 工程：`ignore/p11/defs/p11b2.py` 的 `p11b-npot`、`p11b-inst`、`p11b-rt`、`p11b-sheet`，以及 `ignore/p11/b/make_rt_init.py` 的 `p11b-rt-init`。
- 测试媒体：`make_media`、`ignore/p11/b/make_gif.py`、`make_gamma.py`。
- 抓帧在 `A:\p11b\`；浏览器解码比较 `ignore/p11/b/dec_browser.js`，gamma 拟合 `gamma_fit.py`。
- 测试窗口 1600×900：另一个会话占着 1920×1080。没有改 WPE 设置，测试窗口都已关闭。

**结论**（读码与实测吻合，已回填上面各节）：
- **文件选择**：过滤只有 `*.jpg;*.jpeg;*.jfif;*.png;*.gif;*.mp4`，值是 `/` 分隔的绝对路径，不拷贝（R1）。原来的「待定：WPE 收而浏览器解不了的格式」不存在，删掉。
- **槽 0 换图**：UV 上界与内缩按新纹理重算，图层尺寸不变（M1、R4）。合成 RT、fbo、被依赖 RT、`fullscreen` 跟着重建（R4）。
- **instanced**：参考尺寸取对象 `size`；换图后合成 RT 是用户图尺寸（M2）。
- **`g_Color4` / `g_Alpha`**：组合层与 instanced 在任一槽用户纹理生效时为 1，回到缺省时恢复（M2、R4）。
- **RT 缺省**：运行中改值按 RT 尺寸裁、替换 RT；加载时就有值不生效（M3、M8、R5）。
- **粒子精灵表**：帧表在加载时按槽 0 定一次，运行中换图沿用（M4、R6）。
- **GIF**：stb 派生解码器，只在被绘制时按 `g_Frametime` 推进，点采样，无限循环（M5、R2）。
- **视频**：与 P9a 同一个播放器类，纹理按裁后尺寸，裁切在源矩形上，失败回缺省纹理（M6、R3）。
- **解码**：
  - 浏览器的 `createImageBitmap` 与 FreeImage 在 8 位 PNG / 16 位 RGBA PNG / BMP / ICO 上逐像素相同（M7）；
  - PNG `gAMA` 照 libpng 的表校正，实测逐像素对上（M9、R7）；
  - JPEG 色度上采样、16 位灰度拉伸是解码库的差异（M7、M9）。
- **改正**：
  - M7 原写「`gAMA` 被忽略」，测试图只有 0 / 255、测不出，M9 改正；
  - 读码改正上一轮三处：视频失败回缺省纹理、扩展名不分大小写、GIF 不是 FreeImage 解的（rea-p11b 末尾）。

### 步骤 1–3（2026-11-14，三个 Sonnet 代理并行，按「决定」）

**分工与目录：**
- 步骤 1、2 在快照副本里做：`ignore/p11/b/ov-a`、`ov-b`，基线 `7cbde3c6`。开工前我先写了两边共用的约定 `ignore/p11/b/contract.patch`：
  - `compile/usertextures.ts` 的类型；
  - `ScenePass.userTextures?`、`SceneBundle.userTextures?`；
  - 绑定目标 `user-texture`，以及三处穷举分支的占位。
- 步骤 3 在独立 worktree `ignore/p11/b/wt` 里做：子模块、`bin/` 下的子目录、`node_modules` 用目录联接指回主仓库。原因是 `cargo tauri dev` 监视主工作区，改 Rust 就重编重启。

**步骤 1（编译期）：**
- `compile/usertextures.ts` 的 `parseUserTextures`、`mergeUserTextures`、`instanceReferenceSize`、`defaultOfTexture`；
- `compilePass` 按缺省纹理分流（静态纹理 / 被依赖图层的合成 RT / 棋盘格占位 / 运行时 RT）；
- instanced 与 effect 实例覆盖合并 `usertextures`，`BindingCollector.bindUserTexture`；
- 能力表按项报细分键，pass 级 `keepaspect` 改中性。

语料（`ignore/p11/b/corpus-head.json` 对 `corpus-ov-a.json`，HEAD 重扫，183 个工程）：
- 能渲染 88 → 90，新增 `3462279189`、`3783690410`，原来都只差 `usertextures`；没有场景掉出；
- 去掉 `material:usertextures` 30 张、`effect:*:pass:usertextures` 21 张；
- 新增 `usertextures:system` 19 张、`:usershortcut` 3 张、`:particle-sheet` 2 张；
- 其余键逐张不变。

我核对：tsc 0 error，vitest 3173 个全过（基线 3137，加 36）。变异检查三处：两处被测试抓到；第三处（删掉 `!names[slot]`）是等价变异，解析发生在注解缺省绑定之前。

**步骤 2（运行时，静态图）：**
- `src/usertex/`：
  - `crop.ts`：裁切取整、纹理名；
  - `png.ts`：`gAMA` 表；
  - `sources.ts`：来源表、按值缓存 4 张、后发先至丢弃。
- 渲染器：
  - `render/graph.ts`：`TextureRef` 的 `user` 变体、`planLayer` 的 `userBase`；
  - `render/scene.ts`：
    - 槽 0 整层强制重建（`ensureUserSizing` 换合成 RT、独占 fbo、被依赖图层的 RT）；
    - 其它槽只重建 bind group 与 `g_Texture<n>Resolution`；
    - 组合层 / instanced 的强制白（`g_Alpha`、`g_Color`、`g_Color4`）；
    - 采样器按槽位、1 级 mip、无各向异性。
- `render/state.ts`：`user-texture` 写入、`userWritten`；
- 宿主：加载时预解码，上限 5 s；dev 探针 `host.userTextures()`。

返工三处（我审查后要求）：
- gamma 原来经 2D 画布读回（预乘 alpha 有舍入损失），改成上传 GPU 时查表（`render/userGamma.ts`）。我在 dev 应用的真 GPU 上用同一份 WGSL 处理 `ut-gm100` / `ut-gm060`：编译没有任何消息，和 WPE 导出的纹理逐字节相同。
- 预解码加 5 s 上限。
- M8 的门闸改读 `SceneState.userWritten`（只在属性写入时记），解码完成不再算写入。

我核对：tsc 0 error，vitest 3208 个全过。

**步骤 3（后端、面板、放行）：**
- `user_props.rs`：
  - `WpePropKind::SceneTexture`；
  - 过滤固定为 WPE 那一条；
  - `wpe_slash_path` 照 WPE 统一成 `/`，UNC 保留开头 `//`；
  - `user_file_grants` 收它。
- 放行：
  - `wpe_web_dir_index.rs` 的场景条目带用户选的文件，`metadataId` 补丁时重算；
  - `scene_dir_grants` 改名 `scene_grants`；
  - `wpe_web_pull_state` 的场景分支在返回前覆盖写一次。
- 面板：`scenetexture` 和 `file` 共用文件选择与清空，只在场景上显示。

我核对：Rust 测试 7 + 22 个、面板测试 9 个通过，Prettier 通过。代理对两个 crate 跑了 `cargo fmt`，另有 22 个无关文件是 HEAD 原本就不合 rustfmt 的换行（照约定保留）。`deno.lock` 被顺手改了，不进补丁。

**合并：**
- 步骤 1、2 改的文件没有重叠，三方合并（`ignore/p11/b/a/merge3.py`）后 tsc 0 error、vitest 3244 个全过。
- 开发期间 HEAD 先后多了 P4f 步骤 4、P6b 步骤 2 等提交，只有 `render/graph.ts` 一行 import 冲突。
- 以 HEAD 为祖先合并进工作区（`a/merge_wt.py`，写前核对文件没被同时改）：工作区里别的会话未提交的改动全部保留。叠上去前后的工作区快照 tsc 都是 0 error。
- 步骤 3 的补丁 `ignore/p11/b/p11b-step3.patch`（30 个文件）经用户同意（2026-11-14：「好，移动吧」）打进主工作区，dev 重编重启（352 s）。

**真机冒烟**（dev 应用 + WPE，测试行 14660–14663 测完已用 `projects_remove` 移除）：
- 后端：`get_wpe_web_properties` 认出 `scenetexture`、扩展名是 WPE 那一条；面板命令写入 `D:\…\ut-b.jpg`，存成 `D:/…/ut-b.jpg`。
- 渲染（`render_scene`，1920×1080 画布，PNG `ut-a.png`），和 WPE 抓帧（`A:\p11b\npot-a-1080`、`inst-a-1080`）整帧比：
  - `p11b-npot`（非 2 的幂的槽 0）**0 差**；
  - `p11b-inst`（instanced + tint，合成 RT 300×200、强制白）**0 差**。

  均不含 FR / CLK 两个时钟块。
- 1600×900 窗口、JPEG `ut-b.jpg` 的那组有差，两类都是已知差异：
  - 条纹边界：每条边界 4 列，是 JPEG 色度上采样；
  - 图层上下边缘各 1 行：WPE 按窗口分辨率光栅化，我们先画场景再缩，即「场景比窗口大时的上屏」。
- 运行中改值：宿主统计 `applied` +1、`recompiled` 为空，来源表解码出新值。
- `file:` 放行：选中的文件能读，没选的 `ut-d.png` 被拒；从库里删掉图片后同一个文件被拒，日志 `deny file: … ut-a.png`。

**没验到：**
- 帧循环里 GPU 换纹理那条路（`syncUserTextures` → `rebuildLayer` / `rebindUserDraw`）只在假设备上测过：屏外宿主不跑帧循环，`render_scene` 是探针按当前值重建场景。要在主窗口预览里改属性看，或步骤 5 走查时补。
- 合成 RT 池只增不减：反复换不同尺寸的图时，旧尺寸的 RT 不回收。

**工具问题：**共用的 dev 宿主产物 `target/debug/resources/wpe-scene` 被几个会话轮流从各自的源码重建。冒烟期间被换回不含 P11b 的旧产物两次，表现为渲染结果报 `material:usertextures`，或旧宿主 `t.onerror`（它的 worker 文件被删了）。每次渲染前要核对 `宿主产物` 那一行。

### 步骤 4（2026-11-14，两个 Sonnet 代理并行）

**分工：**在 HEAD `45e1cb89` 的快照副本里做（`ignore/p11/b4/head` 基线）。我先写约定 `ignore/p11/b4/contract.md` 与 `usertex/gif.ts` 的接口桩：
- 代理 G（`ov-g`）：照 WPE `resourceutil64.dll` 的反编译逐字节移植 GIF 解码器（`usertex/gif.ts`），60 个用例；
- 代理 I（`ov-i`）：来源表、渲染器、宿主、探针的接线，44 个用例。

**做了什么：**
- `usertex/gif.ts`：`GifAnimation`（`open` / `advance(dt)` / `canvas`）。照反编译，不照 stb 原版：
  - disposal 2 的填色把调色板项原样拷进画布（R、B 互换）；上一帧透明时用 transparent 那一项；
  - `bgindex` 只在有全局调色板、非 0、不越界时保留；
  - 首帧（含重新开始）只在本帧不透明时填背景；
  - alpha `> 128` 才写；
  - `remain` 按 float32 扣减并带出超出部分，一次最多一帧。
- `usertex/sources.ts`：
  - `mediaKind`；
  - GIF 与视频按值登记、引用计数；动图不进解码缓存，换走再选回来从头开始；
  - 每个纹理名一份帧状态（`GifTexture` / `VideoTexture`，视频用 P9a 的 `VideoTexturePlayer`）；
  - `beginFrame` / `setPaused`；dev 用的 `advanceGifs` / `seekVideos`；
  - 视频第一帧上限 10 s。
- `render/scene.ts`：
  - `Draw.userAnimations` 只看着色器绑定的槽；
  - 画到时 `drawn()`：GIF `writeTexture`（按裁切的 offset / 行距），视频 `copyExternalImageToTexture`（源矩形起点 = 裁切起点）；
  - GIF 强制点采样；帧来源换了对象就重建 GPU 纹理。
- `render/renderer.ts`：实时帧在视频帧号之后 `beginFrame(frametime)`。
- `host.ts`：暂停 / 隐藏传给来源表，视频 warning 走宿主 report。
- 探针：`gifDts`（逐项 `beginFrame` + `advanceGifs`）；`videoTime` 也作用于用户视频。

**合并：**两边改的文件不重叠。`ov` = `ov-i` + G 的三个文件：tsc 0 error，vitest 3463 个全过（基线 3359）。

以 HEAD 快照为祖先三方合并进工作区（`ignore/p11/b/a/merge_wt.py`，17 个文件，无冲突），工作区里别的会话未提交的改动保留。合并后的工作区快照（`ignore/p11/b4/wtm`）tsc 0 error、vitest 3573 个全过，Prettier 通过。

**和 WPE 比**（`p11b-npot`，比例 1.5，整张 GIF 进纹理；抓帧 `A:\p11b\gifdisp*`，工具 `ignore/p11/b4/gif_*.py`、`gif_dump.ts`）：
- **测试图**：`ignore/p11/b4/make_disp_gif.py` 手写编码三张，在 `ignore/p11/texsrc/`。
  - `ut-disp.gif`：7 帧，disposal 1 / 3 / 2（透明）/ 2 / 0（局部调色板 + 交错）/ 3（全屏棋盘、透明）/ 0；延时 70 / 130 / 0 / 50 / 210 / 10 / 160 ms。
  - `-b`：首帧带透明位，bgindex 是蓝。
  - `-c`：bgindex 为 0。
- **合成**：WPE 导出的 12 张槽纹理（RGBA，含 alpha）与解码器的逐帧画布逐像素相同，重新开始之后的同一帧也相同。实测看到：
  - 背景色 R、B 互换：(255,0,128) 填成 (128,0,255)，蓝填成红；
  - 首帧带透明位时不填背景。
- **时机**：三张 GIF 共 96 次换帧（`gif_timing.py`，dt 取 CLK），都能用读码的推进模型复现，超出部分 c0 有一致的取值区间。延时 0 的帧恰好显示一个渲染帧，10 ms 的帧不被拉长。代理的 `advance` 和这个 float32 模型在 WPE 的 dt 序列（加 0、0.0001、0.25 等边界）上逐步相同。
- **变异检查**：8 条（disposal 2 的 R/B 与取项、bgindex 0、首帧背景条件、`two_back` 更新条件、交错起始行、不带超出部分、disposal 3 降级）全被单测拦下。
- **真 GPU**（dev 应用，宿主产物 `index-DAg0prwG.js`）：
  - 第 0 帧整帧和 WPE 0 差（两个图层）；
  - 屏外宿主里按 `gifDts` 推进 0–6 帧，`np-auto` 图层的 300×200 采样哈希和 WPE 的 7 种画面逐个相同。
- **视频**：条纹测试片 `ut-vstripe.mp4`（`ignore/p11/b4/make_stripe_video.py`，8 条 40 像素竖条）。在 `p11-ut`（1:1）上，WPE 是从 x = 40 起的 6 条（抓帧 `A:\p11b\vstripe`）。在主窗口里用同一个 `copyExternalImageToTexture` + `origin {40, 0}` 读回，色带顺序与边界相同，交界 1–2 列是色度上采样（已知差异）。

**没验到 / 已知：**
- **屏外探针拿不到用户视频的帧**：屏外宿主 iframe 的 `document.hidden` 为真，Chromium 对不可见且没放过媒体的 frame 推迟媒体加载，`<video>` 只到 `loadstart` / `stalled`、`readyState` 0。用户视频在探针里因此超时成 `failed`。产品里桌面与预览的宿主可见，不受影响。P9a 的 `ProbeVideos` 用的是同样的元素，推测 `render_scene` 的 `videoTime` 现在在屏外宿主里同样拿不到帧（未核实，可能是 CEF 08 之后才出现的）。
- `render_scene` 还不转发 `gifDts`：要改 dev 工具（vite 插件与 MCP），改完要重启它们才生效。这次直接在宿主里调探针。
- 帧循环里的视频上传（`drawn` → `copyExternalImageToTexture`）没有在实时帧里跑过。
- 视频源矩形起点落在半像素时，WPE 的 MF 会重采样，我们取整像素。HDR 视频不做。槽 0 换成用户视频时的 `getVideoTexture()` 不做。
- 暂停期间改值建出的 GIF，第一次画到时用的是上一个实时帧的 frametime。
- GIF 解码在几乎不可压缩的大帧上约 29 ms / 帧（1.1 MB 一帧，代理的一次性测量）。

### 步骤 5 — 走查（2026-11-14）

**先补的工具**（用户同意「行」）：
- `render_scene` / `host_render` 转发 `gifDts`（`scripts/kabegame-dev/`、`apps/kabegame-dev-mcp/`，一个 Sonnet 代理）。
  - 我改了它的 409 条件：没有属性来源的场景，探针不回 `userTextures`，不能算旧产物。
  - vite 插件改完自动重启生效；MCP 要等会话重启。
- 屏外宿主拿不到视频帧，查明是**主窗口被最小化或隐藏**造成的：
  - 宿主 iframe 的 `document.hidden` 跟着为真，Chromium 推迟没放过媒体的 frame 的媒体加载；
  - 主窗口可见时屏外宿主是 `visible`、rAF 不跑，视频 30 ms 出第一帧。
  - 不是宿主或探针的 bug。探针改成要用视频而 frame 不可见时立刻报原因（`dev/videoProbe.ts` 的 `checkVideoVisibility`，`dev/probeUserTextures.ts` 的 `userVideoValues`）。
- `host.renderFrame(time, key?)` 给了 `key` 时存读回的 RGBA，用来按区域和 WPE 比运行中改值后的画面。

**生成工程**（1920×1080 窗口，PNG `ut-a.png`；抓帧 `A:\p11b\s5-*`，比较 `ignore/p11/b/a/cmp_frame.py` 屏蔽 FR / CLK）：

| 工程 | 情形 | 结果 |
|---|---|---|
| `p11-ut-ar` | 1:4 与 1:1 两种缺省纹理比例，寻址沿用缺省 | 整帧 0 差 |
| `p11b-rt` | 空值 | 整帧 0 差 |
| `p11b-rt-init` | 加载时就有值不生效（M8） | 整帧 0 差 |
| `p11b-rt` | 运行中改值（M3）：屏外宿主收 `metadataId` 补丁就地写入，`host.renderFrame` 渲染宿主当前状态 | 前 1000 行区域哈希改值前后都和 WPE 相同；`applied` +1、没有重编译 |
| `p11b-inst` | 运行中改值，槽 0 整层重建（合成 RT 32×32 → 300×200、强制白） | 同上，相同 |

运行中换图的两条路（重绑 draw、整层重建）因此第一次在真 GPU 上验到。

**真实壁纸的复制工程**（`kbp content isolate --instrument`。属性值写进复制工程 `project.json` 的缺省值，图片拷进工程目录：Kabegame 的 `file:` 放行认场景目录。WPE 用 `capture_sweep` 抓、按日志时间线回放，后处理 ultra。窗口和场景 1:1：3840×2130 带边框，或 wpe-renderdoc 新加的无边框 3840×2160 / 3396×2160）：

| 场景 | 留下的对象 / 换成固定值的字段 | 结果 |
|---|---|---|
| 3462279189 天空 | 2737；相机 `origin` 的脚本换成它算出的 `1920 1080 500`（探针回放不跑脚本） | 整帧 0 差（属性 `_1` 没声明，永远是缺省纹理） |
| 3351163962 instanced | 246 及父链；`background`、`roll1` 设成可见 | 整帧 0 差 |
| 3253330537 blend | 617；`newproperty19` 设成可见；`cameraparallax` 关掉 | 整帧 0 差 |
| 2833017810 yoshi（HDR + 泛光，非 2 的幂槽 0） | 286；`customsilhouette` 开、`texturecolor` 白、清屏色灰 | 最大差 1：WPE 的上屏是半精度浮点（线性），换算成 sRGB 8 位后的舍入差 |
| 3783690410 xray（effect 槽 3，场景里有两段视频） | 17 | 视频时刻扫到 8.92 s 时差 > 32 的只剩 2055 个像素，是一颗会动的水珠；其余零星差异来自视频，遮罩各象限的边界上没有成条的差异 |

没走完的两张：
- 3660962877：用户纹理所在的 effect 的可见性绑在 `appdockapplyusertexture1` 上，两边都没画这个槽；图层槽 0 是 `usershortcut`（P11d），`scale` 和 alpha 还跟鼠标脚本，不可隔离。
- 3351072238（缺省是 RT）：复制工程里被测对象不出画，整帧黑，两边相同但没有信息量。RT 缺省的运行中改值由生成工程 `p11b-rt` 覆盖。

**走查中发现的、不属于 P11b 的问题**（已报告，不在本节修）：
1. **布尔字段绑数值属性**：3253330537 的 `general.cameraparallax` 绑在滑块属性 `newproperty16`（值 −0.22）上，WPE 当真（视差开），我们当假。差异就是整层随光标平移约 (+0.7, −7.5) 像素。归 P5 / P3a 的绑定取值。
2. **标清、未标色彩信息的视频整体偏色**（`ut-vstripe.mp4`，320×240）：
   - Chromium 识别成 `smpte170m`，矩阵对；`copyExternalImageToTexture` 另做 SMPTE-C → sRGB 的原色转换。
   - WPE（MF）只做矩阵，所以和源值相同。
   - 已转给 P9，P11b 记为已知差异。
3. `kbp cmp frame` 不认 R16G16B16A16_FLOAT 的 DDS（HDR 场景的上屏），临时用 `ignore/p11/b4/dds_srgb.py` 换算。
4. HEAD 的 `compile/pipeline.test.ts` 语料用例失败（3293687972 读取 125 MB 超上限），不含 P11b 改动的 HEAD 同样失败。

**语料**：步骤 4 没改编译，能渲染数同步骤 1（88 → 90），不重扫。
