# tauri-plugin-sysmedia

读系统「正在播放」的媒体会话，推出平台无关的读数。不认识任何消费方：现在唯一的消费方是应用的 `wpe_media`
（WPE 网页壁纸与场景的媒体集成），攒批、换单位、换成 WPE 的消息格式都在那边做。

## 结构

照 `tauri plugin new` 的官方模板（跨端写法）：

| 文件 | 作用 |
| --- | --- |
| `src/lib.rs` | `init()`、`SysmediaExt`（`app.sysmedia()`）、两端共用的 `Watch` 句柄 |
| `src/models.rs` | 读数模型：`MediaEvent`（会话切换 / 属性 / 播放状态 / 时间轴）及其字段 |
| `src/desktop.rs` | 桌面端 `Sysmedia<R>`，按系统分到 `desktop/<os>.rs` |
| `src/desktop/macos.rs` | macOS 数据源：解出适配器、管 `perl` 子进程、退避重启 |
| `src/desktop/macos/stream.rs` | 适配器输出 → 读数（纯逻辑，单测用实测行） |
| `src/mobile.rs` + `android/` | 移动端：注册 Kotlin 插件 `SysmediaPlugin`，现在只回答「不可用」 |
| `macos/mediaremote-adapter/` | 嵌入的上游源码（见其中 `UPSTREAM.md`） |
| `permissions/` | 不开 JS 命令，默认权限为空 |

## API

```rust
use tauri_plugin_sysmedia::{MediaEvent, SysmediaExt};

let available = app.sysmedia().available();
let watch = app.sysmedia().watch(|event: MediaEvent| { /* 在插件线程里调，尽快返回 */ });
drop(watch); // 停止
```

- `watch` 先推一次 `MediaEvent::Session(…)`（没有会话就是 `None`），之后读到就推，不攒批。
- 换会话（换了来源应用或进程，含从无到有、从有到无）推 `Session(Some(快照))`；同一会话里只推变了的类，顺序
  属性 → 播放状态 → 时间轴。属性 / 时间轴为 `None` 表示读取失败。
- 时间轴单位微秒，`position_micros` 是 `updated_unix_micros`（Unix 纪元微秒）那一刻的位置，播放中要自己外推。

## 平台

| 平台 | 数据源 | 状态 |
| --- | --- | --- |
| macOS | MediaRemote，经 mediaremote-adapter | 有（2026-11-21） |
| Windows | SMTC | 仍在应用的 `wpe_media/media.rs`，待迁入（`.claude/plans/sysmedia/README.md` S2） |
| Linux | MPRIS（D-Bus） | 没有 |
| Android | `MediaSessionManager`（要用户授予「通知使用权」） | 没有，Kotlin 骨架回答不可用 |

项目不支持 iOS，不建 iOS 工程。

## macOS

macOS 15.4 起 MediaRemote 只给系统程序数据。照 [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) 的做法借
`/usr/bin/perl`：perl 加载我们的动态库、调导出函数，动态库在 perl 进程里读 MediaRemote、把变化逐行打印成 JSON。

- **嵌入**：上游源码原样放在 `macos/mediaremote-adapter/`，`build.rs` 在 macOS 目标上直接调 clang 编成动态库（参数照上游
  CMake；只编目标架构；最低系统版本跟 `MACOSX_DEPLOYMENT_TARGET`，没设取 11.0，同应用；arm64 由链接器 ad-hoc 签名），
  `include_bytes!` 连同上游 perl 脚本编进程序。打包配置不用改。
- **解出**：第一次 `watch` 时解到 `<应用缓存目录>/sysmedia/<内容哈希>/`（`mediaremote-adapter.pl` 与
  `MediaRemoteAdapter.framework/MediaRemoteAdapter`，照 `.framework` 的形状，上游脚本不用改），已在且大小相同不重写，
  别的哈希目录顺手删掉。桌面的 dev 与已安装版 identifier 都是 `Kabegame`、共用这个缓存目录，版本不同时会互删对方的目录：
  删掉不影响已经起来的子进程，而每次起子进程前都会重新解出，所以能自己补回来。
- **进程**：`/usr/bin/perl <脚本> <框架> stream --micros`，一条线程逐行读 stdout，stderr 记 `warn!`。意外退出时退避重启
  （1 s 起翻倍、封顶 30 s，连续跑满一分钟回到 1 s）；新进程的第一行是完整状态，和推过的比较，只推变了的。丢弃 `Watch`
  即杀掉子进程。Kabegame 崩溃时子进程要等下一次写 stdout 收到 SIGPIPE 才退出。
- **失效**：Apple 将来封掉这条路时，适配器表现为一直没有会话；不另做自检（不带上游的测试客户端）。

字段映射（`stream.rs`）与实测（2026-11-21，macOS 26.6.2，Amazon 的 Pake 网页应用与网易云）：

- 来源应用取 `parentApplicationBundleIdentifier`，没有再取 `bundleIdentifier`：网页播放器的 `bundleIdentifier` 是
  `com.apple.WebKit.GPU`。会话身份是「来源应用 + 进程号」。
- 标题、歌手、专辑、流派（一项）照搬；副标题、专辑艺人拿不到，空串。`mediaType` 按关键词归成音乐 / 视频 / 图片，没有时未知
  （Amazon 网页应用与网易云都不给）。没有标题的媒体适配器当作没有，和没有会话一样。
- 封面是 base64，变了才解码。Amazon 网页应用声明的 `artworkMimeType` 每次更新都在 `image/tiff` / `image/jpeg` 之间来回跳，
  实际字节是 512×512 的未压缩 TIFF（约 1 MB）；网易云（原生应用，`com.netease.163music`）给的是真的 JPEG（约 10 KB）。
  所以不看 mime，消费方按文件头识别。
- 播放状态只有 `playing` 一个布尔：真为播放、假为暂停。
- 延迟：发出暂停约 42 ms、恢复约 60 ms 后收到；自然切歌时新时长与「播放中」比新标题早约 300 ms 到。
- 常驻开销：perl 进程 CPU 0%，内存约 27 MB；没有授权弹框。

## 测试

```bash
cargo test -p tauri-plugin-sysmedia                      # 纯逻辑与解出
cargo test -p tauri-plugin-sysmedia -- --ignored         # 真机：起 perl 读本机的 Now Playing（有在播时打印读数）
```

跟上游：按 `macos/mediaremote-adapter/UPSTREAM.md` 的清单整目录重拷、更新提交号，再跑上面两条，并在 dev 里用网页壁纸 /
场景的媒体回调走查一遍。
