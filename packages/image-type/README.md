# @kabegame/image-type

通过 **base64 小图实际加载检测** 判断当前 WebView / 浏览器对现代图片格式的支持情况，不依赖 UA，可缓存，适用于 Web / Tauri / Electron。

## 检测格式

- **WebP**
- **AVIF**
- **HEIC**（可选）
- **SVG**

JPEG、PNG 等常见格式无需检测，默认支持。

## 安装

工作区内直接依赖：

```json
{
  "dependencies": {
    "@kabegame/image-type": "workspace:*"
  }
}
```

## 使用

```ts
import { getImageSupport, getSupportedFormats } from "@kabegame/image-type"

// 获取支持结果（带内存 + 可选 localStorage 缓存）
const support = await getImageSupport()

if (support.avif) {
  img.src = "image.avif"
} else if (support.webp) {
  img.src = "image.webp"
} else {
  img.src = "image.jpg"
}

// 得到格式列表，便于传给后端
const formats = getSupportedFormats(support)
// 例如: ["webp", "avif", "svg"]
```

### 仅内存缓存（不写 localStorage）

```ts
const support = await getImageSupport({ useStorage: false })
```

### 清除缓存

```ts
import { clearImageSupportCache } from "@kabegame/image-type"

clearImageSupportCache()
```

### 与 Tauri 后端同步

检测完成后可将支持的格式列表通知后端，例如：

```ts
import { getImageSupport, getSupportedFormats } from "@kabegame/image-type"
import { invoke } from "@tauri-apps/api/core"

const support = await getImageSupport()
const formats = getSupportedFormats(support)
await invoke("set_supported_image_formats", { formats })
```

需在后端提供对应的 `set_supported_image_formats` 命令并保存该列表。

## API

| 方法 | 说明 |
|------|------|
| `getImageSupport(options?)` | 获取支持结果，优先缓存再检测 |
| `detectImageSupport()` | 直接执行检测，不读缓存 |
| `getSupportedFormats(result)` | 将结果转为 `ImageFormat[]` |
| `clearImageSupportCache()` | 清除内存与 localStorage 缓存 |

## 设计说明

- **运行时真实检测**：用 `new Image()` 加载极小 base64 图，`onload` / `onerror` 判断，不依赖 User-Agent。
- **性能**：仅加载 < 100 bytes 级 base64，`Promise.all` 并发，结果缓存，通常只执行一次。
- **SSR 安全**：在 `typeof window === "undefined"` 时返回全 `false`。
- **持久缓存**：可选 `localStorage`，下次访问可优先读取。

## License

与主项目一致。
