package app.kabegame.worker

import android.app.WallpaperManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters
import app.kabegame.util.BitmapStyleProcessor
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets

class WallpaperRotationWorker(
    private val appContext: android.content.Context,
    params: WorkerParameters
) : Worker(appContext, params) {

    private data class RotationPayload(val imagePath: String, val style: String)

    override fun doWork(): Result {
        return try {
            val payload = rotateWallpaper()
            if (payload == null) {
                return Result.success()
            }
            if (payload.imagePath.isBlank()) {
                return Result.success()
            }

            val bitmap = decodeBitmap(payload.imagePath)
            if (bitmap == null) {
                return Result.success()
            }

            val displayMetrics = appContext.resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val screenHeight = displayMetrics.heightPixels

            val processedBitmap = BitmapStyleProcessor.process(bitmap, payload.style, screenWidth, screenHeight)
            WallpaperManager.getInstance(appContext).setBitmap(processedBitmap)
            Result.success()
        } catch (e: Throwable) {
            Log.e("DBG9675c0", "Worker exception", e)
            Result.retry()
        }
    }

    /**
     * 消费 Rust 预取的轮播队列 `rotation_queue.json`：
     * `{ path, count, position, currentImageId?, items: [{ id, localPath, position }] }`。
     *
     * Worker 在冷进程里跑、没有 PathQL，选图规则全在 Rust（`wallpaper/rotator.rs` 的 android_queue）：
     * 这里只弹出首个文件仍在的 item，把推进后的位置与当前壁纸 id 写回队列文件，
     * 由 Rust 下次刷新队列时同步回 settings.json（Worker 不写 settings.json，避免与运行中的应用互相覆盖）。
     */
    private fun rotateWallpaper(): RotationPayload? {
        val dataDir = appContext.filesDir
        val settingsJson = readJsonObject(File(dataDir, "settings.json")) ?: JSONObject()

        val enabled = settingsJson.optBoolean("wallpaperRotationEnabled", false)
        if (!enabled) {
            return null
        }
        var style = settingsJson.optString("wallpaperStyle", "fill").ifBlank { "fill" }
        if (style == "system") {
            style = "fill"
        }

        val queueFile = File(dataDir, "rotation_queue.json")
        val queue = readJsonObject(queueFile) ?: return null
        // 队列属于旧路径（设置已改、Rust 尚未刷新）：不动作，等 Rust 重建
        val settingsPath = settingsJson.optString("wallpaperRotationPath", "")
        if (queue.optString("path", "") != settingsPath) {
            return null
        }

        val items = queue.optJSONArray("items") ?: return null
        var pickedIndex = -1
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            if (imagePathExists(item.optString("localPath", ""))) {
                pickedIndex = i
                break
            }
        }
        if (pickedIndex < 0) {
            return null
        }
        val picked = items.getJSONObject(pickedIndex)

        val rest = JSONArray()
        for (i in pickedIndex + 1 until items.length()) {
            rest.put(items.get(i))
        }
        queue.put("items", rest)
        queue.put("position", picked.optLong("position", 0) + 1)
        queue.put("currentImageId", picked.optString("id", ""))
        writeJsonAtomic(queueFile, queue)

        return RotationPayload(
            imagePath = picked.optString("localPath", ""),
            style = style
        )
    }

    private fun imagePathExists(path: String): Boolean {
        if (path.startsWith("content://")) {
            return true
        }
        return File(path).exists()
    }

    private fun readJsonObject(file: File): JSONObject? {
        if (!file.exists()) {
            return null
        }
        return try {
            JSONObject(file.readText(StandardCharsets.UTF_8))
        } catch (_: Throwable) {
            null
        }
    }

    private fun writeJsonAtomic(file: File, json: JSONObject) {
        val parent = file.parentFile
        if (parent != null && !parent.exists()) {
            parent.mkdirs()
        }
        val tmpFile = File(file.parentFile ?: appContext.filesDir, "${file.name}.tmp")
        tmpFile.writeText(json.toString(2), StandardCharsets.UTF_8)
        if (!tmpFile.renameTo(file)) {
            if (file.exists() && !file.delete()) {
                throw IOException("delete old file failed: ${file.absolutePath}")
            }
            if (!tmpFile.renameTo(file)) {
                throw IOException("rename tmp file failed: ${tmpFile.absolutePath}")
            }
        }
    }

    private fun decodeBitmap(path: String): Bitmap? {
        return if (path.startsWith("content://")) {
            appContext.contentResolver.openInputStream(Uri.parse(path))?.use { input ->
                BitmapFactory.decodeStream(input)
            }
        } else {
            BitmapFactory.decodeFile(path)
        }
    }
}
