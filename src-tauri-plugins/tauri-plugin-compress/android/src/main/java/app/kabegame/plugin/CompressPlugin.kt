package app.kabegame.plugin

import android.app.Activity
import android.media.MediaMetadataRetriever
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class CompressPlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class CompressVideoForPreviewArgs {
        var inputPath: String = ""
        var outputPath: String = ""
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

        try {
            val inputFile = File(inputPath)
            if (!inputFile.exists() || !inputFile.isFile) {
                invoke.reject("输入视频不存在: $inputPath")
                return
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
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("安卓视频压缩失败: ${e.message}", e)
        }
    }
}
