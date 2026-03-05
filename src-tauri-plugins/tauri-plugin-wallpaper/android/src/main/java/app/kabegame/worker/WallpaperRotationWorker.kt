package app.kabegame.worker

import android.app.WallpaperManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters
import app.kabegame.util.BitmapStyleProcessor
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets

class WallpaperRotationWorker(
    private val appContext: android.content.Context,
    params: WorkerParameters
) : Worker(appContext, params) {

    private data class ImageRow(val id: String, val localPath: String)
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

    private fun rotateWallpaper(): RotationPayload? {
        val dataDir = appContext.filesDir
        val settingsFile = File(dataDir, "settings.json")
        val settingsJson = readJsonObject(settingsFile) ?: JSONObject()

        val enabled = settingsJson.optBoolean("wallpaperRotationEnabled", false)
        if (!enabled) {
            return null
        }

        val albumId = settingsJson.optString("wallpaperRotationAlbumId", "")
            .trim()
            .ifEmpty { null }
        val rotationMode = settingsJson.optString("wallpaperRotationMode", "random")
        val currentImageId = settingsJson.optString("currentWallpaperImageId", "")
            .trim()
            .ifEmpty { null }
        var style = settingsJson.optString("wallpaperStyle", "fill").ifBlank { "fill" }
        if (style == "system") {
            style = "fill"
        }

        val images = queryImages(albumId)
        if (images.isEmpty()) {
            return null
        }

        val rotationStateFile = File(dataDir, "rotation_state.json")
        val rotationStateJson = readJsonObject(rotationStateFile)
        val selectedIndex = if (rotationMode == "sequential") {
            val startIndex = if (rotationStateJson != null) {
                rotationStateJson.optInt("currentIndex", 0)
            } else if (currentImageId != null) {
                val pos = images.indexOfFirst { it.id == currentImageId }
                if (pos >= 0) (pos + 1) % images.size else 0
            } else {
                0
            }
            pickSequentialIndex(images, startIndex) ?: return null
        } else {
            pickRandomIndex(images, currentImageId) ?: return null
        }

        val selected = images[selectedIndex]
        val nextIndex = (selectedIndex + 1) % images.size

        settingsJson.put("currentWallpaperImageId", selected.id)
        writeJsonAtomic(settingsFile, settingsJson)
        writeJsonAtomic(rotationStateFile, JSONObject().put("currentIndex", nextIndex))

        return RotationPayload(
            imagePath = selected.localPath,
            style = style
        )
    }

    private fun queryImages(albumId: String?): List<ImageRow> {
        val dbFile = File(appContext.filesDir, "databases/images.db")
        if (!dbFile.exists()) {
            return emptyList()
        }

        val result = mutableListOf<ImageRow>()
        val db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
        db.use {
            if (albumId != null) {
                val cursor = db.rawQuery(
                    """
                    SELECT CAST(i.id AS TEXT) as id, i.local_path
                    FROM images i
                    INNER JOIN album_images ai ON i.id = ai.image_id
                    WHERE ai.album_id = ?
                    ORDER BY COALESCE(ai."order", ai.rowid) ASC
                    """.trimIndent(),
                    arrayOf(albumId)
                )
                cursor.use {
                    val idIdx = cursor.getColumnIndexOrThrow("id")
                    val pathIdx = cursor.getColumnIndexOrThrow("local_path")
                    while (cursor.moveToNext()) {
                        result.add(
                            ImageRow(
                                id = cursor.getString(idIdx),
                                localPath = cursor.getString(pathIdx)
                            )
                        )
                    }
                }
            } else {
                val cursor = db.rawQuery(
                    "SELECT CAST(id AS TEXT) as id, local_path FROM images ORDER BY crawled_at ASC",
                    null
                )
                cursor.use {
                    val idIdx = cursor.getColumnIndexOrThrow("id")
                    val pathIdx = cursor.getColumnIndexOrThrow("local_path")
                    while (cursor.moveToNext()) {
                        result.add(
                            ImageRow(
                                id = cursor.getString(idIdx),
                                localPath = cursor.getString(pathIdx)
                            )
                        )
                    }
                }
            }
        }
        return result
    }

    private fun pickRandomIndex(images: List<ImageRow>, currentId: String?): Int? {
        val candidates = mutableListOf<Int>()
        for (idx in images.indices) {
            val image = images[idx]
            if (!imagePathExists(image.localPath)) {
                continue
            }
            if (currentId != null && images.size > 1 && image.id == currentId) {
                continue
            }
            candidates.add(idx)
        }

        if (candidates.isEmpty()) {
            for (idx in images.indices) {
                if (imagePathExists(images[idx].localPath)) {
                    candidates.add(idx)
                }
            }
        }
        if (candidates.isEmpty()) {
            return null
        }
        val seed = (System.nanoTime().ushr(1) % candidates.size.toLong()).toInt()
        return candidates[seed]
    }

    private fun pickSequentialIndex(images: List<ImageRow>, startIndex: Int): Int? {
        if (images.isEmpty()) {
            return null
        }
        val normalizedStart = ((startIndex % images.size) + images.size) % images.size
        for (offset in images.indices) {
            val idx = (normalizedStart + offset) % images.size
            if (imagePathExists(images[idx].localPath)) {
                return idx
            }
        }
        return null
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
