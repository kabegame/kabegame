package app.kabegame.plugin

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@TauriPlugin
class TaskNotificationPlugin(private val activity: Activity) : Plugin(activity) {

    private var pendingPermissionBlock: (() -> Unit)? = null

    /** downloadId → 子通知 ID（稳定映射，便于 upsert / 取消）。 */
    private val downloadNotifIds = HashMap<Long, Int>()
    private var childIdSeq = CHILD_NOTIFICATION_ID_BASE

    private val permissionLauncher: ActivityResultLauncher<String>? by lazy {
        if (activity is androidx.activity.ComponentActivity) {
            (activity as androidx.activity.ComponentActivity).registerForActivityResult(
                ActivityResultContracts.RequestPermission()
            ) { granted ->
                if (granted) {
                    pendingPermissionBlock?.invoke()
                }
                pendingPermissionBlock = null
            }
        } else null
    }

    @InvokeArg
    class DownloadItem {
        var id: Long = 0
        var title: String = ""
        var indeterminate: Boolean = false
        var progress: Int = 0
    }

    @InvokeArg
    class UpdateNotificationsArgs {
        var runningCount: Int = 0
        var items: List<DownloadItem> = emptyList()
    }

    /**
     * 全量协调下载/任务通知:
     * - `runningCount == 0 && items` 空 → 停前台服务 + 取消全部子通知 + 显示可划掉「全部完成」。
     * - 否则 → 启动/刷新前台汇总服务(分组汇总),按 items upsert 子通知并取消已消失的子通知。
     */
    @Command
    fun updateNotifications(invoke: Invoke) {
        ensureNotificationPermission {
            val args = invoke.parseArgs(UpdateNotificationsArgs::class.java)
            val running = args.runningCount.coerceAtLeast(0)
            val items = args.items

            if (running == 0 && items.isEmpty()) {
                stopServiceAndClearChildren()
                showCompletionNotification()
                invoke.resolve()
                return@ensureNotificationPermission
            }

            val intent = Intent(activity, TaskNotificationService::class.java).apply {
                putExtra(TaskNotificationService.EXTRA_RUNNING_COUNT, running)
                putExtra(TaskNotificationService.EXTRA_DOWNLOAD_COUNT, items.size)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
                syncChildNotifications(items)
                invoke.resolve()
            } catch (e: Exception) {
                Log.e("TaskNotification", "Failed to update notifications", e)
                invoke.reject("Failed to update notifications: ${e.message}")
            }
        }
    }

    /** 按 items upsert 子通知,并取消 map 中不在 items 的子通知。 */
    private fun syncChildNotifications(items: List<DownloadItem>) {
        ensureChannel()
        val manager = activity.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
            as android.app.NotificationManager
        val present = items.map { it.id }.toHashSet()

        // 取消已消失的子通知。
        val iterator = downloadNotifIds.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (!present.contains(entry.key)) {
                manager.cancel(entry.value)
                iterator.remove()
            }
        }

        // upsert 每个活跃下载。
        for (item in items) {
            val notifId = downloadNotifIds.getOrPut(item.id) { childIdSeq++ }
            val pct = item.progress.coerceIn(0, 100)
            val builder = androidx.core.app.NotificationCompat.Builder(activity, CHANNEL_ID)
                .setContentTitle(item.title)
                .setContentText(if (item.indeterminate) "下载中" else "$pct%")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setGroup(GROUP_KEY)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(appPendingIntent())
                .setProgress(100, pct, item.indeterminate)
            manager.notify(notifId, builder.build())
        }
    }

    private fun stopServiceAndClearChildren() {
        activity.stopService(Intent(activity, TaskNotificationService::class.java))
        val manager = activity.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
            as android.app.NotificationManager
        for (notifId in downloadNotifIds.values) {
            manager.cancel(notifId)
        }
        downloadNotifIds.clear()
        childIdSeq = CHILD_NOTIFICATION_ID_BASE
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = android.app.NotificationChannel(
                CHANNEL_ID,
                "任务进度",
                android.app.NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
            val manager = activity.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
                as android.app.NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun appPendingIntent(): android.app.PendingIntent {
        val launchIntent = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
            ?: Intent(Intent.ACTION_MAIN).apply {
                setPackage(activity.packageName)
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return android.app.PendingIntent.getActivity(
            activity,
            0,
            launchIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun showCompletionNotification() {
        ensureChannel()
        val notification = androidx.core.app.NotificationCompat.Builder(activity, CHANNEL_ID)
            .setContentTitle("任务已全部完成")
            .setContentText("点击打开应用")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(appPendingIntent())
            .setAutoCancel(true)
            .build()
        val manager = activity.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
            as android.app.NotificationManager
        manager.notify(TaskNotificationService.NOTIFICATION_ID + 1, notification)
    }

    private fun ensureNotificationPermission(block: () -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            block()
            return
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            block()
            return
        }
        val launcher = permissionLauncher
        if (launcher != null) {
            pendingPermissionBlock = block
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            block()
        }
    }

    companion object {
        const val CHANNEL_ID = "task_progress"
        const val GROUP_KEY = "app.kabegame.downloads"
        /** 子通知 ID 起点（汇总 9001 / 完成 9002 之上,避免碰撞）。 */
        const val CHILD_NOTIFICATION_ID_BASE = 9100
    }
}
