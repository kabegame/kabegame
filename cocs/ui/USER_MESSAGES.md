# 后端给用户的提示（`user-message`）

后端有话要直接告诉用户、又不是某个命令的返回值时（后台出了错、事后才知道的失败），走这一条统一通道：后端广播一个
`user-message` 事件，主窗口用看板娘（`kameMessage`）显示。不要为单个功能另开一个事件、再在前端各写一份监听和提示。

第一个用户是场景快捷方式（P11d）的启动失败，见 [../wpe/scene/AUDIO_MEDIA.md](../wpe/scene/AUDIO_MEDIA.md)「快捷方式（P11d）」的「失败的反馈」。

## 形状

`AppEvent::UserMessage`（`kabegame-core/src/ipc/events.rs`），序列化后：

```json
{ "type": "user-message", "level": "error", "key": "gallery.wpeShortcutLaunchFailed", "params": { "reason": "文件夹不存在：/tmp/x" } }
```

- `level`：`info` / `success` / `warning` / `error`（`UserMessageLevel`），对应看板娘消息的四种类型；
- `key`：前端 i18n 的完整键（`<命名空间>.<键>`），文案在 `packages/kabegame-i18n` 里，五种语言都要有；
- `params`：文案里的命名参数，一个对象；不是对象时前端按没有参数处理。

文案由前端按当前语言翻译，后端不拼成句。参数里的原因（如「文件夹不存在：…」）目前是后端写死的中文，和命令返回的错误串同一份。

## 后端

```rust
use kabegame_core::emitter::{GlobalEmitter, UserMessageLevel};

GlobalEmitter::global().emit_user_message(
    UserMessageLevel::Error,
    "gallery.wpeShortcutLaunchFailed",
    serde_json::json!({ "reason": reason }),
);
```

- 经 `EventBroadcaster` 广播，在「订阅全部」（`AppEventKind::default_kinds()`）里：桌面 / Android 的事件循环
  （`startup.rs` 的 `start_event_loop`）`emit` 给各 webview，Web 版与桌面 Web 服务器经 SSE 推，app IPC 订阅全部的客户端也收得到；
- 没开 `ipc-server` 的构建（CLI 本进程）里是空操作；
- 发提示的同时照常写日志（`warn!` 等），日志是给排查用的，提示是给用户看的，两者不互相代替；
- 命令出错时调用方本来就能拿到错误：只有调用方不一定是用户看得见的地方（壁纸窗口、后台线程）、或者错误是事后才知道的，
  才需要发提示。发了提示的，前端调用方出错时只记日志，免得同一件事提示两遍。

## 前端

`apps/kabegame/src/services/userMessages.ts`：`App.vue` 启动时 `init()`（经 `@/api/rpc` 的 `listen`，Tauri 与 Web 同一套），卸载时
`dispose()`。收到后 `i18n.global.t(key, params)` 翻译，交给 `kameMessage[level]`。

- 只有主窗口初始化它：壁纸窗口没有看板娘，在那里发生的事也在主窗口提示一次，不管从哪个窗口、哪条入口触发；
- `kameMessage` 在看板娘关着（设置 `kamechanEnabled`）或被挡住（全屏预览等）时自己降级成 `toast`，调用方不用管；
- 级别不认识时按 `info`。

## 加一种提示

1. 在 `packages/kabegame-i18n/src/locales/*/` 五种语言里加文案键；
2. 后端在知道这件事的地方调 `emit_user_message`；
3. 前端什么都不用改。

## 测试

- 后端：`ipc::events` 的 `user_message_serializes_for_the_frontend`（事件名、在「订阅全部」里、序列化形状）；
- 前端：`services/userMessages.test.ts`（翻译与参数、不认识的级别按 `info`、参数不是对象、`init` / `dispose` 的监听）。
