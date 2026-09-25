下面把所有方案摊开。先说清楚评判标准，否则"安全"这个词没有意义。

## 总体设计思路与威胁模型

这件事的全部难度来自一个事实：**kabegame 会在自己的进程里加载第三方页面**（畅游窗口、爬虫任务窗口）。所以"页面 JS 能做到的事"等价于"任意被访问的网站能做到的事"。拖拽又天然是个越过沙箱的出口——用户把东西拖进上传框、拖进另一个浏览器，数据就出去了。

Chromium 现有的两道闸门正是为此存在的，两道都在 `RenderWidgetHostImpl::FilterDropData`（`render_widget_host_impl.cc:2085`，已核对 149.0.7827.201 源码）：

```cpp
void RenderWidgetHostImpl::FilterDropData(DropData* drop_data) {
  drop_data->view_id = GetRoutingID();

  for (auto& url_info : drop_data->url_infos) {
    GetProcess()->FilterURL(true, &url_info.url);   // 闸门①:file:// → about:blank#blocked
  }
  if (drop_data->did_originate_from_renderer) {
    drop_data->filenames.clear();                    // 闸门②:渲染进程发起 → 路径清空
  }
}
```

所以真正该问的不是"哪个方案能跑通"，而是——**这个方案把信任放在了谁身上？** 我按这个维度排序：

| 信任对象 | 后果 |
|---|---|
| 谁都不信 | 前端被 XSS 也只能泄露已在图库里的图 |
| 信任我们自己的前端 | 前端一旦被注入 = 任意本地文件读取 |
| 信任所有页面 | 任意网站 = 任意本地文件读取 |

下面每个方案都标注它落在哪一档。

---

## 现状锚点

**a. 发起点**（`content/browser/web_contents/web_contents_view_aura.cc:1241`）

```cpp
  std::unique_ptr<ui::OSExchangeDataProvider> provider =
      ui::OSExchangeDataProviderFactory::CreateProvider();
  PrepareDragData(source_rfh, drop_data, provider.get());   // 现状:这里之后没有任何扩展点

  auto data = std::make_unique<ui::OSExchangeData>(std::move(provider));
  ...
  result_op = aura::client::GetDragDropClient(root_window)
      ->StartDragAndDrop(std::move(data), root_window, content_native_view,
                         event_info.location, ...);
```

**b. 装填函数**（同文件 `:260`）

```cpp
void PrepareDragData(RenderFrameHost& source_rfh,
                     const DropData& drop_data,
                     ui::OSExchangeDataProvider* provider) {
#if BUILDFLAG(IS_WIN)
  if (drop_data.download_metadata.has_value()) {
    PrepareDragForDownload(source_rfh, drop_data, provider);  // 现状:Windows 独占
  }
#endif
  ...
  if (!drop_data.filenames.empty())
    provider->SetFilenames(drop_data.filenames);              // 现状:但 filenames 已被闸门②清空
  ...
}
```

**c. 前端现状**（`ImageContent.vue:205`）

```js
  dt.setData("DownloadURL", `${mime}:${name}:${url}`);   // 现状:Linux 无效,仅 Windows 有用
  dt.setData("text/uri-list", url);                      // 现状:http://127.0.0.1:PORT/file?path=...
  dt.setData("text/plain", url);
```

---

## 方案 A — 不打 patch，维持现状

**机制**：`text/uri-list` 给 `http://127.0.0.1` URL，目标自己下载。已实测生效（`kioworker` 连到 33247 端口，文件同秒落盘）。

**patch 面**：零。

**信任对象**：谁都不信。前端能给的只有我们自己服务器上、且必须在图库里的图。

**代价**：只对会下载远程 URL 的目标有效（KDE KIO、GNOME gvfs）。绘图软件导入、网页上传框、命令行工具全部拿不到文件。而且文件名要靠 `Content-Disposition`（已修）。

**定位**：基线。任何其他方案都必须证明自己值回成本。

---

## 方案 B — 放开 `file://` 过滤（简单，但不能用）

**机制**：patch 闸门①，让 `file://` 不被 `FilterURL` 改写。前端把 `text/uri-list` 从 http 改成 `file:///home/cm/Pictures/...`。

**patch 面**：极小，几行。

**信任对象**：**所有页面。**

**为什么不能用**：畅游窗口里任何一个网站，一行 JS：

```js
el.addEventListener("dragstart", e =>
  e.dataTransfer.setData("text/uri-list", "file:///home/cm/.ssh/id_rsa"));
```

用户把它拖进任何上传框，私钥就出去了。不需要漏洞利用，这就是设计行为。`ChildProcessSecurityPolicy` 是**按进程**授权的，没有"只给这个页面"的粒度。

**定位：不可接受。** 列在这里是因为它确实是最省事的改法，得明确否掉。

---

## 方案 B′ — 放开 `file://`，但按进程门控（简单，中等安全）

**机制**：同 B，但在 `FilterDropData` 里先判断发起进程是不是我们自己的 UI，只对它放行 `file://`。

Chromium 的站点隔离保证了我们的 app 页面和畅游里的第三方站点**在不同渲染进程**，所以进程级判断是成立的边界：

```cpp
  for (auto& url_info : drop_data->url_infos) {
    if (url_info.url.SchemeIsFile() && IsCefTrustedProcess(GetProcess()->GetID()))
      continue;                                   // 新增:可信进程放行 file://
    GetProcess()->FilterURL(true, &url_info.url);
  }
```

**patch 面**：小。一个 Chromium 侧 patch + 一个判断可信进程的 CEF 接口。前端改一行（`fileToUrl` → `file://`）。

**信任对象**：**我们自己的前端。**

**风险**：前端拿到了"拖出任意本地路径"的能力。我们自己的 UI 一旦被注入（第三方图片元数据渲染、插件描述 EJS、markdown 渲染……任何一处 XSS），就等价于任意文件读取。而这些注入面在本仓是真实存在的。

**定位**：可用，但它把安全性押在"我们前端永远没有注入漏洞"上。**如果要快速见效可以选它，但要清醒地知道押的是什么。**

---

## 方案 C — 去掉 `filenames.clear()`（不可行，不是不安全）

**机制**：patch 闸门②。

**为什么不可行**：`DropData::filenames` 里的路径来自 Blink 的 `File` 对象的**真实后端路径**，而页面 JS 造不出带真实路径的 `File`——只有 `<input type=file>` 或用户拖进来的文件才有。我们的图库页面手里根本没有这样的 `File`，所以即使闸门②拆了，`filenames` 依然是空的。

**定位**：**死路，机制上就到不了目的地。** 列出来是为了省掉你评估它的时间。（顺带：拆了这道闸门会让页面能把用户曾经给过它的文件再拖出去——是个真实的安全退化，但换不来我们要的东西。）

---

## 方案 D — 浏览器进程内补 `SetFilenames`（推荐）

**机制**：在 `PrepareDragData` 返回之后、`StartDragAndDrop` 之前插一个 CEF 回调，由我们的 Rust 代码往 provider 上补真实路径：

```cpp
  PrepareDragData(source_rfh, drop_data, provider.get());
  CefPrepareDragDataHook(source_rfh, drop_data, provider.get());   // 新增
```

身份通道走 `drop_data.custom_data`（mime→string 的 map，**闸门①②都不碰它**）。前端：

```js
  dt.setData("application/x-kabegame-image", String(props.image.id));   // 只给 id
```

Rust 侧拿 id 查库还原成路径，再 `SetFilenames()`。

**两道门控**：

1. **只认 id，不认路径。** 路径永远由 Rust 查 DB 得出。前端即便被完全控制，也只能导出**已经在用户图库里的图**。
2. **按来源门控。** `PrepareDragData` 的第一个参数就是 `source_rfh`，用 `source_rfh.GetLastCommittedOrigin()` 挡掉畅游窗口的第三方页面。

**为什么没有时序问题**：从 `PrepareDragData` 到 `StartDragAndDrop` 是同一个同步调用栈，中间没有任何 IPC，也不需要 `preventDefault()`。

**patch 面**：一个 Chromium 侧 patch（走 CEF 的 `patch/patch.cfg` + `patch/patches/`，由我们的 `third-patches/cef/0003-*.patch` 添加）+ CEF C API + Rust 胶水。

**信任对象**：**谁都不信。**

**代价**：Chromium 侧 patch 的漂移风险高于纯 CEF patch（0001/0002 只碰 CEF 自己的 C++）。每次升 Chromium 都要跟。以及需要重编 CEF（数小时）。

---

## 方案 H — 浏览器进程自己发起拖拽

**机制**：前端 `dragstart` 里 `preventDefault()` 取消 Blink 的拖拽，走 Tauri 命令回到 Rust，由 Rust 构造 `OSExchangeData` 并直接调 `DesktopDragDropClientOzone::StartDragAndDrop`。

**patch 面**：**只需 CEF 侧 patch**（新增一个 `CefBrowserHost` 方法），不碰 Chromium 源码——和现有 0001/0002 同层，维护成本更低。

**信任对象**：谁都不信（同 D，也是 id→路径）。

**两个实打实的问题**：

1. **时序未验证。** Wayland 的 `WaylandDataDragController::GetAndValidateSerialForDrag()` 要求一个仍然有效的按键 serial（鼠标键还按着形成的隐式 grab）。IPC 往返只要用户没松手就来得及，但这个我**没有实测过**，不能替你打包票。
2. **绕过了 Chromium 自己的拖拽簿记。** `WebContentsViewAura::StartDragging` 里还有 `drag_security_info_.OnDragInitiated()`、`IsDragAllowedByDataControlPolicy()`、拖拽幽灵图、`SystemDragEnded()` 等一整套状态管理。自己发起意味着这些都要么重做要么放弃（至少幽灵图得自己设）。

**定位**：patch 层次更干净，但引入两个 D 没有的不确定性。

---

## 方案 E / F — 已排除

**E（让 Linux 也走 `DownloadURL` 虚拟文件）**：`DragDownloadFile` 在 Linux 构建里**一次都没出现**（`nm` 计数为 0），`SetDownloadFileInfo` 在任何 Linux provider 上都不存在。等于要移植整套虚拟文件机制，而收益不超过 D（D 用 `SetFilenames`，本来就零字节拷贝）。

**F（`SetFileContents`）**：Wayland 下 offer 的是 `application/octet-stream;name=`，语义是"一坨匿名数据"而不是"一个本地文件"。而且要在拖拽开始时就把整个文件读进内存——200MB 的视频，用户刚按下鼠标就吃 200MB，哪怕最后没松手。**比方案 A 的内存表现还差。**

---

## 对照表

| | patch 面 | 信任对象 | 目标兼容性 | 时序风险 | 升级维护 |
|---|---|---|---|---|---|
| **A** 现状 | 无 | 无 | 仅文件管理器 | — | — |
| **B** 放开 file:// | 极小 | 所有页面 ❌ | 全部 | 无 | 低 |
| **B′** file:// + 进程门控 | 小 | 我们的前端 ⚠ | 全部 | 无 | 中 |
| **C** 拆 filenames 清空 | 小 | — | **达不到目的** | — | — |
| **D** 补 SetFilenames | 中（Chromium 侧） | 无 ✅ | 全部 | 无 | 高 |
| **H** 自己发起拖拽 | 中（仅 CEF 侧） | 无 ✅ | 全部 | **未验证** | 中 |
| **E/F** | 大 | — | 一般 | — | 高 |

---

## 我的建议

**选 D。** 理由是那一列"信任对象"：B′ 省事，但它把安全性押在"我们前端永远不被注入"上，而本仓的注入面（插件 EJS 描述、第三方图片元数据、markdown 渲染）是真实存在的；D 的 id→DB 解析让这个前提变得无关紧要——前端全被控制，攻击者也只能导出用户自己图库里的图。

H 的 patch 层次确实更干净，值得作为备选。但它的两个不确定性（serial 时序、簿记绕过）都需要先花代价验证，而 D 一个都没有。如果 D 的 Chromium 侧 patch 在后续升级里维护不动了，再转 H 是个合理的退路。

需要你拍板的就一件事：**D 还是 B′**——是多花一份 Chromium patch 的维护成本换掉"信任前端"这个前提，还是先要速度。

要我把这份整理写进 `cocs/` 存档吗？按仓库约定还得在 `cocs/README.md` 补索引条目。