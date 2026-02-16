package app.kabegame.plugin

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.math.max
import kotlin.math.min

import app.kabegame.service.KabegameWallpaperService

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

            if (needsAdvancedFeatures) {
                // 使用 WallpaperService (Live Wallpaper)
                setWallpaperViaService(filePath, style, transition, enableParallax, invoke)
            } else {
                // 使用 WallpaperManager (Static Wallpaper)
                setWallpaperViaManager(bitmap, style, invoke)
            }

        } catch (e: Exception) {
            invoke.reject("设置壁纸失败: ${e.message}", e)
        }
    }

    // 保存配置到preference，发送广播提醒服务更新
    private fun setWallpaperViaService(
        filePath: String,
        style: String,
        transition: String,
        enableParallax: Boolean,
        invoke: Invoke
    ) {
        try {
            // 1. 保存配置到 SharedPreferences
            val prefs = activity.getSharedPreferences("kabegame_wallpaper", Context.MODE_PRIVATE)
            with(prefs.edit()) {
                putString("image_path", filePath)
                putString("style", style)
                putString("transition", transition)
                putBoolean("parallax", enableParallax)
                apply()
            }

            // 2. 检查当前是否已经是我们的壁纸服务
            val wallpaperManager = WallpaperManager.getInstance(activity)
            val info = wallpaperManager.wallpaperInfo
            val isMyServiceActive = info != null && info.packageName == activity.packageName && 
                                    info.serviceName == KabegameWallpaperService::class.java.name

            if (isMyServiceActive) {
                // 3a. 如果已经是，发送广播通知更新
                val intent = Intent("app.kabegame.WALLPAPER_UPDATE")
                intent.setPackage(activity.packageName)
                activity.sendBroadcast(intent)
                
                invoke.resolve(JSObject().apply {
                    put("success", true)
                    put("method", "service_update")
                    put("style", style)
                })
            } else {
                // 3b. 如果不是，启动壁纸选择器
                val intent = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
                intent.putExtra(
                    WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT,
                    ComponentName(activity, KabegameWallpaperService::class.java)
                )
                // 尝试直接启动预览
                try {
                    activity.startActivity(intent)
                    invoke.resolve(JSObject().apply {
                        put("success", true)
                        put("method", "service_intent")
                        put("message", "Opened wallpaper chooser")
                    })
                } catch (e: Exception) {
                    // 部分设备可能不支持 ACTION_CHANGE_LIVE_WALLPAPER，尝试通用设置
                    try {
                        val simpleIntent = Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER)
                        activity.startActivity(simpleIntent)
                        invoke.resolve(JSObject().apply {
                            put("success", true)
                            put("method", "service_chooser")
                            put("message", "Opened generic wallpaper chooser")
                        })
                    } catch (e2: Exception) {
                        invoke.reject("无法启动壁纸设置界面: ${e2.message}")
                    }
                }
            }
        } catch (e: Exception) {
            invoke.reject("Service 设置失败: ${e.message}", e)
        }
    }

    private fun setWallpaperViaManager(
        bitmap: Bitmap,
        style: String,
        invoke: Invoke
    ) {
        try {
            val wallpaperManager = WallpaperManager.getInstance(activity)
            val displayMetrics = activity.resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val screenHeight = displayMetrics.heightPixels

            // Preprocess bitmap for style
            val processedBitmap = processBitmapForStyle(bitmap, style, screenWidth, screenHeight)

            wallpaperManager.setBitmap(processedBitmap)

            invoke.resolve(JSObject().apply {
                put("success", true)
                put("method", "manager")
                put("style", style)
                put("transition", "none")
                put("parallax", false)
            })
        } catch (e: Exception) {
            invoke.reject("WallpaperManager 设置失败: ${e.message}", e)
        }
    }

    private fun processBitmapForStyle(
        bitmap: Bitmap,
        style: String,
        screenWidth: Int,
        screenHeight: Int
    ): Bitmap {
        // Create a mutable bitmap for the screen size
        val resultBitmap = Bitmap.createBitmap(screenWidth, screenHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(resultBitmap)
        canvas.drawColor(Color.BLACK)

        val paint = Paint()
        paint.isFilterBitmap = true

        when (style) {
            "fill" -> drawFill(canvas, bitmap, screenWidth, screenHeight, paint)
            "fit" -> drawFit(canvas, bitmap, screenWidth, screenHeight, paint)
            "stretch" -> drawStretch(canvas, bitmap, screenWidth, screenHeight, paint)
            "center" -> drawCenter(canvas, bitmap, screenWidth, screenHeight, paint)
            "tile" -> drawTile(canvas, bitmap, screenWidth, screenHeight, paint)
            else -> drawFill(canvas, bitmap, screenWidth, screenHeight, paint)
        }

        return resultBitmap
    }

    private fun drawFill(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val scale = max(
            screenWidth.toFloat() / bitmap.width,
            screenHeight.toFloat() / bitmap.height
        )
        val scaledWidth = (bitmap.width * scale).toInt()
        val scaledHeight = (bitmap.height * scale).toInt()
        
        val dx = (screenWidth - scaledWidth) / 2
        val dy = (screenHeight - scaledHeight) / 2
        
        val destRect = Rect(dx, dy, dx + scaledWidth, dy + scaledHeight)
        canvas.drawBitmap(bitmap, null, destRect, paint)
    }

    private fun drawFit(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val scale = min(
            screenWidth.toFloat() / bitmap.width,
            screenHeight.toFloat() / bitmap.height
        )
        val scaledWidth = (bitmap.width * scale).toInt()
        val scaledHeight = (bitmap.height * scale).toInt()
        
        val dx = (screenWidth - scaledWidth) / 2
        val dy = (screenHeight - scaledHeight) / 2
        
        val destRect = Rect(dx, dy, dx + scaledWidth, dy + scaledHeight)
        canvas.drawBitmap(bitmap, null, destRect, paint)
    }

    private fun drawStretch(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val destRect = Rect(0, 0, screenWidth, screenHeight)
        canvas.drawBitmap(bitmap, null, destRect, paint)
    }

    private fun drawCenter(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val dx = (screenWidth - bitmap.width) / 2
        val dy = (screenHeight - bitmap.height) / 2
        canvas.drawBitmap(bitmap, dx.toFloat(), dy.toFloat(), paint)
    }

    private fun drawTile(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        for (x in 0 until screenWidth step bitmap.width) {
            for (y in 0 until screenHeight step bitmap.height) {
                canvas.drawBitmap(bitmap, x.toFloat(), y.toFloat(), paint)
            }
        }
    }
}
