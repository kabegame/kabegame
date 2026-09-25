# Linux CEF 拖出真实本地文件

本文说明桌面 Linux 的 CEF standard 后端如何把图库图片拖到外部程序，并让目标端收到
真实的本地文件，而不是需要自行下载的 `http://127.0.0.1` URL。

## 适用范围与生效条件

这条链路只为 Linux 的 CEF standard 模式启用。运行时使用的 CEF 必须由包含
`third-patches/cef/0003-drag-source-filenames.patch` 的源码重新构建；只更新 Rust、前端或
cef-rs bindings，不会让已经编好的旧 CEF 获得新的 Chromium/CEF 回调。

Linux 上前端**只**写自定义 mime 里的 image id，不再写 `DownloadURL` / `text/uri-list` /
`text/plain`。链路一旦生效，Chromium 会把 URL、text 与 file_contents 一并清掉，这三项写了
也留不下；留着只会让人误以为 Linux 拖出仍依赖 `/download` HTTP 端点。代价是链路不生效时
（旧 CEF、resolver 未安装、授权失败）没有 HTTP URL 兜底：目标端收到的是 Blink 为 `<img>`
自动填充的默认载荷，也就是网格里那张**缩略图**的 URL 与字节。

Windows / macOS 不走本链路，仍写 `DownloadURL` + `text/uri-list` + `text/plain` 三项 localhost
HTTP URL，`/download` 端点因此必须保留——Windows 的 `PrepareDragForDownload` 是它唯一的
真实消费者（该函数在 Chromium 里就是 `#if BUILDFLAG(IS_WIN)`）。

## 为什么前端不能直接给路径

渲染进程发起拖拽后，Chromium browser process 会经过
`RenderWidgetHostImpl::FilterDropData`。只要 `did_originate_from_renderer` 为真，它就会
无条件清空 `DropData::filenames`。因此，即使页面能构造类似文件的数据，也无法把本地路径
穿过这道边界。

这是防止被控制的网页把宿主任意路径伪装成拖出文件的安全边界，不是 Chromium 的缺陷，
也不应通过放宽过滤来绕过。路径必须由 browser process 一侧的受信任宿主补入。

## 三段式权责

1. **前端只提议图片身份。** `ImageContent.vue` 在 `dragstart` 中写入自定义格式
   `application/x-kabegame-image-id`，值为 image id；它不提供路径，也不能决定导出哪个文件。
2. **Chromium/CEF 只提供受控钩子。** Linux 的 `WebContentsViewAura::StartDragging` 在构造
   平台拖拽载荷之前调用 delegate。CEF 将其暴露为 `CefDragHandler::OnStartDragging`，并允许
   client 读取自定义格式、添加经过授权的本地文件。
3. **Rust app 才做授权。** per-webview 的 `TauriCefDragHandler` 把固定 label 与 image id
   交给 resolver；kabegame app 只接受 `main`，再按 id 查询 `images` 表并确认磁盘文件存在。
   任一检查失败都不注入文件。

数据流如下：

```text
ImageContent.vue: image id
  → Chromium/CEF drag-source delegate
  → TauriCefDragHandler: (webview label, image id)
  → kabegame resolver: label 白名单 + images DB + 文件存在性
  → CefDragData::AddFile(已授权的真实路径)
  → Linux 平台拖拽载荷中的 file:// URI / filename
```

## 为什么注入文件后必须清理旧载荷

成功解析出真实文件后，Chromium patch 会复制一份 `DropData`，设置 `filenames`，并清除
`url_infos`、`text` 与 `file_contents`。这三项都不能保留：

- **`url_infos`**：Wayland 的 `text/uri-list` 由 `GetURLs(CONVERT_FILENAMES)` 合成，已有 URL
  会排在从 filename 转换出的 `file://` URI 前面。多数目标只使用第一项，结果仍会走 HTTP。
- **`text`**：只清 `url_infos` 仍不够。当 URL format 不存在时，`GetURLs()` 会调用
  `GetPlainTextURL()`，把 `text/plain` 中的 localhost URL 再解析成 URL 并放到文件 URI 前面。
  X11 上保留 URL 还可能生成 `_NETSCAPE_URL`，使文件管理器把操作识别为下载而不是复制。
- **`file_contents`**：Blink 拖动 `<img>` 时会携带页面已加载的图片字节。图库网格通常加载的是
  缩略图；若目标优先消费 `application/octet-stream`，就会静默得到缩略图而不是库内原图。

清理只发生在 delegate 返回至少一个已授权 filename 时。授权失败时原载荷保持不变——在 Linux
上那就是 Blink 自动填充的缩略图 URL 与字节，因为前端已不再写任何 HTTP URL。

## 四层实现与维护文件

| 层 | 职责 | 维护位置 |
| --- | --- | --- |
| Chromium patch | 在 Linux `StartDragging` 的平台载荷生成前调用 delegate；注入成功时改写 `DropData` 并清理 URL、text 与缩略图字节 | `third-patches/cef/0003-drag-source-filenames.patch` 内的 `patch/patches/kabegame_drag_source_filenames.patch` 与 `patch/patch.cfg`；目标文件为 `content/public/browser/web_contents_view_delegate.{h,cc}`、`content/browser/web_contents/web_contents_view_aura.cc` |
| CEF API | 将 delegate 接到 `CefDragHandler::OnStartDragging`，并用 `CefDragData::GetCustomData` 暴露页面自定义格式 | 同一个 `third-patches/cef/0003-drag-source-filenames.patch`；涉及 `include/cef_drag_{handler,data}.h`、`libcef/common/drag_data_impl.{h,cc}`、`libcef/browser/chrome/chrome_web_contents_view_delegate_cef.{h,cc}` |
| cef-rs bindings | 保持 C ABI struct 布局和安全 wrapper 与 CEF 一致 | `third-patches/cef-rs/0006-drag-source-bindings-linux.patch`、`0007-drag-source-bindings-windows.patch`、`0008-drag-source-bindings-macos.patch` |
| Rust + 前端 | 前端声明 id；runtime 读取 id 并调用 resolver；app 校验 label、DB 与文件后返回路径 | `packages/kabegame-core/src/components/image/ImageContent.vue`、`packages/kabegame-core/src/utils/dragExport.ts`、`src-tauri/tauri-runtime-cef/src/{webview,runtime,lib}.rs`、`src-tauri/kabegame/src/{drag_export,lib}.rs` |

`third-patches/cef/0003` 中的 Chromium 内层 patch 与 CEF API 是同一功能的两半，必须同进
同退。只更新其中一半，要么没有调用点，要么没有 client API。

## 两道安全门

路径授权有两道独立的门：

1. **image id → DB 记录。** `authorize_drag_image()` 使用
   `Storage::find_image_by_id()` 查图库记录，再检查 `local_path` 对应文件确实存在。前端不能用
   自定义格式请求任意路径。
2. **webview label 白名单。** resolver 当前只接受 `main`。畅游内容页、爬虫窗口或以后新增的
   webview 即使伪造相同 custom mime，也拿不到本地文件。

这里使用白名单而非黑名单：新增 webview 默认没有导出能力；确实需要时必须显式评审并加入。

## 平台门控与 ABI

功能是否启用只在 app 安装 resolver 时决定一次：
`src-tauri/kabegame/src/lib.rs` 仅在 `not(feature = "web") + target_os = "linux" +
feature = "standard"` 时调用 `set_drag_file_resolver()`。未安装 resolver 等价于关闭功能。

CEF API 声明和 cef-rs struct 字段不能按平台条件删减。Linux、Windows 与 macOS bindings 若看到
不同的 `_cef_drag_handler_t` / `_cef_drag_data_t` 布局，字段 offset 和 size 就会与实际 libcef
不一致。为此，`0006`、`0007`、`0008` 同步维护三个桌面平台的 ABI；Chromium 的实际 delegate
调用仍只在 Linux 编译。这样平台策略集中在 app 安装点，底层 ABI 不分叉，Windows 的
`DownloadURL` 行为也不会被改变。

## 排查入口

拖出没有得到真实文件时，按以下顺序检查：

1. **CEF 是否真的重编过。** 确认运行时 CEF 包含 `third-patches/cef/0003`；旧 CEF 只会交付
   Blink 为 `<img>` 自动填充的缩略图载荷，看起来像“新代码没生效”。
2. **resolver 是否安装。** 当前进程必须是 Linux CEF standard 构建，并走到
   `set_drag_file_resolver()`。web、Android、Windows、macOS 或非 standard 模式不会安装。
3. **webview label 是否为 `main`。** handler 是 per-webview 的，label 在创建时固定；畅游的
   navbar 与内容页是其它实例，不会通过白名单。
4. **id 是否进入 custom data。** 检查 `ImageContent.vue` 的 `dragstart` 是否写入
   `application/x-kabegame-image-id`，以及 `OnStartDragging` 能否读到非空值。
5. **DB 与文件是否有效。** 用该 id 查询 `images` 表，确认记录存在、`local_path` 正确且文件仍在
   磁盘上。不存在的 id、已移动或删除的源文件都会安全跳过，不会注入 filename。
6. **载荷是否仍被缩略图污染。** 若 resolver 成功但目标仍拿到 URL 或缩略图字节，检查最终
   `text/uri-list` 的逐行内容及所有 offered mime；第一项应是 `file://`，不应出现任何
   `http://127.0.0.1` 项，也不应再提供缩略图 `file_contents`。

端到端回归矩阵见 `versions/latest/regression.md` 的“Linux 拖出真实本地文件”。
