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
| `src/desktop/linux.rs` | Linux 数据源：会话总线连接、匹配规则、消息处理、封面取回、停止与重连 |
| `src/desktop/linux/mpris.rs` | MPRIS 的纯逻辑：元数据解析、播放器表与当前会话、和上次推出的比较、封面地址分类 |
| `src/desktop/linux/fixture.rs` + `examples/mpris_fixture.rs` | 假的 MPRIS 播放器（feature `mpris-fixture`），真总线测试与 dev 走查用 |
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
| Linux | MPRIS（D-Bus） | 有（2026-11-22） |
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

## Linux

会话总线上同时挂着多个 `org.mpris.MediaPlayer2.*`，系统不指定「当前会话」。实现照 macOS 的分法：`linux.rs` 管总线，
`linux/mpris.rs` 是纯逻辑。

- **总线**：依赖树里已有的 zbus 5（`tauri-plugin-opener` 在 Linux 上带进来的同一份），一条线程用 `zbus::block_on` 跑异步循环。
  先登记三条匹配规则（`NameOwnerChanged` 限 `org.mpris.MediaPlayer2` 命名空间、Player 接口的 `PropertiesChanged`、`Seeked`）
  再 `ListNames` 列举，之后把总线消息、封面取回结果合成一个流逐条处理，每条处理完选当前会话、和上次推出的比较。调用超时 2 s。
  丢弃 `Watch` 发停止信号、等线程退出；总线连不上或断开时推「没有会话」，按 macOS 的退避重连。
- **当前会话**：有在播的取最近进入 Playing 的；都没在播取最近播过的（暂停的留在原地，同 Windows 上暂停的会话仍是当前会话）；
  都没播过先暂停的、再后发现的。没有标题的不算（同 macOS）；`playerctld`（转发别的播放器的代理）与本进程的播放器不算。
- **会话身份是进程**（有 pid 用 pid，没有用唯一总线名）：VLC 3 开两条连接，`vlc` 与 `vlc.instance<pid>` 各挂一个内容相同的
  播放器，状态变化时两边先后到，按总线名认会在两者之间来回换会话（实测暂停 / 继续各推两次 `Session`）；按进程认只推
  `Playback`。和 macOS 的「来源应用 + 进程号」一致。位置读数也按会话身份记，换到同一进程的镜像不重读。
- **字段**：`app_id` 取根接口的 `DesktopEntry`（`vlc`、`spotify`、`google-chrome`），没有就取总线名去掉前缀与 `.instance…`；
  `xesam:artist` / `xesam:albumArtist` 是数组，用「, 」连；`xesam:genre` 照给；副标题空串；MPRIS 没有媒体类型，`kind` 恒为
  `Unknown`。`mpris:length` 见过 `x` / `t` / `i`，artist 见过 `as` 也见过单个 `s`，值外面可能再包一层变体，都认。
  播放状态 Playing / Paused 照映射，Stopped 是 `Other`。
- **时间轴**：`Position` 没有变化信号，只在换会话、播放状态变、换曲（曲目 id / 标题 / 时长变）、速率变时重读，`Seeked` 直接用
  信号里的位置；读数时刻是读到的那一刻，读不到给 0（消费方不外推）。不定时轮询，同 SMTC / MediaRemote「播放器报了才有」。
- **封面**（`mpris:artUrl`）：`file://`（Chrome、Firefox、VLC 把封面写到本地）当场读，`data:…;base64,` 当场解，`http(s)://`
  （Spotify 的 CDN）另起短线程用 reqwest 的阻塞客户端取（总超时 2 s；回环地址直连，其余照环境变量走代理；和应用同一份
  reqwest 0.11 / native-tls）。上限 16 MB，只给当前会话取、按地址留一份。当前会话的封面在取时读数整体延后到取回或失败，
  让标题和封面一起到。
- **实测**（2026-11-22，Ubuntu 26.04 / Plasma 6.6.4，VLC 3.0.23）：`cvlc --aout=dummy --control dbus` 静音放一首带内嵌封面的 mp3，
  会话、`file://` 封面（VLC 解到 `~/.cache/vlc/art/`）、暂停 / 继续只推 `Playback`、`SetPosition` 后的 `Seeked` 都对；镜像各自触发一次
  位置重读，偶尔连着两条相同位置的 `Timeline`（相隔几微秒，消费方 100 ms 攒批会合并）。

## 测试

```bash
cargo test -p tauri-plugin-sysmedia                      # 纯逻辑与解出
cargo test -p tauri-plugin-sysmedia -- --ignored         # 真机：起 perl 读本机的 Now Playing（有在播时打印读数）
```

Linux（真总线测试要 `mpris-fixture`；本机别的播放器在播时会抢走当前会话，先停掉）：

```bash
cargo test -p tauri-plugin-sysmedia --features mpris-fixture                                   # 纯逻辑
cargo test -p tauri-plugin-sysmedia --features mpris-fixture -- --ignored follows artwork      # 真总线：假播放器
KABEGAME_SYSMEDIA_SECS=20 cargo test -p tauri-plugin-sysmedia --features mpris-fixture \
  prints_this_machines_session -- --ignored --nocapture                                       # 打印本机会话的读数
cargo run -p tauri-plugin-sysmedia --features mpris-fixture --example mpris_fixture           # 假播放器，标准输入给命令
```

在仓库根直接跑 cargo 会落到 `target/`；不想和别的构建抢缓存时给一个单独的 `CARGO_TARGET_DIR`。

跟上游：按 `macos/mediaremote-adapter/UPSTREAM.md` 的清单整目录重拷、更新提交号，再跑上面两条，并在 dev 里用网页壁纸 /
场景的媒体回调走查一遍。
