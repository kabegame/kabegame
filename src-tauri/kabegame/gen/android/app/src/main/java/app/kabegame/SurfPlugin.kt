package app.kabegame

import android.app.Activity
import android.webkit.CookieManager
import android.webkit.WebSettings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** 原生工具栏文案，由 Rust 用 `t!()` 按应用语言下发。 */
@InvokeArg
class SurfToolbarTexts {
  lateinit var back: String
  lateinit var forward: String
  lateinit var reload: String
  lateinit var address: String
  lateinit var collect: String
  lateinit var cancel: String
  lateinit var openInBrowser: String
  lateinit var close: String
  lateinit var closePopup: String
  lateinit var more: String
  lateinit var desktopSite: String
  lateinit var addToHome: String
}

@InvokeArg
class SurfAttachArgs {
  lateinit var label: String
  lateinit var host: String
  lateinit var url: String
  lateinit var events: Channel
  lateinit var texts: SurfToolbarTexts
  /** 派生不出桌面 UA（默认 UA 尚未登记）时为 null，「桌面版网站」菜单项隐藏。 */
  var desktopUserAgent: String? = null
  /** 记录当前是否以桌面版打开；配置变化重建时以它为准。 */
  var desktopMode: Boolean = false
}

@InvokeArg
class SurfLabelArgs {
  lateinit var label: String
}

@InvokeArg
class SurfCollectRunningArgs {
  lateinit var label: String
  var running: Boolean = false
}

@InvokeArg
class SurfCookieArgs {
  lateinit var url: String
}

@InvokeArg
class SurfShortcutListenArgs {
  lateinit var events: Channel
}

@InvokeArg
class SurfShortcutArgs {
  lateinit var host: String
  lateinit var label: String
  /** 站点 favicon 的 base64；没有时用首字母图标。 */
  var icon: String? = null
  /** 发出固定请求后的提示（国产 ROM 常默认关闭「创建桌面快捷方式」权限且无回调）。 */
  var hint: String = ""
  /** 已固定过时的提示：不再发请求（部分桌面会再弹一次确认框或静默无反应）。 */
  var alreadyPinnedHint: String = ""
}

@InvokeArg
class SurfShortcutDisableArgs {
  lateinit var host: String
  lateinit var message: String
}

data class SurfBinding(
  val label: String,
  val host: String,
  val url: String,
  val events: Channel,
  val texts: SurfToolbarTexts,
  val desktopUserAgent: String?,
  /** 桌面模式：切换时就地更新，配置变化重建时交给新实例。 */
  var desktopMode: Boolean,
)

private class PendingAttach(val binding: SurfBinding, val invoke: Invoke)

/**
 * Activity 与 `attach` 的会合点：两边到达顺序不定。
 *
 * - Activity 先到：登记后等 binding。
 * - `attach` 先到：先存 binding 与 invoke，等 `setContentView` 完成 IPC 替换后再一起 resolve，
 *   这样 Rust 能拿到 `ipcAvailable`。找不到 Activity 时（Activity 已销毁）reject，避免 Rust 干等。
 */
object SurfRegistry {
  private val activities = HashMap<String, SurfActivity>()
  private val pending = HashMap<String, PendingAttach>()
  /** 配置变化重建时旧实例留下的 binding，由同 label 的新实例接走。 */
  private val carried = HashMap<String, SurfBinding>()

  fun attach(binding: SurfBinding, invoke: Invoke) {
    val activity = activities[binding.label]
    if (activity == null) {
      pending[binding.label] = PendingAttach(binding, invoke)
    } else {
      activity.bind(binding)
      resolve(invoke, activity)
    }
  }

  fun onActivityReady(label: String, activity: SurfActivity) {
    activities[label] = activity
    val attach = pending.remove(label)
    if (attach != null) {
      carried.remove(label)
      activity.bind(attach.binding)
      resolve(attach.invoke, activity)
    } else {
      carried.remove(label)?.let { activity.bind(it) }
    }
  }

  /** [carry] 非空表示配置变化重建：保留 binding（及未完成的 attach），等新实例接走。 */
  fun onActivityGone(label: String, activity: SurfActivity, carry: SurfBinding? = null) {
    if (activities[label] === activity) {
      activities.remove(label)
      if (carry != null) {
        carried[label] = carry
      } else {
        carried.remove(label)
        pending.remove(label)?.let { attach -> attach.invoke.reject("畅游页面已关闭") }
      }
    }
  }

  fun get(label: String): SurfActivity? = activities[label]

  private fun resolve(invoke: Invoke, activity: SurfActivity) {
    invoke.resolve(JSObject().put("ipcAvailable", activity.ipcAvailable))
  }
}

@TauriPlugin
class SurfPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun attach(invoke: Invoke) {
    val args = invoke.parseArgs(SurfAttachArgs::class.java)
    activity.runOnUiThread {
      SurfRegistry.attach(
        SurfBinding(
          args.label,
          args.host,
          args.url,
          args.events,
          args.texts,
          args.desktopUserAgent,
          args.desktopMode,
        ),
        invoke,
      )
    }
  }

  /** 系统 WebView 默认 UA：畅游内容页不改 UA，它就是 Cookie 的签发 UA，Rust 登记给 cefUserAgent()。 */
  @Command
  fun getDefaultUserAgent(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        invoke.resolve(JSObject().apply { put("userAgent", WebSettings.getDefaultUserAgent(activity)) })
      } catch (error: Exception) {
        invoke.reject("读取 WebView 默认 UA 失败: ${error.message}", error)
      }
    }
  }

  /**
   * 下载补头用的 Cookie（含 HttpOnly），已是 `a=b; c=d` 形式。
   *
   * 不用 wry 的 `cookies_for_url`：生成的 `RustWebView.getCookies` 把 `getCookie` 声明成非空，
   * 媒体 CDN 等没有 Cookie 的 URL 返回 null 时会在主线程抛 NPE 让应用崩溃。
   */
  @Command
  fun getCookie(invoke: Invoke) {
    val args = invoke.parseArgs(SurfCookieArgs::class.java)
    activity.runOnUiThread {
      try {
        val cookie = CookieManager.getInstance().getCookie(args.url) ?: ""
        invoke.resolve(JSObject().apply { put("cookie", cookie) })
      } catch (error: Exception) {
        invoke.reject("读取 Cookie 失败: ${error.message}", error)
      }
    }
  }

  /** Rust 回推一键下载运行态：运行中工具栏换成转圈。 */
  @Command
  fun setCollectRunning(invoke: Invoke) {
    val args = invoke.parseArgs(SurfCollectRunningArgs::class.java)
    activity.runOnUiThread {
      SurfRegistry.get(args.label)?.setCollectRunning(args.running)
      invoke.resolve()
    }
  }

  @Command
  fun close(invoke: Invoke) = onSurf(invoke) { it.finish() }

  /** Rust 启动时注册：桌面快捷方式点开的站点 host 经此 Channel 投递（含冷启动时暂存的那一个）。 */
  @Command
  fun listenShortcuts(invoke: Invoke) {
    val args = invoke.parseArgs(SurfShortcutListenArgs::class.java)
    activity.runOnUiThread {
      SurfShortcuts.listen(args.events)
      invoke.resolve()
    }
  }

  @Command
  fun pinShortcut(invoke: Invoke) {
    val args = invoke.parseArgs(SurfShortcutArgs::class.java)
    activity.runOnUiThread {
      try {
        val supported = SurfShortcuts.isSupported(activity)
        val requested = supported &&
          SurfShortcuts.requestPin(
            activity,
            args.host,
            args.label,
            SurfShortcuts.decodeIcon(args.icon),
            args.hint,
            args.alreadyPinnedHint,
          )
        invoke.resolve(JSObject().apply {
          put("supported", supported)
          put("requested", requested)
        })
      } catch (error: Exception) {
        invoke.reject("添加桌面快捷方式失败: ${error.message}", error)
      }
    }
  }

  @Command
  fun updateShortcut(invoke: Invoke) {
    val args = invoke.parseArgs(SurfShortcutArgs::class.java)
    activity.runOnUiThread {
      runCatching {
        SurfShortcuts.update(activity, args.host, args.label, SurfShortcuts.decodeIcon(args.icon))
      }
      invoke.resolve()
    }
  }

  @Command
  fun disableShortcut(invoke: Invoke) {
    val args = invoke.parseArgs(SurfShortcutDisableArgs::class.java)
    activity.runOnUiThread {
      runCatching { SurfShortcuts.disable(activity, args.host, args.message) }
      invoke.resolve()
    }
  }

  private fun onSurf(invoke: Invoke, block: (SurfActivity) -> Unit) {
    val label = invoke.parseArgs(SurfLabelArgs::class.java).label
    activity.runOnUiThread {
      val surf = SurfRegistry.get(label)
      if (surf == null) {
        invoke.reject("畅游页面未打开")
        return@runOnUiThread
      }
      try {
        block(surf)
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject("畅游操作失败: ${error.message}", error)
      }
    }
  }
}
