package app.kabegame.plugin.picker

import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult

/**
 * Activity 在 onCreate 之前注册的 launcher 提供给 PickerPlugin 使用，
 * 避免插件在 Activity 已 RESUMED 后才被创建时调用 registerForActivityResult 导致崩溃。
 */
interface PickerLauncherHost {
    fun launchFolderPicker(intent: Intent, onResult: (ActivityResult) -> Unit)
    fun launchPickImages(onResult: (List<Uri>) -> Unit)
    fun launchPickKgpgFile(intent: Intent, onResult: (ActivityResult) -> Unit)
}
