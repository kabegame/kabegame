# tauri-plugin-sysmedia：系统「正在播放」的跨端插件

> 状态：总纲已确认（2026-11-21）。S1 完成：单测、编译检查与 dev 走查（回归 MM1–MM8，网易云）都通过；S2 未开始。
> 待定三项按倾向定了：Android 只放骨架、Linux MPRIS 以后、解到应用缓存目录。

## 总体设计思路

新建 `src-tauri/tauri-plugin-sysmedia`，结构照 `tauri plugin new` 生成的官方模板：`lib.rs` 里按 `cfg(desktop)` /
`cfg(mobile)` 选 `desktop.rs` 或 `mobile.rs` 的 `Sysmedia<R>`，`setup` 时 `app.manage`，对外是 `SysmediaExt`
（`app.sysmedia()`）；`models.rs` / `error.rs` / `commands.rs` / `build.rs` / `permissions/` / `android/` 都按模板放。
`desktop.rs` 内部再按系统分到 `desktop/windows.rs`（SMTC）、`desktop/macos.rs`（MediaRemote），Linux 暂为不支持；
`mobile.rs` 走 `register_android_plugin`，Kotlin 一侧本期只有骨架、回报不支持。项目不支持 iOS，不建 iOS 工程。

插件只做一件事：**读系统当前的媒体会话，推出平台无关的原始读数**，不知道 WPE。读数只有四种：
会话切换（附带一份完整快照）、属性（来源应用、标题、歌手、专辑、流派、类型、封面原始字节）、
播放状态、时间轴（位置 / 时长 / 读数时刻 / 速率）。对外 API 是 `watch(选项, 回调) -> Watch`（丢弃即停）
加 `available()`。「丢掉旧会话迟到的事件」属于读得对不对，放在插件里，读到就推；攒批是消费方的口味，
插件不做，`wpe_media` 收读数时照 winrtutil 攒 100 ms，批里有会话切换就只认切换后的那份快照。

WPE 相关的一半留在 `wpe_media`：两个投影（网页 / 场景）、配色、网页投影每秒外推时间轴的定时器、订阅与门控。
`wpe_media/media.rs` 从「读 SMTC」变成「接插件读数 → 喂 `Projections` → 广播」；`kind_available(Media)` 改问插件。
投影的输入单位保持现在的 FILETIME（100 ns、1601 起），在接入处换算，已对照过 WPE 的投影代码一行不动。

macOS 数据源用 mediaremote-adapter（`/usr/bin/perl` 加载我们的动态库，它有 MediaRemote 的权限），**嵌入**的做法：
上游源码原样放进插件（`macos/mediaremote-adapter/`，记上游提交 `6571499` 与 BSD-3 许可证），`build.rs` 在 macOS
目标上直接调 clang 编成动态库放进 `OUT_DIR`，Rust 用 `include_bytes!` 连同上游的 perl 脚本一起编进程序；
第一次 `watch` 时按内容哈希解到应用缓存目录（照 `.framework` 的目录形状，上游脚本不用改），起
`/usr/bin/perl … stream --micros` 子进程，把一行行 JSON 增量合并成当前状态，再翻成上面四种读数。
打包配置（resources、`macOS.files`、签名）一行不改。子进程意外退出时退避重启，`Watch` 丢弃时杀掉。

## 关键决策

1. **插件不认识 WPE**：投影、配色、外推留在 `wpe_media`；插件读数用平台无关的单位（微秒、Unix 纪元）。
   理由：插件是「系统媒体」这个能力本身，换个消费方（比如以后应用自己的界面显示正在播放）不用动它。
2. **Windows SMTC 一并迁入插件**（`desktop/windows.rs`）：读取与代数丢弃搬进插件；攒批（`collect_batch` /
   `plan_batch` 与它们的单测）留在 `wpe_media`，改成对读数做，规则不变，对外行为不变。
3. **嵌入而不是子模块或打包资源**：源码随仓库、产物随二进制，没有额外的构建步骤与打包改动；
   跟上游时整目录替换。不带上游的测试客户端：适配器失效（Apple 将来封掉）时表现为「一直没有会话」，不另做自检。
4. **macOS 字段映射**：来源应用取 `parentApplicationBundleIdentifier`，没有再取 `bundleIdentifier`（网页播放器的
   `bundleIdentifier` 是 WebKit 的 GPU 进程）；专辑艺人、副标题给空；封面按文件头识别（实测 mime 乱跳、
   实际是 TIFF）；类型按 `mediaType` 映射，没有时为 0。
5. **本期不开 JS 命令**：消费方都在 Rust；模板里的 `commands.rs` / `permissions/` 留骨架，`guest-js` 不建。
6. **攒批只在顶层、一律 100 ms**：插件不攒批、不加平台特例，`wpe_media` 照 winrtutil 统一用 100 ms。
   macOS 自然切歌时新时长与「播放中」比新标题早约 300 ms，这段「旧标题 + 新时长」的混合态接受，不另做处理。

## 待定

- **Android 本期做不做**：读别的应用的媒体会话要用户在系统设置里授予「通知使用权」，交互成本高。倾向本期只放骨架。
- **Linux MPRIS**（D-Bus）本期做不做：技术上直接，但没有 Linux 窗口壁纸，只影响预览。倾向以后。
- **解出位置**：应用缓存目录（会被清理，下次再解）还是数据目录。倾向缓存目录。

## 分期

| 期 | 内容 | 验证 |
| --- | --- | --- |
| S1 | 插件骨架（官方模板结构、android 骨架）、读数模型、macOS 数据源（嵌入、解出、子进程、增量合并、映射）；`wpe_media` 在 macOS 上改接插件，`kind_available(Media)` 放行 macOS | 本机：插件单测（增量合并、映射、单位换算）；dev 里用 Amazon 走查暂停 / 切歌 / 封面 / 播放器退出 / 从 Kabegame 拉起，网页壁纸与场景的媒体回调 |
| S2 | Windows SMTC 迁入插件，`wpe_media/media.rs` 两个平台都只做「读数 → 投影」 | 本机编不了 Windows：需要在 Windows 上编译、跑单测，并按 P11c 的媒体走查回归 |
| 以后 | Linux MPRIS、Android 通知使用权 | — |

先做 macOS 再迁 Windows：S1 能在本机完整验证，S2 的改动只是搬家，单独一期便于在 Windows 上对照回归。
读数模型在 S1 就按 Windows 现有的读取语义（三类事件、会话切换全量重读、旧会话丢弃）设计，S2 不用改接口。
