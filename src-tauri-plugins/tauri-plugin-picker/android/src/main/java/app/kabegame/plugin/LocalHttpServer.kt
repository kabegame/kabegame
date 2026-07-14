package app.kabegame.plugin

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min

/*
 * ============================================================================
 * TODO(android-video-hevc): Android 上 HEVC 视频无法在 WebView 内联播放
 * ============================================================================
 *
 * 背景 / 现状（已查清，本服务部分已完成）：
 *  - 本地导入的视频（content://media/picker/...，存为 image.localPath）通过这个
 *    LocalHttpServer 经 http://127.0.0.1:<port>/file?path=<content uri> 提供给前端
 *    <video> 播放。range/seek 已验证完全正确（实 socket 走 Chromium 原生网络栈，
 *    honor Content-Range；非 faststart MP4 也能 seek 到末尾读 moov）。
 *  - 但用户实测的视频是 HEVC(H.265)：服务正确返回 206 + moov 后，<video> 解析出
 *    codec 即报 MediaError code=4 (SRC_NOT_SUPPORTED) / readyState=0，不再请求样本数据。
 *  - 根因：本应用的 WebView 是 Chrome 103 (Android 13)，不支持 HEVC <video> 播放。
 *    Chromium 的 HEVC 支持始于 M107，且需「设备有 HW HEVC 解码器」才启用。
 *  - 注意：Android WebView 是系统共享组件（经 Play 更新），**应用无法 bundle/pin/lock
 *    其版本**，所以「升级 WebView」不是可控/确定的解（且测试用模拟器无 HW HEVC 解码器，
 *    甚至连 H.264 编码器都没有：logcat "HW encoder for video/avc is not available"）。
 *
 * 为什么 Android 独有此问题：
 *  - 桌面已解决：compress.rs `generate_compatible_video`（browser_safe==false 时把视频
 *    转成 H.264 mp4，存 image.compatiblePath），前端 ImageContent.vue 的 videoSrc 优先
 *    用 compatibleUrl。
 *  - 但 Android 的 compress.rs `compress_video_for_preview` 只生成 GIF 预览，**不产出
 *    可播放的 H.264 副本**，所以 HEVC 视频在 Android 上没有可播放源。
 *
 * 计划修复（择一或组合，需真机验证；模拟器无 H.264 编码器无法验证）：
 *  1. Android 生成 H.264(+faststart) 互换副本：取 desktop 同思路，在取入流程对
 *     非 browser_safe 视频转码为 H.264 写入 compatibles_dir，落到 image.compatiblePath。
 *     前端已优先 compatibleUrl，故无需改前端取 URL 逻辑。Android 无 FFmpeg，转码走
 *     MediaCodec/MediaMuxer 或 androidx.media3 Transformer（后者实现量小、可靠）。
 *  2. 运行期能力检测分流（推荐叠加在 1 上，避免对支持设备做无谓转码）：
 *     前端用 videoEl.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') 判定当前 WebView
 *     是否能播 HEVC：能 → 直接内联播 content:// 原本（零转码）；不能 → 用 (1) 的 H.264
 *     副本，或退化到既有 PickerPlugin.openVideo（content:// 交系统播放器，HW 解 HEVC）。
 *
 * 关联代码：
 *  - src-tauri/kabegame-core/src/crawler/downloader/compress.rs
 *      :55  compress_video_for_preview (android, 仅 GIF)
 *      :572 generate_compatible_video (desktop, H.264 转码参照)
 *  - packages/core/src/components/image/ImageContent.vue  videoSrc 优先 compatibleUrl
 *  - PickerPlugin.openVideo（系统播放器兜底）
 * ============================================================================
 */
internal class LocalHttpServer(context: Context) {
    private val appContext = context.applicationContext
    private val contentResolver = appContext.contentResolver

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var baseUrl: String? = null

    @Synchronized
    fun start(): String {
        baseUrl?.let { return it }

        val socket = ServerSocket(0, 50, InetAddress.getByName(LOOPBACK_HOST))
        val url = "http://$LOOPBACK_HOST:${socket.localPort}"
        serverSocket = socket
        baseUrl = url

        thread(name = "KabegameLocalHttpServer", isDaemon = true) {
            acceptLoop(socket)
        }

        Log.i(TAG, "started at $url")
        return url
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            try {
                val client = socket.accept()
                thread(name = "KabegameLocalHttpRequest", isDaemon = true) {
                    try {
                        handleClient(client)
                    } catch (e: IOException) {
                        // 客户端(WebView <video>/<img>)中途断开(seek、切源、放弃缓冲)会让
                        // 后续 output.write 抛 ConnectionReset / Broken pipe——属正常，绝不能
                        // 让它逃出请求线程崩溃整个 app（本地媒体服务的必备容错）。
                        Log.d(TAG, "client connection ended: ${e.message}")
                    } catch (e: Throwable) {
                        // 任何其它异常同样兜底：单个请求出错不应拖垮进程。
                        Log.w(TAG, "handleClient failed", e)
                    }
                }
            } catch (e: IOException) {
                if (!socket.isClosed) {
                    Log.e(TAG, "accept failed", e)
                }
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            client.soTimeout = SOCKET_TIMEOUT_MS
            val input = BufferedInputStream(client.getInputStream())
            val output = client.getOutputStream()
            val requestLine = input.readHttpLine()
            if (requestLine.isBlank()) {
                sendText(output, 400, "Bad Request", "bad request")
                return
            }

            val parts = requestLine.split(" ")
            if (parts.size < 3) {
                sendText(output, 400, "Bad Request", "bad request")
                return
            }

            val method = parts[0].uppercase(Locale.US)
            val requestTarget = parts[1]
            val headers = readHeaders(input)
            if (method != "GET" && method != "HEAD") {
                sendText(output, 405, "Method Not Allowed", "method not allowed")
                return
            }

            val parsed = parseRequestTarget(requestTarget)
            val endpoint = parsed.path ?: ""
            if (endpoint != "/file" && endpoint != "/thumbnail" && endpoint != "/compatible") {
                sendText(output, 404, "Not Found", "not found", method == "HEAD")
                return
            }

            val path = parsed.getQueryParameter("path")?.trim().orEmpty()
            if (path.isBlank()) {
                sendText(output, 400, "Bad Request", "missing path", method == "HEAD")
                return
            }

            servePath(output, method == "HEAD", path, headers["range"])
        }
    }

    private fun servePath(
        output: OutputStream,
        headOnly: Boolean,
        path: String,
        rangeHeader: String?
    ) {
        val size = resolveSize(path)
        if (size == null) {
            sendText(output, 404, "Not Found", "file not found", headOnly)
            return
        }

        val mimeType = resolveMimeType(path)
        val range = rangeHeader?.let { parseRange(it, size) }
        if (rangeHeader != null && range == null) {
            sendHeaders(
                output,
                416,
                "Range Not Satisfiable",
                mapOf(
                    "Content-Range" to "bytes */$size",
                    "Accept-Ranges" to "bytes",
                    "Content-Length" to "0"
                )
            )
            return
        }

        if (range != null) {
            val length = range.end - range.start + 1
            val headers = linkedMapOf(
                "Content-Type" to mimeType,
                "Accept-Ranges" to "bytes",
                "Content-Range" to "bytes ${range.start}-${range.end}/$size",
                "Content-Length" to length.toString(),
                "Cache-Control" to IMMUTABLE_CACHE_CONTROL,
                "Connection" to "close"
            )
            sendHeaders(output, 206, "Partial Content", headers)
            if (!headOnly) {
                openInputAt(path, range.start).use { opened ->
                    copyTo(opened.input, output, length)
                }
            }
            return
        }

        val headers = linkedMapOf(
            "Content-Type" to mimeType,
            "Accept-Ranges" to "bytes",
            "Content-Length" to size.toString(),
            "Cache-Control" to IMMUTABLE_CACHE_CONTROL,
            "Connection" to "close"
        )
        sendHeaders(output, 200, "OK", headers)
        if (!headOnly) {
            openInputAt(path, 0L).use { opened ->
                copyTo(opened.input, output, size)
            }
        }
    }

    private fun resolveSize(path: String): Long? {
        val uri = Uri.parse(path)
        return when (uri.scheme) {
            "content" -> resolveContentSize(uri)
            "file" -> uri.path?.let { File(it).takeIf { f -> f.isFile }?.length() }
            else -> File(path).takeIf { it.isFile }?.length()
        }?.takeIf { it >= 0L }
    }

    private fun resolveContentSize(uri: Uri): Long? {
        var size = -1L
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (index >= 0 && !cursor.isNull(index)) {
                        size = cursor.getLong(index)
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "query content size failed: $uri", e)
        }
        if (size >= 0L) return size

        return try {
            contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                afd.length.takeIf { it >= 0L }
            }
        } catch (e: Exception) {
            Log.w(TAG, "asset content size failed: $uri", e)
            null
        }
    }

    private fun resolveMimeType(path: String): String {
        val uri = Uri.parse(path)
        if (uri.scheme == "content") {
            contentResolver.getType(uri)?.let { return it }
        }

        val ext = when (uri.scheme) {
            "file" -> uri.path
            "content" -> uri.path
            else -> path
        }?.substringAfterLast('.', "")?.lowercase(Locale.US).orEmpty()

        if (ext.isNotBlank()) {
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let { return it }
        }
        return "application/octet-stream"
    }

    private fun openInputAt(path: String, start: Long): OpenedInput {
        val uri = Uri.parse(path)
        return when (uri.scheme) {
            "content" -> openContentInputAt(uri, start)
            "file" -> openFileInputAt(File(uri.path ?: ""), start)
            else -> openFileInputAt(File(path), start)
        }
    }

    private fun openFileInputAt(file: File, start: Long): OpenedInput {
        val stream = FileInputStream(file)
        stream.channel.position(start)
        return OpenedInput(stream)
    }

    private fun openContentInputAt(uri: Uri, start: Long): OpenedInput {
        try {
            val afd = contentResolver.openAssetFileDescriptor(uri, "r")
            if (afd != null) {
                try {
                    val stream = FileInputStream(afd.fileDescriptor)
                    stream.channel.position(afd.startOffset + start)
                    return OpenedInput(stream, afd)
                } catch (e: Exception) {
                    runCatching { afd.close() }
                    Log.w(TAG, "seek via asset fd failed, fallback to stream: $uri", e)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "open asset fd failed, fallback to stream: $uri", e)
        }

        try {
            val pfd = contentResolver.openFileDescriptor(uri, "r")
            if (pfd != null) {
                try {
                    val stream = FileInputStream(pfd.fileDescriptor)
                    stream.channel.position(start)
                    return OpenedInput(stream, pfd)
                } catch (e: Exception) {
                    runCatching { pfd.close() }
                    Log.w(TAG, "seek via file fd failed, fallback to stream: $uri", e)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "open file fd failed, fallback to stream: $uri", e)
        }

        val stream = contentResolver.openInputStream(uri)
            ?: throw IOException("open content input failed: $uri")
        skipFully(stream, start)
        return OpenedInput(stream)
    }

    private fun parseRange(header: String, size: Long): ByteRange? {
        if (size <= 0L) return null
        val value = header.trim()
        if (!value.startsWith("bytes=", ignoreCase = true)) return null
        val spec = value.substringAfter('=').substringBefore(',').trim()
        val dash = spec.indexOf('-')
        if (dash < 0) return null

        val startPart = spec.substring(0, dash).trim()
        val endPart = spec.substring(dash + 1).trim()
        val start: Long
        val end: Long

        if (startPart.isEmpty()) {
            val suffixLength = endPart.toLongOrNull() ?: return null
            if (suffixLength <= 0L) return null
            start = max(0L, size - suffixLength)
            end = size - 1
        } else {
            start = startPart.toLongOrNull() ?: return null
            end = if (endPart.isEmpty()) {
                size - 1
            } else {
                min(endPart.toLongOrNull() ?: return null, size - 1)
            }
        }

        if (start < 0L || end < start || start >= size) return null
        return ByteRange(start, end)
    }

    private fun parseRequestTarget(target: String): Uri {
        return if (target.startsWith("http://") || target.startsWith("https://")) {
            Uri.parse(target)
        } else {
            Uri.parse("http://$LOOPBACK_HOST$target")
        }
    }

    private fun readHeaders(input: BufferedInputStream): Map<String, String> {
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = input.readHttpLine()
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx > 0) {
                val name = line.substring(0, idx).trim().lowercase(Locale.US)
                val value = line.substring(idx + 1).trim()
                headers[name] = value
            }
        }
        return headers
    }

    private fun sendText(
        output: OutputStream,
        statusCode: Int,
        reason: String,
        body: String,
        headOnly: Boolean = false
    ) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        sendHeaders(
            output,
            statusCode,
            reason,
            mapOf(
                "Content-Type" to "text/plain; charset=utf-8",
                "Content-Length" to bytes.size.toString(),
                "Connection" to "close"
            )
        )
        if (!headOnly) {
            output.write(bytes)
        }
    }

    private fun sendHeaders(
        output: OutputStream,
        statusCode: Int,
        reason: String,
        headers: Map<String, String>
    ) {
        output.writeAscii("HTTP/1.1 $statusCode $reason\r\n")
        for ((name, value) in headers) {
            output.writeAscii("$name: $value\r\n")
        }
        output.writeAscii("\r\n")
        output.flush()
    }

    private fun copyTo(input: InputStream, output: OutputStream, limit: Long?) {
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        if (limit == null) {
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                output.write(buffer, 0, read)
            }
            return
        }

        var remaining = limit
        while (remaining > 0L) {
            val read = input.read(buffer, 0, min(buffer.size.toLong(), remaining).toInt())
            if (read < 0) break
            output.write(buffer, 0, read)
            remaining -= read.toLong()
        }
    }

    private fun skipFully(input: InputStream, bytes: Long) {
        var remaining = bytes
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (remaining > 0L) {
            val skipped = input.skip(remaining)
            if (skipped > 0L) {
                remaining -= skipped
                continue
            }
            val read = input.read(buffer, 0, min(buffer.size.toLong(), remaining).toInt())
            if (read < 0) throw IOException("unexpected EOF while skipping")
            remaining -= read.toLong()
        }
    }

    private fun BufferedInputStream.readHttpLine(): String {
        val bytes = ArrayList<Byte>(128)
        while (true) {
            val b = read()
            if (b < 0) break
            if (b == '\n'.code) break
            if (b != '\r'.code) {
                bytes.add(b.toByte())
            }
            if (bytes.size > MAX_HEADER_LINE_BYTES) {
                throw IOException("header line too long")
            }
        }
        return bytes.toByteArray().toString(Charsets.ISO_8859_1)
    }

    private fun OutputStream.writeAscii(value: String) {
        write(value.toByteArray(Charsets.ISO_8859_1))
    }

    private data class ByteRange(val start: Long, val end: Long)

    private class OpenedInput(
        val input: InputStream,
        private val extraCloseable: Closeable? = null
    ) : Closeable {
        override fun close() {
            runCatching { input.close() }
            runCatching { extraCloseable?.close() }
        }
    }

    companion object {
        private const val TAG = "KbgLocalHttp"
        private const val LOOPBACK_HOST = "127.0.0.1"
        private const val SOCKET_TIMEOUT_MS = 15_000
        private const val MAX_HEADER_LINE_BYTES = 16 * 1024
        private const val IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
        private const val DEFAULT_BUFFER_SIZE = 64 * 1024
    }
}
