# Tauri Android 画廊图片加载优化方案

## 一、背景问题

当前架构：

Rust Core  
    ↓  
JNI -> Kotlin Plugin
    ↓  
Tauri Bridge  
    ↓  
WebView  
    ↓  
JS  

原始加载流程：

1. Rust 通过kotlin读取图片文件
2. 复制到内存
3. 转换为 Blob
4. 通过 Bridge 传给 JS
5. JS 再渲染 `<img>`

存在问题：

- 大量图片 IO 阻塞
- 内存复制成本高
- Bridge 传输数据体积大
- JS 主线程参与数据处理
- GC 频繁
- 滑动卡顿

本质问题：

> 不应该让 JS 层持有图片二进制数据

---

## 二、优化核心思想

### 目标

- 消除 Bridge 层图片数据传输
- 避免 Blob 生成
- 避免 JS 参与图片二进制处理
- 使用 WebView 原生流式加载机制

核心策略：

> 通过 WebView 请求拦截 + InputStream 返回，实现真正流式加载

---

## 三、最终架构设计

```
JS
  ↓
<img src="app://gallery/123">
  ↓
WebView 请求
  ↓
Android shouldInterceptRequest
  ↓
InputStream
  ↓
WebView 原生解码渲染
```

优势：

- 无内存复制
- 无 Blob
- 无 Bridge 大数据传输
- WebView 原生流式读取
- UI 主线程不阻塞

---

## 四、实现步骤

### 1️⃣ JS 层改造

从：

```js
const blob = await invoke("load_image_blob", id)
img.src = URL.createObjectURL(blob)
```

改为：

```html
<img src="app://gallery/123" />
```

JS 不再持有图片数据。

---

### 2️⃣ Android 侧拦截请求

实现自定义 WebViewClient：

```kotlin
class GalleryWebViewClient : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {

        val uri = request?.url ?: return null

        if (uri.scheme == "app" && uri.host == "gallery") {

            val imageId = uri.lastPathSegment ?: return null
            val inputStream = openImageStream(imageId)

            return WebResourceResponse(
                "image/jpeg",
                null,
                inputStream
            )
        }

        return null
    }
}
```

设置 WebViewClient：

```kotlin
webView.webViewClient = GalleryWebViewClient()
```

---

### 3️⃣ 打开图片流

```kotlin
fun openImageStream(id: String): InputStream {
    val file = File(getGalleryPath(id))
    return FileInputStream(file)
}
```

可以扩展：

- 加入磁盘缓存
- 加入缩略图优先加载
- 加入分辨率压缩

---

## 五、为什么这个方案更优

### 1️⃣ 不再经过 Bridge

原方案：

Rust → JS → Blob → WebView  

新方案：

WebView → Android → InputStream  

减少跨语言传输。

---

### 2️⃣ 真正流式读取

WebView 会：

- 按需读取 InputStream
- 边下载边解码
- 边解码边渲染

不会一次性加载到内存。

---

### 3️⃣ 主线程负载降低

- 不再在 JS 主线程创建 Blob
- 不再 JSON 序列化图片数据
- 不再触发额外 GC

滑动流畅度显著提升。

---

## 六、可选增强优化

### ✅ 1. 缩略图优先加载

可以实现：

```
app://gallery/thumb/123
app://gallery/full/123
```

进入视口先加载 thumb，再懒加载 full。

---

### ✅ 2. 预加载下一屏

在 Recycler 视口边界附近：

- 预触发 next 页图片流
- 放入 LRU 内存缓存

---

### ✅ 3. 加入 LRU 内存缓存

在 Android 层：

```kotlin
LruCache<String, ByteArray>
```

减少重复 IO。

---

### ✅ 4. 使用 ContentProvider（可选）

如果希望标准 URI 方案：

```
content://your.provider/gallery/123
```

需要：

- 自定义 ContentProvider
- grantUriPermission
- WebView 允许 content scheme

实现复杂度高于自定义 scheme。

---

## 七、最终效果

优化前：

- 启动时大量 IO
- 内存峰值高
- Bridge 传输大数据
- 滑动卡顿

优化后：

- 启动零图片 IO
- 图片进入视口才加载
- WebView 原生流式解码
- 滑动流畅
- 内存占用可控

---

## 八、总结

核心原则：

> 不要让 JS 持有图片二进制数据  
> 不要跨 Bridge 传输大体积内容  
> 利用 WebView 原生流式能力  

移动端 WebView 场景下：

Blob 是 workaround  
InputStream 才是正道

---

## 九、Android 实际实现（content:// 代理方案）

### 9.1 为何不能直接用 content:// 作为 img src

Chromium 将 `content://` 视为「本地资源」。当页面来源为 `http://tauri.localhost` 等时，**子资源**（如 `<img src="content://...">`）在渲染器层就会被拒绝，报错：

```
Not allowed to load local resource: content://...
```

该请求**不会**到达 Java 层的 `shouldInterceptRequest`，因此无法通过「直接拦截 content://」实现流式加载。

### 9.2 方案：HTTP 代理 URL

改用与页面同源的 HTTP URL 作为代理，由 `shouldInterceptRequest` 拦截后还原为 content URI 并流式返回：

| 环节 | 做法 |
|------|------|
| 前端 | `content://media/picker/0/...` → `http://kbg-content.localhost/media/picker/0/...` |
| Android | 在 `shouldInterceptRequest` 中识别 `host == "kbg-content.localhost"`，将 URL 还原为 `content://...`，用 `ContentResolver.openInputStream(uri)` 打开流，返回 `WebResourceResponse(mimeType, null, inputStream)` |

这样请求会正常进入 `shouldInterceptRequest`，由我们流式提供 body。

### 9.3 前端实现要点

- **常量**（`packages/core/src/env.ts`）：  
  `CONTENT_URI_PROXY_PREFIX = "http://kbg-content.localhost/"`  
  仅 Android 使用；桌面端不涉及。

- **URL 转换**：  
  - `useImageUrlMapCache.ts`：`ensureOriginalAssetUrl` 中，Android 且 `path.startsWith("content://")` 时，`url = path.replace("content://", CONTENT_URI_PROXY_PREFIX)` 写入缓存。  
  - `useImageItemLoader.ts`：`toAssetUrl` 中，Android 且 `raw.startsWith("content://")` 时，返回 `raw.replace("content://", CONTENT_URI_PROXY_PREFIX)`。  
  即：**所有给 WebView 的 content 图片 URL 一律走代理前缀**，不直接暴露 `content://`。

- **无额外加载步骤**：不调用 `read_file`、不生成 Blob、不 `createObjectURL`，仅做字符串替换后设入 `img.src`。

### 9.4 Android 侧实现要点

- **拦截时机**：wry 在 `onWebViewCreate` 之后才调用 `setWebViewClient(RustWebViewClient)`，因此须在 `onWebViewCreate` 里用 `webView.post { ... }` 延迟执行，再包装 WebViewClient（否则会被覆盖）。

- **包装类**（`MainActivity.kt`）：  
  `ContentUriStreamClient` 包装原始 `WebViewClient`，在 `shouldInterceptRequest` 中：  
  - 若 `request.url.host == "kbg-content.localhost"`，则 `uri.toString().replace("http://kbg-content.localhost/", "content://")` 得到 content URI；  
  - 使用 `ContentResolver.getType(uri)`（或按路径后缀猜测）得到 MIME；  
  - `ContentResolver.openInputStream(uri)` 得到 `InputStream`；  
  - 返回 `WebResourceResponse(mimeType, null, inputStream)`，由 WebView 流式读取并解码渲染。

- **API**：获取当前 WebViewClient 需 API 26+（`WebViewCompat.getWebViewClient(webView)`），低于 26 时不安装包装器，content 图仍可走旧逻辑（如 read_file + Blob）。

### 9.5 数据流小结

```
JS: img.src = "http://kbg-content.localhost/media/picker/0/..."
    → WebView 发起 HTTP 请求
    → ContentUriStreamClient.shouldInterceptRequest
    → 还原为 content://...，openInputStream
    → WebResourceResponse(mimeType, null, inputStream)
    → WebView 流式解码渲染
```

---

## 十、桌面端参考

桌面端（Windows / macOS / Linux）无需 content 代理：

- 图片多为**本地文件路径**，通过 Tauri 的 `convertFileSrc` 得到 `http://asset.localhost/...` 或等价 asset URL，由 Tauri/wry 的 custom protocol 直接提供流式响应，无需前端再做一层代理。
- 若未来在桌面端也需要「自定义 scheme → 流式返回」的类似能力，可参考本方案思路：  
  - **不**让 JS 直接使用会被浏览器禁止的 scheme（如某些环境下的 `file://` 或自定义 `content://`）；  
  - 使用与页面同源的 **HTTP 代理 URL**，在 native 层（Tauri custom protocol 或桌面 WebView 的等价 API）根据 path 或 host 识别并返回流式内容。  
- 即：**「代理 URL + 单一拦截点 + InputStream/流式响应」** 的架构在桌面端同样适用，仅需把「Android ContentResolver」换成「桌面文件 API 或自定义协议实现」即可。