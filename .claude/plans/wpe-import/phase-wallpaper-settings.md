# WPE 设置字段组：桌面用全局「壁纸设置」，预览用逐壁纸「预览设置」

> 状态：2026-11-15 批准；四步代码与文档都已完成并提交。WS4–WS8 的真机项待勾（回归文档「WPE 壁纸设置与预览设置」）。

## Context

下面 7 项现在都是全局设置，桌面和预览共用：暂停、音量、视频倍速、媒体集成、场景后处理、反射、阴影。而且：
- 预览的音量和倍速直接读全局设置，预览的暂停是弹窗里的临时 ref。
- 后处理、反射、阴影、媒体集成在预览里没有入口。

用户要把预览和桌面分开：

- **桌面用「壁纸设置」**：仍是 settings 里的一份全局设置，所有壁纸共用。设置页用新的「WPE 设置字段组」组件显示全部字段，当前壁纸用不上的字段照样显示，只是不起作用。
- **预览用「预览设置」**：每张壁纸一份，存在 metadata 里。没设的项取 Kabegame 自己的默认值，不回落到全局。预览右栏用同一个字段组，按壁纸类型显示，和作者属性分成两块。
- **作者的用户属性不动**：`userProperties` 仍是一份，桌面和预览共用。
- **「跟随 WPE」**：只在能探测到 WPE 的环境（Windows）里保留。

## 总体设计思路

**预览的暂停不持久化。**它仍是 `ImagePreviewDialog` 里的内存 ref，换图时复位，和工具条、右键菜单的「暂停」联动，这些都和现在一样。字段组里的暂停开关只往外抛 `update("paused", v)`，由预览弹窗接住、改这个 ref。所以 metadata 里的 `previewSettings` 只存 6 项，不含暂停。

**应用背景强制暂停。**应用背景恒传 `paused = true`。网页垫片的 freezer 和场景宿主的 `setPaused` 在开场就暂停时，必须先画出一帧再停，否则背景会是空白。这一点要实测，不满足就在宿主和垫片里补「首帧之后才生效」。

**字段组组件是纯视图。**`WpeSettingsFields.vue` 只认三样东西：一份「已设的值」、一份「生效值」（用来显示没设的项）、要显示哪些字段。它通过 `update(key, value | null)` 往外报改动，自己不读写任何存储。两处调用各自接数据源：
- 设置页逐键接 `useSettingKeyState`，也就是现有的全局键和命令。
- 预览接新的 `useWpePreviewSettings(imageId)`，读写 metadata。

字段表、默认值和按类型选字段的规则只写一份，放在 `utils/wpeSettings.ts`。

**预览设置的存储。**metadata 顶层新增 `previewSettings`，和 `userProperties` 并列，只存设过的键。写入照 `set_wpe_web_user_properties` 的做法：先 `Storage::rewrite_image_metadata`，再发 `metadataId` 补丁。消费方本来就按这个补丁重读，所以不建新表、不加迁移。解析、钳制和默认值在 core 新模块 `wpe::preview_settings` 里，只有这一份实现。

**场景的三项改成由父页面下发。**场景宿主不再自己 invoke 全局 getter，也不再听 `setting-change`。改成 `WpeSceneView` 经 postMessage 推 `kabegame:wpe-scene-settings { postprocess, reflection, shadows }`，宿主开场请求一次，同 style 协议，值变了就 `reload()`。两边各自传：
- 壁纸窗口传全局值。
- 预览传这张图的预览设置。

这样宿主不用知道自己是在预览里还是在桌面上。音量和暂停照旧走 `kabegame:wpe-volume`，倍速照旧走 Stage 视频层的 props，只是预览一侧的取值换成预览设置。

**媒体集成在后端判定。**数据出口在 `WpeMediaHub`，所以这一项留在后端。
- 订阅时按调用方窗口 label 区分：`wallpaper*` 读全局的 `wpeMediaIntegration`，`main` 读这张图（现有逻辑能认出是哪张）的预览设置。
- 每个订阅各存一个 `enabled`，取代 hub 现在的全局 bool。
- 全局开关改了，刷新壁纸窗口的订阅；某张图的预览设置改了，刷新这张图在主窗口的订阅。

**应用背景**和预览在同一个主窗口、画法也一样，所以除暂停外的各项都归「预览设置」，音量仍强制为 0，暂停强制为 true（见上）。

**默认值与跟随。**

| 项 | 预览设置没设时 / 不能跟随时的取值 |
|---|---|
| 暂停 | 否 |
| 音量 | 1 |
| 倍速 | 1 |
| 媒体集成 | 开 |
| 后处理 | `enabled` |
| 反射 | 开 |
| 阴影 | `medium` |

- 能否跟随，看能不能读到 WPE 的 `config.json`（现有 `wpeEngineDir` 解析）。由命令 `get_wpe_follow_available` 给出，这个命令只在 Windows 上可能返回 true。
- 不能跟随时：
  - 选项里没有「跟随」。
  - 存着的 `follow`，界面上显示为 Kabegame 默认值。
  - 宿主按 Kabegame 默认值解析，现在缺 `config.json` 时回落的就是 WPE 出厂值，和上表一致，要核对一遍。
- 全局键的存储默认值不改，仍是 `follow`。媒体集成仍是布尔值，没有跟随档。

**按类型显示的字段**（设置页显示全部）：

| 壁纸类型 | 显示的字段 |
|---|---|
| `x-wpe/video` | 暂停、音量、倍速 |
| `x-wpe/web` | 暂停、音量、媒体集成 |
| `x-wpe/scene` | 暂停、音量、媒体集成、后处理、反射、阴影 |

媒体集成只在 Windows 显示。

## 前置条件

别的会话做完的 P13d 阴影还没提交，和本计划改的文件重叠：`host.ts`、`Settings.vue`、`settings*.ts`、`wpe_web.rs`、i18n、`WpeSceneShadowsSetting.vue`。等它进 HEAD 再开工。

## 步骤 1：后端

**新增**
- `src-tauri/kabegame-core/src/wpe/preview_settings.rs`：
  - `PreviewSettings`，6 个 `Option` 字段（音量、倍速、媒体集成、后处理、反射、阴影；暂停不在里面）。
  - `parse(raw)`：非法值当作没设。
  - `apply_changes(raw, changes)`：照 `user_props::apply_changes`，`null` 表示删掉该键，段空了就删掉整段。
  - 单测。
- 命令（主窗口免 ACL，只需注册）：
  - `get_wpe_preview_settings(imageId)` 返回 `{ imageId, metadataId, settings }`。
  - `set_wpe_preview_settings(imageId, changes)`：先 `rewrite_image_metadata`，再发 `metadataId` 补丁，然后调 hub 的 `refresh_image(imageId)`。
  - `get_wpe_follow_available()`。

**修改**
- `wpe_media/mod.rs`：
  - 订阅记录增加 `label`、`image_id` 与 `enabled`。
  - `want_media` 改成「存在 enabled 的 media 订阅」。
  - `set_media_enabled` 改成只刷新 `wallpaper*` 订阅；新增 `refresh_image`。
  - 只给变化了的订阅推 `Status`，Scene 投影照旧复位。
  - 相应测试一起改。
- `commands/wpe_web.rs` 的 `wpe_web_media_subscribe`：认出图之后，按 label 算出 `enabled`，交给 hub。

## 步骤 2：字段组与设置页

**新增**
- `apps/kabegame/src/utils/wpeSettings.ts`：字段表、默认值、`fieldsFor(type | null)`、`displayValue(value, followAvailable)`，附 vitest。
- `apps/kabegame/src/components/wallpaper/WpeSettingsFields.vue`：
  - 表单件复用 `components/common/form/` 的 `KbBoolean` / `KbNumber` / `KbSelect`。
  - 阴影下拉照 `WpeSceneShadowsSetting.vue` 的 Select / AndroidPickerSelect 写法。
  - 「改过」的小圆点和单项重置只给预览用（`resettable` prop），写法照 `WpeWebPropertiesPanel`。

**修改**
- `Settings.vue`：
  - 删掉第 326 行之后的 7 行 `SettingRow`。
  - 换成 `<WpeSettingsFields>`，全部字段，每个字段接 `useSettingKeyState(key)`。
  - 外层沿用 `SettingRow` 的标签、说明排版；暂停沿用现在的 `desktopWallpaperLive` 条件。
  - 删掉 `WpeSceneShadowsSetting.vue`，它的下拉写法已经进了字段组。
- i18n 五种语言：「网页壁纸媒体集成」改成「媒体集成」，说明里写清楚网页与场景都管；新增预览设置的标题。

## 步骤 3：预览

**新增**
- `apps/kabegame/src/composables/useWpePreviewSettings.ts`：读写照 `useWpeWebProperties.ts`，即 invoke 读、按 `metadataId` 补丁重读、草稿 300 ms 去抖写入；同时给出生效值。

**修改**
- `ImagePreviewDialog.vue`：
  - 右栏对全部 `x-wpe/*` 显示，`x-wpe/video` 也显示。
  - 分两块：「预览设置」是按类型显示的字段组，「壁纸属性」是现有的作者属性面板（只有网页、场景有，读写不变）。
  - 暂停仍用弹窗里的内存 ref `wallpaperPaused`，和工具条、右键菜单的 `pauseWallpaper` 联动，换图复位。字段组的暂停开关显示这个 ref，`update("paused")` 由弹窗特殊处理成改 ref，不写 metadata。
- `WpeWallpaperContent.vue`：音量、倍速和三项场景设置改读预览设置，不再读 `settings.values.*`。暂停照旧由外面传进来。
- 应用背景（`App.vue` 等调用处）：恒传 `paused = true`，音量 0。开场即暂停时要先出首帧，网页垫片 freezer 与 `host.setPaused` 按实测补。
- `WallpaperStage.vue` / `WpeSceneView.vue`：加 `sceneSettings` prop，经 `kabegame:wpe-scene-settings` 推送并应答请求。
- `WallpaperWindow.vue`：读全局的 `wpeScenePostprocess` / `wpeSceneReflection` / `wpeSceneShadows`，连同 `setting-change`，作为 `sceneSettings` 传下去。
- `apps/wpe-scene/src/host.ts`：
  - 删掉三项的 invoke 与 `setting-change` 分支。
  - 改成请求加推送，值变了就 `reload()`，`recompiled.reason` 仍为 `settings`。
  - dev 覆盖 `reflectionOverride` / `shadowsOverride` 保留。
- `permissions/wpe-scene-host.toml`：去掉三个 `get_wpe_scene_*`。

## 步骤 4：文档

- `cocs/wpe/WPE_IMPORT.md`：属性面板、预览设置、媒体集成按订阅判定、音量来源。
- `cocs/wpe/WPE_SCENE.md`：三项场景设置的来源改为父页面下发。
- `cocs/wallpaper/MULTI_SCREEN.md`：全局项清单。
- `cocs/README.md` 的对应条目。
- `versions/latest/regression.md` 新增一节，`changelog.md` 加一两行。

## 验证

**每步的独立验收**
- `git status` 查有没有改到范围外的文件。
- `deno task check -c kabegame`。
- 只跑相关的 vitest 文件，工作目录用 `/D/Codes/kabegame`。
- Prettier。
- `deno task test`：kabegame-core 的 `preview_settings` 与 kabegame 的 `wpe_media`。

**真机（kabegame-dev MCP，不接管图库界面）**
- `invoke` 读写预览设置，看 metadata 改写和 `metadataId` 补丁。
- 桌面不受预览设置影响。
- 场景宿主收到推送后 reload。
- 媒体订阅：全局关、预览开时，桌面收到 `status{enabled:false}`，预览照常有数据。
- 截图设置页的字段组；Windows 上有「跟随」，把 `get_wpe_follow_available` 模拟成 false 时没有。
- 应用背景：网页、场景、视频三种壁纸都停在一帧画面上，不空白、不动。
- 预览右栏按类型显示、字段组的暂停与右键菜单联动：需要你允许接管图库界面，或者你自己勾这两条回归。

## 实施记录（2026-11-15）

实施中和上面计划不同、或计划没写到的地方：

- **预览里的 `x-wpe/video` 只有倍速**（`wpePreviewFieldsFor`）：视频壁纸在预览里按普通视频播放，暂停与音量归视频控制条（音量是全部视频共用的 `kabegame-video-volume`），字段组再给一份会两头抢同一个值。倍速由 `ImagePreviewDialog` 设到预览的 `<video>` 上。
- **场景宿主等父页面的第一条设置**：在 iframe 里最多等 3 s，等不到按跟随并记 warn；不在 iframe 里（单测）不等。dev 工具直接开的屏外宿主由 `scripts/kabegame-dev/scene.ts` 在主页面替它回全局设置。三个 `get_wpe_scene_*` 命令保留（设置页、壁纸窗口、dev 工具还读全局值），只从 `wpe-scene-host.toml` 里拿掉。
- **`WpeSceneView` 回请求的顺序**：场景设置 → 样式 → 显示缩放（样式仍是最后一条，原有测试的「最后一条是样式」不用改）。
- **探针 `recompiled` 的键**由 `wpeScenePostprocess` 等全局键名改成 `postprocess` / `reflection` / `shadows`（宿主不再知道值来自哪里）。
- **媒体集成的 hub**：`subscribe` 保留原签名（跟全局），新增 `subscribe_gated`、`set_preview_enabled`；缓存只在监视停止时清（别的订阅还开着时留给重新打开的订阅补发）。
- **应用背景**：所有媒体都强制暂停（视频停在第一帧，原来按全局倍速播放），去掉了 `App.vue` 里设倍速并 `play()` 的逻辑。
- **i18n**：五种语言改了「媒体集成」与音量说明，新增 `gallery.wpePreviewSettingsTitle` / `wpePreviewSettingsResetAll`。后处理、反射说明里「目前只能渲染关闭时的效果」已过时，本次没改。
