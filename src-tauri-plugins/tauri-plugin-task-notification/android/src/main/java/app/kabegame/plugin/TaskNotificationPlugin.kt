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
    class UpdateTaskNotificationArgs {
        var runningCount: Int = 0
    }

    @Command
    fun updateTaskNotification(invoke: Invoke) {
        ensureNotificationPermission {
            val args = invoke.parseArgs(UpdateTaskNotificationArgs::class.java)
            val count = args.runningCount.coerceAtLeast(0)

            if (count <= 0) {
                clearTaskNotification(invoke)
                return@ensureNotificationPermission
            }

            val intent = Intent(activity, TaskNotificationService::class.java).apply {
                putExtra(TaskNotificationService.EXTRA_RUNNING_COUNT, count)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
                invoke.resolve()
            } catch (e: Exception) {
                Log.e("TaskNotification", "Failed to start foreground service", e)
                invoke.reject("Failed to start notification: ${e.message}")
            }
        }
    }

    @Command
    fun clearTaskNotification(invoke: Invoke) {
        activity.stopService(Intent(activity, TaskNotificationService::class.java))
        ensureNotificationPermission {
            showCompletionNotification()
        }
        invoke.resolve()
    }

    private fun showCompletionNotification() {
        val channelId = "task_progress"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = android.app.NotificationChannel(
                channelId,
                "任务进度",
                android.app.NotificationManager.IMPORTANCE_DEFAULT
            )
            val manager = activity.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            manager.createNotificationChannel(channel)
        }

        val launchIntent = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
            ?: Intent(Intent.ACTION_MAIN).apply {
                setPackage(activity.packageName)
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pendingIntent = android.app.PendingIntent.getActivity(
            activity,
            0,
            launchIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )

        val notification = androidx.core.app.NotificationCompat.Builder(activity, channelId)
            .setContentTitle("任务已全部完成")
            .setContentText("点击打开应用")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()

        val manager = activity.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
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
}
