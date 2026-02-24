package app.kabegame.plugin

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class PathesPlugin(private val activity: Activity) : Plugin(activity) {

    /** 应用数据目录（与 Tauri app_data_dir 一致，用于 Kabegame 数据、设置等）。 */
    @Command
    fun getAppDataDir(invoke: Invoke) {
        try {
            val dir = activity.filesDir?.absolutePath
                ?: throw IllegalStateException("filesDir is null")
            val result = JSObject()
            result.put("dir", dir)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get app data dir: ${e.message}", e)
        }
    }

    @Command
    fun getCachePaths(invoke: Invoke) {
        val result = JSObject()
        try {
            val internalCache = activity.cacheDir?.absolutePath
            val externalCache = activity.externalCacheDir?.absolutePath

            result.put("internal", internalCache)
            result.put("external", externalCache)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get cache paths: ${e.message}", e)
        }
    }

    /** 外部存储数据目录（getExternalFilesDir，用于图片、缩略图等大文件）。 */
    @Command
    fun getExternalDataDir(invoke: Invoke) {
        try {
            val dir = activity.getExternalFilesDir(null)?.absolutePath
                ?: throw IllegalStateException("getExternalFilesDir is null")
            val result = JSObject()
            result.put("dir", dir)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get external data dir: ${e.message}", e)
        }
    }

    /** 归档解压输出目录：内部私有目录下的固定子目录，用于 ZIP/RAR 解压临时输出。 */
    @Command
    fun getArchiveExtractDir(invoke: Invoke) {
        try {
            val dir = java.io.File(activity.filesDir, "archive_extract")
            if (!dir.exists()) {
                dir.mkdirs()
            }
            val result = JSObject()
            result.put("dir", dir.absolutePath)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to get archive extract dir: ${e.message}", e)
        }
    }
}
