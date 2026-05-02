# 帮助图片目录

此目录用于存放帮助页面（使用技巧）的示例图片。

## 目录结构建议

```
help-images/
├── grallery/              # 导入相关技巧的图片
│   ├── drag-drop-usage-1.png
│   ├── drag-drop-folder-1.png
│   └── drag-drop-zip-1.png
├── plugins/             # 插件相关技巧的图片
│   ├── import-method1-1.png  # 双击导入
│   ├── import-method2-1.png  # 拖入窗口
│   ├── import-method3-1.png  # 源管理导入
│   └── import-method4-1.png  # 插件编辑器
└── ...
```

## 引用方式

**Vite 会自动处理 `public` 目录下的文件**，直接使用绝对路径引用即可：

```typescript
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

const method1Images = ref<TipImage[]>([
  {
    src: "/help-images/plugins/import-method1-1.png",  // 注意：以 / 开头
    alt: "双击导入示例",
    caption: "在资源管理器中双击 .kgpg 文件"
  },
  {
    src: "/help-images/plugins/import-method1-2.png",
    alt: "导入窗口",
    caption: "自动打开的导入确认窗口"
  }
]);
```

## 工作原理

1. **开发环境**：Vite 开发服务器会自动提供 `public` 目录下的文件
2. **生产构建**：Vite 会将 `public` 目录的内容原样复制到 `dist-kabegame` 的根目录
3. **路径解析**：使用 `/help-images/...` 这样的绝对路径，Vite 会自动解析为 `public/help-images/...`

## 注意事项

- ✅ **只属于 main app**：图片放在 `apps/kabegame/public` 下，只会被打包到 `dist-kabegame`，不会进入其他 app
- ✅ **无需 import**：直接使用字符串路径，不需要 `import` 语句
- ✅ **自动处理**：Vite 会自动处理，无需额外配置
- 📝 **路径格式**：必须使用 `/` 开头的绝对路径（如 `/help-images/...`），不能使用相对路径
- 🖼️ **图片格式**：建议使用 PNG 格式，保持图片清晰度
- 📦 **文件命名**：建议使用有意义的命名，便于管理

## 示例

在模板中也可以直接使用：

```vue
<template>
  <img src="/help-images/plugins/import-method1-1.png" alt="示例" />
</template>
```
