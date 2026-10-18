package app.kabegame.plugin

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class SeedBundledPluginsArgs {
    lateinit var targetDir: String
}

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

    /**
     * 把 APK `assets/resources/plugins/` 下预置的 `.kgpg` 复制进用户插件目录 `targetDir`。
     *
     * 版本门控：复制成功后在 `targetDir` 写入 [BUNDLED_VERSION_FILE]，内容为当前安装包版本
     * （versionName + versionCode + lastUpdateTime，覆盖安装同版本的 dev 包也会变化）。
     * 下次启动标记一致则直接跳过；不一致（首次启动 / 应用更新）才重新复制，同名插件以预置版本覆盖。
     * 任一文件复制失败则不写标记，下次启动重试。
     * assets 读取与大文件写入放在后台线程，避免阻塞主线程。
     */
    @Command
    fun seedBundledPlugins(invoke: Invoke) {
        val args = invoke.parseArgs(SeedBundledPluginsArgs::class.java)
        Thread {
            try {
                invoke.resolve(seedBundledPluginsBlocking(File(args.targetDir)))
            } catch (e: Exception) {
                invoke.reject("Failed to seed bundled plugins: ${e.message}", e)
            }
        }.start()
    }

    private fun seedBundledPluginsBlocking(targetDir: File): JSObject {
        val version = currentPackageVersion()
        val marker = File(targetDir, BUNDLED_VERSION_FILE)
        val result = JSObject()
        result.put("version", version)
        if (marker.isFile && marker.readText().trim() == version) {
            result.put("skipped", true)
            result.put("copied", 0)
            return result
        }

        if (!targetDir.isDirectory && !targetDir.mkdirs()) {
            throw IllegalStateException("创建插件目录失败: ${targetDir.absolutePath}")
        }
        val assets = activity.assets
        val names = assets.list(BUNDLED_PLUGINS_ASSET_DIR).orEmpty()
            .filter { it.endsWith(".kgpg") }
        var copied = 0
        var failed = 0
        for (name in names) {
            // 先写临时文件再 rename，避免中途中断留下半个 .kgpg 被插件扫描读到
            val tmp = File(targetDir, "$name.tmp")
            try {
                assets.open("$BUNDLED_PLUGINS_ASSET_DIR/$name").use { input ->
                    tmp.outputStream().use { output -> input.copyTo(output) }
                }
                val dst = File(targetDir, name)
                if (!tmp.renameTo(dst)) {
                    dst.delete()
                    if (!tmp.renameTo(dst)) throw IllegalStateException("rename 失败: $dst")
                }
                copied++
            } catch (e: Exception) {
                failed++
                tmp.delete()
                android.util.Log.w(TAG, "复制预置插件失败 $name: ${e.message}")
            }
        }
        if (failed == 0) {
            marker.writeText(version)
        }
        result.put("skipped", false)
        result.put("copied", copied)
        result.put("failed", failed)
        return result
    }

    private fun currentPackageVersion(): String {
        val pm = activity.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(activity.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(activity.packageName, 0)
        }
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
        return "${info.versionName}+$versionCode+${info.lastUpdateTime}"
    }

    companion object {
        private const val TAG = "PathesPlugin"
        /** tauri-cli 把 bundle.resources 注入到 APK assets 时保留 `resources/` 前缀。 */
        private const val BUNDLED_PLUGINS_ASSET_DIR = "resources/plugins"
        /** 写在用户插件目录里的「最后一次复制的安装包版本」标记。 */
        private const val BUNDLED_VERSION_FILE = ".bundled-plugins-version"
    }
}
