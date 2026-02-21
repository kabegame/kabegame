package app.kabegame.plugin

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class PathesPlugin(private val activity: Activity) : Plugin(activity) {
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
}
