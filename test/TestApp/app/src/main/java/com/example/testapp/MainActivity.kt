package com.example.testapp

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBox
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewScreenSizes
import androidx.compose.ui.unit.dp
import com.example.testapp.ui.theme.TestAppTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.zip.ZipInputStream

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            TestAppTheme {
                TestAppApp()
            }
        }
    }
}

@PreviewScreenSizes
@Composable
fun TestAppApp() {
    var currentDestination by rememberSaveable { mutableStateOf(AppDestinations.HOME) }

    NavigationSuiteScaffold(
        navigationSuiteItems = {
            AppDestinations.entries.forEach {
                item(
                    icon = {
                        Icon(
                            it.icon,
                            contentDescription = it.label
                        )
                    },
                    label = { Text(it.label) },
                    selected = it == currentDestination,
                    onClick = { currentDestination = it }
                )
            }
        }
    ) {
        Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
            when (currentDestination) {
                AppDestinations.HOME -> Greeting(name = "Android", modifier = Modifier.padding(innerPadding))
                AppDestinations.FAVORITES -> Greeting(name = "Favorites", modifier = Modifier.padding(innerPadding))
                AppDestinations.PROFILE -> Greeting(name = "Profile", modifier = Modifier.padding(innerPadding))
                AppDestinations.URI_TEST -> UriTestScreen(modifier = Modifier.padding(innerPadding))
            }
        }
    }
}

enum class AppDestinations(
    val label: String,
    val icon: ImageVector,
) {
    HOME("Home", Icons.Default.Home),
    FAVORITES("Favorites", Icons.Default.Favorite),
    PROFILE("Profile", Icons.Default.AccountBox),
    URI_TEST("URI 测试", Icons.Default.List),
}

@Composable
fun UriTestScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current

    var imageUri by rememberSaveable { mutableStateOf<Uri?>(null) }
    var folderUri by rememberSaveable { mutableStateOf<Uri?>(null) }
    var archiveUri by rememberSaveable { mutableStateOf<Uri?>(null) }
    var apiLog by rememberSaveable { mutableStateOf("") }
    var extractLoading by rememberSaveable { mutableStateOf(false) }
    var extractResult by rememberSaveable { mutableStateOf<String?>(null) }
    var extractError by rememberSaveable { mutableStateOf<String?>(null) }
    var copyLoading by rememberSaveable { mutableStateOf(false) }
    var copyResult by rememberSaveable { mutableStateOf<String?>(null) }
    var copyError by rememberSaveable { mutableStateOf<String?>(null) }

    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        imageUri = uri
        apiLog = ""
        uri?.let { apiLog = queryUriInfo(context, it, "图片") }
    }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        folderUri = uri
        apiLog = ""
        uri?.let { apiLog = queryUriInfo(context, it, "文件夹") }
    }
    val pickArchive = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        archiveUri = uri
        apiLog = ""
        extractResult = null
        extractError = null
        copyResult = null
        copyError = null
        uri?.let { apiLog = queryUriInfo(context, it, "压缩包") }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("选择并查看 URI / 操作 API", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { pickImage.launch("image/*") }, modifier = Modifier.weight(1f)) {
                Text("选择图片")
            }
            Button(onClick = { pickFolder.launch(null) }, modifier = Modifier.weight(1f)) {
                Text("选择文件夹")
            }
        }
        // 当最后选择的是图片时，显示用系统 app 打开按钮
        imageUri?.let { uri ->
            Button(
                onClick = {
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, context.contentResolver.getType(uri) ?: "image/*")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    val chooser = Intent.createChooser(intent, "选择图片查看器")
                    context.startActivity(chooser)
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("通过系统 app 打开图片")
            }
        }
        Button(onClick = { pickArchive.launch(arrayOf("application/zip", "application/x-zip-compressed", "*/*")) }, modifier = Modifier.fillMaxWidth()) {
            Text("选择压缩包")
        }

        // 解压：与主程序相同输出路径 cacheDir/archive_extract/<UUID>
        if (archiveUri != null) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        extractResult = null
                        extractError = null
                        extractLoading = true
                        extractScope.launch {
                            val uri = archiveUri!!
                            val result = extractZipToDirectory(context, uri)
                            extractLoading = false
                            result.fold(
                                onSuccess = { path ->
                                    extractResult = path
                                    extractError = null
                                },
                                onFailure = { e ->
                                    extractError = e.message ?: e.toString()
                                    extractResult = null
                                }
                            )
                        }
                    },
                    enabled = !extractLoading,
                    modifier = Modifier.weight(1f)
                ) {
                    Text(if (extractLoading) "解压中…" else "解压到 cacheDir/archive_extract")
                }
                if (extractLoading) {
                    CircularProgressIndicator(Modifier.height(24.dp))
                }
            }
        }

        if (extractResult != null) {
            val dir = File(extractResult!!)
            val children = dir.listFiles()?.toList().orEmpty()
            val preview = buildString {
                appendLine("解压目录: ${dir.absolutePath}")
                appendLine("顶层项数: ${children.size}")
                children.take(10).forEach { f ->
                    appendLine("  - ${f.name}${if (f.isDirectory) "/" else ""}")
                }
                if (children.size > 10) appendLine("  ...")
            }
            Text("解压结果", style = MaterialTheme.typography.titleSmall)
            Card(Modifier.fillMaxWidth()) {
                Text(preview, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(12.dp))
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        copyResult = null
                        copyError = null
                        copyLoading = true
                        extractScope.launch {
                            val path = extractResult!!
                            val result = walkAndCopyImages(context, path)
                            copyLoading = false
                            result.fold(
                                onSuccess = { copyResult = it; copyError = null },
                                onFailure = { e -> copyError = e.message ?: e.toString(); copyResult = null }
                            )
                        }
                    },
                    enabled = !copyLoading,
                    modifier = Modifier.weight(1f)
                ) {
                    Text(if (copyLoading) "遍历复制中…" else "遍历复制图片")
                }
                if (copyLoading) {
                    CircularProgressIndicator(Modifier.height(24.dp))
                }
            }
        }
        if (copyResult != null) {
            Card(Modifier.fillMaxWidth()) {
                Text(copyResult!!, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(12.dp))
            }
        }
        if (copyError != null) {
            Card(Modifier.fillMaxWidth()) {
                Text("复制失败: $copyError", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp))
            }
        }
        if (extractError != null) {
            Card(Modifier.fillMaxWidth()) {
                Text(
                    "解压失败: $extractError",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(12.dp)
                )
            }
        }

        // 当前 URI 展示
        listOf(
            "图片" to imageUri,
            "文件夹" to folderUri,
            "压缩包" to archiveUri
        ).forEach { (label, uri) ->
            if (uri != null) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text("$label URI:", style = MaterialTheme.typography.labelMedium)
                        Text(uri.toString(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    }
                }
            }
        }

        if (apiLog.isNotEmpty()) {
            Text("API 查询结果", style = MaterialTheme.typography.titleSmall)
            Card(Modifier.fillMaxWidth()) {
                Text(apiLog, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(12.dp))
            }
        }
    }
}

private fun queryUriInfo(context: Context, uri: Uri, label: String): String {
    val cr = context.contentResolver
    val sb = StringBuilder()
    sb.appendLine("--- $label ---")
    sb.appendLine("uri = $uri")
    val type = cr.getType(uri)
    sb.appendLine("contentResolver.getType(uri) = ${type ?: "(null)"}")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try {
            val pfd = cr.openFileDescriptor(uri, "r")
            pfd?.use { sb.appendLine("openFileDescriptor().statSize = ${it.statSize}") }
        } catch (e: Exception) {
            sb.appendLine("openFileDescriptor error: ${e.message}")
        }
    }
    if (DocumentsContract.isDocumentUri(context, uri)) {
        val docId = DocumentsContract.getDocumentId(uri)
        sb.appendLine("DocumentsContract.getDocumentId = $docId")
        if (DocumentsContract.isTreeUri(uri)) {
            sb.appendLine("(isTreeUri = true，可列出子节点)")
            try {
                val childUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri, docId)
                cr.query(childUri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
                    sb.appendLine("子项数量: ${c.count}")
                    var i = 0
                    while (c.moveToNext() && i < 5) {
                        sb.appendLine("  - ${c.getString(0)} (${c.getString(1)})")
                        i++
                    }
                    if (c.count > 5) sb.appendLine("  ... 仅显示前 5 项")
                }
            } catch (e: Exception) {
                sb.appendLine("list children error: ${e.message}")
            }
        }
    }
    return sb.toString()
}

/**
 * 与主程序一致的归档解压根目录：Android 上为 cacheDir/archive_extract
 *（主程序 AppPaths.temp_dir = cacheDir，extract_base = temp_dir.join("archive_extract")）。
 */
private fun getArchiveExtractBaseDir(context: Context): File {
    val base = File(context.cacheDir, "archive_extract")
    if (!base.exists()) base.mkdirs()
    return base
}

/**
 * 将 ZIP（content URI 或 file URI）解压到与主程序相同的输出结构：
 * cacheDir/archive_extract/<UUID>/，返回解压目录绝对路径或异常信息。
 */
private suspend fun extractZipToDirectory(context: Context, archiveUri: Uri): Result<String> =
    withContext(Dispatchers.IO) {
        try {
            val outputDir = getArchiveExtractBaseDir(context)
            if (!outputDir.isDirectory) {
                return@withContext Result.failure(IllegalStateException("outputDir 不是目录: ${outputDir.absolutePath}"))
            }
            val extractDirName = UUID.randomUUID().toString()
            val extractDir = File(outputDir, extractDirName)
            extractDir.mkdirs()

            val inputStream = when (archiveUri.scheme) {
                "content" -> context.contentResolver.openInputStream(archiveUri)
                    ?: throw IllegalStateException("无法打开 content URI: $archiveUri")
                "file" -> java.io.FileInputStream(archiveUri.path ?: throw IllegalStateException("无效的 file URI"))
                else -> throw IllegalStateException("不支持的 URI scheme: ${archiveUri.scheme}")
            }

            inputStream.use { stream ->
                ZipInputStream(stream).use { zipStream ->
                    var entry = zipStream.nextEntry
                    while (entry != null) {
                        if (!entry.isDirectory) {
                            val entryName = entry.name
                            if (entryName.contains("..") || entryName.startsWith("/")) {
                                zipStream.closeEntry()
                                entry = zipStream.nextEntry
                                continue
                            }
                            val outputFile = File(extractDir, entryName)
                            outputFile.parentFile?.mkdirs()
                            FileOutputStream(outputFile).use { zipStream.copyTo(it) }
                        } else {
                            File(extractDir, entry.name).mkdirs()
                        }
                        zipStream.closeEntry()
                        entry = zipStream.nextEntry
                    }
                }
            }
            Result.success(extractDir.absolutePath)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

private val extractScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

/** 与主程序 image_type 内置扩展名一致（小写，不含点号）。 */
private val IMAGE_EXTENSIONS = setOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "svg")

private fun isImageFile(file: File): Boolean {
    val ext = file.name.substringAfterLast('.', "").lowercase()
    return ext in IMAGE_EXTENSIONS
}

/** 递归遍历目录下所有文件。 */
private fun walkFiles(dir: File): Sequence<File> = sequence {
    dir.listFiles()?.forEach { f ->
        if (f.isDirectory) yieldAll(walkFiles(f)) else yield(f)
    }
}

/**
 * 遍历解压目录，将图片文件复制到目标目录（与主程序 images_dir 类似：externalFilesDir/images）。
 * 返回摘要或异常信息。
 */
private suspend fun walkAndCopyImages(context: Context, extractDirPath: String): Result<String> =
    withContext(Dispatchers.IO) {
        try {
            val sourceDir = File(extractDirPath)
            if (!sourceDir.isDirectory) {
                return@withContext Result.failure(IllegalStateException("不是目录: $extractDirPath"))
            }
            val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
            val destDir = File(picturesDir, "TestAPP")
            destDir.mkdirs()
            if (!destDir.isDirectory) {
                return@withContext Result.failure(IllegalStateException("无法创建目标目录: ${destDir.absolutePath}"))
            }
            val imageFiles = walkFiles(sourceDir).filter { isImageFile(it) }.toList()
            var copied = 0
            imageFiles.forEach { f ->
                val destFile = File(destDir, f.name)
                if (destFile.exists()) {
                    val base = f.name.substringBeforeLast('.')
                    val ext = f.name.substringAfterLast('.', "")
                    var n = 1
                    var candidate: File
                    while (true) {
                        candidate = File(destDir, "${base}_$n.$ext")
                        if (!candidate.exists()) break
                        n++
                    }
                    f.copyTo(candidate, overwrite = false)
                } else {
                    f.copyTo(destFile, overwrite = false)
                }
                copied++
            }
            Result.success("复制 $copied 个图片到 ${destDir.absolutePath}")
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

@Composable
fun Greeting(name: String, modifier: Modifier = Modifier) {
    Text(
        text = "Hello $name!",
        modifier = modifier
    )
}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {
    TestAppTheme {
        Greeting("Android")
    }
}