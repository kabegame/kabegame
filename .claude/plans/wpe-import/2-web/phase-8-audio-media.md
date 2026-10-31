# Phase 8 — 音频可视化与媒体集成

> 状态：方案（2026-10-31；同日按 B 段 iframe 统一与 CEF 补丁 07 之后的代码重写），决策 1 / 2 / 3 / 5 待确认（见文末）；调用方 frame 并入 tauri 补丁 18（决策 6）。
> 上级：[PLAN.md](PLAN.md)。
>
> 用户决定（2026-10-31）：
> - 没有多显示器，Phase 6 继续跳过，先做 Phase 8。本 Phase 不依赖 Phase 6：没有暂停机制时，采集只在「没有页面订阅」时停；
>   Phase 6 落地后由它的暂停条件挂起推送（见点 9）。
> - 预览与桌面两边都收数据（决策 4）。
>
> 主测试样本：创意工坊 `3747222633`「音域回响 · Sonic Topography」（尚未导入 dev 库）。它在 `<head>` 内联脚本里注册
> 4 个媒体监听（属性 / 封面 / 播放状态 / 时间轴），在模块脚本里注册音频监听，把 128 个值按下标插值成 512 个；
> 没有音频时显示「空闲波浪」。辅助样本：`12100` Corsair-O-Tron、`12098` 阿洛娜指纹识别（都声明了 `supportsaudioprocessing`），
> 反例 `12099` Personal Slideshow（声明为 `false`）。

## 总体设计思路

WPE 的音频与媒体数据是「页面订阅、宿主推送」：页面调用 `wallpaperRegisterAudioListener` / `wallpaperRegisterMedia*Listener`
登记回调，WPE 渲染进程在页面登记之后才开始送数据（API.md §4.8）。Kabegame 照这个形状实现，传输用 Tauri 的
**Channel**：垫片在页面第一次登记某类监听时，向后端订阅这一类数据并交出一个 Channel，后端把数据只推回这个 Channel。
不用全局事件，原因与应用日志流（`start_app_log_stream`）相同：每秒 30 帧的频谱不该进入事件系统，也不该让同窗口里
别的监听者收到；tauri 补丁 18 起，作为命令参数收到的 Channel 只投递到发起调用的那个 frame。数据分两类订阅：
`audio`（频谱）与 `media`（媒体会话的状态、属性、封面、播放状态、时间轴）。

两种宿主已经是同一条路：图库预览（主窗口）和桌面（壁纸窗口）都是 `WallpaperStage` web 层里的 `file:` iframe，
iframe 里有 Tauri 的 IPC 桥（补丁 19），权限只来自 `wpe-web-capability`。订阅命令与 `wpe_web_pull_state` 一样，
按调用方文档 URL（`CallerOrigin`，由 CEF 补丁 07 在建工厂时确定）经 `WpeWebDirIndex` 认出是哪张，
不再分「桌面按 label 找窗口、预览由宿主页代办」两套，前端也没有桥要写。预览和桌面同时显示时各订各的，共用一个采集线程。
音频订阅照 WPE 只对 `general.supportsaudioprocessing: true` 的壁纸放行。

后端新增 Windows 专属模块 `wpe_media`，核心是全局订阅表 `WpeMediaHub`：表里有 `audio` 订阅时才开 WASAPI 回环采集线程，
有 `media` 订阅且设置「媒体集成」打开时才开系统媒体会话（`GlobalSystemMediaTransportControlsSessionManager`）监视；
最后一个订阅离开即停。频谱计算与封面配色是纯函数，单测覆盖；采集与监视只负责把系统数据喂给它们。音频按 WPE 规格每 33ms
推一次 128 个浮点（左右各 64 段、低频在前、大致 0–1），**定时器独立于采集包**：WASAPI 回环在系统静音时不送包，
这时照常推逐帧衰减到 0 的数据，页面的空闲判断才会生效。媒体按变化推送；新订阅先收到一份当前快照（WPE 只在变化时推，
补快照对页面无害，且让晚于第一次变化才登记的页面也有数据）。

订阅**归属调用方 frame**，frame 销毁即释放。这是本方案最关键的一处，理由有二：
- Channel 发往已销毁子 frame 时被运行时静默丢弃，`send` 照样返回 `Ok`，「发送失败即删除」对 frame 级销毁不起作用；
- 大于 8 KB 的消息（封面）要先存进 Tauri 的 Channel 数据队列、等页面来取，frame 销毁之后新存进去的条目没人取，
  一直留到整个 webview 销毁；频谱每秒 30 次 eval 也会继续打到不存在的 frame 上。

Tauri 已经在子 frame 销毁时发 `WebviewEvent::SubframeDestroyed` 并清掉自己的监听，应用可以用 `Builder::on_webview_event`
收到；缺的是应用命令拿不到「调用方是哪个 frame」（`CallerFrameAddress` 是 crate 私有）。frame 级 IPC 本来就是
tauri 补丁 18 引入的，`CallerFrameAddress` 与 `CallerOrigin` 都在里面，所以直接在 18 里补一个公开命令参数
`tauri::ipc::CallerFrame`，不另起补丁。订阅表按 `(webview label, SubframeId, 类型)` 存：
- `SubframeDestroyed` → 删该 frame 的订阅。主窗口刷新、看门狗整页重载、关预览、网页壁纸之间直接切换都会销毁旧 iframe，
  不需要在导航入口或宿主页里另外释放；旧 frame 的销毁事件晚到也只删旧 id，碰不到新 iframe 的订阅，没有先后竞争。
- 同一 frame 再订阅同一类 → 替换旧条（覆盖 iframe 自己刷新、frame 不换的情况）。
- 窗口销毁 → 删该 label 的全部订阅；`send` 失败（webview 已不在）→ 删该条，作兜底。
- 不提供退订命令：WPE 没有取消登记的接口，垫片也无从调用。

不选「宿主页销毁 iframe 时代为释放」：它与新 iframe 的订阅请求有先后竞争，也管不到页面自己刷新。

设置只加一项「媒体集成」（`wpeMediaIntegration`，走 settings 架构）：它决定媒体监视开不开，以及页面收到的
`MediaStatus { enabled }`。音频不另设开关：WPE 只看壁纸自己声明的 `supportsaudioprocessing`。

## 现状锚点

**a. 垫片：六个注册函数只存回调，从不回调**（`src-tauri/kabegame/src/webview_js/wpe_shim.js:15`）
```js
  window.wallpaperMediaIntegration = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };
  var registered = {};
  [
    "wallpaperRegisterAudioListener",
    "wallpaperRegisterMediaStatusListener",
    "wallpaperRegisterMediaPropertiesListener",
    "wallpaperRegisterMediaThumbnailListener",
    "wallpaperRegisterMediaPlaybackListener",
    "wallpaperRegisterMediaTimelineListener",
  ].forEach(function (name) {
    registered[name] = [];
    // 可多次注册、全部保留；Phase 8 起才有数据回调        ← 现状：没有订阅、没有数据
    window[name] = function (cb) {
      if (typeof cb === "function") registered[name].push(cb);
    };
  });
```

**b. 垫片只有一种传输：iframe 直接 `invoke` / `listen`**（`wpe_shim.js` 末尾；预览与桌面同一份，`internals` 在垫片开头已取到）
```js
  var transport = {
    pull: function () {
      return internals.invoke("wpe_web_pull_state");
    },
    listen: function (names, onEvent) {
      return Promise.all(
        names.map(function (name) {
          var handler = internals.transformCallback(function (event) {
            onEvent({ name: name, payload: event.payload });
          });
          return internals.invoke("plugin:event|listen", { event: name, handler: handler });
        }),
      );
    },
  };                                                          // 现状：没有 subscribe
```

**c. 网页壁纸的权限**（`src-tauri/kabegame/permissions/wpe-web.toml`、`capabilities/wpe-web.json`）
```toml
[[permission]]
identifier = "wpe-web"
description = "WPE web wallpaper page (file://) permissions"
commands.allow = ["wpe_web_pull_state", "wallpaper_pong"]   # 现状：没有订阅命令
```
```json
  "identifier": "wpe-web-capability",
  "description": "WPE web wallpaper pages: the file: iframe of WallpaperStage in the main window (gallery preview) and in the wallpaper window (desktop). Pull state, answer pings, listen to four events. …",
  "windows": ["main", "wallpaper"],
  "frames": "sub",
  "remote": { "urls": ["file:///*"] },
```

**d. 拉取命令按调用方文档认壁纸**（`src-tauri/kabegame/src/commands/wpe_web.rs:283`）
```rust
pub async fn wpe_web_pull_state(caller: tauri::ipc::CallerOrigin) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    let id = index
        .image_id_of(&doc)
        .ok_or("not inside a web wallpaper")?;              // 订阅命令照此认「调用方是哪张」
    …
}
```
图片 metadata 就是 `project.json` 原文（`parse_defs` 读 `/general/properties`），`supportsaudioprocessing` 在
`/general/supportsaudioprocessing`。

**e. Channel 只投递到发起调用的 frame；frame 没了就静默丢弃**
```rust
// third/tauri/crates/tauri/src/ipc/channel.rs —— Channel 作为命令参数
impl<'de, R: Runtime, TSend> CommandArg<'de, R> for Channel<TSend> {
  fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
    …
    let Some(address) = command.message.caller_address.clone() else {
      return Err(InvokeError::from("a channel cannot be delivered to the frame that made this call"));
    };
    … .map(|id| id.channel_on_frame(webview, address))
  }
}
// 同文件 channel_on_frame：小于 8192 字节直接 eval 到该 frame；更大的存进 ChannelDataIpcQueue，
// 只检查「webview 还在」（insert_if(.., || webview.is_registered())），再 eval 一段 fetch 让页面来取
```
```rust
// src-tauri/tauri-runtime-kbcef/src/runtime.rs:3307 —— 子 frame eval
                WebviewMessage::EvalInSubframe(subframe_id, script) => {
                    …
                    match frame.filter(|frame| frame.is_valid() == 1) {
                        Some(frame) => { /* execute_java_script */ }
                        // frame 已销毁:与主 frame 导航后 eval 落空一致,静默丢弃   ← 现状：send 不会失败
                        None => tracing::trace!("eval target frame no longer exists: {}", …),
                    }
                }
```
大消息由页面调 `plugin:__TAURI_CHANNEL__|fetch` 取回：这个命令不走 ACL，补丁 18 起只把条目交给它发往的那个 frame。
真机 D8 只在主窗口验证过 Channel 的大消息取数。

**f. 子 frame 销毁已有事件，应用可收**
```rust
// third/tauri/crates/tauri/src/app.rs:205
  /// A subframe of the webview was destroyed. Tauri drops the JS event listeners it registered;
  /// apps do not need to handle it. Only runtimes that report subframes emit it.
  SubframeDestroyed(crate::webview::SubframeId),
// third/tauri/crates/tauri/src/manager/webview.rs:770 —— Tauri 自己的处理
    WebviewEvent::SubframeDestroyed(id) => {
      webview.manager().listeners().remove_subframe_js_listeners(webview.label(), id);
      webview.state::<ChannelDataIpcQueue>().remove_frame_entries(webview.label(), &FrameAddress::Sub(id.clone()));
    }
// 应用侧：Builder::on_webview_event(|webview, event| …) 收到同一事件（manager/webview.rs:650 转发给全局监听）
```
```rust
// src-tauri/tauri-runtime-kbcef/src/webview.rs:1315 —— CEF OnFrameDestroyed，主 frame 不报
            fn on_frame_destroyed(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>) {
                …
                (self.emitter)(WebviewEvent::SubframeDestroyed(SubframeId::new(id)));
            }
```

**g. 应用命令拿不到调用方 frame**（`third/tauri/crates/tauri/src/ipc/mod.rs:600`）
```rust
/// The frame that made the call (see [`FrameAddress::of_caller`]).
///
/// Command argument for crate commands that send something back to the caller later: `listen`,
/// `unlisten` and the channel data `fetch`. Read from the invoke message, never from the payload.
pub(crate) struct CallerFrameAddress(pub(crate) Option<FrameAddress>);   // 现状：crate 私有
// webview/mod.rs:162
pub(crate) enum FrameAddress { Main, Sub(SubframeId) }                   // SubframeId 已公开（tauri::webview::SubframeId）
```

**h. web → web 切换先销毁旧 iframe 再建新的**（`apps/kabegame/src/components/wallpaper/WallpaperStage.vue:636`）
```ts
async function enterWeb(next: WallpaperTarget, normalizedPath: string) {
  setLastError("");
  if (webFrameEl) {
    … // 有过渡时先淡出
    teardownWeb();                       // 旧 iframe 移除 → CEF 报 SubframeDestroyed
  }
  …
  await createWebFrame(next.webEntry);   // 新 iframe，新的 SubframeId
```
这条路径依赖 `10172b1b`（渲染侧按 browser id 计数）：之前网页壁纸之间直接切换时，新 iframe 偶发整份没有 IPC 桥。

**i. 应用的窗口事件钩子**（`src-tauri/kabegame/src/lib.rs:540`）
```rust
        builder = builder.on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => { … }
            tauri::WindowEvent::Destroyed => {
                if window.label().starts_with("surf-") { … }        // 现状：只处理畅游
            }
            _ => {}
        });
```
应用没有注册 `on_webview_event`。

**j. Channel 推送的现成写法**（`src-tauri/kabegame/src/commands/app_logs.rs:33`）
```rust
/// 用 Channel 而不是全局事件：Channel 只回到开启查看器的那个页面，日志不会进入事件系统。
#[tauri::command]
pub fn start_app_log_stream(on_logs: Channel<Vec<LogRecord>>) { … }
```
消息形如 `{ message, index }`，`index` 用来按序投递（大消息走 fetch 会晚到）；Channel 被丢弃时 Tauri 再 eval 一条
`{ end: true, index }`。

**k. 设置项的现成写法**（以 `wallpaperVolume` 为例）
```rust
// kabegame-core/src/settings/mod.rs
    WallpaperVolume,                                                  // :124 SettingKey 枚举
            SettingKey::WallpaperVolume => SettingValue::F64(1.0),    // :352 默认值
            SettingKey::WallpaperVolume,                              // :449 全部键列表
            SettingKey::WallpaperVolume => { … clamp … }              // :606 从 JSON 读取
            SettingKey::WallpaperVolume => "wallpaperVolume".to_string(), // :783 键名
    pub fn get_wallpaper_volume(&self) -> f64 { … }                   // :1118
    pub fn set_wallpaper_volume(&self, volume: f64) -> Result<(), String> { …; Self::emit_setting_change(…); }
// kabegame/src/commands/settings.rs：get_ / set_ 命令；lib.rs 注册
// apps/kabegame/src/stores/settingsDescriptors.ts
    tauri("wallpaperVolume", "get_wallpaper_volume", "set_wallpaper_volume", "volume"),   // :191
      readonly("wallpaperVolume", 0.5),                                                    // :284 Web 版
```

**l. 依赖**（`src-tauri/kabegame/Cargo.toml:67`）
```toml
[target.'cfg(target_os = "windows")'.dependencies]
tauri-plugin-wemt = { workspace = true, optional = true }
windows = {version = "0.52", features = [
  "Win32_Foundation",
  "Win32_System_Com",
  "Win32_UI_Shell",
] }                                   # 现状：没有音频、WinRT 媒体相关 feature；仓库里没有任何 FFT crate
windows-sys = {workspace = true, features = [ … ] }
```
`image`（含 jpeg / png）与 `base64` 已是依赖。

## 点 1 — tauri 补丁 18 增补：公开调用方 frame（`third/tauri/crates/tauri/src/ipc/`）

- **新增** `ipc/mod.rs`：命令参数 `CallerFrame`，放在 18 已加的 `CallerOrigin` 旁边，规则与 Channel 参数一致（取不到 frame 即失败）：
```rust
/// The frame that made the call, for app commands that keep something per calling frame, for example a
/// subscription whose [`Channel`] delivers to that frame, and drop it on
/// [`WebviewEvent::SubframeDestroyed`](crate::WebviewEvent::SubframeDestroyed).
///
/// Read from the invoke message (reported by the runtime), never from the payload. Fails when the
/// calling frame cannot be addressed: a subframe the runtime gave no id for, or a request without a frame.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CallerFrame {
  /// The main frame of the webview.
  Main,
  /// A subframe, with the id the runtime reported for it.
  Sub(crate::webview::SubframeId),
}

impl<'a, R: Runtime> CommandArg<'a, R> for CallerFrame {
  fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
    match &command.message.caller_address {
      Some(FrameAddress::Main) => Ok(Self::Main),
      Some(FrameAddress::Sub(id)) => Ok(Self::Sub(id.clone())),
      None => Err(InvokeError::from("the calling frame of this invoke cannot be addressed")),
    }
  }
}
```
- **修改** `app.rs` 里 `WebviewEvent::SubframeDestroyed` 的文档（18 加的）：「apps do not need to handle it」改为「Tauri drops
  what it kept for the frame; apps that keep something per [`ipc::CallerFrame`] release it here」。
- **新增** `ipc/protocol.rs` 测试模块里、18 已有的 `caller_origin_is_the_request_origin` 旁边：
```rust
  #[crate::command(root = "crate")]
  fn caller_frame(frame: crate::ipc::CallerFrame) -> String {
    match frame {
      crate::ipc::CallerFrame::Main => "main".into(),
      crate::ipc::CallerFrame::Sub(id) => id.0.to_string(),
    }
  }

  /// `CallerFrame` is the frame the runtime reported for the request, never the payload; a caller that
  /// cannot be addressed is rejected.
  #[test]
  fn caller_frame_is_the_reported_frame() {
    // 同 caller_origin_is_the_request_origin 的 mock 窗口与 InvokeRequest，body 里塞 { "frame": "evil" }：
    // frame: Sub + subframe_id Some("frame-a") → "frame-a"；frame: Main → "main"；frame: Sub + subframe_id None → 错误
  }
```
- **生成**：重写 18，不 reset 子模块。19 只改 `crates/tauri-runtime/src/webview.rs` 与 `crates/tauri/src/manager/webview.rs`，
  和这次改的三个文件不重叠，可以先撤下 19 再从 17 生成：
```bash
# third/tauri 当前是基线 + 01–19，再加上面的改动
git -C third/tauri apply -R ../../third-patches/tauri/19-tauri-subframe-ipc-injection.patch   # 撤下 19
deno task patch tauri --gen --from 17 --out third-patches/tauri/18-tauri-frame-scoped-ipc.patch # 覆盖 18
git -C third/tauri apply ../../third-patches/tauri/19-tauri-subframe-ipc-injection.patch       # 重新套上 19
deno task patch tauri --check
```
  > 说明：不走 `deno task patch tauri` 的 reset，避免改写整个子模块的文件时间、让 tauri 栈全量重编；只有 19 的两个文件被重写。
  生成后核对新 18 相对旧 18 只多出这三处。注释用英文。

## 点 2 — 消息与订阅表（`src-tauri/kabegame/src/wpe_media/mod.rs`，新，Windows）

- **新增** 推给页面的消息类型，字段名照 WPE 回调参数（camelCase），`type` 区分：
```rust
/// 推给网页壁纸页面的一条数据，字段与 WPE 回调参数同名（API.md §3.2）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WpeMediaMessage {
    /// 128 个浮点：0–63 左声道、64–127 右声道，各自低频在前；已去掉 NaN / Infinity。
    Audio { data: Vec<f32> },
    Status { enabled: bool },
    #[serde(rename_all = "camelCase")]
    Properties {
        title: String,
        artist: String,
        sub_title: String,
        album_title: String,
        album_artist: String,
        genres: String,        // 逗号分隔
        content_type: String,  // music / video / image
    },
    #[serde(rename_all = "camelCase")]
    Thumbnail {
        thumbnail: String,     // data:image/png;base64,…（无封面时为空串）
        primary_color: String,
        secondary_color: String,
        tertiary_color: String,
        text_color: String,
        high_contrast_color: String,
    },
    Playback { state: u8 },    // 0 停止 / 1 播放 / 2 暂停
    Timeline { position: f64, duration: f64 }, // 秒
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WpeMediaKind { Audio, Media }
```
- **新增** 订阅表。发送端抽象成 trait，单测不需要真实 webview：
```rust
/// 一条订阅的发送端；返回 false 表示对端 webview 已不存在，订阅随即删除。
/// 注意 frame 已销毁时 Tauri Channel 的发送照样成功，frame 级释放靠 `release_frame`。
pub trait MediaSink: Send + Sync {
    fn send(&self, message: &WpeMediaMessage) -> bool;
}

/// 一条订阅：归属某个 webview 里的某个子 frame（网页壁纸 iframe）。
struct Subscription { label: String, frame: SubframeId, kind: WpeMediaKind, sink: Box<dyn MediaSink> }

/// 全局订阅表：有 audio 订阅才开采集线程，有 media 订阅且「媒体集成」打开才开媒体监视；
/// 每次增删后按订阅表重算两者该不该运行（`reconcile`）。
pub struct WpeMediaHub {
    subs: Mutex<Vec<Subscription>>,
    audio: Mutex<Option<audio::AudioCapture>>,   // Drop 即停线程
    media: Mutex<Option<media::MediaWatcher>>,   // Drop 即退订系统事件
}

impl WpeMediaHub {
    pub fn global() -> &'static Self;
    /// 新订阅；同一 `(label, frame, kind)` 已有的旧条被替换（iframe 自己刷新、frame 不变）。
    /// media 先收到 `Status` 与当前快照（若监视在运行），再随变化推送。
    pub fn subscribe(&self, label: &str, frame: SubframeId, kind: WpeMediaKind, sink: Box<dyn MediaSink>);
    /// 子 frame 销毁（`WebviewEvent::SubframeDestroyed`）：删这个 frame 的全部订阅。
    pub fn release_frame(&self, label: &str, frame: &SubframeId);
    /// 窗口销毁：删这个 webview 的全部订阅。
    pub fn release_label(&self, label: &str);
    /// 设置「媒体集成」变化：向全部 media 订阅推 `Status`，并启停监视。
    pub fn set_media_enabled(&self, enabled: bool);
    /// 采集线程 / 监视器回调：按 kind 广播，发送失败的订阅删除后 reconcile。
    fn broadcast(&self, kind: WpeMediaKind, message: &WpeMediaMessage);
}
```
  - 媒体快照由 `MediaWatcher` 持有（每类最后一条），新订阅时按 `Properties → Thumbnail → Playback → Timeline` 补发。
  - Tauri `Channel<WpeMediaMessage>` 实现 `MediaSink`：`channel.send(message.clone()).is_ok()`。
  - 增删订阅打 `debug!`（label、frame、kind、增删后的订阅数），回归 B4–B8 靠它核对订阅数；逐帧路径不打日志。
- **新增** `src-tauri/kabegame/src/lib.rs`：`#[cfg(target_os = "windows")] mod wpe_media;`。

## 点 3 — 频谱（`wpe_media/spectrum.rs`，新，纯函数）

- **新增** `Spectrum`：每声道保留最近 2048 个样本的环形缓冲，每次 `frame()` 产出 128 个值。WPE 的具体算法没有公开资料，
  这里自定，常数集中在一处，真机按样本调：
```rust
/// 把立体声样本流变成 WPE 的 128 段频谱（API.md §3.2：左 0–63、右 64–127，低频在前，大致 0–1）。
/// 算法：Hann 窗 → 2048 点实数 FFT → 64 个对数间隔频段（30 Hz – 16 kHz，不超过奈奎斯特）取段内最大幅值
/// → 换成 dB 线性映射到 0–1（可略超 1）→ 上升即时、下降按帧衰减。
pub struct Spectrum {
    sample_rate: u32,
    left: Ring, right: Ring,         // 各 2048
    smoothed: [f32; 128],
    fft: Arc<dyn realfft::RealToComplex<f32>>,
    bands: Vec<(usize, usize)>,       // 每段的 FFT 下标区间；低频段可能共用一个下标
}

pub struct SpectrumTuning {
    pub min_db: f32,      // 映射到 0 的电平，初值 -70
    pub range_db: f32,    // 映射区间，初值 60（-10 dB ≈ 1.0）
    pub tilt_db_per_octave: f32, // 高频补偿，初值 3
    pub release: f32,     // 每帧保留比例，初值 0.75（约 0.1 s 衰减一半）
}

impl Spectrum {
    pub fn new(sample_rate: u32) -> Self;
    /// 交错样本（只取前两个声道；单声道复制到两边）。
    pub fn push(&mut self, interleaved: &[f32], channels: usize);
    /// 静音时调用：往缓冲里补零，让频谱自然衰减到 0。
    pub fn push_silence(&mut self, frames: usize);
    /// 一帧 128 个值，非有限值置 0。
    pub fn frame(&mut self) -> [f32; 128];
}
```
- **新增** 依赖 `realfft`（基于 `rustfft`，MIT / Apache-2.0）：`src-tauri/kabegame/Cargo.toml` 的 Windows 依赖段。
- **新增** 单测：1 kHz 正弦落在对应频段且左右独立；全零输入在若干帧后全部为 0；输入含 NaN 时输出无 NaN；
  48 kHz 与 44.1 kHz 下频段边界单调且覆盖 64 段。

## 点 4 — 回环采集线程（`wpe_media/audio.rs`，新）

- **新增** `AudioCapture`：一个专用线程，COM MTA 初始化，打开默认渲染设备（`eRender` / `eConsole`）的共享模式回环流
  （`AUDCLNT_STREAMFLAGS_LOOPBACK`），按 `GetMixFormat` 读样本；每 10ms 轮询一次 `GetNextPacketSize` / `GetBuffer`，
  每 33ms 调 `Spectrum::frame()` 交给 `WpeMediaHub::broadcast(Audio)`。
```rust
pub struct AudioCapture { stop: Arc<AtomicBool>, thread: Option<JoinHandle<()>> }

impl AudioCapture {
    /// 起线程；失败（没有输出设备等）只记日志，线程照样按 33ms 推静音帧，页面行为与「没在放音乐」一致。
    pub fn start(on_frame: impl Fn([f32; 128]) + Send + 'static) -> Self;
}
impl Drop for AudioCapture { /* 置停止标志并 join */ }
```
  - 推送定时器与采集包解耦：包里带 `AUDCLNT_BUFFERFLAGS_SILENT` 或这段时间没有包（系统静音时回环不送包）都按静音补零。
  - 样本格式：只处理 mix format 的 32 位浮点与 16 位整数，其它格式记一次 `warn!` 后按静音处理。
  - 设备变化：`GetBuffer` 返回 `AUDCLNT_E_DEVICE_INVALIDATED`，或每秒比对一次默认设备 id 发现变化，就关掉重开；
    不实现 `IMMNotificationClient`（要写 COM 回调，轮询足够）。
  - 线程里的逐帧路径不打 `trace!` 以上日志。
- **修改** `src-tauri/kabegame/Cargo.toml` 的 `windows` feature：加 `Win32_Media_Audio`、`Win32_Media_KernelStreaming`
  （mix format 的子格式 GUID）、`Win32_System_Com_StructuredStorage`、`Win32_System_Threading`（按需，以编译为准）。

## 点 5 — 媒体会话监视（`wpe_media/media.rs`、`wpe_media/colors.rs`，新）

- **新增** `MediaWatcher`：`GlobalSystemMediaTransportControlsSessionManager::RequestAsync()` 拿到管理器，订阅
  `CurrentSessionChanged`；对当前会话订阅 `MediaPropertiesChanged`、`PlaybackInfoChanged`、`TimelinePropertiesChanged`，
  会话切换时重新挂。每类变化读一次、与上次比较，有差异才广播：
  - `Properties`：`Title`、`Artist`、`Subtitle`、`AlbumTitle`、`AlbumArtist`、`Genres`（逗号拼接）、`PlaybackType`
    （Music → `music`，Video → `video`，Image → `image`，未知按 `music`）。
  - `Thumbnail`：读 `Thumbnail` 流 → `image` 解码 → 长边缩到不超过 512 → PNG 编码 → `data:image/png;base64,`（API.md §3.2 的 REA 结论）；
    颜色由 `colors.rs` 从缩到 64×64 的图里算。没有封面时推空串与默认色。解码放 blocking 线程。
  - `Playback`：`PlaybackStatus` Playing → 1、Paused → 2，其余（Stopped / Closed / Opened / Changing）→ 0。
  - `Timeline`：`Position` / `EndTime - StartTime` 换算成秒；播放中每秒补一次，位置按 `LastUpdatedTime` 外推
    （很多播放器只在跳转时更新时间轴）。播放器不提供时间轴（`EndTime` 为 0）就不推，页面要能接受永不回调（官方文档）。
  - 没有会话：推 `Playback { state: 0 }`，属性清空。
- **新增** `colors.rs`：
```rust
/// 封面的三个主色（按像素占比排序的简单中位切分）、与主色对比足够的文字色、黑白中对比更高的那个。
/// 输出 CSS `rgb(r, g, b)` 字符串（官方文档没写格式，页面通常直接赋给 style）。
pub fn thumbnail_colors(rgba: &image::RgbaImage) -> ThumbnailColors;
```
  - 单测：纯色图三个主色相同；黑底白字图的 `highContrastColor` 为白；文字色与主色的对比度不低于 4.5。
- **修改** `windows` feature：加 `Media_Control`、`Foundation`、`Storage_Streams`。

## 点 6 — 订阅命令与权限（`src-tauri/kabegame/src/commands/wpe_web.rs`、`permissions/`、`capabilities/`）

- **新增**
```rust
/// 网页壁纸订阅音频（`audio`）或媒体会话（`media`）数据，经 `channel` 推回调用的 iframe。
///
/// 预览（主窗口）与桌面（壁纸窗口）的网页壁纸 iframe 走同一条路：按调用方文档认出是哪张（同
/// [`wpe_web_pull_state`]）；订阅归属调用方 frame，frame 销毁即释放（见 `lib.rs` 的 `on_webview_event`），
/// 同一 frame 再订阅同一类替换旧条，所以没有退订命令。只接受子 frame：两个窗口的主 frame 是应用页。
/// `audio` 只对 `general.supportsaudioprocessing: true` 的壁纸放行（照 WPE）。WPE 网页壁纸只支持 Windows，
/// 其它平台返回错误。
#[tauri::command]
pub async fn wpe_web_media_subscribe<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    caller: tauri::ipc::CallerOrigin,
    frame: tauri::ipc::CallerFrame,
    kind: WpeMediaKind,
    channel: tauri::ipc::Channel<WpeMediaMessage>,
) -> Result<(), String> {
    let tauri::ipc::CallerFrame::Sub(frame) = frame else {
        return Err("only web wallpaper frames can subscribe".to_string());
    };
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let id = WpeWebDirIndex::global()
        .image_id_of(&doc)
        .ok_or("not inside a web wallpaper")?;
    if kind == WpeMediaKind::Audio && !supports_audio_processing(&id).await? {
        return Err("this wallpaper does not process audio".to_string());
    }
    WpeMediaHub::global().subscribe(webview.label(), frame, kind, Box::new(channel));
    Ok(())
}
```
  - `supports_audio_processing`：blocking 线程里 `Storage::global().get_metadata(&id)`，读
    `/general/supportsaudioprocessing`，只有 `true` 才放行（缺失按 `false`，与 WPE 一致）。
- **修改** `permissions/wpe-web.toml`：
```toml
commands.allow = ["wpe_web_pull_state", "wallpaper_pong", "wpe_web_media_subscribe"]   # 新增订阅命令
```
- **修改** `capabilities/wpe-web.json` 的 `description`：「Pull state, answer pings, listen to four events」后补
  「subscribe to audio / media data over a channel」。listen 作用域不变（不用事件）。
- **修改** `lib.rs` 在 `wpe_web_pull_state` 旁注册（`#[cfg(not(target_os = "android"))]`，与其它 WPE 命令同处；
  实现内部按 Windows 门控）。

## 点 7 — 释放接线（`src-tauri/kabegame/src/lib.rs`）

- **新增** `configure_app` 的桌面分支注册全局 `on_webview_event`：
```rust
        // 网页壁纸的音频 / 媒体订阅归属 iframe：frame 销毁即释放（Channel 发往已销毁 frame 会被静默丢弃，
        // 发送不会失败；大消息还会留在 Tauri 的 Channel 数据队列里）。主窗口刷新、看门狗重载、关预览、
        // 网页壁纸之间切换都会销毁旧 iframe。
        #[cfg(target_os = "windows")]
        {
            builder = builder.on_webview_event(|webview, event| {
                if let tauri::WebviewEvent::SubframeDestroyed(frame) = event {
                    crate::wpe_media::WpeMediaHub::global().release_frame(webview.label(), frame);
                }
            });
        }
```
- **修改** `on_window_event` 的 `WindowEvent::Destroyed` 分支，在畅游处理之前加：
```rust
            tauri::WindowEvent::Destroyed => {
                #[cfg(target_os = "windows")]
                crate::wpe_media::WpeMediaHub::global().release_label(window.label());   // 新增：窗口没了，订阅随之作废
                if window.label().starts_with("surf-") { … }
            }
```
- **不改** `WallpaperWindow`（窗口不再导航，看门狗重载销毁的子 frame 由上面的事件覆盖）与 `WallpaperStage`（不代为释放）。

## 点 8 — 垫片（`webview_js/wpe_shim.js`）

- **修改** 注册函数：每类第一次登记时订阅；数据到达后回调全部已登记的函数；媒体每类缓存最后一条，之后才登记的回调
  在微任务里补一次。注册函数只会被页面脚本调用，那时垫片已整体执行完，`transport` 已赋值。
```js
  var registered = {};
  var lastMedia = {}; // 新增：媒体每类最后一条（音频不缓存）
  var subscribed = {}; // 新增：audio / media 是否已订阅
  var MEDIA_LISTENERS = {
    // 新增：消息 type → 注册函数名
    status: "wallpaperRegisterMediaStatusListener",
    properties: "wallpaperRegisterMediaPropertiesListener",
    thumbnail: "wallpaperRegisterMediaThumbnailListener",
    playback: "wallpaperRegisterMediaPlaybackListener",
    timeline: "wallpaperRegisterMediaTimelineListener",
  };
  [ … ].forEach(function (name) {
    registered[name] = [];
    // 可多次注册、全部保留；每类第一次登记即向宿主订阅（WPE 同样在登记后才送数据）
    window[name] = function (cb) {
      if (typeof cb !== "function") return;
      registered[name].push(cb);
      var kind = name === "wallpaperRegisterAudioListener" ? "audio" : "media";
      if (!subscribed[kind]) {
        subscribed[kind] = true;
        // 壁纸没声明 supportsaudioprocessing 时被拒：照 WPE 永不回调，不报错
        transport.subscribe(kind, onMedia).catch(function () {});
      }
      var type = mediaTypeOf(name); // 新增：晚登记补最后一条
      if (type && lastMedia[type]) {
        var last = lastMedia[type];
        queueMicrotask(function () {
          invokeListener(cb, last);
        });
      }
    };
  });
  function onMedia(message) {
    // 新增：Channel 送来的一条
    if (message.type === "audio") {
      // 每个回调一份新数组：页面可能就地改写
      registered.wallpaperRegisterAudioListener.forEach(function (cb) {
        invokeListener(cb, message.data.slice());
      });
      return;
    }
    var name = MEDIA_LISTENERS[message.type];
    if (!name) return;
    var payload = Object.assign({}, message);
    delete payload.type;
    lastMedia[message.type] = payload;
    registered[name].forEach(function (cb) {
      invokeListener(cb, payload);
    });
  }
```
  - `invokeListener` 用 try/catch 包住页面回调，异常记 `console.error("[kb-wpe] …")`，与 `call` 一致。
- **修改** `transport` 加 `subscribe(kind, onMessage)`：手写 Tauri Channel 的序号协议（乱序先存、按 `index` 顺序投递，
  同 `@tauri-apps/api` 的 `Channel`；`{ end: true }` 忽略），实参传 `"__CHANNEL__:" + id`。大消息由 Tauri 生成的脚本
  在本 frame 里调 `plugin:__TAURI_CHANNEL__|fetch` 取回再走同一个回调，垫片不用管：
```js
    subscribe: function (kind, onMessage) {
      var next = 0;
      var pending = {};
      var id = internals.transformCallback(function (raw) {
        if (!raw || "end" in raw) return;
        pending[raw.index] = raw.message;
        while (next in pending) {
          var message = pending[next];
          delete pending[next];
          next++;
          onMessage(message);
        }
      });
      return internals.invoke("wpe_web_media_subscribe", { kind: kind, channel: "__CHANNEL__:" + id });
    },
```
- **修改** 传输段注释：权限清单补「订阅音频 / 媒体（Channel，只回本 frame，frame 销毁即由后端释放）」。
- 页面不会退订：WPE 没有取消登记的接口。

## 点 9 — 设置「媒体集成」（core settings → 命令 → 前端）

- **新增** `SettingKey::WpeMediaIntegration`（键名 `wpeMediaIntegration`，`bool`，默认值见决策 2）：枚举、默认值、
  全部键列表、从 JSON 读取、键名五处照 `WallpaperVolume`；`get_` / `set_`，setter 发 `setting-change`；
  `kabegame/src/commands/settings.rs` 两个命令、`lib.rs` 注册；setter 之后调 `WpeMediaHub::global().set_media_enabled(v)`（Windows）。
- **修改** `settingsDescriptors.ts` 加 `tauri("wpeMediaIntegration", …)`，`settings.ts` 类型加字段，Web 版 `readonly(…, false)`。
- **修改** `Settings.vue` 壁纸分区加一行开关（`v-if="IS_WINDOWS"`），文案说明「网页壁纸可读取正在播放的歌曲名、封面与进度」。
- **新增** i18n `settings.wpeMediaIntegration` / `settings.wpeMediaIntegrationDesc`（5 种语言）。
- Phase 6 落地暂停条件后，暂停期间 `WpeMediaHub` 停推（采集可保留），本 Phase 不做。

## 点 10 — 文档与回归

- **修改** `third-patches/tauri/README.md` 的 18 条目：补「公开 `ipc::CallerFrame`（应用命令按调用方 frame 保存东西，在
  `SubframeDestroyed` 释放）」，re-check 锚点加 `CallerFrameAddress`、`FrameAddress::of_caller`。`cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md`
  在 `CallerOrigin` 旁补 `CallerFrame` 与「按 frame 保存的东西在 `SubframeDestroyed` 释放」；`AGENTS.md`「IPC 权限与事件」补一句命令可经
  `CallerFrame`（补丁 18）认出调用方 frame。
- **修改** `cocs/wpe/WPE_IMPORT.md`：新增「音频与媒体集成（Phase 8）」小节：Channel 订阅、按 frame 释放、两类数据、频谱算法与调参常数、
  媒体字段映射、设置项；`cocs/README.md` 的 WPE 条目补主题与适用场景（频谱不动 / 一直满格 / 没有歌名封面 / 切走壁纸后仍在采集）。
- **修改** `API.md` 兼容矩阵两行改为「已完成（8，待真机）」；第九节补「封面颜色格式未确认（暂用 `rgb()`）」。
- **修改** `PLAN.md`：落地后 Phase 8 状态改为已实现；总纲 `../PLAN.md` 阶段表更新第二阶段状态。
- **修改** `versions/latest/regression.md` 新增小节（用例见「验证」），`changelog.md` 加用户侧一行与 Internal 一行（补丁 18 增补 `CallerFrame`）。

## 验证

**A. 静态（Claude 执行）**
1. `deno task patch tauri --check` 通过；新 18 相对旧 18 只多出 `ipc/mod.rs` 的 `CallerFrame`、`app.rs` 的文档与
   `ipc/protocol.rs` 的单测，19 不变。`caller_frame_is_the_reported_frame` 与 18 已有的 `caller_origin_is_the_request_origin` 同法跑通。
2. `test-kabegame`：`kabegame --lib wpe_media`（频谱、配色、订阅表：同 frame 同类替换、`release_frame` 只删该 frame、
   `release_label`、发送失败删订阅、增删后 reconcile 的启停）。
3. `check-kabegame` 0 error（`CARGO_TARGET_DIR=target-check`）。
4. 改动文件 Prettier / rustfmt。

**B. Windows CEF dev（改了垫片与 tauri 补丁，须完全重启 dev）**

订阅数看点 2 的 `debug!` 日志。
1. 导入 `3747222633`（只读用户目录，写 dev 库）并设为桌面壁纸；浏览器或播放器放音乐：频谱随音乐动，左右声道分开，低频在前；
   停止播放后约 1 秒内回落、空闲波浪出现；`Audio` 帧约 30 次每秒（debug ingest 计数）。
2. 同一张：歌名 / 歌手 / 封面 / 播放暂停 / 进度条显示正确，切歌更新；暂停后状态变化，进度停住。
3. 设置关「媒体集成」：页面收到 `{ enabled: false }`，之后不再有媒体数据；再打开恢复并补快照。
4. 切到图片壁纸：旧 frame 的订阅随 `SubframeDestroyed` 释放，采集线程退出（日志）；切回音频壁纸重新订阅。
   看门狗重载后订阅恢复、每类只剩一条。
5. 预览同一张（桌面也在显示它）：两处都动，进程里只有一个采集线程；关掉预览后订阅只剩桌面那条。
6. 网页壁纸之间直接切换 10 次（含从 12097 切走）：每次新 iframe 都订阅成功，旧 frame 的订阅都被释放，每类始终只有一条。
7. 页面里 `location.reload()`：订阅不重复，控制台没有 `Couldn't find callback` 刷屏。
8. 开着预览刷新主窗口：预览的订阅被清，新文档重新订阅。
9. 封面大于 8 KB：预览与桌面的 iframe 都经 `plugin:__TAURI_CHANNEL__|fetch` 收到 `Thumbnail`，顺序没有错乱。
10. `12099`（`supportsaudioprocessing: false`）：音频订阅被拒，不起采集线程；媒体订阅照常。
11. 应用页主 frame 调 `wpe_web_media_subscribe` 报 `only web wallpaper frames can subscribe`；畅游页调被 ACL 拒绝。
12. 播放中切换系统默认输出设备：几秒内恢复频谱。
13. 没有任何媒体会话时：`Playback { state: 0 }`，页面不报错；不提供时间轴的播放器不推 `Timeline`。
14. Corsair-O-Tron、阿洛娜：可视化跟随音乐；超大封面（网易云 / Spotify）不卡页面。
15. 频谱观感调参：以样本的视觉效果为准记录最终常数（若用户可在 WPE 里对照，同一首歌对比幅度与衰减）。

## 风险

- **频谱与 WPE 观感不一致**：算法自定，幅度过大会让可视化一直满格、过小看不出起伏。常数集中在 `SpectrumTuning`，真机调；
  需要精确对齐时可另行用 REA 静态分析 `wallpaper64.exe` 的频谱代码（见决策 3）。
- **封面颜色格式**：官方未写，暂用 `rgb()`。页面若用字符串拼接（例如 `+ '80'` 加透明度）会出错，真机遇到再改。
- **WASAPI 回环会采到 Kabegame 自己的声音**（视频壁纸、页面里的音频）：与 WPE 一致，不处理。
- **同一 frame 换文档但新文档不再订阅**：frame 不变时没有销毁事件，旧订阅会继续往新文档推，Tauri 找不到回调 id 会在
  控制台告警。只在页面自己导航到别的页面、且新页面不登记同类监听时发生，网页壁纸很少这样做；B7 核对。
- **工作区还是旧 18**：`tauri::ipc::CallerFrame` 不存在，应用编译失败，不会静默出错。拉取后 `.husky/post-merge` 会重跑补丁。
- **媒体会话隐私**：网页壁纸来自创意工坊，拿到歌名与封面后可以自行联网发送；由设置项控制，默认值见决策 2。

## 关键决策

1. **传输**（待确认）：Channel（推荐）vs Tauri 事件。Channel 只回到订阅的 frame、不进事件系统，有日志流的先例，受限页面的大消息也能收；
   事件则要给 `wpe-web-capability` 加 listen 作用域，同窗口里任何监听者都能收到，而订阅命令照样要写。
2. **「媒体集成」默认值**（待确认）：打开（推荐，与 WPE 默认一致，壁纸开箱即显示歌名封面）vs 关闭（隐私优先，用户手动开）。
3. **频谱算法**（待确认）：自定算法 + 用「音域回响」等样本真机调参（推荐）vs 先用 REA 静态分析 `wallpaper64.exe` 的频谱实现再照搬
   （更接近 WPE 观感，但多一轮逆向）。
4. ~~**预览是否也收数据**~~ 已定（2026-10-31）：两边都收。B 段之后预览与桌面走同一条路，不用写桥。
5. **FFT 依赖**（待确认）：新增 `realfft`（推荐）vs 手写 radix-2 FFT（无新依赖，约 60 行，要自己测正确性）。
6. ~~**调用方 frame 从哪来**~~ 已定（2026-10-31）：并入 tauri 补丁 18，公开 `CallerFrame`（frame 级 IPC 与
   `CallerFrameAddress` 都是 18 引入的）。未选：另起补丁 20；宿主页销毁 iframe 时代为释放（有先后竞争、管不到页面自刷新）。
