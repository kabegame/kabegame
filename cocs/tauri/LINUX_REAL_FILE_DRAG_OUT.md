# CEF 拖出真实本地文件（Linux / macOS）

本文说明桌面 Linux 与 macOS 的 CEF standard 后端如何把图库图片拖到外部程序，并让目标端
收到真实的本地文件，而不是需要自行下载的 `http://127.0.0.1` URL。

## 适用范围与生效条件

这条链路为 Linux 与 macOS 的 CEF standard 模式启用。运行时使用的 CEF 必须由包含
`third-patches/cef/0003-drag-source-filenames.patch` 的源码重新构建；只更新 Rust、前端或
cef-rs bindings，不会让已经编好的旧 CEF 获得新的 Chromium/CEF 回调。

这两个平台上前端**只**写自定义 mime 里的 image id，不再写 `DownloadURL` / `text/uri-list` /
`text/plain`。链路一旦生效，Chromium 会把 URL、text 与 file_contents 一并清掉，这三项写了
也留不下；留着只会让人误以为拖出仍依赖 `/download` HTTP 端点。代价是链路不生效时
（旧 CEF、resolver 未安装、授权失败）没有 HTTP URL 兜底：目标端收到的是 Blink 为 `<img>`
自动填充的默认载荷，也就是网格里那张**缩略图**的 URL 与字节。

Windows 不走本链路，仍写 `DownloadURL` + `text/uri-list` + `text/plain` 三项 localhost
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
2. **Chromium/CEF 只提供受控钩子。** Linux 的 `WebContentsViewAura::StartDragging` 与 macOS
   的 `WebContentsViewMac::StartDragging` 在构造平台拖拽载荷之前调用 delegate。CEF 将其
   暴露为 `CefDragHandler::OnStartDragging`，并允许 client 读取自定义格式、添加经过授权的
   本地文件。
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
  → Linux: OSExchangeData 中的 file:// URI / filename
    macOS: 拖拽 pasteboard 上的 public.file-url
```

## 两个平台的载荷模型不同

Linux 是**推**：`PrepareDragData()` 把所有格式一次性写进 `OSExchangeDataProvider`，
`StartDragging` 只需在写入前把 filenames 换掉。

macOS 是**拉**：`WebContentsViewMac::StartDragging` 自己不建 pasteboard，而是把 `DropData`
经 mojo（`content/common/web_contents_ns_view_bridge.mojom` 的 `StartDrag`，可能跨到
app-shim 进程）转给 `WebDragSource`——一个 `NSPasteboardWriting` 对象，靠
`-writableTypesForPasteboard:` 声明「我能提供哪些 flavor」、靠
`-pasteboardPropertyListForType:` 在目标索取时才现算数据。

这带来两处 Linux 没有的工作：

- **`WebDragSource` 原本完全没有 filenames 通路。** 它既不读 `DropData::filenames`，也从不
  写 `NSPasteboardTypeFileURL`（接收端反而是读的，见 `web_drag_dest_mac.mm` 的
  `ui::clipboard_util::FilesFromPasteboard`）。所以 patch 必须给它补上声明与取数两段，
  这是新增能力而非解除限制。
- **`filenames` 过 mojo 不用改协议。** `DropData` 是 `[Native]` struct，走 legacy IPC
  ParamTraits，而 `common_param_traits_macros.h` 里早有 `IPC_STRUCT_TRAITS_MEMBER(filenames)`
  与 `ui::FileInfo` 的 traits。在 browser process 改完 `DropData` 即可漂到 NSView 侧。

**只提供第一个文件。** 一个 `WebDragSource` 就是一个 `NSPasteboardWriting` 对象，
`-startDragWithDropData:` 把它包进单个 `NSDraggingItem`；macOS 表达多文件必须是多个
`NSPasteboardItem`（对比 `clipboard_util_mac.mm` 的 `WriteFilesToPasteboard`），各自还要有
自己的 dragging item 与 frame。当前 resolver 本就是 `(label, image id) → 单个路径`，
因此取 `filenames.front()`；将来要多选拖出，需要一并改造 `-startDragWithDropData:`。

## 为什么注入文件后必须清理旧载荷

成功解析出真实文件后，Chromium patch 会复制一份 `DropData`，设置 `filenames`，并清除
`url_infos`、`text`、`file_contents`（macOS 还多清 `html` 与 `download_metadata` 两项）。

Linux 上清理是**被合成规则逼的**：

- **`url_infos`**：Wayland 的 `text/uri-list` 由 `GetURLs(CONVERT_FILENAMES)` 合成，已有 URL
  会排在从 filename 转换出的 `file://` URI 前面。多数目标只使用第一项，结果仍会走 HTTP。
- **`text`**：只清 `url_infos` 仍不够。当 URL format 不存在时，`GetURLs()` 会调用
  `GetPlainTextURL()`，把 `text/plain` 中的 localhost URL 再解析成 URL 并放到文件 URI 前面。
  X11 上保留 URL 还可能生成 `_NETSCAPE_URL`，使文件管理器把操作识别为下载而不是复制。
- **`file_contents`**：Blink 拖动 `<img>` 时会携带页面已加载的图片字节。图库网格通常加载的是
  缩略图；若目标优先消费 `application/octet-stream`，就会静默得到缩略图而不是库内原图。

macOS 没有 `text/uri-list` 这种合成，各 flavor 相互独立，但
`-writableTypesForPasteboard:` **返回数组的顺序就是优先级**——目标取它认识的第一个。
所以：

- **`public.file-url` 必须排在最前**，排在 `public.url` 与 file contents 之前，否则文件拖拽
  不成其为文件拖拽。
- **`url_infos` / `text`**：分别对应 `public.url` 与 `public.utf8-plain-text`。严格说 macOS
  留着它们不会顶掉排在更前的 file-url，但偏好这两者的目标仍会拿到 HTTP URL。一并清掉，
  两个平台就只有一套行为与一套排查心智模型。注意即使前端什么都不写，Blink 拖 `<img>`
  时也会自动把图片 URL 填进 `url_infos`。
- **`file_contents`**：在 macOS 上以具体 UTType（如 `public.png`）为名直接携带字节，
  与 Linux 同理，是缩略图而非库内原图。
- **`html`**：**Linux 不需要清而 macOS 必须清。** Blink 拖 `<img>` 时会把该元素的 HTML
  片段（`<img src="http://127.0.0.1:…">`）填进 `DropData::html`，`WebDragSource` 据此声明
  `public.html`。邮件正文、备忘录、TextEdit 这类富文本目标偏好 HTML 甚于 file-url，会把这段
  markup 嵌进正文——图片指回本地 HTTP server，server 一关就成死图。Linux 上 `text/html`
  排在 `text/uri-list` 之后，且目标多为文件管理器，不构成问题。
- **`download_metadata`**：**Linux 不需要清而 macOS 必须清。** Linux 上没有消费者
  （`PrepareDragForDownload` 是 `#if BUILDFLAG(IS_WIN)`），但 `WebDragSource` 会据它声明
  `com.apple.pasteboard.promised-file-url` 与 `com.apple.pasteboard.promised-file-content-type`；
  目标一旦索取该 flavor，Chromium 就会把落点目录取出、真的下载一份文件过去，
  而不是交出磁盘上已有的那个。

清理只发生在 delegate 返回至少一个已授权 filename 时。授权失败时原载荷保持不变——那就是
Blink 自动填充的缩略图 URL 与字节，因为前端已不再写任何 HTTP URL。

## macOS 还必须摘掉 renderer 污染标记

这是两个平台差异最大、也最容易漏掉的一处：**Chromium 标记「这份拖动数据出自网页渲染器」的
污染位，在 Linux 上过不了进程边界，在 macOS 上却直接写在 pasteboard 上。**

- Linux：`OSExchangeDataProviderNonBacked::MarkRendererTaintedFromOrigin()` 只是给 provider
  设了个成员 `tainted_by_renderer_origin_`，不进 X11 / Wayland 的拖动数据，出了本进程就没了。
- macOS：`OSExchangeDataProviderMac` 与 `WebDragSource` 都把它写成一个真实 flavor
  `org.chromium.renderer-initiated-drag`（`ui::kUTTypeChromiumRendererInitiatedDrag`），
  任何接收方都看得见。

接收端 `PopulateDropDataFromPasteboard()` 读到这个 flavor 就置
`DropData::did_originate_from_renderer`，随后 `RenderWidgetHostImpl::FilterDropData()`
无条件执行 `filenames.clear()`。也就是说只要标记还在，**注入的文件会在每一个 Chromium 系
接收方那里被丢掉**：Chrome、Edge、所有 Electron 应用（VSCode、Slack……），以及本应用自己的
webview；而原生 AppKit 应用不认识这个 flavor，照常收到文件。

症状因此很有迷惑性——鼠标显示绿色加号（`draggingEntered:` 时 pasteboard 上确实有
`public.file-url`），终端与文本编辑能拿到路径，Chrome 地址栏也能拿到 file URL（走 views 的
`ExtractFileURL`，不经过 renderer，`FilterDropData()` 没有机会执行），唯独拖进任何 Chromium
页面区毫无反应。

因此 delegate 已背书本地文件时不再声明该 flavor：

```objc
if (_dropData.filenames.empty()) {
  [writableTypes addObject:ui::kUTTypeChromiumRendererInitiatedDrag];
}
```

这不是放宽安全边界，而是**把 macOS 拉回 aura 路径本来就有的行为**：这些路径不是渲染器给的，
是 browser process 过了两道门之后注入的，且渲染器自己写入的载荷都已在同一处清空。
`org.chromium.chromium-initiated-drag` 保留不动——它只表示「来自 Chromium」，不触发过滤。

**代价要记住**：摘掉标记后，把这份拖动再拖回本应用 webview 时，页面会像收到一次普通的系统
文件拖入那样看到该文件（Linux 一直如此）。

## 四层实现与维护文件

| 层 | 职责 | 维护位置 |
| --- | --- | --- |
| Chromium patch | 在 Linux / macOS `StartDragging` 的平台载荷生成前调用 delegate；注入成功时改写 `DropData` 并清理 URL、text、缩略图字节与（macOS）download promise；macOS 另需让 `WebDragSource` 声明并提供 `public.file-url`、并摘掉 renderer 污染标记 | `third-patches/cef/0003-drag-source-filenames.patch` 内的 `patch/patches/kabegame_drag_source_filenames.patch` 与 `patch/patch.cfg`；目标文件为 `content/public/browser/web_contents_view_delegate.{h,cc}`、`content/browser/web_contents/web_contents_view_aura.cc`、`content/browser/web_contents/web_contents_view_mac.mm`、`content/app_shim_remote_cocoa/web_drag_source_mac.mm` |
| CEF API | 将 delegate 接到 `CefDragHandler::OnStartDragging`，并用 `CefDragData::GetCustomData` 暴露页面自定义格式 | 同一个 `third-patches/cef/0003-drag-source-filenames.patch`；涉及 `include/cef_drag_{handler,data}.h`、`libcef/common/drag_data_impl.{h,cc}`、`libcef/browser/chrome/chrome_web_contents_view_delegate_cef.{h,cc}` |
| cef-rs bindings | 保持 C ABI struct 布局和安全 wrapper 与 CEF 一致 | `third-patches/cef-rs/0006-drag-source-bindings-linux.patch`、`0007-drag-source-bindings-windows.patch`、`0008-drag-source-bindings-macos.patch` |
| Rust + 前端 | 前端声明 id；runtime 读取 id 并调用 resolver；app 校验 label、DB 与文件后返回路径 | `apps/kabegame/src/components/image/ImageContent.vue`、`apps/kabegame/src/utils/dragExport.ts`、`src-tauri/tauri-runtime-cef/src/{webview,runtime,lib}.rs`、`src-tauri/kabegame/src/{drag_export,lib}.rs` |

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
`src-tauri/kabegame/src/lib.rs` 仅在 `not(feature = "web") + any(target_os = "linux",
target_os = "macos") + feature = "standard"` 时调用 `set_drag_file_resolver()`。未安装
resolver 等价于关闭功能。

CEF API 声明和 cef-rs struct 字段不能按平台条件删减。Linux、Windows 与 macOS bindings 若看到
不同的 `_cef_drag_handler_t` / `_cef_drag_data_t` 布局，字段 offset 和 size 就会与实际 libcef
不一致。为此，`0006`、`0007`、`0008` 同步维护三个桌面平台的 ABI——这也是 macOS 接入时
**不需要动 bindings 层**的原因：布局早就是一致的，缺的只是 Chromium 侧的调用点。
Windows 仍不编译 delegate 调用，其 `DownloadURL` 行为不受影响。

## 排查入口

拖出没有得到真实文件时，按以下顺序检查：

1. **CEF 是否真的重编过。** 确认运行时 CEF 包含 `third-patches/cef/0003`；旧 CEF 只会交付
   Blink 为 `<img>` 自动填充的缩略图载荷，看起来像“新代码没生效”。
2. **resolver 是否安装。** 当前进程必须是 Linux 或 macOS 的 CEF standard 构建，并走到
   `set_drag_file_resolver()`。web、Android、Windows 或非 standard 模式不会安装。
3. **webview label 是否为 `main`。** handler 是 per-webview 的，label 在创建时固定；畅游的
   navbar 与内容页是其它实例，不会通过白名单。
4. **id 是否进入 custom data。** 检查 `ImageContent.vue` 的 `dragstart` 是否写入
   `application/x-kabegame-image-id`，以及 `OnStartDragging` 能否读到非空值。
5. **DB 与文件是否有效。** 用该 id 查询 `images` 表，确认记录存在、`local_path` 正确且文件仍在
   磁盘上。不存在的 id、已移动或删除的源文件都会安全跳过，不会注入 filename。
6. **载荷是否仍被缩略图污染。** 若 resolver 成功但目标仍拿到 URL 或缩略图字节：Linux 上
   检查最终 `text/uri-list` 的逐行内容及所有 offered mime，第一项应是 `file://`，不应出现
   任何 `http://127.0.0.1` 项；macOS 上检查 drag pasteboard 的 flavor 列表，
   `public.file-url` 应排在首位，且不应出现 `public.url`、`public.html`、
   `com.apple.pasteboard.promised-file-url` 或以图片 UTType 命名的 file contents flavor。
7. **macOS 专有：只有原生应用收得到文件。** 若终端、文本编辑、访达能收到，而 Chrome 页面区、
   VSCode、Slack 等一概无反应（鼠标仍显示绿色加号），说明 pasteboard 上还留着
   `org.chromium.renderer-initiated-drag`，接收端的 `FilterDropData()` 把 filenames 清了。
   见上文“macOS 还必须摘掉 renderer 污染标记”。

端到端回归矩阵见 `versions/latest/regression.md` 的“Linux / macOS 拖出真实本地文件”。
