package app.kabegame.plugin

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * 系统「正在播放」的媒体会话。还没有实现：读别的应用的会话要用 MediaSessionManager.getActiveSessions，
 * 需要用户在系统设置里授予本应用「通知使用权」（NotificationListenerService）。
 */
@TauriPlugin
class SysmediaPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun available(invoke: Invoke) {
        val ret = JSObject()
        ret.put("available", false)
        invoke.resolve(ret)
    }
}
