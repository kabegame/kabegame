package app.kabegame

import android.app.Activity
import android.webkit.CookieManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** 爬虫宿主工具栏文案，由 Rust 用 `t!()` 按应用语言下发。 */
@InvokeArg
class CrawlerToolbarTexts {
  lateinit var title: String
  lateinit var collapse: String
  lateinit var cancel: String
}

@InvokeArg
class CrawlerAttachArgs {
  lateinit var label: String
  lateinit var taskName: String
  lateinit var events: Channel
  lateinit var texts: CrawlerToolbarTexts
}

@InvokeArg
class CrawlerLabelArgs {
  lateinit var label: String
}

@InvokeArg
class CrawlerSubscribeArgs {
  lateinit var events: Channel
}

@InvokeArg
class CrawlerClearCookiesArgs {
  lateinit var url: String
}

data class CrawlerBinding(
  val label: String,
  val taskName: String,
  val events: Channel,
  val texts: CrawlerToolbarTexts,
)

private class CrawlerPendingAttach(val binding: CrawlerBinding, val invoke: Invoke)

/**
 * 宿主 Activity 与 `attach` 的会合点：两边到达顺序不定（Activity 的 setContentView 先发生，
 * `attach` 由 Rust 在 build 之后发出，但仍可能晚于/早于 Activity 就绪登记）。
 *
 * 额外维护「预期关闭」：Rust 主动 `close`（任务正常结束 / renderGone 收尾）不算用户取消，
 * `onDestroy` 不再回发 `closed`，否则会把刚完成的任务误标成取消。
 */
object CrawlerRegistry {
  private val activities = HashMap<String, CrawlerActivity>()
  private val pending = HashMap<String, CrawlerPendingAttach>()
  private val expectedClose = HashSet<String>()
  /** 配置变化重建时旧实例留下的 binding，由同 label 的新实例接走。 */
  private val carried = HashMap<String, CrawlerBinding>()

  fun attach(binding: CrawlerBinding, invoke: Invoke) {
    val activity = activities[binding.label]
    if (activity == null) {
      pending[binding.label] = CrawlerPendingAttach(binding, invoke)
    } else {
      activity.bind(binding)
      resolve(invoke, activity)
    }
  }

  fun onActivityReady(label: String, activity: CrawlerActivity) {
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
  fun onActivityGone(label: String, activity: CrawlerActivity, carry: CrawlerBinding? = null) {
    if (activities[label] === activity) {
      activities.remove(label)
      if (carry != null) {
        carried[label] = carry
      } else {
        carried.remove(label)
        pending.remove(label)?.let { attach -> attach.invoke.reject("爬虫页面已关闭") }
      }
    }
  }

  fun markExpectedClose(label: String) {
    expectedClose.add(label)
  }

  /** 取出并清除「预期关闭」标记。 */
  fun consumeExpectedClose(label: String): Boolean = expectedClose.remove(label)

  fun get(label: String): CrawlerActivity? = activities[label]

  private fun resolve(invoke: Invoke, activity: CrawlerActivity) {
    invoke.resolve(JSObject().put("ipcAvailable", activity.ipcAvailable))
  }
}

@TauriPlugin
class CrawlerPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun attach(invoke: Invoke) {
    val args = invoke.parseArgs(CrawlerAttachArgs::class.java)
    activity.runOnUiThread {
      CrawlerRegistry.attach(
        CrawlerBinding(args.label, args.taskName, args.events, args.texts),
        invoke,
      )
    }
  }

  /**
   * 把停靠容器提到主 webview 之上。app 在后台时安卓限制拉起界面：只记为待显示，
   * 回到前台由 `CrawlerHost` 自动提到最上层（Rust 据此写一条任务日志）。
   */
  @Command
  fun show(invoke: Invoke) {
    val label = invoke.parseArgs(CrawlerLabelArgs::class.java).label
    activity.runOnUiThread {
      if (!CrawlerHost.isDocked(label)) {
        invoke.reject("爬虫页面未打开")
        return@runOnUiThread
      }
      val pending = CrawlerHost.showOrDefer(label)
      invoke.resolve(JSObject().put("pending", pending))
    }
  }

  /** 原生工具栏「收起」：只改 Z 序，页面继续在主界面下运行。 */
  @Command
  fun hide(invoke: Invoke) {
    val label = invoke.parseArgs(CrawlerLabelArgs::class.java).label
    activity.runOnUiThread {
      CrawlerHost.hide(label)
      invoke.resolve()
    }
  }

  /** 结束宿主 Activity（只在 JS 结束时才该发生；普通收起用 [hide]）。 */
  @Command
  fun close(invoke: Invoke) {
    val label = invoke.parseArgs(CrawlerLabelArgs::class.java).label
    activity.runOnUiThread {
      val host = CrawlerRegistry.get(label)
      if (host == null) {
        invoke.reject("爬虫页面未打开")
        return@runOnUiThread
      }
      CrawlerRegistry.markExpectedClose(label)
      try {
        host.finishAndRemoveTask()
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject("关闭爬虫页面失败: ${error.message}", error)
      }
    }
  }

  /**
   * 逐个把该 URL 的 Cookie 写成过期，替代 wry 安卓空实现的 `delete_cookie`。
   * `getCookie` 只给 `a=b; c=d`，这里按 name 逐个 setCookie 过期（路径取 /，与站点根一致）。
   */
  @Command
  fun clearCookies(invoke: Invoke) {
    val args = invoke.parseArgs(CrawlerClearCookiesArgs::class.java)
    activity.runOnUiThread {
      try {
        val manager = CookieManager.getInstance()
        val cookie = manager.getCookie(args.url)
        if (!cookie.isNullOrBlank()) {
          cookie.split(';').forEach { pair ->
            val name = pair.substringBefore('=').trim()
            if (name.isNotEmpty()) {
              manager.setCookie(args.url, "$name=; Max-Age=0; Path=/")
            }
          }
          manager.flush()
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject("清除站点 Cookie 失败: ${error.message}", error)
      }
    }
  }

  /** 进程级前后台事件：看门狗在后台期间挂起心跳计时，回到前台重置。 */
  @Command
  fun subscribeHost(invoke: Invoke) {
    val args = invoke.parseArgs(CrawlerSubscribeArgs::class.java)
    activity.runOnUiThread {
      CrawlerHost.subscribeHost(args.events)
      invoke.resolve()
    }
  }
}
