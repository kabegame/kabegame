package app.kabegame

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject
import java.lang.ref.WeakReference

/**
 * 爬虫页面显示位置的属主：把每个任务的 `RustWebView` 连同一条薄工具栏装进容器，挂到
 * `MainActivity` 内容根节点、**垫在主 webview 下面**（`z = -1`）。
 *
 * 主界面窗口始终可见，所以 Chromium 认为页面 `visible`：计时器不节流、页面不冻结；主 webview
 * 不透明，用户看不到它。`show` / `hide` 只改容器 `z`（触摸分发随 Z 序走），不缩不隐藏——
 * 缩成 1×1 或 `INVISIBLE` 都会让页面判成 hidden。
 *
 * 显示 / 收起带一段纵向滑动：显示先提到最上层再从底部滑上来；收起先滑出底部、动画结束才放回
 * 主 webview 下面并复原位移。状态（`shown`、返回键回调）立即切换，只有画面在动。动画期间不给
 * 容器开硬件层：WebView 经 draw functor 绘制，父级离屏层会让页面在动画中闪白。
 *
 * 不放进 `CrawlerActivity` 自己的窗口：原型证明「单独成栈、退到后台」的页面隐藏约 60 秒就被
 * Chromium 冻结（Activity 只当 wry 的宿主，负责创建 / 销毁回调）。
 */
object CrawlerHost {
  private const val SHOWN_Z = 10f
  private const val HIDDEN_Z = -1f
  private const val SHOW_DURATION_MS = 260L
  private const val HIDE_DURATION_MS = 200L

  private class Dock(
    val label: String,
    val container: FrameLayout,
    val toolbar: CrawlerToolbar,
  ) {
    var shown = false
  }

  private val docks = LinkedHashMap<String, Dock>()
  private var mainRef: WeakReference<MainActivity>? = null
  private var shownLabel: String? = null
  /** 后台时收到的 `show`：回到前台再提到最上层（安卓限制后台拉起界面）。 */
  private var pendingShow: String? = null
  private var hostEvents: Channel? = null
  private var hostVisible = true
  private var lifecycleObserved = false

  private val foregroundObserver = object : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) {
      hostVisible = true
      sendHostVisibility()
      pendingShow?.let { label ->
        pendingShow = null
        if (docks.containsKey(label)) show(label)
      }
    }

    override fun onStop(owner: LifecycleOwner) {
      hostVisible = false
      sendHostVisibility()
    }
  }

  fun attachMain(activity: MainActivity) {
    mainRef = WeakReference(activity)
    docks.values.forEach { dock -> mount(activity, dock) }
    if (!lifecycleObserved) {
      lifecycleObserved = true
      // ProcessLifecycleOwner 只反映整个进程的前后台，Activity 之间切换不会触发。
      ProcessLifecycleOwner.get().lifecycle.addObserver(foregroundObserver)
    }
    activity.setCrawlerBackEnabled(shownLabel != null)
  }

  fun detachMain(activity: MainActivity) {
    if (mainRef?.get() === activity) {
      mainRef = null
    }
  }

  /** wry 把宿主 Activity 的主 webview 交出来时调用（此时 Activity 还没登记到 Registry）。 */
  fun dock(label: String, webview: RustWebView) {
    if (docks.containsKey(label)) return
    val toolbar = CrawlerToolbar(webview.context).apply {
      onCollapse = { hide(label) }
      onCancel = {
        // 用户取消：交回 Rust 结束任务，窗口会由 Rust 的 destroy 关闭。
        CrawlerRegistry.get(label)?.emitCancel()
        hide(label)
      }
    }
    val column = LinearLayout(webview.context).apply {
      orientation = LinearLayout.VERTICAL
      addView(
        toolbar,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
      addView(
        webview,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
      )
    }
    val container = FrameLayout(webview.context).apply {
      addView(
        column,
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
      // 工具栏默认不可见：藏在主 webview 下面时没人看得到，显示时再切回 VISIBLE。
      // 用 INVISIBLE 而不是 GONE：保留布局高度，显示 / 收起时页面视口不跳动。
      toolbar.visibility = View.INVISIBLE
      z = HIDDEN_Z
    }
    ViewCompat.setOnApplyWindowInsetsListener(container) { target, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      target.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      // 不能 CONSUMED：容器与主 webview 是兄弟节点，消费掉会让主界面拿不到安全区
      // （MainActivity 靠 webview 的 insets 注入 --sat / --sab）。
      insets
    }
    val dock = Dock(label, container, toolbar)
    docks[label] = dock
    mainRef?.get()?.let { mount(it, dock) }
    ViewCompat.requestApplyInsets(container)
  }

  fun undock(label: String) {
    val dock = docks.remove(label) ?: return
    dock.container.animate().cancel()
    (dock.container.parent as? ViewGroup)?.removeView(dock.container)
    if (shownLabel == label) {
      shownLabel = null
      mainRef?.get()?.setCrawlerBackEnabled(false)
    }
    if (pendingShow == label) {
      pendingShow = null
    }
  }

  fun isDocked(label: String): Boolean = docks.containsKey(label)

  /**
   * 提到主 webview 之上。app 在后台时只记为待显示并返回 `true`；回到前台由
   * `foregroundObserver` 自动显示（Rust 据此写一条任务日志）。
   */
  fun showOrDefer(label: String): Boolean {
    if (!hostVisible) {
      pendingShow = label
      return true
    }
    show(label)
    return false
  }

  fun show(label: String) {
    val dock = docks[label] ?: return
    // 同时最多一个爬虫页面在前台：其余放回下面（页面仍在运行）。
    docks.values.forEach { other ->
      if (other !== dock && other.shown) {
        other.shown = false
        settleHidden(other)
      }
    }
    if (dock.shown) return
    val container = dock.container
    // 收起动画还没走完就再次显示：从当前位置滑回来，不跳到底部重来。
    val midHide = container.z == SHOWN_Z
    container.animate().cancel()
    dock.shown = true
    dock.toolbar.visibility = View.VISIBLE
    container.z = SHOWN_Z
    container.bringToFront()
    if (!midHide) container.translationY = slideDistance(container)
    container.animate()
      .translationY(0f)
      .setDuration(SHOW_DURATION_MS)
      .setInterpolator(DecelerateInterpolator(2f))
      .start()
    shownLabel = label
    mainRef?.get()?.setCrawlerBackEnabled(true)
  }

  fun hide(label: String) {
    val dock = docks[label] ?: return
    if (dock.shown) {
      dock.shown = false
      val container = dock.container
      container.animate().cancel()
      container.animate()
        .translationY(slideDistance(container))
        .setDuration(HIDE_DURATION_MS)
        .setInterpolator(AccelerateInterpolator(1.5f))
        // 动画被 show 打断时 cancel 不会触发 endAction；这里再看一次状态，防止迟到的回调把它压下去。
        .withEndAction { if (!dock.shown) settleHidden(dock) }
        .start()
    }
    if (shownLabel == label) {
      shownLabel = null
      mainRef?.get()?.setCrawlerBackEnabled(false)
    }
  }

  /** 系统返回键：把当前显示的爬虫页面放回主界面下。 */
  fun hideShown(): Boolean {
    val label = shownLabel ?: return false
    hide(label)
    return true
  }

  fun applyTexts(label: String, texts: CrawlerToolbarTexts) {
    docks[label]?.toolbar?.applyTexts(texts)
  }

  fun subscribeHost(events: Channel) {
    hostEvents = events
    sendHostVisibility()
  }

  private fun sendHostVisibility() {
    hostEvents?.send(JSObject().apply {
      put("type", "hostVisibility")
      put("visible", hostVisible)
    })
  }

  /** 收起的终态：垫回主 webview 下面、位移复原、工具栏隐藏（页面仍是 visible）。 */
  private fun settleHidden(dock: Dock) {
    dock.container.animate().cancel()
    dock.container.translationY = 0f
    dock.container.z = HIDDEN_Z
    dock.toolbar.visibility = View.INVISIBLE
  }

  private fun slideDistance(container: View): Float {
    val height = if (container.height > 0) container.height else container.resources.displayMetrics.heightPixels
    return height.toFloat()
  }

  private fun mount(activity: MainActivity, dock: Dock) {
    val root = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    (dock.container.parent as? ViewGroup)?.removeView(dock.container)
    root.addView(
      dock.container,
      0,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    // 重建后按当前状态重新排 Z 序（动画中途重建就直接落到终态）。
    dock.container.animate().cancel()
    dock.container.translationY = 0f
    dock.container.z = if (dock.shown) SHOWN_Z else HIDDEN_Z
    dock.toolbar.visibility = if (dock.shown) View.VISIBLE else View.INVISIBLE
    ViewCompat.requestApplyInsets(dock.container)
  }
}

/**
 * 爬虫宿主工具栏：任务名 + 「收起」+「取消任务」。
 *
 * 全部操作落在 Kotlin：收起只改 Z 序，取消经 events Channel 交给 Rust 结束任务。
 */
class CrawlerToolbar(context: Context) : LinearLayout(context) {
  var onCollapse: (() -> Unit)? = null
  var onCancel: (() -> Unit)? = null

  private val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
    Configuration.UI_MODE_NIGHT_YES
  private val fgColor = if (night) 0xFFF5F5F7.toInt() else 0xFF1D1D1F.toInt()
  private val bgColor = if (night) 0xFF1D1D1F.toInt() else 0xFFF5F5F7.toInt()
  private val pressedColor = if (night) 0xFF3A3A3C.toInt() else 0xFFE5E5EA.toInt()
  private val dangerColor = if (night) 0xFFFF6B5F.toInt() else 0xFFD92D20.toInt()

  private val title = TextView(context).apply {
    setTextColor(fgColor)
    textSize = 13f
    maxLines = 1
    isSingleLine = true
    ellipsize = android.text.TextUtils.TruncateAt.END
  }
  private val collapse = textButton()
  private val cancel = textButton(dangerColor)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setBackgroundColor(bgColor)
    setPadding(dp(12), 0, dp(4), 0)
    addView(title, LayoutParams(0, dp(48), 1f))
    addView(collapse, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
    addView(cancel, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
    collapse.setOnClickListener { onCollapse?.invoke() }
    cancel.setOnClickListener { onCancel?.invoke() }
  }

  fun applyTexts(texts: CrawlerToolbarTexts) {
    title.text = texts.title
    collapse.text = texts.collapse
    cancel.text = texts.cancel
  }

  private fun textButton(color: Int = fgColor): TextView = TextView(context).apply {
    setTextColor(color)
    textSize = 13f
    gravity = Gravity.CENTER
    isClickable = true
    isFocusable = true
    setPadding(dp(12), 0, dp(12), 0)
    background = android.graphics.drawable.RippleDrawable(
      ColorStateList.valueOf(pressedColor),
      null,
      null,
    )
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
