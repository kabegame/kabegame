package app.kabegame

import android.app.Activity
import android.webkit.WebSettings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SurfAttachArgs {
  lateinit var label: String
  lateinit var host: String
  lateinit var url: String
  lateinit var events: Channel
}

@InvokeArg
class SurfLabelArgs {
  lateinit var label: String
}

@InvokeArg
class SurfNavigateArgs {
  lateinit var label: String
  lateinit var url: String
}

data class SurfBinding(
  val label: String,
  val host: String,
  val url: String,
  val events: Channel,
)

object SurfRegistry {
  private val activities = HashMap<String, SurfActivity>()
  private val pending = HashMap<String, SurfBinding>()

  fun attach(binding: SurfBinding) {
    val activity = activities[binding.label]
    if (activity == null) {
      pending[binding.label] = binding
    } else {
      activity.bind(binding)
    }
  }

  fun onActivityReady(label: String, activity: SurfActivity) {
    activities[label] = activity
    pending.remove(label)?.let(activity::bind)
  }

  fun onActivityGone(label: String, activity: SurfActivity) {
    if (activities[label] === activity) {
      activities.remove(label)
      pending.remove(label)
    }
  }

  fun get(label: String): SurfActivity? = activities[label]
}

@TauriPlugin
class SurfPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun attach(invoke: Invoke) {
    val args = invoke.parseArgs(SurfAttachArgs::class.java)
    activity.runOnUiThread {
      SurfRegistry.attach(SurfBinding(args.label, args.host, args.url, args.events))
      invoke.resolve()
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

  @Command
  fun goBack(invoke: Invoke) = onSurf(invoke) {
    if (it.content.canGoBack()) it.content.goBack()
  }

  @Command
  fun goForward(invoke: Invoke) = onSurf(invoke) {
    if (it.content.canGoForward()) it.content.goForward()
  }

  @Command
  fun reload(invoke: Invoke) = onSurf(invoke) { it.content.reload() }

  @Command
  fun navigate(invoke: Invoke) {
    val args = invoke.parseArgs(SurfNavigateArgs::class.java)
    onSurf(invoke, args.label) { it.content.loadUrl(args.url) }
  }

  @Command
  fun close(invoke: Invoke) = onSurf(invoke) { it.finish() }

  private fun onSurf(invoke: Invoke, block: (SurfActivity) -> Unit) {
    val label = invoke.parseArgs(SurfLabelArgs::class.java).label
    onSurf(invoke, label, block)
  }

  private fun onSurf(invoke: Invoke, label: String, block: (SurfActivity) -> Unit) {
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
