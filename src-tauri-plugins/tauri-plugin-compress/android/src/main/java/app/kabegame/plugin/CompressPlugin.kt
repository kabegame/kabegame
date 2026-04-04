package app.kabegame.plugin

import android.app.Activity
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.Locale

@TauriPlugin
class CompressPlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class CompressVideoForPreviewArgs {
        var inputPath: String = ""
        var outputPath: String = ""
    }

    @InvokeArg
    class ExtractVideoFramesArgs {
        var inputPath: String = ""
        var outputDir: String = ""
    }

    @Command
    fun compressVideoForPreview(invoke: Invoke) {
        val args = invoke.parseArgs(CompressVideoForPreviewArgs::class.java)
        val inputPath = args.inputPath
        val outputPath = args.outputPath

        if (inputPath.isBlank() || outputPath.isBlank()) {
            invoke.reject("inputPath/outputPath 不能为空")
            return
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val inputFile = File(inputPath)
                if (!inputFile.exists() || !inputFile.isFile) {
                    withContext(Dispatchers.Main) { invoke.reject("输入视频不存在: $inputPath") }
                    return@launch
                }

                val outputFile = File(outputPath)
                outputFile.parentFile?.mkdirs()

                // 当前实现先兜底复制，后续可替换为 Media3/MediaCodec 真正转码。
                inputFile.copyTo(outputFile, overwrite = true)

                var width: Int? = null
                var height: Int? = null
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(outputFile.absolutePath)
                    width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                        ?.toIntOrNull()
                    height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                        ?.toIntOrNull()
                } finally {
                    try {
                        retriever.release()
                    } catch (_: Exception) {
                    }
                }

                val result = JSObject()
                result.put("outputPath", outputFile.absolutePath)
                if (width != null) result.put("width", width)
                if (height != null) result.put("height", height)
                withContext(Dispatchers.Main) { invoke.resolve(result) }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { invoke.reject("安卓视频压缩失败: ${e.message}", e) }
            }
        }
    }

    /**
     * 从视频按 4fps 提取帧并写入 outputDir，命名为 frame_000.png, frame_001.png, ...
     * GIF 编码在 Rust 端完成。
     */
    @Command
    fun extractVideoFrames(invoke: Invoke) {
        val args = invoke.parseArgs(ExtractVideoFramesArgs::class.java)
        val inputPath = args.inputPath
        val outputDir = args.outputDir

        if (inputPath.isBlank() || outputDir.isBlank()) {
            invoke.reject("inputPath/outputDir 不能为空")
            return
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val inputFile = File(inputPath)
                if (!inputFile.exists() || !inputFile.isFile) {
                    withContext(Dispatchers.Main) { invoke.reject("输入视频不存在: $inputPath") }
                    return@launch
                }

                val outDir = File(outputDir)
                outDir.mkdirs()

                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(inputFile.absolutePath)
                    val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                    var durationUs = durationMs * 1000
                    if (durationUs <= 0L) durationUs = 2_500_000L

                    // 4fps = 250ms 一帧，与 ffmpeg 一致：预览最多 2.5s，最多 10 帧
                    val targetDurationUs = minOf(durationUs, 2_500_000L)
                    val frameIntervalUs = 250_000L // 250ms = 4fps
                    val numFrames = (targetDurationUs / frameIntervalUs).toInt().coerceIn(1, 10)

                    val frameOption = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                        MediaMetadataRetriever.OPTION_CLOSEST
                    } else {
                        MediaMetadataRetriever.OPTION_CLOSEST_SYNC
                    }

                    val targetWidth = 300
                    var count = 0
                    for (i in 0 until numFrames) {
                        val timeUs = (i * frameIntervalUs).coerceAtMost((durationUs - 1).coerceAtLeast(0L))
                        val frame = retriever.getFrameAtTime(timeUs, frameOption) ?: continue
                        val scaled = scaleBitmapToWidth(frame, targetWidth)
                        if (scaled !== frame) frame.recycle()
                        val pngFile = File(outDir, "frame_%03d.png".format(Locale.US, i))
                        FileOutputStream(pngFile).use { fos ->
                            scaled.compress(Bitmap.CompressFormat.PNG, 90, fos)
                        }
                        scaled.recycle()
                        count++
                    }

                    val result = JSObject()
                    result.put("frameDir", outDir.absolutePath)
                    result.put("count", count)
                    withContext(Dispatchers.Main) { invoke.resolve(result) }
                } finally {
                    try {
                        retriever.release()
                    } catch (_: Exception) {
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { invoke.reject("视频帧提取失败: ${e.message}", e) }
            }
        }
    }

    private fun scaleBitmapToWidth(source: Bitmap, targetWidth: Int): Bitmap {
        val w = source.width
        val h = source.height
        if (w <= targetWidth) return source
        val targetHeight = (h * targetWidth / w).coerceAtLeast(1)
        return Bitmap.createScaledBitmap(source, targetWidth, targetHeight, true)
    }
}
