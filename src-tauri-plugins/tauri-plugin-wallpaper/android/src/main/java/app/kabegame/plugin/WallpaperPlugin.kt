package app.kabegame.plugin

import android.app.Activity
import android.app.WallpaperManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import app.kabegame.util.BitmapStyleProcessor
import app.kabegame.worker.WallpaperRotationWorker
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.TimeUnit

@TauriPlugin
class WallpaperPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        private const val ROTATION_WORK_NAME = "kabegame_wallpaper_rotation"
    }

    @InvokeArg
    class SetWallpaperArgs {
        lateinit var filePath: String
        var style: String = "fill"
    }

    @InvokeArg
    class ScheduleRotationArgs {
        var intervalMinutes: Long = 15
    }

    // #region agent log
    private fun debugLog(hypothesisId: String, message: String, data: String) {
        try {
            val payload = """{"sessionId":"9675c0","hypothesisId":"$hypothesisId","location":"WallpaperPlugin.kt","message":"$message","data":$data,"timestamp":${System.currentTimeMillis()}}"""
            Log.i("DBG9675c0", payload)
        } catch (_: Throwable) {
        }
    }
    // #endregion

    @Command
    fun setWallpaper(invoke: Invoke) {
        val args = invoke.parseArgs(SetWallpaperArgs::class.java)
        val filePath = args.filePath
        val style = args.style.ifBlank { "fill" }
        try {
            val bitmap = if (filePath.startsWith("content://")) {
                activity.contentResolver.openInputStream(Uri.parse(filePath))?.use { inputStream ->
                    BitmapFactory.decodeStream(inputStream)
                } ?: throw Exception("无法读取 content URI 或解码图片")
            } else {
                val file = File(filePath)
                if (!file.exists()) {
                    invoke.reject("文件不存在: $filePath")
                    return
                }
                BitmapFactory.decodeFile(filePath)
                    ?: throw Exception("无法解码图片文件")
            }

            if (bitmap == null) {
                invoke.reject("无法解码图片文件")
                return
            }
            setWallpaperViaManager(bitmap, style, invoke)
        } catch (e: Exception) {
            invoke.reject("设置壁纸失败: ${e.message}", e)
        }
    }

    private fun setWallpaperViaManager(bitmap: Bitmap, style: String, invoke: Invoke) {
        try {
            val wallpaperManager = WallpaperManager.getInstance(activity)
            val displayMetrics = activity.resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val screenHeight = displayMetrics.heightPixels

            val processedBitmap = BitmapStyleProcessor.process(bitmap, style, screenWidth, screenHeight)
            wallpaperManager.setBitmap(processedBitmap)

            invoke.resolve(JSObject().apply {
                put("success", true)
                put("method", "manager")
                put("style", style)
            })
        } catch (e: Exception) {
            invoke.reject("WallpaperManager 设置失败: ${e.message}", e)
        }
    }

    @Command
    fun scheduleRotation(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleRotationArgs::class.java)
        val interval = args.intervalMinutes.coerceAtLeast(15L)

        try {
            val request = PeriodicWorkRequestBuilder<WallpaperRotationWorker>(
                interval,
                TimeUnit.MINUTES
            )
                .setInitialDelay(interval, TimeUnit.MINUTES)
                .build()

            WorkManager.getInstance(activity).enqueueUniquePeriodicWork(
                ROTATION_WORK_NAME,
                ExistingPeriodicWorkPolicy.REPLACE,
                request
            )

            invoke.resolve(JSObject().apply {
                put("success", true)
                put("intervalMinutes", interval)
            })
        } catch (e: Exception) {
            invoke.reject("调度壁纸轮播失败: ${e.message}", e)
        }
    }

    @Command
    fun cancelRotation(invoke: Invoke) {
        try {
            WorkManager.getInstance(activity).cancelUniqueWork(ROTATION_WORK_NAME)
            invoke.resolve(JSObject().apply {
                put("success", true)
            })
        } catch (e: Exception) {
            invoke.reject("取消壁纸轮播失败: ${e.message}", e)
        }
    }
}
