# Phase 6d：Windows 拖出改走 03 真实文件链路

> 状态：方案已写（2026-10-30）。前置：Phase 6c 已实现（桌面图库媒体走 `file://`，本地 HTTP 已退役）。
>
> 起因：6c 之后 Windows 拖出写的是 `file://` 的 `DownloadURL`。真机两轮 `DEBUG-dragout` 插桩证实
> Chromium 的 `DragDownloadFile` 下载**能跑完**（第二轮 `complete=true`，文件落在
> `%TEMP%\chrome_drag…\<名>.jpg`），但资源管理器松手后仍然没有文件；第一轮还暴露了运行时
> `TauriCefDownloadHandler` 会把拖拽下载的强制临时路径改成相对的建议名、让下载以 `interrupted` 收尾。
> 用户决定不再修 `DownloadURL` 这条延迟渲染下载链路，改把 03 的真实文件拖出扩到 Windows。

## 总体设计思路

Windows 不再用「`DownloadURL` → OLE 延迟渲染 → `DragDownloadFile` 下载到临时目录 → 目标端取文件」
这条绕远路，改成和 Linux 一样的**推模型**：渲染进程只在自定义 mime 里提议 image id，浏览器进程在
`WebContentsViewAura::StartDragging` 构造平台载荷之前问 delegate 要真实文件，`OSExchangeDataProviderWin::SetFilenames`
直接把库内原图的路径写成 `CF_HDROP`。资源管理器收到的就是一份普通的文件拖放，松手即复制，不再有下载、
临时目录与「谁来决定目标路径」的问题。

Windows 与 Linux 共用同一个 `web_contents_view_aura.cc`，03 的 Linux 钩子本来就写在这个文件里、只是被
`#if BUILDFLAG(IS_LINUX)` 关着，所以 Chromium 侧的主体改动只是把门控放宽；CEF API（`OnStartDragging` /
`GetCustomData`）、cef-rs 三平台 bindings（06 / 07 / 08 早已同步布局）与运行时的 `on_start_dragging`
都已经是平台无关的，缺的只是运行时与应用里两个 `cfg` 没带 `windows`。

Windows 有三处与 Linux 不同、必须跟 macOS 对齐的地方，全部在 Chromium 内层补丁里处理：

1. **`download_metadata` 必须清。** `PrepareDragData` 在 Windows 上会先按它调 `PrepareDragForDownload`，
   往 IDataObject 里塞一份**延迟渲染的 `CF_HDROP`**；我们注入的真实文件也是 `CF_HDROP`，两份同格式并存
   谁先谁赢说不清。前端不再写 `DownloadURL` 后它本来就为空，这里是纵深防御。
2. **`html` 要清。** Blink 拖 `<img>` 时会把 `<img src="file:///…thumbnails/…">` 填进 `DropData::html`，
   Windows 上变成 `CF_HTML`；Word / Outlook / OneNote 这类富文本目标偏好 `CF_HTML` 甚于 `CF_HDROP`，会把
   指向缩略图的 markup 嵌进正文而不是附上原图。与 macOS 同理。
3. **渲染器污染标记要摘。** Windows 的 `MarkRendererTaintedFromOrigin` 和 macOS 一样是写在 IDataObject 上的
   真实格式（`chromium/x-renderer-taint`），跨进程可见；接收端若是 Chromium 系（Chrome / Edge / VSCode /
   Electron / 本应用自己的 webview），`FilterDropData()` 读到它就清空 filenames，文件对它们不可见而资源管理器
   照常收到——和 macOS 没摘标记时一模一样的迷惑症状。处理方式也一样：delegate 背书了本地文件时不打标记；
   这些路径不是渲染器给的，渲染器写的载荷已在同一处清空。Linux 的标记是进程内成员、不出进程，保持原样。

关键决策：
- **不保留 `DownloadURL` 兜底。** 与 Linux / macOS 一致：链路不生效（旧 CEF、resolver 未装、授权失败）时
  目标端拿到的是 Blink 为 `<img>` 自动填充的默认载荷——Windows 上 `file_contents` 会以
  `CFSTR_FILEDESCRIPTOR` / `CFSTR_FILECONTENTS` 虚拟文件交付缩略图字节，资源管理器也接受这种格式，
  所以「原图缺失、已回退到缩略图」的行在 Windows 仍有一份可落地的东西（待真机确认）。
- **前端把 `effectAllowed` 定成 `copy`。** `CF_HDROP` 在资源管理器里同卷默认是**移动**；Blink 默认
  `effectAllowed=uninitialized` 会把 copy / move / link 全部允许，不限制就会把库内文件挪走。三个平台
  一起设，Linux 文件管理器同样有同文件系统默认移动的习惯。
- **resolver 加 `is_file()`。** `authorize_drag_image` 现在只查 `metadata()` 存在；`x-wpe/*` 行的
  `local_path` 是目录，伪造 id 可以把整个壁纸目录拖出去（前端 WPE 行 `draggable=false` 只是第一道闸）。
  按 AGENTS 的「`local_path` 当文件用必须分流」要求收紧为普通文件，三个平台共享。
- **Web 版保留 `DownloadURL`。** 真实浏览器里 `DownloadURL` 是有效的拖出下载手段，而且 Web 的 URL 是 HTTP；
  Android 没有拖出。前端按 `IS_WEB` 分叉，桌面三平台统一走 id。

数据流（Windows）：

```text
ImageContent.vue: dataTransfer.setData("application/x-kabegame-image-id", id); effectAllowed = "copy"
  → RenderWidgetHostImpl::FilterDropData（filenames 恒空；custom_data 原样通过）
  → WebContentsViewAura::StartDragging → delegate_->GetDragFilenames(drop_data)        ← 内层补丁放宽到 IS_WIN
  → ChromeWebContentsViewDelegateCef::GetDragFilenames → CefDragHandler::OnStartDragging
  → TauriCefDragHandler::on_start_dragging（cfg 加 windows）→ resolver("main", id)
  → kabegame authorize_drag_image：label 白名单 + images 表 + is_file()
  → CefDragData::AddFile(真实路径) → DropData.filenames
  → PrepareDragData(…, mark_renderer_tainted=false)：清 url_infos / text / file_contents / html / download_metadata
  → OSExchangeDataProviderWin::SetFilenames → CF_HDROP → DoDragDrop(DROPEFFECT_COPY) → 资源管理器复制
```

## 现状锚点

**a. Chromium 内层补丁的 aura 钩子只开 Linux**（`third/cef/patch/patches/kabegame_drag_source_filenames.patch`，对应构建树
`D:\Codes\cefbuild\chromium_git\chromium\src\content\browser\web_contents\web_contents_view_aura.cc:1241-1274`，当前内容）
```cpp
  std::unique_ptr<ui::OSExchangeDataProvider> provider =
      ui::OSExchangeDataProviderFactory::CreateProvider();
#if BUILDFLAG(IS_LINUX)                     // 现状：Windows 也编译这个文件，但被门控排除
  std::vector<ui::FileInfo> delegate_filenames;
  if (delegate_ && drop_data.filenames.empty()) {
    delegate_filenames = delegate_->GetDragFilenames(drop_data);
  }
  if (!delegate_filenames.empty()) {
    DropData file_drop_data = drop_data;
    file_drop_data.filenames = std::move(delegate_filenames);
    file_drop_data.url_infos.clear();
    file_drop_data.text.reset();
    file_drop_data.file_contents.clear();   // 现状：不清 html / download_metadata（Linux 不需要）
    PrepareDragData(source_rfh, file_drop_data, provider.get());
  } else {
    PrepareDragData(source_rfh, drop_data, provider.get());
  }
#else
  PrepareDragData(source_rfh, drop_data, provider.get());
#endif
```

**b. `PrepareDragData` 无条件打污染标记，Windows 上还先消费 `download_metadata`**（同文件 `:260-270`，上游代码）
```cpp
void PrepareDragData(RenderFrameHost& source_rfh,
                     const DropData& drop_data,
                     ui::OSExchangeDataProvider* provider) {
  provider->MarkRendererTaintedFromOrigin(source_rfh.GetLastCommittedOrigin());  // 现状：Windows 上是真实格式 chromium/x-renderer-taint
#if BUILDFLAG(IS_WIN)
  if (drop_data.download_metadata.has_value()) {
    PrepareDragForDownload(source_rfh, drop_data, provider);   // 现状：塞一份延迟渲染的 CF_HDROP
  }
#endif
  // … file_contents / text / url_infos / html / filenames(→ CF_HDROP) / custom_data
}
```

**c. Windows provider 的污染标记与文件名**（`ui/base/dragdrop/os_exchange_data_provider_win.cc:296-306, 441-449`，上游代码）
```cpp
void OSExchangeDataProviderWin::MarkRendererTaintedFromOrigin(const url::Origin& origin) {
  STGMEDIUM storage = CreateStorageForString(origin.opaque() ? std::string() : origin.Serialize());
  data_->contents_.push_back(/* GetRendererTaintFormatType() = CustomPlatformType("chromium/x-renderer-taint") */);
}
void OSExchangeDataProviderWin::SetFilenames(const std::vector<FileInfo>& filenames) {
  STGMEDIUM storage = clipboard_util::CreateStorageForFileNames(filenames);   // 现状：CF_HDROP，真实路径
  …
}
```

**d. 接口注释写死了平台**（内层补丁里的 `content/public/browser/web_contents_view_delegate.h` 与
`third/cef/include/cef_drag_handler.h:103-112`）
```cpp
  // Called on the UI thread from the view's StartDragging(), before the data
  // is handed to the platform drag loop. Called on Linux and macOS only.   // 现状
  virtual std::vector<ui::FileInfo> GetDragFilenames(const DropData& drop_data);
```
```cpp
  /// page content. Currently called on Linux and macOS for windowed browsers.   // 现状
  /*--cef(added=experimental)--*/
  virtual void OnStartDragging(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDragData> dragData) {}
```

**e. 运行时起手侧只编 Linux / macOS**（`src-tauri/tauri-runtime-kbcef/src/webview.rs:1151-1194`）
```rust
            fn on_start_dragging(&self, _browser: Option<&mut Browser>, drag_data: Option<&mut DragData>) {
                #[cfg(any(target_os = "linux", target_os = "macos"))]   // 现状：Windows 空实现
                {
                    let Some(drag_data) = drag_data else { return };
                    let custom_data = drag_data.custom_data(Some(&CefString::from(DRAG_IMAGE_ID_MIME)));
                    // …resolver(&self.label, &id) → drag_data.add_file(path, basename)
                }
            }
```

**f. 应用只在 Linux / macOS 安装 resolver；授权只查「存在」**（`src-tauri/kabegame/src/lib.rs:279-294`，`drag_export.rs:7-12`）
```rust
    // 只在 Linux / macOS 的 CEF standard 模式安装 resolver:不安装即关闭真实文件
    // 注入,Windows 的 DownloadURL 虚拟文件路径因此完全不受影响。   // 现状注释
    #[cfg(all(any(target_os = "linux", target_os = "macos"), feature = "standard"))]
    tauri_runtime_kbcef::set_drag_file_resolver(|label, image_id| {
        if label != "main" { return None; }
        crate::drag_export::authorize_drag_image(image_id)
    });
```
```rust
pub(crate) fn authorize_drag_image(image_id: &str) -> Option<std::path::PathBuf> {
    let info = kabegame_core::storage::Storage::find_image_by_id(image_id).ok()??;
    let path = std::path::PathBuf::from(&info.local_path);
    std::fs::metadata(&path).ok()?;      // 现状：目录（x-wpe/* 行）也通过
    Some(path)
}
```

**g. 前端 Windows 分支写 `DownloadURL`**（`apps/kabegame/src/components/image/ImageContent.vue:214-267`）
```ts
const dragFileName = (sourceUrl: string): string => { /* … */ };          // 现状：只为 DownloadURL 服务
const onDragStart = (slot: MediaSlot, event: DragEvent) => {
  // …beginInternalDrag(); const dt = event.dataTransfer;
  if (IS_LINUX || IS_MACOS) {                                              // 现状：Windows 不走 id
    if (props.image.id) dt.setData(DRAG_IMAGE_ID_MIME, props.image.id);
    return;
  }
  const url = currentSrc || slot.source?.url || "";                        // 现状：Windows / Android / Web 共用
  dt.setData("DownloadURL", `${displayImageMimeType(props.image.type)}:${name}:${url}`);
  dt.setData("text/uri-list", url);
  dt.setData("text/plain", url);
};                                                                         // 现状：没有设 effectAllowed
```

**h. 文档与回归把 Windows 写成「仍走 DownloadURL、待真机验证」**：`AGENTS.md:53`（「Windows 拖出传 `file://` 的
`DownloadURL`（真机待验证）」）、`cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`（标题 Linux / macOS；多处「Windows 不走本链路」）、
`cocs/README.md:142`、`third-patches/cef/README.md:19`（「on Linux and macOS」）、`src-tauri/tauri-runtime-kbcef/README.md:42`、
`cocs/wpe/WPE_IMPORT.md`（6b 节「Windows 拖出使用 `file://`」）、`versions/latest/regression.md` 6b / 6c 两处「7 Windows 拖出」行、
`versions/latest/changelog.md:12`（「拖出待真机验证」）。

## 点 1 — Chromium 内层补丁放宽到 Windows（`kabegame_drag_source_filenames.patch` 内 `web_contents_view_aura.cc` 两处）

- **修改** `PrepareDragData` 增加参数 `bool mark_renderer_tainted`（默认 `true`，其它调用点不动）。
- **修改** aura `StartDragging` 的门控 `IS_LINUX` → `IS_LINUX || IS_WIN`；delegate 分支里新增清 `download_metadata`
  （两平台）、清 `html`（仅 Windows）、Windows 不打污染标记。
```cpp
// Utility to fill a ui::OSExchangeDataProvider object from DropData.
// `mark_renderer_tainted` is false only when the WebContentsViewDelegate
// vouched for local files in StartDragging() below (see the comment there).
void PrepareDragData(RenderFrameHost& source_rfh,
                     const DropData& drop_data,
                     ui::OSExchangeDataProvider* provider,
                     bool mark_renderer_tainted = true) {                 // 修改：新增参数
  if (mark_renderer_tainted) {                                            // 修改
    provider->MarkRendererTaintedFromOrigin(source_rfh.GetLastCommittedOrigin());
  }
  // …其余不动
}
```
```cpp
#if BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_WIN)                              // 修改
  // （原 Linux 注释保留）
  //
  // On Windows two more payloads compete with the injected CF_HDROP and
  // must go: `download_metadata` makes PrepareDragForDownload() add a
  // second, delay-rendered CF_HDROP (the DownloadURL path this delegate
  // path replaces), and `html` becomes CF_HTML, which rich-text targets
  // (Word, Outlook, OneNote) prefer over CF_HDROP and would embed as an
  // <img> pointing at the thumbnail. The renderer taint is also skipped on
  // Windows: unlike the Linux provider, OSExchangeDataProviderWin writes it
  // as a real clipboard format (chromium/x-renderer-taint) that crosses to
  // other processes, and a receiving Chromium (Chrome, Edge, Electron apps,
  // this browser itself) reads it back as did_originate_from_renderer and
  // clears every filename in RenderWidgetHostImpl::FilterDropData() -- the
  // same leak the macOS half avoids by not declaring
  // org.chromium.renderer-initiated-drag. The paths are not renderer data:
  // the delegate produced them, and every renderer-authored payload was
  // cleared alongside them.
  std::vector<ui::FileInfo> delegate_filenames;
  if (delegate_ && drop_data.filenames.empty()) {
    delegate_filenames = delegate_->GetDragFilenames(drop_data);
  }
  if (!delegate_filenames.empty()) {
    DropData file_drop_data = drop_data;
    file_drop_data.filenames = std::move(delegate_filenames);
    file_drop_data.url_infos.clear();
    file_drop_data.text.reset();
    file_drop_data.file_contents.clear();
    file_drop_data.download_metadata.reset();                             // 新增（Linux 无消费者，无行为变化）
#if BUILDFLAG(IS_WIN)
    file_drop_data.html.reset();                                          // 新增
    constexpr bool kMarkRendererTainted = false;                          // 新增
#else
    constexpr bool kMarkRendererTainted = true;
#endif
    PrepareDragData(source_rfh, file_drop_data, provider.get(), kMarkRendererTainted);   // 修改
  } else {
    PrepareDragData(source_rfh, drop_data, provider.get());
  }
#else
  PrepareDragData(source_rfh, drop_data, provider.get());
#endif
```
- **修改** 内层补丁里 `web_contents_view_delegate.h` 的注释：`Called on Linux and macOS only.` → `Called on Linux, macOS and Windows.`
  > 说明：`IS_CHROMEOS` 仍不开，和现状一致。

## 点 2 — CEF 侧注释（`third/cef/include/cef_drag_handler.h`）

- **修改** `OnStartDragging` 文档：`Currently called on Linux and macOS for windowed browsers.` →
  `Currently called on Linux, macOS and Windows for windowed browsers.`。
  > 说明：注释行数不变，不影响 04–06 的上下文；`GetCustomData`、`ChromeWebContentsViewDelegateCef::GetDragFilenames`、
  > cef-rs 06 / 07 / 08 bindings 全部不动（Windows 的 `_cef_drag_handler_t` / `_cef_drag_data_t` 布局早已含这两个槽）。

## 点 3 — 补丁文件再生成（`third-patches/cef/03-drag-source-filenames.patch`）

内层 Chromium 补丁是 03 的一个**文件内容**，不能手改 hunk 计数。流程（Claude 执行 git 相关步骤；构建树里的 Chromium
文件改动直接留在那里供用户重编，`build-chromium.ts` 以 `--no-chromium-update` 跑，不会再碰这些文件）：

1. 在构建树 `D:\Codes\cefbuild\chromium_git\chromium\src` 按点 1 改 `content/browser/web_contents/web_contents_view_aura.cc` 与
   `content/public/browser/web_contents_view_delegate.h`（这两个文件当前就是「上游 + 03 内层补丁」的状态，`git status` 为 `M`）。
2. `cd …\src\cef && python tools/patch_updater.py --resave --patch kabegame_drag_source_filenames`
   → 重写构建树 `cef/patch/patches/kabegame_drag_source_filenames.patch`（不用 `python -I`，脚本要从自身目录导 `exec_util`）。
3. 把它拷回 `third/cef/patch/patches/kabegame_drag_source_filenames.patch`；按点 2 改 `third/cef/include/cef_drag_handler.h`。
4. 重生成 03：`deno task patch cef -r` → 手工 `git -C third/cef apply` 01、02（或 `deno task patch cef` 后
   `git -C third/cef checkout` 掉 04–06 涉及的文件——以 patch-manager 实际提供的能力为准）→
   `deno task patch cef --gen --from 02 --out third-patches/cef/03-drag-source-filenames.patch`。
5. `deno task patch cef --check` 全系列干跑通过，`deno task patch cef` 重新应用六个补丁，`git -C third/cef status` 与应用前一致。
6. 用户重编：MSYS2 `CEFBUILD=D:/Codes/cefbuild deno task build:chromium`（`stageCefPatchesAsCommit` 会把 `third/cef` 工作树固化进
   `kabegame-build`，automate-git 因 cef 哈希变化整树重拷 `src/cef`，Chromium 侧两个文件靠第 1 步已经改好的工作树编译）。

- **修改** `third-patches/cef/README.md:19` 的 03 条目：平台改成 Linux、macOS、Windows；补一句 Windows 半边（aura 共用钩子，
  另清 `html` / `download_metadata`、不打 `chromium/x-renderer-taint`，`CF_HDROP` 由 `OSExchangeDataProviderWin::SetFilenames` 产出）。

## 点 4 — 运行时（`src-tauri/tauri-runtime-kbcef/src/webview.rs`、`README.md`）

- **修改** `on_start_dragging` 的 `#[cfg(any(target_os = "linux", target_os = "macos"))]` → 去掉 cfg（三个桌面平台都是 CEF；本 crate
  本来只在桌面编译），`add_file` 前的注释补 Windows：落地文件名来自 `CF_HDROP` 的路径本身，同样忽略 `display_name`。
```rust
            fn on_start_dragging(&self, _browser: Option<&mut Browser>, drag_data: Option<&mut DragData>) {
                // 三个桌面平台共用：Linux / Windows 走 aura 推模型（OSExchangeData），macOS 走
                // WebDragSource 拉模型；哪个平台真会回调由 CEF 补丁 03 决定，未带补丁的 CEF 不会进来。
                let Some(drag_data) = drag_data else { return };            // 修改：不再包在 cfg 块里
                // …原逻辑不变
            }
```
- **修改** `README.md:42` 「文件拖放」行：「起手侧在 Linux 与 macOS 上」→「起手侧在三个桌面平台上」。

## 点 5 — 应用（`src-tauri/kabegame/src/lib.rs`、`drag_export.rs`）

- **修改** `lib.rs` 的 resolver 安装门控与注释：
```rust
    // 三个桌面平台的 CEF standard 模式都安装 resolver:不安装即关闭真实文件注入。平台启用
    // 门控集中在此处一次完成;CEF API 与三份 cef-rs bindings 保持相同 struct 布局。
    // label 白名单（原注释保留）
    #[cfg(feature = "standard")]                                             // 修改：去掉 any(linux, macos)
    tauri_runtime_kbcef::set_drag_file_resolver(|label, image_id| { /* 不变 */ });
```
  > 说明：`standard` feature 只在桌面存在（Android / web 不开），所以等价于「三个桌面平台」；若 `standard` 在 Android 也会开，
  > 则写成 `all(not(target_os = "android"), feature = "standard")`——执行时以 `Cargo.toml` 的 feature 定义为准。
- **修改** `drag_export.rs::authorize_drag_image`：`metadata(&path).ok()?` → `metadata(&path).ok()?.is_file().then_some(())?`，注释补
  「`x-wpe/*` 行的 `local_path` 是目录，不得拖出」。可选单测：目录路径返回 `None`（用临时目录）。

## 点 6 — 前端（`apps/kabegame/src/components/image/ImageContent.vue`）

- **修改** `onDragStart`：按 `IS_WEB` 分叉；桌面三平台只写 id 并把 `effectAllowed` 定成 `copy`；删除桌面的 `DownloadURL` 分支。
```ts
const onDragStart = (slot: MediaSlot, event: DragEvent) => {
  // …dragEnabled / beginInternalDrag / dt 判空不变
  if (IS_WEB) {
    // Web 版：真实浏览器里 DownloadURL 是有效的拖出下载手段，URL 是 HTTP（原分支原样保留）
    const target = event.target;
    const currentSrc = /* … */;
    const url = currentSrc || slot.source?.url || "";
    if (!url) return;
    const name = dragFileName(url).replace(/:/g, "_");
    dt.setData("DownloadURL", `${displayImageMimeType(props.image.type)}:${name}:${url}`);
    dt.setData("text/uri-list", url);
    dt.setData("text/plain", url);
    return;
  }
  // 桌面三平台（Windows / macOS / Linux）走真实文件拖出：只提议 image id，由 browser process 侧
  // 授权后注入本地路径（见 cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md）。
  // 只允许复制：CF_HDROP 在资源管理器同卷默认是移动，Blink 默认 effectAllowed=uninitialized 会把
  // move 也放开，库内文件会被挪走；Linux 文件管理器同文件系统也有同样的默认。
  dt.effectAllowed = "copy";                                                   // 新增
  if (props.image.id) dt.setData(DRAG_IMAGE_ID_MIME, props.image.id);          // 修改：Windows 也进来
};
```
- **修改** 头注释（`:222-236`）：三平台统一、Web 保留 `DownloadURL`、`effectAllowed` 的理由；`IS_LINUX` / `IS_MACOS` 导入若无其它
  使用改为 `IS_WEB`。`dragFileName` / `displayImageMimeType` 因 Web 分支仍在使用而保留。
- Android：`dragstart` 事实上不发生，分支里不单独处理（写 id 无副作用）。

## 点 7 — 文档、回归与 changelog

- `AGENTS.md:53`：「Windows 拖出传 `file://` 的 `DownloadURL`（真机待验证）」→「三个桌面平台的拖出都走 CEF 补丁 03 的真实文件链路
  （Windows 为 `CF_HDROP`），Web 版保留 `DownloadURL`」。
- `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`（文件名不改，链接多处引用）：标题改「CEF 拖出真实本地文件（Linux / macOS / Windows）」；
  「适用范围」删除 Windows 例外段，补 Windows 的 `CF_HDROP` 推模型；「载荷模型」补「Windows 与 Linux 同为 aura 推模型」；
  「为什么注入文件后必须清理旧载荷」补 Windows 的 `download_metadata`（第二份延迟渲染 `CF_HDROP`）与 `html`（`CF_HTML`）；
  「污染标记」一节改为「macOS 与 Windows 都必须摘掉」（Windows 为 `chromium/x-renderer-taint` 自定义剪贴板格式），并记一句
  Windows 没有 03 时的历史（`DownloadURL` 延迟渲染下载能完成但资源管理器拿不到文件，CEF Chrome 风格下
  `CefDownloadManagerDelegateImpl::DetermineDownloadTarget` 也不认强制路径）；「四层实现」表平台列加 Windows；
  「平台门控与 ABI」改三平台；「排查入口」第 2 条改三平台，第 6 条补 Windows（用最小 Win32 / .NET 接收器或 `ClipSpy` 类工具
  列 IDataObject 格式：应有 `CF_HDROP`，不应有 `chromium/x-renderer-taint`、`CF_HTML`、`FileGroupDescriptorW`）；`effectAllowed=copy`
  与 resolver `is_file()` 各记一句。
- `cocs/README.md:142`：条目主题补 Windows。
- `cocs/wpe/WPE_IMPORT.md` 6b 节、`.claude/plans/wpe-import/2-web/PLAN.md`（6b / 6c 表行与正文里「Windows 拖出 `DownloadURL`」）→
  指向 6d。`third-patches/cef/README.md`：点 3。`src-tauri/tauri-runtime-kbcef/README.md`：点 4。
- `versions/latest/regression.md`：6b / 6c 两处「7 Windows 拖出」行备注改「由 Phase 6d 取代（`DownloadURL` 路线放弃）」；新增小节
  「Phase 6d：Windows 拖出真实本地文件」，用例见下。
- `versions/latest/changelog.md`：用户可见一行（Windows 从图库拖图 / 视频到资源管理器等程序得到的是库内原文件，只复制不移动）+
  内部一行（03 扩到 Windows：aura 钩子放宽、清 `html` / `download_metadata`、不打 `x-renderer-taint`；运行时 / 应用 cfg；
  前端 `effectAllowed=copy`、Web 保留 `DownloadURL`；resolver `is_file()`）。

## 验证

**A. 静态（代理 / Claude）**
1. `deno task patch cef --check` 通过；`deno task patch cef` 后 `git -C third/cef status` 只含六个补丁的文件；
   `git -C third/cef diff` 中 `kabegame_drag_source_filenames.patch` 的 `web_contents_view_aura.cc` hunk 含 `IS_WIN`。
2. 构建树 `git -C D:/Codes/cefbuild/chromium_git/chromium/src diff --stat` 只多 `web_contents_view_aura.cc` /
   `web_contents_view_delegate.h` 两个文件的本次改动；用 `git apply --check -R` 以新内层补丁反向干跑确认两者一致。
3. `check-kabegame` 0 error（`CARGO_TARGET_DIR=D:/Codes/kabegame/target-check`）；`grep -rn "DownloadURL" apps/kabegame/src` 只剩
   `IS_WEB` 分支；`grep -rn "any(target_os = \"linux\", target_os = \"macos\")" src-tauri/kabegame/src/lib.rs src-tauri/tauri-runtime-kbcef/src/webview.rs`
   为空。
4. 单测：`kabegame drag_export`（若加了目录用例）。

**B. 真机（Windows，用户重编 CEF 并完全重启 dev；无法用 CDP 模拟系统拖放，全部人工）**

| 用例 | 操作 | 预期 |
| --- | --- | --- |
| 1 资源管理器复制 | 网格拖一张原图与缩略图肉眼可分的图到资源管理器目录 | 得到库内原文件（文件名 = `local_path` 的 basename），光标为「复制」；库内文件仍在原处 |
| 2 同卷不移动 | 拖到与图库同一盘符的目录 | 仍是复制，不是移动；按住 Shift 也不能移动 |
| 3 同名冲突 | 再拖一次到同目录 | 走资源管理器自己的「替换 / 跳过」对话框 |
| 4 视频 | 拖一个视频行 | 得到原视频文件（不是 mp4 缩略图），扩展名与原片一致 |
| 5 sha256 | 对库内原图、落地文件、缩略图分别算 sha256 | 落地 = 原图 ≠ 缩略图 |
| 6 Chromium 系接收方 | 拖到 Chrome / Edge 测试页的 `<input type="file">`，再拖到 VSCode 资源管理器面板 | 都收到本地文件（证明没有 `x-renderer-taint`）；不是 URL 文本 |
| 7 富文本目标 | 拖到 Word 或 Outlook 新邮件 | 作为文件 / 附件插入，不是指向 `file:///…thumbnails` 的内嵌 HTML 图片 |
| 8 拖回本应用 | 从网格拖到画廊 / 画册热区 | 全程静默（`beginInternalDrag` 认领），不触发导入浮层 |
| 9 原图缺失回退 | 拖一张 `local_path` 已不存在、显示缩略图的行 | 不注入文件；资源管理器若能接受 `CFSTR_FILECONTENTS` 则得到缩略图文件，否则无文件（记录实际结果） |
| 10 WPE 行 | 网格 / 预览里的 `x-wpe/*` 行 | `draggable=false`，不起拖；用调试会话伪造该 id 的自定义 mime 拖出 → 不注入（`is_file()` 拒目录） |
| 11 畅游伪造 id | 第三方内容页 `dragstart` 写 `application/x-kabegame-image-id` = 真实 id，拖到资源管理器 | 无文件（label 白名单） |
| 12 不存在的 id | `main` 调试会话把 mime 值换成不存在的 id | 无文件、不崩溃、拖拽不卡 |
| 13 拖入回归 | 从资源管理器拖图进画廊 / 画册 / `KbPath` | Enter / Over / Drop / Leave 与导入照常，不导航到文件 |
| 14 IDataObject 格式 | 用剪贴板 / 拖放格式查看器接收一次拖放 | 有 `CF_HDROP`；无 `chromium/x-renderer-taint`、`CF_HTML`、`FileGroupDescriptorW`、`UniformResourceLocatorW` |

Linux / macOS：复跑 v4.5.0「Linux / macOS 拖出真实本地文件」矩阵的「文件管理器复制」与「拖入回归」各一条即可（本次对它们只多了
`effectAllowed=copy`、`download_metadata.reset()`（无消费者）与 resolver `is_file()`）。

## 风险与备注

- **`effectAllowed=copy` 改变 Linux / macOS 既有行为**：目标端不再能「移动」。这是期望行为（图库文件不该被外部程序挪走）。
- **Windows 下 `custom_data`（image id）仍随拖放进 IDataObject**（`chromium/x-web-custom-data` pickle），与 Linux 一致，无敏感信息。
- **摘掉污染标记后的代价**与 macOS 相同：把这份拖动拖回本应用 webview 时，页面会像收到一次系统文件拖入；`useFileDrop`
  的内部拖拽认领（`beginInternalDrag` + enter 快照）已覆盖，用例 8 验证。
- **`PrepareDragData` 签名加默认参数**：`web_contents_view_aura.cc` 内其它调用点只有 `StartDragging` 一处；上游 re-vendor 时
  这是内层补丁里的新 hunk，上下文漂移按 `third-patches/cef/README.md` 流程处理。
- **ChromeOS 不开**，`IS_CHROMEOS` 与现状一致不进门控。
- 03 真机此前只在 Linux / macOS 验证过；Windows 第一次走 aura 推模型，用例 6 / 7 / 14 是新增风险点（污染标记、`CF_HTML`）。

## 实施记录

- 2026-10-30：主仓库部分（点 4–7，不含 `third/`、`third-patches/cef/*.patch` 与构建树）由 Claude 子代理实施；点 1–3 的 Chromium
  内层补丁、`third/cef` 与 03 再生成由另一人并行负责，本记录不覆盖。
  - **点 4**：`tauri-runtime-kbcef/src/webview.rs` 的 `on_start_dragging` 去掉 `#[cfg(any(linux, macos))]` 块、块内代码反缩进一级，
    逻辑不变；开头补「三平台共用：Linux / Windows aura 推模型、macOS 拉模型，回调与否由 03 决定」，`add_file` 前的注释改为三个平台
    （Windows 取 `CF_HDROP` 路径本身）。`README.md` 「文件拖放」行改三个桌面平台。
  - **点 5**：`kabegame/src/lib.rs` 的 resolver 门控改为 `all(not(target_os = "android"), feature = "standard")`：`standard` feature 本身
    不按 target 限制，而 `tauri-runtime-kbcef` 只在三个桌面 target 段声明、`mod drag_export` 门控是 `not(target_os = "android")`，
    显式排除 Android 与两者对齐（方案的 `#[cfg(feature = "standard")]` 在有人给 Android 开 `standard` 时会编译失败）。
    `drag_export.rs` 抽出纯函数 `authorized_file_path(path) -> Option<PathBuf>`（`metadata().is_file()`，跟随符号链接），
    `authorize_drag_image` 改为调用它；新增 3 个单测（目录被拒 / 普通文件放行 / 不存在被拒），用 `std::env::temp_dir()` 下按
    pid + 纳秒命名的临时目录，结束时删除。
  - **点 6**：`ImageContent.vue` 的 `onDragStart` 按 `IS_WEB` 分叉：Web 原样保留 `DownloadURL` 分支；桌面三平台设
    `dt.effectAllowed = "copy"` 后只写 image id。头注释重写；`env` 导入 `IS_LINUX` / `IS_MACOS` → `IS_WEB`（文件内无其它使用）。
    `dragFileName` / `displayImageMimeType` 因 Web 分支仍用而保留。文件里既有的 `#region debug-drag` 插桩是 HEAD 中已提交的，
    不属本次范围，未动。
  - **点 7**：`AGENTS.md`、`cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`（整篇按清单改写：标题、适用范围、Windows 放弃 `DownloadURL`
    的历史小节、两种载荷模型、Windows 清理理由、污染标记一节改三平台对照并附 Windows 的 `kMarkRendererTainted` 片段、四层表、
    两道安全门补 `is_file()`、平台门控、排查入口第 2 / 5 / 6 / 7 条与新增第 8 条 `effectAllowed`）、`cocs/README.md`、
    `cocs/wpe/WPE_IMPORT.md`（四处）、`third-patches/cef/README.md`（03 条目与 06 条目末句）、`versions/latest/regression.md`
    （6b / 6c 两处「7 Windows 拖出」备注加前缀，文末新增 Phase 6d 小节）、`versions/latest/changelog.md`（用户侧第 12 行去掉
    「Windows 拖出改用 `file://`（待真机验证）」并新增一行，Internal 新增一行）。
- 与方案的偏差 / 超出清单的同步：
  - resolver 门控见上（多了 `not(target_os = "android")`）。
  - 为避免文档自相矛盾，额外改了清单外几处同样写着「Windows 拖出走 `DownloadURL`」的地方：`tauri-runtime-kbcef/README.md` 「当前限制」
    里的拖出条目、`cocs/web/CDN_MEDIA.md` 第 9 行、`cocs/README.md` 中 WPE_IMPORT 与 third-patches/cef 两个条目、
    `third-patches/cef/README.md` 06 条目末句（「Windows `DownloadURL` still needs device verification」）。
  - `versions/latest/regression.md` 新小节表头沿用本文件所有小节的 `| 状态 | 项目 | … |`（`是否完成 | 标题` 是 v4.5.0 的写法）；
    除 16 条真机用例外，加了已在本环境完成的静态行 S1–S4（`[x]`）。
  - 未改 `.claude/plans/wpe-import/2-web/PLAN.md`（点 7 提到它的 6b / 6c 正文；不在本次分派范围，6d 表行已有人写好），
    `versions/latest/changelog.md` 第 62 行 6b 内部条目里的历史描述也保留原样。
- 验证：`CARGO_TARGET_DIR=target-check deno task check -c kabegame` 0 error（vue-tsc 无输出，cargo check 47.75s，改动文件无 warning；
    日志 `ignore/codex-tasks/phase-6d-agent-check.log`）；`deno task test -c kabegame --skip vue -- --lib drag_export` 3 passed / 0 failed
    （日志 `ignore/codex-tasks/phase-6d-agent-test.log`；不带 `--skip vue` 时前端 Vitest 先跑，HEAD 里既有的
    `KameToolboxBubble.test.ts` mock 失败会中止整条命令，与本次无关）；方案验证 A.3 的两条 grep 为空 / 只剩 `IS_WEB` 分支；
    `ImageContent.vue` Prettier 合规；`git ls-files --eol -m` 无 `w/crlf`。
- 前端 Vitest 补跑（2026-10-30，`apps/kabegame` 下 `npx vitest run`，日志 `ignore/codex-tasks/phase-6d-vitest.log`）：54 个测试文件
    50 个通过、4 个在加载阶段失败，505 个用例全部通过。4 个失败都与本次无关：
  - `KameToolboxBubble.test.ts`：`@kabegame/i18n` 的 mock 没导出 `i18n`，而 `utils/backfillName.ts`（提交 `4d28f682`）在模块顶层读
    `i18n.global.te`。
  - `facetTreeSource.test.ts`、`imageGrid/adapters/gallery.test.ts`、`imageGrid/adapters/imageEvents.test.ts`：报
    `TypeError … Received 'file:///__vue-jsx-ssr-register-helper'`。只 `import "@kabegame/element-plus"` 的最小探针测试也报同一个错，
    说明是 `@vitejs/plugin-vue-jsx` 的 SSR 辅助虚拟模块在本机 Vitest 下解析失败，任何经 import 图引入组件库的测试都会加载失败；
    这三个文件经未改动的 `services/albums.ts`、`utils/kameMessage.ts` 等就会引入组件库。
- 无法验证：Windows 真机拖放（CDP 起不了系统拖放，且需要先重编带新 03 的 CEF 并完全重启 dev）——回归新小节 1–14 全部 `[ ]`；
  Linux / macOS 复跑两条同样待真机；Web 版 `IS_WEB` 分支本轮没有起 Web dev 验证；`deno task check --mode web` 未跑
  （`drag_export` 模块在 web 构建里仍编译、resolver 不安装，预计多一条与此前同类的 dead_code warning）。
