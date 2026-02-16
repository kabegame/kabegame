# Android 壁纸设置实现方案

本文档详细说明 Kabegame 在 Android 平台上实现壁纸设置功能的方案，包括填充效果、过渡模式、视差滚动等高级功能的实现方法，以及不同厂商和版本的兼容性处理。

---

## 目录

- [一、方案概述](#一方案概述)
- [二、功能需求分析](#二功能需求分析)
- [三、实现方案对比](#三实现方案对比)
- [四、WallpaperService 完整实现](#四wallpaperservice-完整实现)
- [五、兼容性分析](#五兼容性分析)
- [六、最佳实践建议](#六最佳实践建议)
- [七、壁纸轮播服务架构](#七壁纸轮播服务架构)

---

## 一、方案概述

### 1.1 功能需求

Kabegame 需要在 Android 平台上实现以下壁纸功能：

1. **填充模式（Style）**
   - `fill`: 填充模式，裁剪图片填满屏幕
   - `fit`: 适应模式，完整显示，可能留黑边
   - `stretch`: 拉伸模式，填满屏幕，可能变形
   - `center`: 居中模式，原尺寸居中显示
   - `tile`: 平铺模式，重复显示

2. **过渡效果（Transition）**
   - `none`: 无过渡，直接切换
   - `fade`: 淡入淡出
   - `slide`: 滑动过渡
   - `zoom`: 缩放过渡

3. **视差滚动（Parallax）**
   - 静态模式：壁纸固定，不随桌面滑动
   - 视差模式：壁纸随桌面滑动而移动

### 1.2 技术方案选择

**推荐方案：双轨并行**

- **基础方案**：使用 `WallpaperManager.setBitmap()` 实现简单快速的壁纸设置
- **高级方案**：使用 `WallpaperService` 实现所有高级功能（填充、过渡、视差）
- **自动降级**：检测设备支持情况，不支持时自动降级到基础方案

---

## 二、功能需求分析

### 2.1 Android 原生 API 限制

| 功能 | WallpaperManager 支持 | WallpaperService 支持 |
|------|---------------------|---------------------|
| 设置壁纸 | ✅ 完全支持 | ✅ 完全支持 |
| 填充模式 | ❌ 不支持（需预处理） | ✅ 完全支持 |
| 过渡效果 | ❌ 不支持 | ✅ 完全支持 |
| 视差滚动 | ❌ 不支持 | ✅ 完全支持 |

### 2.2 实现难度对比

| 方案 | 实现难度 | 功能完整性 | 兼容性 | 性能 |
|------|---------|----------|--------|------|
| WallpaperManager | ⭐ 简单 | ⭐⭐ 基础 | ⭐⭐⭐⭐⭐ 优秀 | ⭐⭐⭐⭐⭐ 优秀 |
| WallpaperService | ⭐⭐⭐⭐ 复杂 | ⭐⭐⭐⭐⭐ 完整 | ⭐⭐⭐ 良好 | ⭐⭐⭐ 良好 |

---

## 三、实现方案对比

### 3.1 方案一：WallpaperManager（基础方案）

**优点：**
- 实现简单，代码量少
- 兼容性极好，所有 Android 版本和厂商都支持
- 性能优秀，系统原生实现
- 无需额外权限

**缺点：**
- 不支持填充模式（需要预处理图片）
- 不支持过渡效果
- 不支持视差滚动

**适用场景：**
- 单次设置壁纸
- 不需要高级功能
- 追求最大兼容性

### 3.2 方案二：WallpaperService（高级方案）

**优点：**
- 完全支持所有填充模式
- 完全支持过渡效果
- 完全支持视差滚动
- 功能完整，体验优秀

**缺点：**
- 实现复杂，代码量大
- 需要处理生命周期
- 需要性能优化
- 部分厂商可能有兼容性问题

**适用场景：**
- 需要轮播功能
- 需要过渡效果
- 需要视差滚动
- 追求完整功能体验

### 3.3 推荐方案：双轨并行

结合两种方案的优点，根据功能需求自动选择：

```kotlin
fun setWallpaper(filePath: String, style: String, transition: String, enableParallax: Boolean) {
    val needsAdvancedFeatures = transition != "none" || enableParallax
    
    if (needsAdvancedFeatures && supportsWallpaperService()) {
        // 使用 WallpaperService（高级功能）
        setWallpaperViaService(filePath, style, transition, enableParallax)
    } else {
        // 使用 WallpaperManager（简单快速）
        setWallpaperViaManager(filePath, style)
    }
}
```

---

## 四、WallpaperService 完整实现

### 4.1 服务声明

**AndroidManifest.xml**

```xml
<!-- 壁纸服务 -->
<service
    android:name=".KabegameWallpaperService"
    android:permission="android.permission.BIND_WALLPAPER"
    android:exported="true">
    <intent-filter>
        <action android:name="android.service.wallpaper.WallpaperService" />
    </intent-filter>
    <meta-data
        android:name="android.service.wallpaper"
        android:resource="@xml/wallpaper" />
</service>

<!-- 权限声明 -->
<uses-permission android:name="android.permission.SET_WALLPAPER" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
```

**res/xml/wallpaper.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<wallpaper
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:thumbnail="@drawable/wallpaper_thumbnail"
    android:description="@string/wallpaper_description"
    android:settingsActivity="app.kabegame/.WallpaperSettingsActivity" />
```

### 4.2 服务实现

**KabegameWallpaperService.kt**

```kotlin
package app.kabegame

import android.graphics.*
import android.os.Handler
import android.os.Looper
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder
import java.io.File

class KabegameWallpaperService : WallpaperService() {
    
    override fun onCreateEngine(): Engine {
        return KabegameWallpaperEngine()
    }
    
    inner class KabegameWallpaperEngine : Engine() {
        // 状态变量
        private var currentBitmap: Bitmap? = null
        private var nextBitmap: Bitmap? = null
        private var style: String = "fill"
        private var transitionType: String = "none"
        private var enableParallax: Boolean = false
        
        // 过渡动画
        private var transitionProgress: Float = 0f
        private var isTransitioning: Boolean = false
        private val transitionHandler = Handler(Looper.getMainLooper())
        
        // 视差滚动
        private var parallaxOffsetX: Float = 0f
        private var parallaxOffsetY: Float = 0f
        
        // 屏幕尺寸
        private var screenWidth: Int = 0
        private var screenHeight: Int = 0
        
        override fun onSurfaceCreated(holder: SurfaceHolder) {
            super.onSurfaceCreated(holder)
            screenWidth = holder.surfaceFrame.width()
            screenHeight = holder.surfaceFrame.height()
        }
        
        override fun onSurfaceChanged(
            holder: SurfaceHolder,
            format: Int,
            width: Int,
            height: Int
        ) {
            super.onSurfaceChanged(holder, format, width, height)
            screenWidth = width
            screenHeight = height
            drawFrame()
        }
        
        override fun onVisibilityChanged(visible: Boolean) {
            super.onVisibilityChanged(visible)
            if (visible) {
                drawFrame()
            } else {
                // 不可见时停止动画以节省资源
                stopTransition()
            }
        }
        
        // 视差滚动回调
        override fun onOffsetsChanged(
            xOffset: Float,
            yOffset: Float,
            xOffsetStep: Float,
            yOffsetStep: Float,
            xPixelOffset: Int,
            yPixelOffset: Int
        ) {
            super.onOffsetsChanged(xOffset, yOffset, xOffsetStep, yOffsetStep, xPixelOffset, yPixelOffset)
            
            if (enableParallax && currentBitmap != null) {
                val bitmap = currentBitmap!!
                val maxOffsetX = (bitmap.width - screenWidth).coerceAtLeast(0)
                val maxOffsetY = (bitmap.height - screenHeight).coerceAtLeast(0)
                
                parallaxOffsetX = xOffset * maxOffsetX
                parallaxOffsetY = yOffset * maxOffsetY
                
                drawFrame()
            }
        }
        
        // 绘制壁纸
        override fun onDraw(canvas: Canvas) {
            val current = currentBitmap ?: return
            
            // 视差模式：绘制偏移后的区域
            if (enableParallax && (parallaxOffsetX != 0f || parallaxOffsetY != 0f)) {
                drawParallaxWallpaper(canvas, current)
                return
            }
            
            // 过渡模式：绘制过渡效果
            if (isTransitioning && nextBitmap != null) {
                drawTransition(canvas, current, nextBitmap!!)
                return
            }
            
            // 普通模式：根据样式绘制
            drawWallpaperWithStyle(canvas, current)
        }
        
        // 根据样式绘制壁纸
        private fun drawWallpaperWithStyle(canvas: Canvas, bitmap: Bitmap, paint: Paint? = null) {
            when (style) {
                "fill" -> drawFill(canvas, bitmap, paint)
                "fit" -> drawFit(canvas, bitmap, paint)
                "stretch" -> drawStretch(canvas, bitmap, paint)
                "center" -> drawCenter(canvas, bitmap, paint)
                "tile" -> drawTile(canvas, bitmap, paint)
                else -> drawFill(canvas, bitmap, paint)
            }
        }
        
        // 填充模式
        private fun drawFill(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val scale = max(
                screenWidth.toFloat() / bitmap.width,
                screenHeight.toFloat() / bitmap.height
            )
            val scaledWidth = (bitmap.width * scale).toInt()
            val scaledHeight = (bitmap.height * scale).toInt()
            val scaled = Bitmap.createScaledBitmap(bitmap, scaledWidth, scaledHeight, true)
            val x = (scaledWidth - screenWidth) / 2
            val y = (scaledHeight - screenHeight) / 2
            val cropped = Bitmap.createBitmap(scaled, x, y, screenWidth, screenHeight)
            canvas.drawBitmap(cropped, 0f, 0f, paint)
        }
        
        // 适应模式
        private fun drawFit(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val scale = min(
                screenWidth.toFloat() / bitmap.width,
                screenHeight.toFloat() / bitmap.height
            )
            val scaledWidth = (bitmap.width * scale).toInt()
            val scaledHeight = (bitmap.height * scale).toInt()
            val scaled = Bitmap.createScaledBitmap(bitmap, scaledWidth, scaledHeight, true)
            val x = (screenWidth - scaledWidth) / 2f
            val y = (screenHeight - scaledHeight) / 2f
            canvas.drawColor(Color.BLACK)
            canvas.drawBitmap(scaled, x, y, paint)
        }
        
        // 拉伸模式
        private fun drawStretch(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val scaled = Bitmap.createScaledBitmap(bitmap, screenWidth, screenHeight, true)
            canvas.drawBitmap(scaled, 0f, 0f, paint)
        }
        
        // 居中模式
        private fun drawCenter(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val x = (screenWidth - bitmap.width) / 2f
            val y = (screenHeight - bitmap.height) / 2f
            canvas.drawColor(Color.BLACK)
            canvas.drawBitmap(bitmap, x, y, paint)
        }
        
        // 平铺模式
        private fun drawTile(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val p = paint ?: Paint()
            for (x in 0 until screenWidth step bitmap.width) {
                for (y in 0 until screenHeight step bitmap.height) {
                    canvas.drawBitmap(bitmap, x.toFloat(), y.toFloat(), p)
                }
            }
        }
        
        // 视差绘制
        private fun drawParallaxWallpaper(canvas: Canvas, bitmap: Bitmap) {
            val srcRect = Rect(
                parallaxOffsetX.toInt().coerceIn(0, bitmap.width - screenWidth),
                parallaxOffsetY.toInt().coerceIn(0, bitmap.height - screenHeight),
                (parallaxOffsetX + screenWidth).toInt().coerceIn(0, bitmap.width),
                (parallaxOffsetY + screenHeight).toInt().coerceIn(0, bitmap.height)
            )
            val dstRect = Rect(0, 0, screenWidth, screenHeight)
            canvas.drawBitmap(bitmap, srcRect, dstRect, null)
        }
        
        // 过渡效果绘制
        private fun drawTransition(canvas: Canvas, current: Bitmap, next: Bitmap) {
            when (transitionType) {
                "fade" -> {
                    drawWallpaperWithStyle(canvas, current)
                    val alpha = (transitionProgress * 255).toInt()
                    val paint = Paint().apply { this.alpha = alpha }
                    drawWallpaperWithStyle(canvas, next, paint)
                }
                "slide" -> {
                    val offsetX = (transitionProgress * screenWidth).toInt()
                    canvas.save()
                    canvas.translate(-offsetX.toFloat(), 0f)
                    drawWallpaperWithStyle(canvas, current)
                    canvas.restore()
                    canvas.save()
                    canvas.translate((screenWidth - offsetX).toFloat(), 0f)
                    drawWallpaperWithStyle(canvas, next)
                    canvas.restore()
                }
                "zoom" -> {
                    drawWallpaperWithStyle(canvas, current)
                    val scale = 1f + (transitionProgress * 0.1f)
                    val matrix = Matrix().apply {
                        setScale(scale, scale)
                        postTranslate(
                            screenWidth * (1 - scale) / 2,
                            screenHeight * (1 - scale) / 2
                        )
                    }
                    val paint = Paint().apply {
                        alpha = (transitionProgress * 255).toInt()
                    }
                    canvas.save()
                    canvas.concat(matrix)
                    drawWallpaperWithStyle(canvas, next, paint)
                    canvas.restore()
                }
                else -> drawWallpaperWithStyle(canvas, current)
            }
        }
        
        // 设置壁纸
        fun setWallpaper(bitmap: Bitmap, newStyle: String, transition: String, parallax: Boolean) {
            style = newStyle
            transitionType = transition
            enableParallax = parallax
            
            if (transition == "none" || currentBitmap == null) {
                // 无过渡或首次设置
                currentBitmap = bitmap
                nextBitmap = null
                isTransitioning = false
                drawFrame()
            } else {
                // 有过渡
                nextBitmap = bitmap
                startTransition()
            }
        }
        
        // 开始过渡动画
        private fun startTransition() {
            isTransitioning = true
            transitionProgress = 0f
            
            val duration = when (transitionType) {
                "fade" -> 800L
                "slide" -> 800L
                "zoom" -> 900L
                else -> 0L
            }
            
            if (duration == 0L) {
                currentBitmap = nextBitmap
                nextBitmap = null
                isTransitioning = false
                drawFrame()
                return
            }
            
            val startTime = System.currentTimeMillis()
            val updateRunnable = object : Runnable {
                override fun run() {
                    if (!isTransitioning) return
                    
                    val elapsed = System.currentTimeMillis() - startTime
                    transitionProgress = (elapsed.toFloat() / duration).coerceIn(0f, 1f)
                    
                    drawFrame()
                    
                    if (transitionProgress < 1f) {
                        transitionHandler.postDelayed(this, 16) // ~60fps
                    } else {
                        // 过渡完成
                        currentBitmap = nextBitmap
                        nextBitmap = null
                        isTransitioning = false
                        transitionProgress = 0f
                    }
                }
            }
            transitionHandler.post(updateRunnable)
        }
        
        // 停止过渡
        private fun stopTransition() {
            isTransitioning = false
            transitionHandler.removeCallbacksAndMessages(null)
        }
    }
}
```

### 4.3 Tauri 插件集成

**WallpaperPlugin.kt**

```kotlin
package app.kabegame

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.BitmapFactory
import android.service.wallpaper.WallpaperService
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class WallpaperPlugin(private val activity: Activity) : Plugin(activity) {
    
    @Command
    fun setWallpaper(
        invoke: Invoke,
        filePath: String,
        style: String = "fill",
        transition: String = "none",
        enableParallax: Boolean = false
    ) {
        try {
            val file = File(filePath)
            if (!file.exists()) {
                invoke.reject("文件不存在: $filePath")
                return
            }
            
            val bitmap = BitmapFactory.decodeFile(filePath)
                ?: throw Exception("无法解码图片文件")
            
            // 判断是否需要高级功能
            val needsAdvancedFeatures = transition != "none" || enableParallax
            
            if (needsAdvancedFeatures && supportsWallpaperService()) {
                // 使用 WallpaperService
                setWallpaperViaService(bitmap, style, transition, enableParallax, invoke)
            } else {
                // 使用 WallpaperManager（需要预处理图片）
                setWallpaperViaManager(bitmap, style, invoke)
            }
        } catch (e: Exception) {
            invoke.reject("设置壁纸失败: ${e.message}", e)
        }
    }
    
    private fun supportsWallpaperService(): Boolean {
        return android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP
    }
    
    private fun setWallpaperViaService(
        bitmap: android.graphics.Bitmap,
        style: String,
        transition: String,
        enableParallax: Boolean,
        invoke: Invoke
    ) {
        // 通过 Intent 启动 WallpaperService
        // 注意：实际实现中需要通过 SharedPreferences 或其他方式传递参数
        val intent = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
        intent.putExtra(
            WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT,
            ComponentName(activity, KabegameWallpaperService::class.java)
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        
        try {
            activity.startActivity(intent)
            invoke.resolve(JSObject().apply {
                put("success", true)
                put("method", "service")
                put("style", style)
                put("transition", transition)
                put("parallax", enableParallax)
            })
        } catch (e: Exception) {
            // 降级到 WallpaperManager
            setWallpaperViaManager(bitmap, style, invoke)
        }
    }
    
    private fun setWallpaperViaManager(
        bitmap: android.graphics.Bitmap,
        style: String,
        invoke: Invoke
    ) {
        try {
            val wallpaperManager = WallpaperManager.getInstance(activity)
            val displayMetrics = activity.resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val screenHeight = displayMetrics.heightPixels
            
            // 预处理图片以适配样式
            val processedBitmap = processBitmapForStyle(bitmap, style, screenWidth, screenHeight)
            
            wallpaperManager.setBitmap(processedBitmap)
            
            invoke.resolve(JSObject().apply {
                put("success", true)
                put("method", "manager")
                put("style", style)
                put("transition", "none")
                put("parallax", false)
                if (style != "fill") {
                    put("warning", "WallpaperManager 模式下，部分样式效果可能不完美")
                }
            })
        } catch (e: Exception) {
            invoke.reject("设置壁纸失败: ${e.message}", e)
        }
    }
    
    private fun processBitmapForStyle(
        bitmap: android.graphics.Bitmap,
        style: String,
        screenWidth: Int,
        screenHeight: Int
    ): android.graphics.Bitmap {
        return when (style) {
            "fill" -> {
                val scale = max(
                    screenWidth.toFloat() / bitmap.width,
                    screenHeight.toFloat() / bitmap.height
                )
                val scaledWidth = (bitmap.width * scale).toInt()
                val scaledHeight = (bitmap.height * scale).toInt()
                val scaled = android.graphics.Bitmap.createScaledBitmap(bitmap, scaledWidth, scaledHeight, true)
                val x = (scaledWidth - screenWidth) / 2
                val y = (scaledHeight - screenHeight) / 2
                android.graphics.Bitmap.createBitmap(scaled, x, y, screenWidth, screenHeight)
            }
            "fit" -> {
                val scale = min(
                    screenWidth.toFloat() / bitmap.width,
                    screenHeight.toFloat() / bitmap.height
                )
                val scaledWidth = (bitmap.width * scale).toInt()
                val scaledHeight = (bitmap.height * scale).toInt()
                android.graphics.Bitmap.createScaledBitmap(bitmap, scaledWidth, scaledHeight, true)
            }
            "stretch" -> {
                android.graphics.Bitmap.createScaledBitmap(bitmap, screenWidth, screenHeight, true)
            }
            "center" -> {
                if (bitmap.width <= screenWidth && bitmap.height <= screenHeight) {
                    bitmap
                } else {
                    val x = (bitmap.width - screenWidth) / 2
                    val y = (bitmap.height - screenHeight) / 2
                    android.graphics.Bitmap.createBitmap(bitmap, x, y, screenWidth, screenHeight)
                }
            }
            "tile" -> {
                createTiledBitmap(bitmap, screenWidth, screenHeight)
            }
            else -> bitmap
        }
    }
    
    private fun createTiledBitmap(
        source: android.graphics.Bitmap,
        width: Int,
        height: Int
    ): android.graphics.Bitmap {
        val tiled = android.graphics.Bitmap.createBitmap(width, height, source.config)
        val canvas = android.graphics.Canvas(tiled)
        val paint = android.graphics.Paint()
        
        for (x in 0 until width step source.width) {
            for (y in 0 until height step source.height) {
                canvas.drawBitmap(source, x.toFloat(), y.toFloat(), paint)
            }
        }
        
        return tiled
    }
}
```

---

## 五、兼容性分析

### 5.1 Android 版本支持

| Android 版本 | WallpaperService 支持 | 注意事项 |
|-------------|---------------------|---------|
| 5.0+ (API 21+) | ✅ 完全支持 | 基础功能 |
| 7.1+ (API 25+) | ✅ 完全支持 | 改进的偏移回调 |
| 8.0+ (API 26+) | ✅ 支持 | **需要前台服务** |
| 10+ (API 29+) | ✅ 支持 | Scoped Storage 限制 |
| 12+ (API 31+) | ✅ 支持 | 前台服务类型限制 |

### 5.2 厂商兼容性

| 厂商 | 支持情况 | 注意事项 |
|------|---------|---------|
| **原生 Android** | ✅ 完全支持 | 标准实现，兼容性最好 |
| **小米 (MIUI)** | ⚠️ 部分支持 | 部分版本可能限制第三方动态壁纸，需要「自启动」权限 |
| **华为 (EMUI/HarmonyOS)** | ⚠️ 部分支持 | 需要「后台运行」权限，HarmonyOS 3.0+ 有更严格限制 |
| **OPPO (ColorOS)** | ⚠️ 部分支持 | 需要「后台运行」和「自启动」权限 |
| **vivo (OriginOS)** | ⚠️ 部分支持 | 需要「后台高耗电」权限 |
| **三星 (One UI)** | ✅ 支持较好 | 相对标准，Samsung DeX 模式下可能有限制 |

### 5.3 权限要求

**必需权限：**
```xml
<uses-permission android:name="android.permission.SET_WALLPAPER" />
```

**Android 8.0+ 需要：**
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
```

**厂商特定权限（运行时请求）：**
- 小米：自启动管理
- 华为：后台运行、修改系统设置
- OPPO：后台运行、自启动
- vivo：后台高耗电

### 5.4 兼容性处理策略

```kotlin
fun checkCompatibility(): CompatibilityInfo {
    val manufacturer = Build.MANUFACTURER.lowercase()
    val sdkVersion = Build.VERSION.SDK_INT
    
    return CompatibilityInfo(
        supportsWallpaperService = sdkVersion >= Build.VERSION_CODES.LOLLIPOP,
        needsForegroundService = sdkVersion >= Build.VERSION_CODES.O,
        manufacturerSpecific = when {
            manufacturer.contains("xiaomi") -> {
                // MIUI 特定处理
                ManufacturerInfo(
                    needsAutoStart = true,
                    needsBackground = true
                )
            }
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> {
                ManufacturerInfo(
                    needsBackground = true,
                    needsWriteSettings = true
                )
            }
            manufacturer.contains("oppo") -> {
                ManufacturerInfo(
                    needsAutoStart = true,
                    needsBackground = true
                )
            }
            manufacturer.contains("vivo") -> {
                ManufacturerInfo(
                    needsBackground = true,
                    needsHighPower = true
                )
            }
            else -> ManufacturerInfo()
        }
    )
}
```

---

## 六、最佳实践建议

### 6.1 性能优化

1. **避免在 onDraw() 中创建对象**
   ```kotlin
   // ❌ 错误：每次绘制都创建新对象
   override fun onDraw(canvas: Canvas) {
       val paint = Paint() // 不要这样做
       canvas.drawBitmap(bitmap, 0f, 0f, paint)
   }
   
   // ✅ 正确：复用对象
   private val paint = Paint()
   override fun onDraw(canvas: Canvas) {
       canvas.drawBitmap(bitmap, 0f, 0f, paint)
   }
   ```

2. **使用对象池**
   ```kotlin
   private val bitmapPool = mutableListOf<Bitmap>()
   
   private fun getBitmap(): Bitmap {
       return bitmapPool.removeLastOrNull() ?: Bitmap.createBitmap(...)
   }
   
   private fun recycleBitmap(bitmap: Bitmap) {
       if (bitmapPool.size < 5) {
           bitmapPool.add(bitmap)
       } else {
           bitmap.recycle()
       }
   }
   ```

3. **控制重绘频率**
   ```kotlin
   private var lastDrawTime = 0L
   private val targetFPS = 30 // 30fps 足够流畅
   
   override fun onDraw(canvas: Canvas) {
       val now = System.currentTimeMillis()
       if (now - lastDrawTime < 1000 / targetFPS) {
           return // 跳过本次绘制
       }
       lastDrawTime = now
       // 绘制逻辑
   }
   ```

4. **大图采样加载**
   ```kotlin
   fun loadBitmap(filePath: String, maxWidth: Int, maxHeight: Int): Bitmap {
       val options = BitmapFactory.Options().apply {
           inJustDecodeBounds = true
       }
       BitmapFactory.decodeFile(filePath, options)
       
       options.inSampleSize = calculateInSampleSize(options, maxWidth, maxHeight)
       options.inJustDecodeBounds = false
       
       return BitmapFactory.decodeFile(filePath, options)
   }
   ```

### 6.2 错误处理

```kotlin
fun setWallpaper(filePath: String, style: String, transition: String, enableParallax: Boolean) {
    try {
        // 尝试使用 WallpaperService
        if (needsAdvancedFeatures && supportsWallpaperService()) {
            try {
                setWallpaperViaService(...)
                return
            } catch (e: SecurityException) {
                // 权限被拒绝，降级
                log.warn("WallpaperService 权限被拒绝，降级到 WallpaperManager")
            } catch (e: Exception) {
                // 其他错误，降级
                log.error("WallpaperService 失败", e)
            }
        }
        
        // 降级到 WallpaperManager
        setWallpaperViaManager(...)
    } catch (e: Exception) {
        // 最终失败，提示用户
        showError("设置壁纸失败: ${e.message}")
    }
}
```

### 6.3 用户体验优化

1. **提供预览功能**
   - 在设置前显示预览效果
   - 让用户选择填充模式和过渡效果

2. **权限引导**
   - 检测所需权限
   - 提供清晰的权限申请说明
   - 引导用户到系统设置页面

3. **降级提示**
   - 当功能不支持时，明确告知用户
   - 说明为什么某些功能不可用

4. **性能监控**
   - 监控壁纸服务的性能
   - 在低端设备上自动降低质量或禁用某些功能

### 6.4 测试建议

1. **版本测试**
   - Android 5.0, 8.0, 10.0, 12.0, 14.0

2. **厂商测试**
   - 小米、华为、OPPO、vivo、三星

3. **功能测试**
   - 所有填充模式
   - 所有过渡效果
   - 视差滚动
   - 轮播功能

4. **性能测试**
   - 内存占用
   - CPU 使用率
   - 电池消耗

---

## 七、壁纸轮播服务架构

### 7.1 问题分析

#### 7.1.1 Rust 端轮播的问题

在桌面端，壁纸轮播逻辑运行在 Rust 后端，使用 `tokio::spawn` 创建异步任务。但在 Android 平台上，这种方案存在严重问题：

1. **应用进程依赖**
   - 轮播任务运行在 Tauri 应用进程中
   - 应用进入后台时，系统可能暂停或终止进程
   - 轮播任务会随应用进程一起被暂停

2. **Android 后台限制**
   - **Android 8.0+**：对后台服务有严格限制
   - **Doze 模式**：设备休眠时暂停后台活动
   - **App Standby**：不活跃应用会被限制
   - **厂商定制**：MIUI、EMUI 等有更严格的限制

3. **实际影响**
   - 应用切换到后台后，轮播可能停止
   - 设备休眠时，轮播可能停止
   - 系统内存不足时，应用可能被杀死
   - 用户清理后台时，轮播会停止

#### 7.1.2 解决方案：转移到 WallpaperService

**为什么必须转移到 Service 端：**

1. **系统级服务**：WallpaperService 由系统管理，不会被杀死
2. **后台运行**：即使应用关闭，服务仍可运行
3. **生命周期独立**：不依赖应用进程
4. **性能更好**：直接在服务中处理，减少进程间通信

### 7.2 架构设计

#### 7.2.1 完整调用链

```
┌─────────────────────────────────────┐
│  前端 (Vue/TypeScript)               │
│  - 开启/关闭轮播                    │
│  - 设置轮播参数（间隔、模式、画册）  │
└──────────────┬──────────────────────┘
               │ invoke("set_wallpaper_rotation_enabled")
               ↓
┌─────────────────────────────────────┐
│  Rust 后端 (Tauri Command)          │
│  - 接收前端请求                      │
│  - 获取图片列表（从数据库）          │
│  - 调用 Android Plugin              │
│  - 保存配置到 SharedPreferences     │
└──────────────┬──────────────────────┘
               │ JNI (run_mobile_plugin_async)
               ↓
┌─────────────────────────────────────┐
│  Android Plugin (Kotlin)           │
│  - 启动/停止 WallpaperService      │
│  - 传递配置参数和图片列表           │
│  - 通过 SharedPreferences 桥接     │
└──────────────┬──────────────────────┘
               │ Intent / SharedPreferences
               ↓
┌─────────────────────────────────────┐
│  WallpaperService (Kotlin)          │
│  - 轮播逻辑（定时器）                │
│  - 读取图片列表                      │
│  - 切换壁纸                          │
│  - 处理过渡效果                      │
│  - 独立运行，不依赖应用进程          │
└─────────────────────────────────────┘
```

#### 7.2.2 数据流

1. **配置传递**：通过 `SharedPreferences` 在 Rust 后端和 Service 之间传递配置
2. **图片列表**：通过 `SharedPreferences` 或直接访问数据库传递图片路径列表
3. **状态同步**：Service 通过 `SharedPreferences` 更新状态，Rust 后端读取

### 7.3 Rust 后端实现

#### 7.3.1 Tauri 命令（桥接层）

```rust
// src-tauri/app-main/src/commands/wallpaper.rs

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn set_wallpaper_rotation_enabled_android(
    app: AppHandle,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    use tauri::plugin::PluginHandle;
    
    // 获取插件 handle（需要在 setup 时保存到 app state）
    // 这里简化处理，实际需要从 app state 获取
    let plugin_handle = app.state::<PluginHandle<tauri::Wry>>();
    
    if enabled {
        // 获取当前配置
        let settings = Settings::global();
        let interval = settings
            .get_wallpaper_rotation_interval_minutes()
            .await
            .map_err(|e| format!("获取轮播间隔失败: {}", e))?;
        let mode = settings
            .get_wallpaper_rotation_mode()
            .await
            .map_err(|e| format!("获取轮播模式失败: {}", e))?;
        let album_id = settings
            .get_wallpaper_rotation_album_id()
            .await
            .map_err(|e| format!("获取轮播画册失败: {}", e))?;
        
        // 获取图片列表
        let image_list = get_image_list_for_rotation(album_id.clone()).await
            .map_err(|e| format!("获取图片列表失败: {}", e))?;
        
        // 调用 Android Plugin 启动轮播
        let result: serde_json::Value = plugin_handle
            .run_mobile_plugin_async(
                "startRotation",
                serde_json::json!({
                    "intervalMinutes": interval,
                    "mode": mode,
                    "albumId": album_id,
                    "imageList": image_list,
                }),
            )
            .await
            .map_err(|e| format!("启动轮播失败: {}", e))?;
        
        Ok(result)
    } else {
        // 停止轮播
        let result: serde_json::Value = plugin_handle
            .run_mobile_plugin_async("stopRotation", serde_json::json!({}))
            .await
            .map_err(|e| format!("停止轮播失败: {}", e))?;
        
        Ok(result)
    }
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn update_wallpaper_rotation_config_android(
    app: AppHandle,
    interval_minutes: u32,
    mode: String,
    album_id: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::plugin::PluginHandle;
    
    let plugin_handle = app.state::<PluginHandle<tauri::Wry>>();
    
    // 获取图片列表
    let image_list = get_image_list_for_rotation(album_id.clone()).await
        .map_err(|e| format!("获取图片列表失败: {}", e))?;
    
    // 调用 Android Plugin 更新配置
    let result: serde_json::Value = plugin_handle
        .run_mobile_plugin_async(
            "updateRotationConfig",
            serde_json::json!({
                "intervalMinutes": interval_minutes,
                "mode": mode,
                "albumId": album_id,
                "imageList": image_list,
            }),
        )
        .await
        .map_err(|e| format!("更新配置失败: {}", e))?;
    
    Ok(result)
}

// 获取图片列表（从数据库）
async fn get_image_list_for_rotation(
    album_id: Option<String>,
) -> Result<Vec<String>, String> {
    let storage = Storage::global();
    
    let images = if let Some(id) = album_id {
        // 从画册获取
        storage
            .get_album_images(&id)
            .map_err(|e| format!("获取画册图片失败: {}", e))?
    } else {
        // 从画廊获取
        storage
            .get_all_images()
            .map_err(|e| format!("获取画廊图片失败: {}", e))?
    };
    
    // 提取本地路径
    Ok(images.into_iter().map(|img| img.local_path).collect())
}
```

#### 7.3.2 插件注册

```rust
// src-tauri/app-main/src/lib.rs

#[cfg(target_os = "android")]
fn init_wallpaper_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::plugin::{Builder, TauriPlugin};

    Builder::new("wallpaper")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.kabegame", "WallpaperPlugin")?;
            // 保存 handle 到 app state，供命令使用
            app.manage(handle);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
{
    builder = builder.plugin(init_wallpaper_plugin());
}
```

### 7.4 Android Plugin 实现（桥接层）

#### 7.4.1 Plugin 类

```kotlin
// src-tauri/app-main/gen/android/app/src/main/java/app/kabegame/WallpaperPlugin.kt

@TauriPlugin
class WallpaperPlugin(private val activity: Activity) : Plugin(activity) {
    
    @Command
    fun startRotation(invoke: Invoke) {
        val args = invoke.parseArgs(StartRotationArgs::class.java)
        
        try {
            // 保存配置到 SharedPreferences
            val prefs = activity.getSharedPreferences("wallpaper_config", Context.MODE_PRIVATE)
            prefs.edit().apply {
                putBoolean("rotation_enabled", true)
                putInt("rotation_interval_minutes", args.intervalMinutes ?: 1)
                putString("rotation_mode", args.mode ?: "random")
                putString("rotation_album_id", args.albumId)
                
                // 保存图片列表（JSON 格式）
                val imageList = args.imageList ?: emptyList()
                val jsonArray = JSONArray(imageList)
                putString("rotation_image_list", jsonArray.toString())
                
                apply()
            }
            
            // 启动 WallpaperService
            val intent = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
            intent.putExtra(
                WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT,
                ComponentName(activity, KabegameWallpaperService::class.java)
            )
            
            activity.startActivity(intent)
            
            invoke.resolve(JSObject().apply {
                put("success", true)
                put("message", "轮播已启动")
            })
        } catch (e: Exception) {
            invoke.reject("启动轮播失败: ${e.message}", e)
        }
    }
    
    @Command
    fun stopRotation(invoke: Invoke) {
        try {
            val prefs = activity.getSharedPreferences("wallpaper_config", Context.MODE_PRIVATE)
            prefs.edit().putBoolean("rotation_enabled", false).apply()
            
            // 通知 Service 停止轮播
            val intent = Intent(activity, KabegameWallpaperService::class.java)
            intent.action = "STOP_ROTATION"
            activity.startService(intent)
            
            invoke.resolve(JSObject().apply {
                put("success", true)
                put("message", "轮播已停止")
            })
        } catch (e: Exception) {
            invoke.reject("停止轮播失败: ${e.message}", e)
        }
    }
    
    @Command
    fun updateRotationConfig(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateRotationConfigArgs::class.java)
        
        try {
            // 更新配置
            val prefs = activity.getSharedPreferences("wallpaper_config", Context.MODE_PRIVATE)
            prefs.edit().apply {
                putInt("rotation_interval_minutes", args.intervalMinutes ?: 1)
                putString("rotation_mode", args.mode ?: "random")
                putString("rotation_album_id", args.albumId)
                
                // 更新图片列表
                val imageList = args.imageList ?: emptyList()
                val jsonArray = JSONArray(imageList)
                putString("rotation_image_list", jsonArray.toString())
                
                apply()
            }
            
            // 通知 Service 更新配置
            val intent = Intent(activity, KabegameWallpaperService::class.java)
            intent.action = "UPDATE_ROTATION_CONFIG"
            intent.putExtra("interval_minutes", args.intervalMinutes ?: 1)
            intent.putExtra("mode", args.mode ?: "random")
            intent.putExtra("album_id", args.albumId)
            activity.startService(intent)
            
            invoke.resolve(JSObject().apply {
                put("success", true)
                put("message", "配置已更新")
            })
        } catch (e: Exception) {
            invoke.reject("更新配置失败: ${e.message}", e)
        }
    }
}

// 参数类
@InvokeArg
class StartRotationArgs {
    var intervalMinutes: Int? = null
    var mode: String? = null
    var albumId: String? = null
    var imageList: List<String>? = null
}

@InvokeArg
class UpdateRotationConfigArgs {
    var intervalMinutes: Int? = null
    var mode: String? = null
    var albumId: String? = null
    var imageList: List<String>? = null
}
```

### 7.5 WallpaperService 轮播实现

**重要：轮播逻辑必须在 Service 端实现，不能依赖 Rust 后端。**

#### 7.5.1 Service 中的轮播逻辑

```kotlin
// src-tauri/app-main/gen/android/app/src/main/java/app/kabegame/KabegameWallpaperService.kt

class KabegameWallpaperService : WallpaperService() {
    inner class WallpaperEngine : Engine() {
        // 轮播相关变量
        private var rotationHandler: Handler? = null
        private var rotationRunnable: Runnable? = null
        private var rotationEnabled = false
        private var rotationIntervalMinutes = 1
        private var rotationMode = "random" // random or sequential
        private var rotationAlbumId: String? = null
        private var currentImageIndex = 0
        private var imageList: List<String> = emptyList()
        
        // 壁纸相关变量（从之前的实现）
        private var currentBitmap: Bitmap? = null
        private var style: String = "fill"
        private var transitionType: String = "none"
        private var enableParallax: Boolean = false
        
        override fun onCreate(surfaceHolder: SurfaceHolder) {
            super.onCreate(surfaceHolder)
            
            // 初始化 Handler
            rotationHandler = Handler(Looper.getMainLooper())
            
            // 加载配置
            loadRotationConfig()
            loadWallpaperConfig()
            
            // 如果轮播已启用，启动轮播
            if (rotationEnabled) {
                startRotation()
            }
        }
        
        override fun onDestroy() {
            stopRotation()
            rotationHandler = null
            super.onDestroy()
        }
        
        override fun onVisibilityChanged(visible: Boolean) {
            super.onVisibilityChanged(visible)
            if (visible) {
                // 可见时继续轮播
                if (rotationEnabled) {
                    startRotation()
                }
                drawFrame()
            } else {
                // 不可见时可以选择暂停轮播以节省资源
                // 或者继续轮播（推荐继续，保证轮播不中断）
                // stopRotation()
            }
        }
        
        // 处理 Intent（用于更新配置）
        override fun onCommand(action: String?, flags: Int, startId: Int): Int {
            when (action) {
                "STOP_ROTATION" -> {
                    stopRotation()
                }
                "UPDATE_ROTATION_CONFIG" -> {
                    loadRotationConfig()
                    if (rotationEnabled) {
                        stopRotation()
                        startRotation()
                    }
                }
            }
            return START_STICKY
        }
        
        // 加载轮播配置（从 SharedPreferences）
        private fun loadRotationConfig() {
            val prefs = getSharedPreferences("wallpaper_config", Context.MODE_PRIVATE)
            rotationEnabled = prefs.getBoolean("rotation_enabled", false)
            rotationIntervalMinutes = prefs.getInt("rotation_interval_minutes", 1)
            rotationMode = prefs.getString("rotation_mode", "random") ?: "random"
            rotationAlbumId = prefs.getString("rotation_album_id", null)
            
            // 加载图片列表
            val imageListJson = prefs.getString("rotation_image_list", null)
            if (imageListJson != null) {
                try {
                    val jsonArray = JSONArray(imageListJson)
                    imageList = (0 until jsonArray.length()).map { i ->
                        jsonArray.getString(i)
                    }
                } catch (e: Exception) {
                    imageList = emptyList()
                }
            } else {
                imageList = emptyList()
            }
        }
        
        // 加载壁纸配置
        private fun loadWallpaperConfig() {
            val prefs = getSharedPreferences("wallpaper_config", Context.MODE_PRIVATE)
            style = prefs.getString("wallpaper_style", "fill") ?: "fill"
            transitionType = prefs.getString("wallpaper_transition", "none") ?: "none"
            enableParallax = prefs.getBoolean("wallpaper_parallax", false)
        }
        
        // 启动轮播
        private fun startRotation() {
            if (!rotationEnabled || imageList.isEmpty()) {
                return
            }
            
            // 先停止现有的轮播
            stopRotation()
            
            rotationRunnable = object : Runnable {
                override fun run() {
                    // 检查是否仍然启用
                    val prefs = getSharedPreferences("wallpaper_config", Context.MODE_PRIVATE)
                    if (!prefs.getBoolean("rotation_enabled", false)) {
                        return
                    }
                    
                    // 选择下一张图片
                    val nextImagePath = getNextImage()
                    if (nextImagePath != null) {
                        val file = File(nextImagePath)
                        if (file.exists()) {
                            // 加载图片
                            val bitmap = BitmapFactory.decodeFile(nextImagePath)
                            if (bitmap != null) {
                                // 设置壁纸（使用之前实现的 setWallpaper 方法）
                                setWallpaper(bitmap, style, transitionType, enableParallax)
                            }
                        }
                    }
                    
                    // 重新加载配置（可能被外部更新）
                    loadRotationConfig()
                    
                    // 安排下一次轮播
                    rotationHandler?.postDelayed(
                        this,
                        rotationIntervalMinutes * 60 * 1000L
                    )
                }
            }
            
            // 立即执行一次（可选，也可以等待第一个间隔）
            rotationHandler?.post(rotationRunnable!!)
            
            // 安排定时轮播
            rotationHandler?.postDelayed(
                rotationRunnable!!,
                rotationIntervalMinutes * 60 * 1000L
            )
        }
        
        // 停止轮播
        private fun stopRotation() {
            rotationRunnable?.let {
                rotationHandler?.removeCallbacks(it)
            }
            rotationRunnable = null
        }
        
        // 获取下一张图片
        private fun getNextImage(): String? {
            if (imageList.isEmpty()) {
                return null
            }
            
            return when (rotationMode) {
                "sequential" -> {
                    val path = imageList[currentImageIndex]
                    currentImageIndex = (currentImageIndex + 1) % imageList.size
                    path
                }
                "random" -> {
                    imageList.random()
                }
                else -> {
                    imageList.firstOrNull()
                }
            }
        }
        
        // 设置壁纸（使用之前实现的逻辑）
        private fun setWallpaper(
            bitmap: Bitmap,
            style: String,
            transition: String,
            parallax: Boolean
        ) {
            // 这里调用之前实现的壁纸设置逻辑
            // 包括填充模式、过渡效果等
            currentBitmap = bitmap
            this.style = style
            this.transitionType = transition
            this.enableParallax = parallax
            
            // 触发重绘
            drawFrame()
        }
    }
}
```

#### 7.5.2 关键实现要点

1. **轮播逻辑完全在 Service 中**
   - 使用 `Handler` 和 `Runnable` 实现定时器
   - 不依赖 Rust 后端或应用进程
   - 即使应用关闭，轮播仍可继续

2. **配置读取**
   - 从 `SharedPreferences` 读取配置
   - 支持动态更新配置
   - 每次轮播前重新加载配置（支持外部更新）

3. **图片列表管理**
   - 图片列表通过 `SharedPreferences` 传递
   - Rust 后端负责从数据库获取并传递
   - Service 端只负责读取和使用

4. **生命周期管理**
   - `onCreate`: 初始化并启动轮播
   - `onDestroy`: 停止轮播并清理资源
   - `onVisibilityChanged`: 根据可见性决定是否继续轮播

### 7.6 数据桥接方案

#### 7.6.1 SharedPreferences 桥接

**优点：**
- 简单易用，无需额外 IPC
- 支持跨进程访问
- 自动持久化

**缺点：**
- 数据大小限制（不适合大量数据）
- 性能相对较低（适合配置数据）

**使用场景：**
- 轮播配置（间隔、模式、画册 ID）
- 壁纸样式配置
- 小量图片路径列表（< 1000 条）

#### 7.6.2 数据库直接访问（可选）

如果图片列表很大，可以考虑让 Service 直接访问数据库：

```kotlin
// Service 端直接访问 SQLite 数据库
private fun loadImagesFromDatabase(albumId: String?): List<String> {
    // 数据库路径需要从 SharedPreferences 获取
    val prefs = getSharedPreferences("wallpaper_config", Context.MODE_PRIVATE)
    val dbPath = prefs.getString("database_path", null) ?: return emptyList()
    
    // 使用 SQLite 读取图片列表
    // 注意：需要知道数据库结构
    // ...
}
```

**优点：**
- 支持大量数据
- 性能更好
- 支持复杂查询

**缺点：**
- 需要知道数据库结构
- 需要数据库路径
- 实现更复杂

### 7.7 实现步骤

1. **第一阶段：基础桥接**
   - 实现 Rust 后端命令
   - 实现 Android Plugin
   - 实现 SharedPreferences 桥接

2. **第二阶段：Service 轮播**
   - 在 WallpaperService 中实现轮播逻辑
   - 实现定时器和图片切换
   - 实现配置动态更新

3. **第三阶段：优化**
   - 优化内存使用
   - 优化电池消耗
   - 处理边界情况

4. **第四阶段：测试**
   - 测试后台运行
   - 测试应用关闭后的行为
   - 测试配置更新

### 7.8 注意事项

1. **Service 必须实现轮播逻辑**
   - 不能依赖 Rust 后端定时调用
   - 必须使用 Service 内的定时器
   - 确保独立运行

2. **配置同步**
   - 使用 SharedPreferences 作为单一数据源
   - Rust 后端写入，Service 读取
   - 支持双向同步（如需要）

3. **资源管理**
   - 及时释放 Bitmap 资源
   - 避免内存泄漏
   - 控制轮播频率

4. **错误处理**
   - 图片文件不存在时的处理
   - 配置读取失败时的处理
   - 网络错误时的处理（如果支持）

---

## 八、总结

使用 `WallpaperService` 可以**兼容性强地实现**所有壁纸功能：

✅ **填充效果**：完全支持，可在 `onDraw()` 中实现所有模式  
✅ **过渡模式**：完全支持，通过动画控制绘制实现  
✅ **视差滚动**：完全支持，通过 `onOffsetsChanged()` 实现  
✅ **壁纸轮播**：必须在 Service 端实现，确保后台运行

**关键要点：**

1. **双轨方案**：基础功能用 `WallpaperManager`，高级功能用 `WallpaperService`
2. **自动降级**：检测设备支持情况，不支持时自动降级
3. **性能优化**：避免在绘制循环中创建对象，控制重绘频率
4. **厂商适配**：针对常见厂商进行测试和权限处理
5. **用户体验**：提供预览、权限引导、降级提示等功能
6. **轮播架构**：**轮播逻辑必须在 WallpaperService 中实现**，不能依赖 Rust 后端，确保应用关闭后仍可运行

**推荐实现顺序：**

1. 第一阶段：实现 `WallpaperManager` 基础方案
2. 第二阶段：实现 `WallpaperService` 高级方案（包括轮播逻辑）
3. 第三阶段：实现 Rust 后端与 Service 的桥接（SharedPreferences）
4. 第四阶段：优化性能和兼容性
5. 第五阶段：添加用户体验优化

---

## 参考资料

- [Android WallpaperService 官方文档](https://developer.android.com/reference/android/service/wallpaper/WallpaperService)
- [Android WallpaperManager 官方文档](https://developer.android.com/reference/android/app/WallpaperManager)
- [Tauri Android 开发指南](https://tauri.app/v2/guides/mobile/android/)
