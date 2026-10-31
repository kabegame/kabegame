# 合并冲突记录：IPC `Origin` 同时承担「来源」与「调用方身份」

2026-10-31。合并 `origin/feat/wpe-import`（dbc5e609，关键提交 24ee52ce）到 main（e0b35e8f，B 段 frame 级 IPC）时，
两边对 IPC 请求的 `Origin` 头各有一套写法，不能二选一。合并已 abort，main 停在 e0b35e8f。

## 总述

B 段让网页壁纸在主窗口（预览）和壁纸窗口（桌面）里都成为 `file:` iframe。它用 IPC 请求的 `Origin` 做两件事：
1. **ACL 判定来源**：远程 `file:` 来源只匹配 `wpe-web-capability`。
2. **认出调用方是哪张壁纸**：`Origin` 是完整的文档 URL，`wpe_web_pull_state` 按其中的路径查网页壁纸目录索引。

24ee52ce 修的是 frame URL 竞态：CEF 的 `frame.url()` 是 UI 线程上的缓存，要到 `DidFinishNavigation` 才刷新；
IO 线程上新文档最早的几个请求，读到的是空串或上一个文档的地址。
它的做法是把 `Origin` 改成从浏览器给的 `request_initiator` 换算。`request_initiator` 只有 origin、不带路径，
所以 `file:` 文档的 `Origin` 一律变成 `file:///`。

结果是：
- 第 1 件事（来源判定）更可靠了。
- 第 2 件事（认出是哪张壁纸）失效。B 段的 `CallerOrigin` 永远是 `file:///`，`wpe_web_pull_state` 认不出壁纸，网页壁纸拉不到属性状态。
- 如果反过来保留 B 段的做法，竞态又回来了。

结论：**来源**可以只靠 initiator 确定，**身份**需要一个 initiator 给不了、又不能被页面伪造的完整文档 URL。两件事要拆开处理。

## 现状

### B 段（main，e0b35e8f）：`Origin` = frame 当前的完整 URL

协议层把 `file:` frame 发出的请求的 `Origin` 改写成 frame URL（`src-tauri/tauri-runtime-kbcef/src/protocol.rs`）：
```rust
// GlobalSchemeHandlerFactory::create：在 IO 线程读 frame.url()（就是这里有竞态）
let request_frame = frame.map(|frame| RequestFrame {
    is_main: frame.is_main() == 1,
    url: Some(CefString::from(&frame.url()).to_string()).filter(|url| !url.is_empty()),
    id: Some(CefString::from(&frame.identifier()).to_string()).filter(|id| !id.is_empty()),
});

fn attach_request_frame(request: &mut HttpRequest<Vec<u8>>, frame: Option<&RequestFrame>) {
    if let Some(frame) = frame {
        pin_file_frame_origin(request, frame);   // file: frame → Origin = frame.url（完整文档 URL）
        request.extensions_mut().insert(frame.clone());
        if let Some(id) = frame.subframe_id() {
            request.extensions_mut().insert(id); // 子 frame 的路由标识（18）
        }
    }
    request.extensions_mut().insert(frame.map_or(IpcFrame::Unknown, RequestFrame::ipc_frame));
}
```

Tauri（补丁 18，`third/tauri/crates/tauri/src/webview/mod.rs` 的 `on_message`）把同一个 URL 交给两处：
```rust
let is_local = self.is_local_url(&request.url);          // 来源：本地 / 远程
message.caller_origin = Some(request.url.clone());       // 身份：命令参数 tauri::ipc::CallerOrigin
let acl_origin = if is_local { Origin::Local } else { Origin::Remote { url: request.url.clone() } };
// resolve_access(.., &acl_origin, request.frame) / is_exempt(.., &acl_origin, ..)
```

应用侧靠这个 URL 认出是哪张壁纸（`src-tauri/kabegame/src/commands/wpe_web.rs`）：
```rust
#[tauri::command]
pub async fn wpe_web_pull_state(caller: tauri::ipc::CallerOrigin) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    let id = index.image_id_of(&doc).ok_or("not inside a web wallpaper")?;  // 按文档路径找所在的壁纸目录
    // … build_wpe_web_state_with_raw(&id)，然后 replace_grants(&id, user_file_grants(&raw))
}
```
> 为什么非要身份：B 段删掉了按窗口登记的壁纸根目录，主窗口和壁纸窗口都能装网页壁纸 iframe。命令也不接收 id（页面可以伪造），
> 只能从浏览器侧的信息推出调用方是哪张壁纸。

回退通道 `cef-ipc` 在 B 段的取值顺序（`src-tauri/tauri-runtime-kbcef/src/ipc.rs` 的 `post_message_request`）是：
`Origin` → frame URL → 子 frame 用占位来源 `kabegame-unattributed://subframe/`（交给 ACL 拒绝，页面的 Promise 会被 reject，不会挂起）→
主 frame 或 frame 未知时用 webview 初始 URL。

### feat/wpe-import（24ee52ce）：`Origin` = 换算后的 `request_initiator`

1. **写入私有头**：在 IO 线程、请求开始加载前（`webview.rs`）。
   - `resource_request_handler` 发现是 `ipc` / `cef-ipc` 请求，就返回 `IpcInitiatorHandler`。
   - 它的 `on_before_resource_load` 用 `set_header_by_name(.., overwrite=1)` 写入 `Sec-Kabegame-Initiator-Origin`。
   - 写入的值是 `origin_from_initiator(request_initiator)`：`"file://"` 换成 `"file:///"`，普通 origin 原样保留，opaque 或缺失写成 `"null"`。
2. **私有头覆写 `Origin`**：在 `protocol.rs` 的 `CefResourceHandler::open` 里，`request_to_http` 之后调用 `apply_initiator_origin`，用 remove 加 insert 换掉 `Origin`。
3. **读取 `Origin`**：
   - Tauri `ipc/protocol.rs` 的 `parse_invoke_request` 执行 `Url::parse(headers["Origin"])`，结果进 `InvokeRequest.url`。
   - 回退通道里，`post_message_request` 遇到不合法的 `Origin` 直接拒绝，不再找替代地址。合法的话转成新请求的 URI，再由 Tauri 的 `handle_ipc_message` 执行 `Url::parse(request.uri())`。
4. **删除**：`RequestFrame.url`、`pin_file_frame_origin`，以及回退通道的 frame URL 和初始 URL 退路。

在 Windows 上真机回归过：桌面壁纸窗口整窗导航进网页壁纸 15 次，0 次失败，修复前是 17 次里失败 12 次。
详见对方分支 `versions/latest/regression.md` 的「CEF 运行时：IPC 来源按发起方 origin 判定」一节。
注意，那次测的是**主 frame** 的 `file:` 文档；B 段已经没有这种形态，桌面也改成了 iframe。

## 已排除的方向

- **Referer**：
  - `file:` 文档本来就不发 Referer。Blink 只给 http(s) 和登记过的 scheme 生成。
  - 跨源请求在默认策略下只送 origin。
  - 最关键：页面可以用 `fetch(url, { referrer })` 把它设成任意同源 URL。04 打开了 `allow_file_access_from_file_urls`，所有 `file:` 地址互相同源，恶意壁纸可以冒充库里另一张壁纸。
  - 以上按 Chromium 源码推断，未实测。
- **`request_initiator` 本身**：它是 `std::optional<url::Origin>`，只有 scheme / host / port。CEF 文档也写明它是「origin (scheme + domain)」。`ResourceRequest` 里其它和发起方有关的字段（`site_for_cookies`、`isolation_info`）也只到 origin 或站点这一层。
- **垫片把 `location.href` 当参数传上来**：页面可以伪造，同上。
- **浏览器进程在导航提交的回调里按 frame 记下 URL**：回调仍在 UI 线程，和 IO 线程的请求之间同样有先后问题，不能根治。

## 候选方案

### 方案 1（不改 Chromium）：来源由 initiator 定，身份用 frame URL 细化

在 `CefResourceHandler::open` 里，先按 24ee52ce 的做法覆写 `Origin`，再加一步：
**只有 `Origin` 已经是 `file:///`、并且 frame URL 也是 `file:` 时**，才把 `Origin` 细化成 frame URL。
```rust
apply_initiator_origin(&mut request);                          // 24ee52ce：来源以 initiator 为准
refine_file_origin(&mut request, self.request_frame.as_ref()); // 新增：Origin == "file:///" 且 frame.url 为 file: → 换成 frame.url
attach_request_frame(&mut request, self.request_frame.as_ref());
```
- 需要保留 B 段的 `RequestFrame.url`。24ee52ce 删掉了它，`id` 也要保留（`SubframeId` 路由用）。
- **安全**：只会在 initiator 已经认定是 `file:` 的请求上细化，永远不会被判成本地来源。24ee52ce 要堵的洞仍然堵着。
- **身份不会认错**：前提是 B 段闸门的不变量「`file:` frame 不会跨壁纸目录」（`file_access::classify_file_requester`）：
  - 主 frame 导航到 `file:` 一律拒绝。
  - `file:` 文档自己导航，按这个文档的访问范围裁决，出不了自己的目录。
  - 应用页把已有 iframe 的 `src` 换成另一张壁纸，也算这个 frame 的当前文档发起，同样被拒；`WallpaperStage` 每次切换都会重建 iframe。

  所以过期的 frame URL 只有两种可能：
  - 空串或 `about:blank`：不细化，`Origin` 保持 `file:///`。ACL 照样放行，listen 立即成功；`wpe_web_pull_state` 这一次认不出壁纸，返回 "not inside a web wallpaper"，靠垫片的 `retrying` 重试兜住（最多 5 次、250ms 起指数退避，共约 7.75s）。
  - 同一目录里的上一个文档：还是同一张壁纸，身份没错。
- **代价**：首次拉取可能要重试一两次；身份正确依赖上面那条不变量，要在 `file_access` 的模块注释里写明，以后放开跨目录导航时必须同时改这里。
- 回退通道里，`http_uri_for` 会把 `file:///D:/…` 转成 `file://localhost/D:/…`；`Url::to_file_path` 把 `localhost` 当本机处理，`caller_document` 能照常解析。

### 方案 2（打 CEF / Chromium 补丁）：文档提交时把完整 URL 跟 initiator 一起绑定

- 在文档提交时，把要提交的完整 URL 绑定到这个文档的子资源加载器上，和 `request_initiator` 同一时机、同样页面改不了。
  CEF 是在 `WillCreateURLLoaderFactory` 里建代理工厂的，具体落点需要在 Chromium 侧确认。
- 再经 `GetResourceRequestHandler` 或请求上的字段暴露给嵌入方。
- 绑定之后，IPC 的来源、调用方身份、`file:` 闸门的发起方判定三处都能用它，`frame.url()` 的依赖可以全部去掉。
  B 段闸门里那条临时规则也能删：认不出调用方文档、但 initiator 是 `file:` 时，按目标路径判定（只放壁纸目录，不放用户选择）。
- 代价：`third-patches/cef` 要新增一个补丁，还要重编 CEF。

建议：先按方案 1 合并，方案 2 以后需要时再做。

## 其余冲突（文本层面，可以直接合）

- **`ipc.rs`**：
  - 采用 24ee52ce 的「`Origin` 不合法就拒，不退到初始 URL」。
  - 保留 B 段的子 frame 放行规则和 `SubframeId` extension。
  - **要决定**：B 段的占位来源 `kabegame-unattributed://subframe/` 是为了让子 frame 拿不到来源时页面 Promise 被 reject，而不是返回 400 后一直挂着。24ee52ce 在主 frame 上接受了「返回 400、页面不回调」（它回归表第 5 项）。子 frame 是沿用占位来源，还是统一成 400，需要选一个。
  - B 段那些「回退到 frame URL」的单测要改写。
- **`webview.rs` `resource_request_handler`**：两边都把 `url` / `initiator` 的计算提到了前面。
  - 合并顺序：先算一次，IPC 分支在前（`IpcInitiatorHandler`），`file:` 分支在后。
  - `file:` 分支用 B 段的 `classify_file_requester`，它要用到 `parent_url`，加上 `FileDocumentGuardHandler(label, requester)`。
  - 闸门的 `deny file:` 日志取 B 段版本。对方那份还在打印 `root` / `grants`，这两个字段 B 段已经没有了。
- **`protocol.rs`**：`RequestFrame` 保留 `is_main` 和 `id`；`url` 是否保留看方案。`INITIATOR_ORIGIN_HEADER`、`is_ipc_url`、`origin_from_initiator`、`apply_initiator_origin` 及其单测都保留。
- **`subprocess.rs`**：只是注释，改成合并后的说法。
- **`wpe_web.rs` 测试**：
  - 对方新增的 `preview_root_rejects_wallpaper_window` 测的是 `check_preview_label`，这个函数 B 段已经删了，测试也去掉。
  - 保留对方在 capability 测试里加的 `file:///` 和 `file://localhost/` 两条断言；文档注释改成「绑定 `main` + `wallpaper`、`frames: "sub"`」。
- **文档**：`cocs/README.md`、`cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md`、`cocs/wpe/WPE_IMPORT.md`、`src-tauri/tauri-runtime-kbcef/README.md`、`versions/latest/regression.md`。
  - 两边的内容都要保留，再统一成合并后的说法：iframe 形态、目录索引、来源用 initiator、身份按选定的方案。
  - 对方回归表里「壁纸窗口整窗导航」「`clear_js_listeners`」「预览代办白名单」这些描述，在 B 段已经不成立，需要改写或注明已被替代。
- 24ee52ce 里不冲突、会自动合入的部分：WPE 滑块按步长对齐（`user_props.rs`、`KbNumber` 的 `stepStrictly`、`WpePropertyField`）。

## 合并后要验证

- 单测：`tauri-runtime-kbcef`（initiator 换算、细化规则、回退通道），以及 `kabegame --lib wpe_web`。
- **Windows 真机**（B 段回归 W1、W7、W8、W10、W11 原本就在等这个修复）：
  - 桌面和预览的 `file:` iframe 在网页壁纸之间、普通图片与网页壁纸之间各切 10 次以上，回放新文档的 console：
    listen 每次都立即成功；pull 允许出现 `[kb-wpe] pull retry`，但最终必须成功，并且拉到的是**这一张**的状态。
  - 子 frame 的 `request_initiator` 在 04 打开时也是 `"file://"`。对方只验证过主 frame，需要实测确认。
  - 用 `fetch(ipc://…)` 强制失败，验证 `cef-ipc` 回退通道同样能认出壁纸。
