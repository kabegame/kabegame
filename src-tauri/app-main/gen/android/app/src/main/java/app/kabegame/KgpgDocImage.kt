package app.kabegame

import android.content.Context
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.zip.ZipInputStream

/**
 * 从 .kgpg 插件包中读取 doc_root 下资源的解析逻辑。
 * KGPG v2 格式：固定头部 + ZIP；头部不参与 ZIP 解析。
 * 用于安卓端插件文档图片的流式加载（不经过 Rust，不卡 UI）。
 */
object KgpgDocImage {

    /** KGPG v2 固定头部长度：meta 64 + icon 128*128*3 + manifest 4096 */
    const val KGPG2_HEADER_SIZE = 64 + 128 * 128 * 3 + 4096

    private const val DOC_ROOT_PREFIX = "doc_root/"

    /**
     * 从已安装插件的 .kgpg 中打开 doc_root 下指定路径的条目流。
     * @param context 用于取 filesDir/plugins-directory
     * @param pluginId 插件 id（对应 xxx.kgpg 文件名）
     * @param docPath doc_root 内相对路径（如 "screenshot.png" 或 "sub/img.png"），不得含 ".."
     * @return 成功时返回 [WebResourceResponse]（含 MIME 与输入流），失败返回 null
     */
    fun openDocRootImage(
        context: Context,
        pluginId: String,
        docPath: String
    ): WebResourceResponse? {
        if (docPath.contains("..")) {
            android.util.Log.w("Kabegame", "KgpgDocImage: path traversal rejected: $docPath")
            return null
        }
        val pluginsDir = File(context.filesDir, "plugins-directory")
        val kgpgFile = File(pluginsDir, "$pluginId.kgpg")
        if (!kgpgFile.isFile) {
            android.util.Log.w("Kabegame", "KgpgDocImage: plugin kgpg not found: ${kgpgFile.absolutePath}")
            return null
        }
        val inputStream = openEntryStream(kgpgFile, "$DOC_ROOT_PREFIX$docPath") ?: return null
        val mimeType = MimeTypeMap.getSingleton().getMimeTypeFromExtension(
            docPath.substringAfterLast('.', "").lowercase()
        ) ?: "application/octet-stream"
        return WebResourceResponse(mimeType, null, inputStream)
    }

    /**
     * 从 .kgpg 文件中打开 ZIP 内指定条目名的输入流。
     * 跳过 KGPG2 固定头部后按 ZIP 解析。
     * @param kgpgFile .kgpg 文件
     * @param entryName ZIP 内条目名（如 "doc_root/screenshot.png"）
     * @return 成功返回该条目的 [InputStream]（调用方负责关闭），失败返回 null
     */
    fun openEntryStream(kgpgFile: File, entryName: String): InputStream? {
        return try {
            val fis = FileInputStream(kgpgFile)
            var skipped = 0L
            while (skipped < KGPG2_HEADER_SIZE) {
                val n = fis.skip(KGPG2_HEADER_SIZE - skipped)
                if (n <= 0) break
                skipped += n
            }
            if (skipped < KGPG2_HEADER_SIZE) {
                fis.close()
                return null
            }
            val zis = ZipInputStream(fis)
            var entry = zis.nextEntry
            while (entry != null) {
                if (entry.name == entryName && !entry.isDirectory) {
                    return zis
                }
                entry = zis.nextEntry
            }
            zis.close()
            null
        } catch (e: Exception) {
            android.util.Log.e("Kabegame", "KgpgDocImage: openEntryStream failed: $kgpgFile / $entryName", e)
            null
        }
    }
}
