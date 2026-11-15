# P11d — 快捷方式（子计划）

> 上级：[phase-11-audio-media.md](phase-11-audio-media.md)「P11d — 快捷方式」。
> 调研沿用总计划的步骤 0：读码 [rea-p11-media.md](rea-p11-media.md) 第 4 节（值的格式、脚本看到的字段、门禁、令牌、启动），
> [rea-p11-textures.md](rea-p11-textures.md) 第 2.3、5 节（图标的取法与补边）。门禁和图标当时都没实测，本节步骤 0 补上。
>
> 现状行号按 HEAD `868d1711`。语料按 P11c 收尾时的扫描 `ignore/p11/c/corpus-ov.json`（219 个工程，能渲染 157 张）。
> 本节的调研产物放 `ignore/p11/d/`（`show_shortcut_scripts.py` 打印场景里调用 `openUserShortcut` 的脚本与属性定义）。

## 总体设计思路

快捷方式是用户在属性面板里给场景配的「点一下就打开」的目标：一个程序、文件、文件夹、网址或命令行。它在场景里有两个作用：
- 图标图层用它当纹理，显示目标的图标。这是 P11b 纹理来源表的第三种来源，前两种是属性文件和封面。
- 脚本在光标回调里调 `engine.openUserShortcut(属性名)` 启动它。

所以 P11d 分三块做：
1. 属性值怎么配、怎么存；
2. 图标怎么取、怎么变成纹理；
3. 启动怎么放行。

**属性值。** 后端认 `usershortcut` 类型，面板给一个编辑器：选类型（文件 / 文件夹 / 网址 / 命令），填路径，文件类型另有参数，路径可以浏览选取。值存在图片 metadata 的 `userProperties`，格式是我们自己的 `<类型>:<路径>[|<参数>]`。拆参数的规则照 WPE：`file` 在第一个 `|` 处拆，`cmd` 在第一个空格处拆；`web` 不以 `http://`、`https://`、`www.`、`steam://` 开头时补 `https://`。WPE 的值中间还有一段 6 位的本机哈希，用来防止别人配好的值拿到本机来运行。我们的值只来自本机面板，所以不复刻这段哈希。

**交给场景宿主的不是原值。** WPE 的脚本只看得到三个字段（`baseclasses.js` 的 `convertUserProperties`）：
- `isbound`：值配好了没有；
- `commandtype`：`file` / `directory` / `website` / `command`；
- `file`：文件与文件夹只给最后一段名字，网址与命令给整串。

后端推给宿主的快捷方式属性只带这三个字段，外加一个不可逆的键：原值的 SHA-256 前 16 位十六进制。宿主靠这个键知道值变了没有，并据此缓存图标；完整路径始终不离开后端。这和 WPE 给脚本看到的一样多，脚本也读不到用户的完整路径。

**图标。** 宿主按 `(图片 id, 属性名)` 向后端要图标。后端从 metadata 读出这一项的值，在 Windows 上照 `winrtutil` 取图（[rea-p11d.md](rea-p11d.md)，步骤 0 已和 WPE 的纹理对过）：
- **文件、文件夹、命令**：
  - 先用 Shell 的缩略图缓存（`IThumbnailCache`，256）取；图片文件拿到的是缩略图，不一定是正方形；
  - 取不到再按目录的已知文件夹图标、`.url` 的 `IconFile`、按扩展名取系统图像列表的顺序退；
  - 后几种是图标句柄，要去预乘；
  - 最后用 OpenCV 的缩小、`inpaint`、放大，给 alpha ≤ 1 的像素补上附近的颜色。
- **网址**：带一条 iPhone Safari 的 User-Agent 请求页面，在 `<link>` 里按规则挑图标；边长不超过 512 的保持原尺寸，最后乘一个抗锯齿的圆形遮罩。取不到就用 WPE 自带的 `webthumbnailfallback.png`，同样乘遮罩。

结果按原始 RGBA 回给宿主，不经 PNG。宿主照 WPE 补透明边：补到槽的比例，居中，不裁切，寻址一律夹取（步骤 0 实测）。之后走 P11b 现成的换纹理通路。值没配、取不到、非 Windows 时，这个槽用缺省纹理。

**启动：门禁照 WPE，安全边界放在应用页。** 调研时发现一件事：场景脚本跑在宿主页里一个同源、没加沙箱的 `about:blank` iframe 里（P3b 为了同步访问 realm 定的），脚本能直接拿到 `parent`，进而拿到宿主的 `__TAURI_INTERNALS__`。所以：
- 宿主 JS 里的门禁只能保证**守规矩的脚本**行为同 WPE，挡不住故意绕过的脚本；
- 宿主现有命令都由宿主自报图片 id，后端不核对调用方当前显示的是不是这张图。

如果像父计划写的那样，把启动命令直接开给宿主，等于任何场景脚本都能不经点击、不限次数地启动任何一张图上用户配过的目标。

所以启动分两层：

- **宿主里照 WPE。** `openUserShortcut` 只在 `cursorClick` / `cursorDown` / `cursorUp` 里能调，否则抛错；令牌在左键按下沿发、松开沿收，同一次点击第二次调用抛错；属性必须是已配好的快捷方式。这些都满足时，宿主同步返回 `true`，并用 `postMessage` 把属性名交给父页面。
- **应用页才是边界。** `WpeSceneView` 收到请求后：
  1. 核对来源是自己的 iframe，且自己是可交互的（预览或桌面壁纸）；
  2. 核对 `navigator.userActivation.isActive`。这是浏览器给真实用户输入的标记，页面伪造不了；点在子 frame 里，祖先 frame 也会得到。
  3. 以**自己持有的**图片 id 调启动命令。这条命令只开给主窗口与壁纸窗口的应用页（它们免 ACL），不进任何 `permissions/*.toml`，宿主调不到。
- **后端只做一件事。** 只启动这张图上类型为 `usershortcut`、且用户在面板里配过的那一项，然后 `ShellExecuteW` 打开。

这样一来，恶意脚本最多能在用户刚点过壁纸的几秒内，重复打开用户自己给这张壁纸配的目标。应用页另外限定同一属性 1 秒内至多一次。

**和 WPE 有意不同的几处**（照报进已知差异）：
- 返回值：WPE 的 `true` 表示 `ShellExecuteW` 成功；我们的启动是异步的，`true` 只表示值已配好，目标不存在等失败只记日志。
- 类型检查：WPE 不查属性类型，`textinput` 里写合法的值也能启动；我们只认 `usershortcut`，也只认用户配过的值，不认工程缺省值。
- 本机哈希：WPE 比对，我们没有这段。

**平台。** 照总计划的决定 3，只做 Windows。其它平台面板不显示这类属性，后端给宿主的 `isbound` 一律为假，所以 `openUserShortcut` 返回 `false`、图标槽用缺省纹理。能力键在全部平台一起去掉；非 Windows 的代码处标 `TODO:[WPE_SCENE]`。

## 范围与语料

219 个工程：
- 调用 `openUserShortcut` 的 4 张：`3577990983`、`3643916956`、`3660962877`、`3662390671`。
  - 前三张是同一个「应用启动坞」脚本资产（`__workshopId` `3573886911` / `3662184340`）：每个图标图层在 `cursorClick` 里用图层名（或脚本属性）当属性名调用，图标纹理来自同名的快捷方式属性。
  - `3662390671` 的 `project.json` 里没有快捷方式属性，它的调用都会返回 `false`。
- 有快捷方式图标槽（`usertextures:usershortcut`）的 3 张。快捷方式属性共 70 个，作者缺省值全是空串。
- 没有脚本读 `isbound` / `commandtype` / `file`（`ignore/p11/d/grep-*.json`）。

P11d 之后这 4 张都不再报这两个键，但**不直接解锁场景**：
- `3660962877` 只差 `layer.getParent`，由 P6d 处理；
- 另外三张还差 puppet、精灵表、`createLayer` 等。

## 现状锚点

**a. 后端不认 `usershortcut`，面板与宿主都看不到这类属性**（`src-tauri/kabegame-core/src/wpe/user_props.rs:76`）
```rust
let kind = match prop.get("type").and_then(Value::as_str) {
    // …
    Some("scenetexture") => WpePropKind::SceneTexture,
    Some("group") => WpePropKind::Group,
    Some("text") | None if prop.get("text").is_some() => WpePropKind::Text,
    _ => return None, // 现状：usershortcut 在这里被跳过
};
```

**b. 推给宿主的属性只有 `type` 和 `value`**（`src-tauri/kabegame/src/commands/wpe_web.rs:164`）
```rust
fn scene_user_from_view(view: WpeWebPropertiesView) -> serde_json::Map<String, Value> {
    view.items.into_iter()
        .filter(|item| !matches!(item.kind, WpePropKind::Group | WpePropKind::Text))
        .filter_map(|item| item.value.map(|value| {
            (item.key, serde_json::json!({ "type": item.kind, "value": value })) // 现状：没有 isbound / commandtype / file
        }))
        .collect()
}
```

**c. 快捷方式来源照报、也不算会换图的来源**（`apps/wpe-scene/src/compile/usertextures.ts:196`、`:229`）
```ts
if (item.kind === "usershortcut") issues.add("usertextures:usershortcut"); // 现状：照报
// …
export function isDynamicSource(kind: UserTextureKind): boolean {
  return kind === "property" || kind === "system"; // 现状：不含 usershortcut
}
```

**d. 脚本 API 缺失表**（`apps/wpe-scene/src/compile/scriptApi.ts:108`）
```ts
engine: methods("root", ["registerAsset", "openUserShortcut", "requestFeatures"]), // 现状：用到就报 script:api:engine.openUserShortcut
```

**e. 运行时只记当前在跑哪段脚本，不记哪个回调**（`apps/wpe-scene/src/script/runtime.ts:218`）
```ts
private invoke(record: ScriptRecord, callback: Callback | HostCallback, fn: () => unknown): unknown {
  if (this.halted) return undefined;
  const previous = this.active;
  this.active = record; // 现状：没有「当前回调」，API 判断不了是不是在光标回调里
  // …
}
```

**f. 宿主的光标派发**（`apps/wpe-scene/src/host.ts:1210`）
```ts
cursor: {
  active: () => this.state !== "fallback" && (this.runtime?.hasCursorCallbacks ?? false),
  input: (snapshot) => { this.cursorInput = snapshot; },       // 现状：每帧的左键在这里
  events: (dispatches) => {
    for (const item of dispatches) this.runtime?.cursorEvent(item.object, item.callback, item.world, item.local);
  },                                                           // 现状：没有令牌
},
```

**g. 应用页收宿主消息**（`apps/kabegame/src/components/wallpaper/WpeSceneView.vue:143`）
```ts
function onWindowMessage(event: MessageEvent) {
  const target = frame.value?.contentWindow;
  if (!target || !event.isTrusted || event.source !== target) return; // 现状：已核对来源是自己的 iframe
  if (isWpeSceneStyleRequest(event.data)) { /* … */ return; }
  const point = frame.value ? wpeContextMenuPoint(event.data, frame.value) : null;
  // …（音量请求）
}
```

**h. 脚本 realm 是同源、没加沙箱的 iframe**（`apps/wpe-scene/src/script/realm.ts:143`）
```ts
const frame = input.document.createElement("iframe"); // 现状：about:blank、同源，脚本能经 parent 拿到宿主的全局
frame.style.display = "none";
input.document.body.appendChild(frame);
```

**i. 宿主的命令权限**（`src-tauri/kabegame/permissions/wpe-scene-host.toml`）
```toml
commands.allow = ["get_wpe_scene_postprocess", "get_wpe_scene_reflection", "wpe_scene_target", "wpe_scene_report"]
# 现状：宿主自报 imageId，后端不核对调用方在显示哪张图
```

## 步骤 0 — 实测（WPE 与 Kabegame）

**0a 门禁与脚本看到的值（WPE）。** 测试工程 `p11-shortcut`（`ignore/p11/defs/p11d.py`，kbp-tools 生成）：
- 几个可点的图层，脚本在 `cursorDown` / `cursorClick` / `cursorUp` / `update` 里按用例调 `openUserShortcut`，用 `[kbp]` 日志记返回值或异常文本；
- `applyUserProperties` 与 `init` 记下快捷方式属性的 `JSON.stringify` 与 `engine.userProperties` 里的形状。

经 `apply_properties` 给测试窗口配值，经 `input_play` 在测试窗口里点击。这样不动真实鼠标，只影响本会话的窗口。

逐条核对 rea-p11-media「留给实测的问题」8 的 (a)–(f)，另加：
- 四种类型各自的 `isbound` / `commandtype` / `file`。`cmd` 的 `file` 是程序还是整串命令行，读码没说清。
- 空串与格式不对的值的形状（读码 `0x140173ee5` 没读）。

值的中段要和本机哈希对上，才会走到启动：哈希按读码用本机注册表的 `MachineGuid` 算，只在本机用、不外传，算法【推】的部分（是否含结尾 NUL）由日志里有没有 `User shortcut blocked.` 判定。大部分用例故意给错的哈希：门禁和令牌照常走完，只是不真的启动。真的启动只做一次，打开 `ignore/p11/d/launch-target` 文件夹（见「待定」2）。

**0b 图标的真值（WPE）。** 给同一个工程配五个目标，抓一帧，把五张图标纹理存出来：
- `C:\Windows\System32\notepad.exe`；
- 开始菜单里一个 `.lnk`；
- `ignore/p11/d/` 下新建的 `.url`，`IconFile` 指向一个 exe；
- 一个文件夹；
- 不带扩展名的命令 `notepad`，验证会用 `SearchPathW` 补全 `.exe`。

槽的比例取 1:1、2:1、1:2，验证补边的取整。读码里没读清的两处由这组数据定：去预乘时 `a = 0` 怎么处理，以及 OpenCV 那一步做了什么。网址类型见「待定」3。

**0c 用户激活（Kabegame）。** dev 应用里预览一张场景：
- 用 CDP 在场景 iframe 里点一下，读应用页的 `navigator.userActivation.isActive`，确认点子 frame 时祖先 frame 也被激活；
- 等 6 秒再读，确认激活过期。

桌面壁纸的点击由后端经 CEF 的 `send_mouse_*_event` 注入，属于浏览器侧发出的输入，按 Chromium 的规则同样会激活。能在不动用户桌面的前提下测就测，测不了就读 CEF 的代码确认。

产出写进 `p11-REPORT.md`「快捷方式」节；若结果和下面的设计不一致，先改子计划再动工。

## 点 1 — 属性值与面板（Rust core + 面板）

- **新增** `WpePropKind::UserShortcut`，并在 `parse_defs` 里认 `usershortcut`：
```rust
/// 场景的快捷方式（P11d）：值是 `<类型>:<路径>[|<参数>]`，类型 file / directory / web / cmd；只在 Windows 的场景壁纸上可编辑。
UserShortcut,
// parse_defs
Some("usershortcut") => WpePropKind::UserShortcut,
```
- **新增** `user_props.rs` 的值解析，后端各处共用：
```rust
pub struct UserShortcut { pub kind: ShortcutKind, pub path: String, pub args: String }
/// 照 WPE `FUN_1401708c0` 拆参数：file 在第一个 `|`、cmd 在第一个空格处拆；类型不认识或路径为空返回 None。
pub fn parse_user_shortcut(value: &str) -> Option<UserShortcut>;
impl UserShortcut {
    /// 脚本看到的 commandtype（file / directory / website / command）与 file（文件、文件夹取最后一段名字，网址、命令取整串，步骤 0a 定）。
    pub fn script_fields(&self) -> (&'static str, String);
}
```
- **修改** `normalize_value`：快捷方式的值按上面的格式校验；`web` 不以那四个前缀开头时补 `https://`；空串表示清空（作者缺省值全是空串，同 `scenetexture` 直接删键）。
- **新增** 面板编辑器 `WpeShortcutField.vue`：
  - 类型用 `KbSegmentedControl` 或 `Select`；
  - 路径输入框，文件与文件夹类型带浏览按钮，复用 `file` / `scenetexture` 现成的选择命令；
  - 文件类型多一个参数输入框；
  - 清空按钮，以及「测试」按钮（见「待定」4）。
- **修改** `WpeWebPropertiesPanel.vue`：`usershortcut` 只在 Windows 的场景上显示，用上面的编辑器。

## 点 2 — 后端：给宿主的字段与图标（Rust）

- **修改** `scene_user_from_view`：快捷方式属性改成下面的形状，不带原值：
```rust
WpePropKind::UserShortcut => {
    let parsed = cfg!(windows).then(|| parse_user_shortcut(value_str)).flatten(); // TODO:[WPE_SCENE] 非 Windows 一律未绑定
    let mut entry = json!({
        "type": "usershortcut",
        "value": shortcut_key(value_str), // 新增：原值 SHA-256 的前 16 位十六进制，空值为 ""；宿主拿它判变化、缓存图标
        "isbound": parsed.is_some(),
    });
    // 没绑定时只有 isbound（步骤 0 实测：空串、格式不对都是 `{isbound: false}`，没有另外两个键）
    if let Some(shortcut) = parsed {
        let (commandtype, file) = shortcut.script_fields(); // cmd 的 file 只有程序部分（实测 `calc /x` → "calc"）
        entry["commandtype"] = commandtype.into();
        entry["file"] = file.into();
    }
    entry
}
```
- **宿主侧对应**：这三个字段只进 `applyUserProperties` 的增量。`engine.userProperties` 里的快捷方式属性照 WPE 给 `{}`，三个字段都是 `undefined`（步骤 0 实测）。宿主组装 `engine.userProperties` 时，交给 `convertUserProperties` 的这一项只带 `type` 与 `value`。
- **新增** 命令 `wpe_scene_shortcut_icon`，进 `wpe-scene-host.toml`：
```rust
/// 场景宿主取快捷方式图标（P11d）：按图片 id 读 metadata 里这一项的值，Windows 上照 winrtutil 取正方形图标、去预乘，
/// 回 `[宽 u32 LE][高 u32 LE][RGBA…]`；没配置、取不到、非 Windows 回空。图片要是库内场景、属性类型要是 usershortcut。
#[tauri::command]
pub async fn wpe_scene_shortcut_icon(image_id: String, name: String) -> Result<tauri::ipc::Response, String>;
```
- **新增** `src-tauri/kabegame/src/wallpaper/wpe_shortcut/`，放取图标与启动的代码。取图标的平台部分是 `cfg(windows)`，在阻塞线程里做，先 `CoInitializeEx(STA | DISABLE_OLE1DDE)`。逐条照 [rea-p11d.md](rea-p11d.md)：
  - **文件、文件夹、命令**（2.1、2.2）：
    1. 不是普通文件时，用 `SearchPathW(文件名, ".exe")` 补全。
    2. `IThumbnailCache::GetThumbnail(256)`，只收 24 位或 32 位，得到的直接用，不去预乘。
    3. 取不到时：
       - 目录走 `IKnownFolderManager` 的 `pszIcon`；
       - `.url` 读 `IconFile`，再 `PrivateExtractIconsW(256)`；
       - 其余按扩展名 `SHGetFileInfoW(USEFILEATTRIBUTES)` 取系统图像列表，从 JUMBO 往下试，跳过「小图标补透明边」的假大图。
    4. 图标句柄用 `DrawIconEx` 画成颜色位图高的正方形，然后去预乘：全程单精度，`cvttss2si` 只取低字节、不钳制，`a = 0` 得 0。
    5. 两支最后都做透明区填色（2.4）。
  - **网址**（1.3–1.7、2.3）：
    - 按原串建地址，失败再补 `https://`、`https://www.`；请求只带那条 iPhone UA，不看状态码；
    - 扫 `<link>`：apple 图标按 `sizes` 的宽排前，普通图标宽 0，最后补 `/favicon.ico`，按宽从大到小稳定排序；相对地址按最终响应地址拼；
    - 逐个下载，第一个能解码的就用（ICO 取像素最多的一帧，不支持 SVG）；不超过 512 的正方形保持原尺寸，否则缩成 `min(w, h, 512)` 的正方形；
    - 乘圆形遮罩：`r = (min >> 1) − 2`，抗锯齿，`a = (遮罩 · a) >> 8`；
    - 全部失败用 `<WPE 安装目录>/assets/materials/util/webthumbnailfallback.png`，同样乘遮罩。
  - **OpenCV 的三处**：`resize` 线性、`inpaint` TELEA、`circle` 抗锯齿，见「待定」5。
  - 结果按值在内存里缓存（WPE 存在 `bin/thumbnail.cache`，不跨重启缓存在画面上没有区别）。
  - `windows` crate 要补几个特性（`Win32_UI_Controls`、`Win32_UI_Shell_Common` 等），动工时按编译结果加；HTTP 用现有的 `reqwest`，解码用 `image`（FreeImage 能认的格式更多，记为已知差异）。

## 点 3 — 后端：启动命令（Rust）

- **新增**
```rust
/// 启动场景的快捷方式（P11d）。只给主窗口与壁纸窗口的应用页（免 ACL），不进任何 permissions/*.toml：
/// 宿主与网页壁纸都调不到。图片要是库内场景；属性在 project.json 里要是 usershortcut；值只取 metadata 的
/// userProperties（用户在面板里配过的），不取工程缺省值。Windows 上 `ShellExecuteW(NULL, NULL, 路径, 参数, NULL, SW_SHOWNORMAL)`，
/// 返回值 > 32 为成功；其它平台报错。
#[tauri::command]
pub async fn wpe_open_user_shortcut(image_id: String, name: String) -> Result<bool, String>;
```
- **修改** `lib.rs` 的 `generate_handler!` 登记两条新命令。

## 点 4 — 宿主：图标来源（TS）

- **修改** `compile/usertextures.ts`：删掉 `usertextures:usershortcut` 这一项，`isDynamicSource` 加上 `usershortcut`。
- **修改** `usertex/sources.ts`：快捷方式槽的值是后端给的键。键变了就按 `(图片 id, 属性名)` 调 `wpe_scene_shortcut_icon`（由宿主注入的依赖去调），空键直接用缺省纹理。
- **新增** 补边，替代裁切（rea-p11-textures 2.3 的 usershortcut 行）：
```ts
/** 快捷方式图标补透明边到槽的比例，居中、不裁（`a` 为 0 时原样）。取整照 WPE：`(int)` 截断、`>> 1` 居中。 */
export function padRect(w: number, h: number, a: number): { width: number; height: number; x: number; y: number } {
  if (!a) return { width: w, height: h, x: 0, y: 0 };
  if (w / h <= a) {
    const width = Math.trunc(h * a);
    return { width, height: h, x: (width - w) >> 1, y: 0 };
  }
  const height = Math.trunc(w / a);
  return { width: w, height, x: 0, y: (height - h) >> 1 };
}
```
- **修改** 渲染器解析用户纹理的地方：快捷方式纹理按补边后的尺寸建，图标拷到偏移处，其余像素保持 WebGPU 建纹理时的全 0；寻址强制夹取。

## 点 5 — 宿主：`openUserShortcut` 与令牌（TS）

- **修改** `script/runtime.ts`：`invoke` 在调用期间记下当前回调名（`activeCallback`），结束时恢复，同 WPE 的 `G+0x62c`。
- **新增** `src/shortcut/token.ts`：
```ts
/** 每次点击一个令牌（rea-p11-media 4.5）：左键按下沿在派发之前发，松开沿在本帧派发之后收。 */
export class ShortcutToken {
  private token = false;
  private last = false;
  beginFrame(down: boolean): void { if (down && !this.last) this.token = true; }
  endFrame(down: boolean): void { if (!down && this.last) this.token = false; this.last = down; }
  take(): boolean { const had = this.token; this.token = false; return had; }
}
```
- **新增** `script/api.ts` 的 `engine.openUserShortcut`。错误对象用 realm 里的 `SyntaxError`：步骤 0 实测 WPE 抛的是 `SyntaxError`（`instanceof Error` 为真），同 P6c 的 `input`。下面代码里的 `realmError` 即构造它：
```ts
this.method(this.engine, "openUserShortcut", (...args: unknown[]) => {
  const callback = this.access.activeCallback();
  if (callback !== "cursorClick" && callback !== "cursorDown" && callback !== "cursorUp")
    throw this.realmError("Cannot execute user command outside of cursor callbacks.");
  if (args.length < 1 || typeof args[0] !== "string") return false;
  const result = this.access.openUserShortcut(args[0]); // 0 失败 / 1 成功 / 2 没有令牌，同 WPE 宿主的返回码
  if (result === 2) throw this.realmError("Cannot execute more than one user command per cursor click.");
  return result === 1;
});
```
- **修改** `host.ts`：
  - 光标派发前后调令牌的 `beginFrame` / `endFrame`；
  - `openUserShortcut(name)` 先 `take()` 令牌，没有返回 2；
  - 属性全集里这一项是 `usershortcut` 且 `isbound` 为真时，`postMessage` 给父页面、返回 1，否则返回 0。令牌在查属性之前就消耗掉，同 WPE。
- **修改** `compile/scriptApi.ts`：`engine` 的缺失表删掉 `openUserShortcut`。

## 点 6 — 应用页转发（Vue）

- **新增** 消息协议 `wpeSceneShortcut.ts`，和 `wpeContextMenu.ts` 放在一起：`{ type: "kabegame:wpe-scene-shortcut", name }`，宿主侧同名常量。
- **修改** `WpeSceneView.vue` 的 `onWindowMessage`：
```ts
const name = wpeShortcutName(event.data);
if (name !== null) {
  // 新增：只认可交互的实例与真实的用户输入；图片 id 用本组件持有的，不用消息里的
  if (props.interactive && navigator.userActivation?.isActive && shortcutThrottle.take(name))
    void invoke<boolean>("wpe_open_user_shortcut", { imageId: props.target.id, name }).catch((error) =>
      logger.warn(`启动快捷方式失败: ${error}`),
    );
  return;
}
```

## 点 7 — dev 探针、能力表与文档

- **dev 探针**：`renderFrame` 的光标回放同样走令牌。脚本调 `openUserShortcut` 时记下 `{ frame, name, result }`，不真的启动，结果里给 `shortcuts`；探针的属性全集可以由请求的 `userProperties` 给出快捷方式的三个字段。
- **语料**：重扫后只应去掉 4 张的 `script:api:engine.openUserShortcut` 与 3 张的 `usertextures:usershortcut`，没有新增键。
- **文档**：
  - `WPE_SCENE.md` 新增「快捷方式（P11d）」一节；
  - `WPE_IMPORT.md` 的属性面板一段加上 `usershortcut`；
  - `cocs/README.md`、回归文档、changelog 同步。

## 步骤

1. **步骤 0**（Claude）：上面的 0a–0c，结果写进报告，需要时改子计划。
2. **步骤 1 后端**（Sonnet 代理，独立 Rust 工作树）：点 1 的 Rust 部分、点 2、点 3，带单测：
   - 值解析的各种格式；
   - 宿主拿到的形状；
   - 启动命令的反向用例：类型不对、只有缺省值、没配、图片不是场景。

   并进主工作区会触发 dev 重编，先问用户。
3. **步骤 2 前端**（Sonnet 代理，HEAD 快照里做再三方合并）：点 1 的面板、点 4–7，带单测：
   - 补边取整；
   - 令牌的边沿；
   - 回调外抛错、第二次抛错、令牌在查属性前消耗；
   - 应用页转发的条件。

   步骤 1、2 之间先写定「约定」（宿主拿到的形状、图标命令的字节格式、消息协议），两个代理可以并行。
4. **步骤 3 走查**（Claude，按 `FINAL_CHECK.md`）：
   - 图标和 0b 存下的 WPE 纹理逐像素比；
   - 生成工程用同一串点击，比我们和 WPE 的回调日志；
   - dev 应用里真机配置、点击、启动一次（同「待定」2）；
   - 反向用例：没配的属性、回调外调用、伪造消息、没有用户激活。
5. **收尾**：文档、回归、changelog，请用户提交。

## 验收

- 0b 的五种目标，图标纹理和 WPE 逐像素相同；不同的部分要能归到已知差异。
- 生成工程上，同一串点击下我们和 WPE 的回调日志逐行相同：返回值、两种异常的文本、令牌在 `cursorDown` 与 `cursorClick` 之间共用。
- 预览里点击启动所配的目标，每次点击一次；以下情况都不启动：没配的属性、回调之外的调用、宿主里伪造的 `postMessage`、直接 `invoke` 启动命令（宿主没有这个权限）。
- 语料只少那两个键，原来能渲染的不掉出。

## 待定

1. **启动的安全边界**：
   - **A（推荐）应用页转发**：宿主照 WPE 判门禁，再把属性名交给 `WpeSceneView`；应用页核对用户激活，用自己持有的图片 id 调启动命令。启动命令不开给宿主。代价是应用页多 20 行左右，返回值与启动结果脱钩（上面已列为已知差异）。
   - **B 照父计划**：启动命令开给宿主，后端只核对图片与属性。场景脚本能绕过宿主的门禁直接调，而且宿主自报的图片 id 可以随便填。
2. **真实启动的实测**：步骤 0a 和走查各真的启动一次，都是打开 `ignore/p11/d/launch-target` 这个空文件夹，会弹出一个资源管理器窗口，请你手动关掉。为了让 WPE 的值通过哈希检查，要读本机注册表的 `MachineGuid` 来算 WPE 的哈希，只在本机用、不写进仓库。其余用例都用错的哈希，不会启动。
3. **网址类型的图标**：
   - **A（推荐）照 WPE**：取网站的图标，失败时用 WPE 自带的 `webthumbnailfallback.png`。步骤 0 先读 `FUN_14002fb10`（取哪个地址、怎么找图标链接、超时），再实现；后端会对用户自己填的网址发请求，和 WPE 一样。
   - **B 先只用 WPE 的缺省图**：不发网络请求，网址类型的图标一律是那张缺省图，记为已知差异。
4. **面板的「测试」按钮**：推荐做。WPE 的面板有这个按钮，调同一条启动命令；由用户在主窗口里点，本身就是用户激活。
5. **OpenCV 的三处要不要逐像素复刻**（步骤 0 读出，[rea-p11d.md](rea-p11d.md) 2.3、2.4）：
   - **透明区填色**：`resize` 线性缩到 64×64 → `inpaint` TELEA 半径 8 → `resize` 线性放回。改的只是 alpha ≤ 1 的像素的 RGB，只在线性采样的图标边缘看得出：不做就是一圈发黑的边，做了是附近的颜色。
   - **圆形遮罩**：OpenCV 的抗锯齿画圆，只影响网站图标圆边上一圈像素的 alpha。

   两个方案：
   - **A（推荐）照 OpenCV 4.4.0 的源码移植进 Rust。** `resize` 的 8 位定点线性、`inpaint` TELEA、`circle` 的抗锯齿，三个都是纯计算，约几百行。验收用 WPE 自己的产物逐像素比：步骤 0 存下的 7 张纹理，以及 WPE 的 `bin/thumbnail.cache` 里同样的图。某一处在合理工作量内对不齐时，退到 B，并报告。
   - **B 近似。** 填色用「最近不透明像素的颜色」扩散，圆用按面积算的覆盖率。边缘有零星像素和 WPE 不同，记为已知差异。

## 风险

1. **realm 同源**：宿主里的门禁不是安全边界（见总体设计）。方案 A 把边界放到应用页和后端；现有的宿主命令都没有副作用，不受影响。
2. **用户激活的时长**：Chromium 的激活约 5 秒有效，有效期内恶意脚本能多次请求，应用页按属性 1 秒限一次。激活规则在 CEF 下的表现以 0c 为准。
3. **实测的副作用**：启动会在用户电脑上开窗口，只做两次，目标是空文件夹。
4. **图标像素**：OpenCV 那一步和 `a = 0` 的去预乘没读清，可能有个别像素不同，以 0b 为准。
5. **异步启动**：脚本拿到 `true` 时程序还没启动，目标不存在时也是 `true`。语料里没有脚本读这个返回值。

## 实施记录

### 决定（2026-11-15）

- **1 用 A（应用页转发）。** 用户：「如果不能往外网发请求，其实允许 B 的隔离也可以」。查过之后，这个前提不成立：
  - 运行时的资源闸门只管 `file:` 与 IPC 请求，http(s) 直接放行（`tauri-runtime-kbcef/src/webview.rs:992`）；
  - 场景宿主页是直接加载的 `file:` 文档，没有 CSP（应用页的 CSP 只作用在 Tauri 提供的页面上）。

  所以场景脚本能往外网发请求，按用户给的条件 B 不够，用 A。
- **3 用 A（照 WPE 取网站图标）**：用户「网站图标用 A 吧」。步骤 0 先读 `FUN_14002fb10`。
- **4 按推荐做「测试」按钮**：用户没有反对。
- **2 到真的启动那一步再问**：步骤 0 的其余用例都用错的哈希，不读 `MachineGuid`、不启动。

- **5 用 A（逐像素移植 OpenCV 4.4.0 的三处）、2 同意**（2026-11-15，用户「同意」）：走查时真的启动一次，打开 `ignore/p11/d/launch-target`；为让 WPE 的值通过哈希检查，读本机 `MachineGuid` 算哈希，只在本机用、不写进仓库。

### 约定（步骤 1、2 开工前写定，三个代理共用）

**分工**（都用 Sonnet）：
- **CV**：在独立 crate `ignore/p11/d/cvport/` 里移植 OpenCV 4.4.0 的三处。交出 `cv.rs` 一个文件，加上它的单测与小测试数据。
- **RS**：工作树 `ignore/p11/d/wt` 里的其余 Rust。`cv.rs` 先写成签名相同的桩。
- **TS**：同一个工作树里的宿主、应用页、面板与 dev 探针。

RS 与 TS 改的文件不相交，合并时我在主工作区按三方合并（基点 HEAD `868d1711`）。

**1. 值的格式**（`userProperties` 里存的，只有本机面板写）：
- 格式是 `<类型>:<路径>`，类型 `file` / `directory` / `web` / `cmd`，空串表示没配。
- 拆参数照 WPE `FUN_1401708c0`：
  - `file` 的路径在第一个 `|` 处拆成「路径 | 参数」；
  - `cmd` 在第一个空格处拆成「程序 参数」；
  - 另外两种不拆。
- 拆完路径为空就不合法。
- `web` 不以 `http://`、`https://`、`www.`、`steam://` 开头时，保存前补 `https://`，照 WPE 面板的 JS，区分大小写。
- 面板读写的是原值，宿主拿不到原值。

**2. 宿主拿到的形状**（`wpe_web_pull_state` 给场景宿主的属性全集里的一项）：
```ts
{ type: "usershortcut", value: string /* 原值 SHA-256 前 16 位十六进制，没配为 "" */, isbound: boolean,
  commandtype?: "file" | "directory" | "website" | "command", file?: string /* 只在 isbound 时有 */ }
```
- `file` 的取法：
  - 文件与文件夹：路径里的 `\` 统一成 `/` 后，取最后一个 `/` 之后的部分；
  - 网址：整个网址；
  - 命令：只取程序部分。
- 非 Windows 时 `isbound` 一律为 `false`。
- 宿主把这一项原样放进 `applyUserProperties` 的增量。`engine.userProperties` 里只给 `convertUserProperties` 传 `{type, value}`，脚本因此读到 `{}`。

**3. 取图标命令** `wpe_scene_shortcut_icon(imageId: string, name: string)`：
- 返回 `tauri::ipc::Response`：
  - 没配、取不到、非 Windows 时是 0 字节；
  - 否则是 `[宽 u32 LE][高 u32 LE][RGBA，直通 alpha，宽·高·4 字节]`。
- 图片要是库内场景；属性在 `project.json` 里要是 `usershortcut`；值取 metadata 的 `userProperties`（不取工程缺省值）。
- 进 `wpe-scene-host.toml`。

**4. 启动命令** `wpe_open_user_shortcut(imageId: string, name: string) -> bool`：
- 同样的三条检查；
- Windows 上 `ShellExecuteW(NULL, NULL, 路径, 参数, NULL, SW_SHOWNORMAL) > 32`，其它平台返回错误；
- 只登记进 `generate_handler!`，不进任何 `permissions/*.toml`。

**5. 宿主 → 应用页的消息**：
- 格式 `{ type: "kabegame:wpe-scene-shortcut", name: string }`；
- 应用页只认 `isTrusted`、来源是自己的 iframe、`name` 是长度 1–256 的字符串。

**6. 宿主的门禁**（WPE 实测）：
- 只在 `cursorClick` / `cursorDown` / `cursorUp` 里能调，否则抛 realm 的 `SyntaxError("Cannot execute user command outside of cursor callbacks.")`。
- 参数缺失或不是字符串原始值时返回 `false`，不消耗令牌。
- 之后先取令牌，没有就抛 `SyntaxError("Cannot execute more than one user command per cursor click.")`。
- 然后查全集：`type === "usershortcut"` 且 `isbound === true` 时，发消息并返回 `true`，否则返回 `false`。
- 令牌在左键按下沿、本帧派发之前发；在松开沿、本帧派发之后收。

**7. `cv.rs` 的签名**（通道顺序 RGBA，与 OpenCV 的 BGRA 对称，两步都与通道顺序无关）：
```rust
/// rea-p11d 2.4 透明区填色：只改 alpha ≤ 1 的像素的 RGB，alpha 不动。rgba.len() == width·height·4。
pub fn fill_transparent(rgba: &mut [u8], width: usize, height: usize);
/// rea-p11d 2.3 圆形遮罩：r = (min(w, h) >> 1) − 2（≤ 1 时取 1），圆心 (w >> 1, h >> 1)，LINE_AA 实心圆，a = (mask·a) >> 8。
pub fn circle_mask(rgba: &mut [u8], width: usize, height: usize);
```

**8. 像素流水线**：
- **消息 8**：缩略图的 RGBA，或图标句柄画出来再去预乘的 RGBA，交给 `fill_transparent`，得到结果。
  - 去预乘：`af = a as f32 / 255.0`，`c' = cvttss2si(c as f32 / af)` 的低字节。只有 `a = 0` 时出界，得 0。Rust 的 `as i32` 是饱和转换，不能直接用。
- **网址**：解码 → 边长大于 512 或不是正方形时缩放 → `circle_mask` → 结果；不做填色。缩放的滤镜【未知】，先用 Catmull-Rom（FreeImage `Rescale` 的缺省），标 `TODO:[WPE_SCENE]`。

**9. 验证数据**：
- WPE 的产物存在 `ignore/p11/d/wpe-icons/`（7 张 1:1 槽的纹理就是 WPE 送进纹理之前的图）；
- 读码代理的 `ignore/p11/rea/p11d/tcache.py` 能从 `<WPE>/bin/thumbnail.cache` 取同样的 PNG。
- RS 加一个 `#[ignore]` 的测试：按环境变量给的路径列表取图标，写成 PNG 到给定目录，供我逐像素比。

### 步骤 1、2（2026-11-15，三个 Sonnet 代理并行）

**CV（OpenCV 移植）**：`ignore/p11/d/cvport/src/cv.rs`，1597 行，只用 std。
- 参照：4.4.0 在 PyPI 上没有 py3.10 的轮子，用 4.5.5 当参照。代理逐行比过这三个源文件，4.4.0 与 4.5.5 在这几处没有行为差别。
- 4.13 重写了 `inpaint`（换成 `std::priority_queue`、多一次 +0.5），结果不同；以 4.4.0 为准。
- 我的独立验收：
  - 单测 30 个全过；
  - 新种子 97 的 680 个参照用例逐字节相同；
  - 两处变异被抓到：resize 定点位数 11 → 10 让 17 个用例失败，inpaint 半径 8 → 7 让 6 个失败；
  - `circle_mask` 作用于 WPE 的 `webthumbnailfallback.png`，结果与 WPE 纹理逐像素相同。
- **事故**：代理建 crate 时，cargo 把它加进了主工作区根 `Cargo.toml` 的 workspace 成员。代理只还原了 `Cargo.lock`（在主工作区用 `git checkout` 还原的），没还原 `Cargo.toml`。我按 HEAD 改回了那一行。dev 进程没受影响。

**RS（后端）**：
- 改动的文件：`user_props.rs`、`wpe_web.rs`、`wpe_scene.rs`（两条命令）、`lib.rs`、`wpe-scene-host.toml`、`Cargo.toml`（`regex` 与 windows 特性），新目录 `wallpaper/wpe_shortcut/`。
- 我的独立验收：core 14 个、kabegame 136 个单测全过。
  - 修了一个只在 `cv` 桩下成立的断言：ICO 测试原来看角上的像素，角在圆形遮罩外。
  - 修了一个真缺陷：`GetSharedBitmap` 拿到的位图归 `ISharedBitmap` 所有，原来写成了临时值，语句一结束位图就被销毁，文件夹缩略图因此取不出来、退成了普通文件夹图标。
- 核对测试 `dump_shortcut_icons` 在测试进程里的结果，`cmp_icons.py` 与 WPE 纹理比：
  - `.lnk`、`.url`、文件夹、维基百科：逐像素相同（两个文件图标都经过了填色）；
  - notepad.exe 的 RGB 最多差 2，calc 最多差 12，alpha 都相同。
- exe 的这两处差异：
  - 测试进程里 exe 的 `GetThumbnail` 失败（`0x8004B200`），走的是「图标 → 去预乘」；
  - WPE 的像素比我们高约 1 级，像是拿到了直通 alpha 的缩略图。
  - 推测是测试程序没有应用清单所致，在 dev 应用里调命令再比（走查）。

**TS（前端）**：
- 宿主：`shortcut/{token,message}.ts`；`api.ts` 的 `openUserShortcut` 抛 realm 的 `SyntaxError`；`runtime.ts` 记当前回调；渲染器新增每个实时帧都调的 `cursor.end` 钩子，令牌在 `input` 里发、`end` 里收。
  - 全集保留完整形状，只在 `engine.userProperties` 出口用 `scriptUserProperties` 剥掉三个字段。
  - 补边在来源表算（`padRect`，返回 `pad` 偏移），在 `GpuScene.userGpuOf` 上传；快捷方式槽一律夹取。
  - 探针：请求可给 `shortcutIcons`，结果多 `shortcuts`。MCP 还没透传这一项。
- 应用页：`wpeSceneShortcut.ts` 与 `WpeSceneView` 的转发。
- 面板：`WpeShortcutField.vue`、`utils/wpeShortcut.ts`，「测试」按钮先 `saveNow()` 再调命令；i18n 五种语言各加 14 个键。
- 我的独立验收：
  - 两个类型检查都是 0 error；
  - vitest：场景宿主 30 个文件 547 个、渲染 45 个文件 1166 个、应用 13 个文件 127 个，全过；
  - 4 处变异全被抓到：应用页不查用户激活、异常换成 `Error`、令牌在帧开头就收、`engine.userProperties` 不剥字段。
- 代理报的 `compile/p3a.test.ts` 工作进程崩溃：HEAD 与工作树上我各跑一次，13 个用例全过，判为跑的时候资源吃紧。

**合并**：`ignore/p11/d/merge_d.py` 三方合并（基点 HEAD）。54 个文件里 3 个冲突，都是两边各加了东西：
- 宿主权限：另一个会话加了 `get_wpe_scene_shadows`；
- `WpeSceneView` 的导入：另一个会话加了 `wpePointer`；
- `api.ts`：P3 会话的 `scriptPropertyEntries`。合并时先剥字段再排序。

### 步骤 3 走查（2026-11-15，用户「可以提交」后合并进主工作区）

**合并**：`merge_d.py --apply`，54 个文件，3 个冲突按预定解法合并，备份在 `ignore/p11/d/merge-backup/`。dev 13:05 重编并重启。合并之后又有两个提交改了 `api.ts`：
- `c3142a5a`（材质键顺序）只带了自己的块；
- `637530bd`（P9d 2a）把工作区里整份 `api.ts` 提交了，带走了 P11d 在 `api.ts` 里的 12 行，也带走了 P3 会话还没提交的 `scriptPropertyEntries` 导入。

所以 P11d 提交前的 HEAD 自己就编不过：缺 `runtime.ts` 的 `activeCallback` 等，P11d 提交补上；`bindings.ts` 的 `scriptPropertyEntries` 是 P3 会话的块，P11d 不带。P11d 提交之后宿主 tsc 还剩这一个错误，4 个用到 `engine.userProperties` 的测试报 `scriptPropertyEntries is not a function`，等 P3 会话提交 `bindings.ts` 后消失。

**检查**（主工作区）：
- 宿主 tsc 0 error；应用 vue-tsc 只有别的会话未入库的 `WpeSceneShadowsSetting.vue` 1 个错误；
- Rust：core 14 个、kabegame 135 个通过，另 1 个是手动跑的测试；
- 宿主相关 130 个测试文件 2970 / 2972 通过，失败的两个与本步无关：
  - `pipeline.test.ts`：`3253330537` 发了 648 次请求、`3543014965` 读了 104 MB，合并前的快照同样失败；
  - `p3a.test.ts` 的绑定表完整性：机器同时在编 Rust 时超时（600 s），单独重跑 13 个全过（整个文件约 9 分钟）。
- Prettier 改了两处长行（`api.ts` 合并时那行、新加的测试），rustfmt 无差异。

**结果**（回归 D2–D7）：
- **图标**：dev 应用里 7 种目标与 WPE 的纹理逐像素相同。步骤 1 时差几级的 notepad.exe 与 calc 也相同，证实那是测试程序取不到缩略图（没有应用清单），不是实现问题。
- **门禁**：9 个用例在 WPE（`input_play`）与屏外宿主的探针（`inputTimeline`）上用同一串输入，脚本日志逐行相同。
- **真实启动**：
  - WPE：s1 用本机哈希，`cursorDown` 里返回 `true`、打开 `launch-target`。哈希含 UTF-16 结尾 NUL（候选两个，第一个就对）。
  - Kabegame：应用页调启动命令返回 `true`。同一文件夹的窗口还开着，系统复用了它，画面上没新窗口。
- **反向用例**：宿主调启动命令被 ACL 拒绝；没配、只有工程缺省值返回 `false`；类型不对、不存在、非场景图片报错。
- **语料**：233 个工程，能渲染 175 → 176（`3660962877`），只去掉两个键（6 张、5 张）。`3660962877` 解包导入：编译干净，252 段脚本没有报错，三个图标就绪。

**走查中改的**：探针的 `probeUserProperties` 对没给后端形状的快捷方式属性补 `isbound: false`。原来脚本在 `applyUserProperties` 里收到 `{}`，WPE 与产品宿主都是 `{isbound: false}`。补了单测。

**没做的**：
- 预览里真实点击图标启动（应用页转发的整条链），要开用户的预览，留给用户（回归 D9）。转发由 `WpeSceneView.test.ts` 覆盖，变异检查抓到「不查用户激活」。
- 启动成功不记日志。建议加一条 `info!`，记图片 id 与属性名。没在这一步加，免得 dev 再重编一次。
- dev 的场景宿主产物没重建，探针的修正等下次 dev 启动或别的会话重建时生效。

### 步骤 0（2026-11-15）

**0a、0b（WPE）**：结果写在 [p11-REPORT.md](p11-REPORT.md)「P11d 补测」。工程是 `ignore/p11/defs/p11d.py`，抓帧 `A:\p11\d-icons\`，纹理存在 `ignore/p11/d/wpe-icons/`。对设计的影响：
- 门禁的 8 个用例都和读码一致；异常是 `SyntaxError`，点 5 已改。
- 脚本看到的字段：
  - 没绑定时只有 `isbound`；
  - `cmd` 的 `file` 只有程序部分；
  - 哈希段对不对不影响 `isbound`；
  - `engine.userProperties` 里是 `{}`。

  点 2 已改。
- 图标都是 `R8G8B8A8_UNORM`、1 级 mip、线性、强制夹取。补边按槽的比例（精灵表取帧比例），补的边全透明，中间和 1:1 槽的图标逐像素相同（`check_pad.py`）。
- 网站图标按原尺寸（维基百科 160×160），取不到时是 300×300 的缺省图。

**读码**（[rea-p11d.md](rea-p11d.md)，代理用本机 Ghidra 工程）：取图标的顺序、去预乘的算术、OpenCV 填色与圆形遮罩、网址的取法都读清了。总体设计与点 2 已按它改写，「待定」新增 5。

我用存下的纹理核对了两条：
- 5 张 Shell 取的图标里，alpha ≤ 1 的像素 RGB 全都不为 0（填过色）；
- 两张网站图标最大 alpha 254、圆外是白色（没填色）。

**更正**：rea-p11-textures 说「`.lnk` 经 `IShellLink` 取图标位置」，是把已知文件夹的 `pszIcon` 读成了 `.lnk`。实际上没有 `.lnk` 专门的分支，先走缩略图缓存。

**0c（用户激活）没测成。** 两次用屏外宿主试：把它挪到主窗口左上角 80×80，用 CDP 点。
- 主窗口被别的窗口挡住时 `visibilityState` 是 `hidden`，浏览器不给跨进程的 iframe 做命中测试，点击都落在主页面上：主页面被激活，宿主没收到 `pointerdown`。
- 只有一次（窗口当时可见）第二下点进了 iframe，宿主被激活；但主页面已被第一下激活，分不清是不是从 iframe 传上去的。
- 要在主窗口可见时重测：把窗口带到前台测几秒，或者放到走查时你在场一起测。

**0c 补测（同日，用户「现在可以补测用户激活」，主窗口可见）：通过。**
- 点击只进了 iframe：宿主的 `pointerdown` 计数加 1，主页面的计数仍是 0。主页面照样被激活，说明激活从子 frame 传到了祖先。
- 约 5.0 s 后过期。

方案 A 的前提成立。桌面壁纸窗口的注入点击【推】同样激活，走查时如能测就在壁纸窗口上再确认一次。详见 p11-REPORT「P11d 补测」。
