package app.kabegame

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar

/**
 * 畅游原生工具栏：后退 / 前进 / 刷新 / 地址栏 / 一键下载 / 更多 / 关闭。
 *
 * 全部操作直接落在 `RustWebView` 上，不经 Rust 往返；只有一键下载按钮发给 Rust
 * （`collectToggle`），运行态由 Rust 经 `SurfPlugin.setCollectRunning` 回推。
 *
 * 「在浏览器打开」与「桌面版网站」收进「更多」菜单：工具栏已有 6 个图标按钮，
 * 地址栏需要尽量宽；桌面版网站的勾选状态由本类维护（Kotlin 是显示状态权威，
 * 记录是持久化权威）。
 */
class SurfToolbar(context: Context) : LinearLayout(context) {
  var onBack: (() -> Unit)? = null
  var onForward: (() -> Unit)? = null
  var onReload: (() -> Unit)? = null
  var onNavigate: ((String) -> Unit)? = null
  var onCollect: (() -> Unit)? = null
  var onOpenInBrowser: ((String) -> Unit)? = null
  var onToggleDesktop: ((Boolean) -> Unit)? = null
  var onClose: (() -> Unit)? = null

  private val theme = SurfTheme(context)
  private val fgColor = theme.fg
  private val bgColor = theme.bg
  private val borderColor = theme.border
  private val inputColor = theme.input
  private val accent = theme.accent

  // 图标与桌面 surf-navbar.ts 是同一套 Feather SVG（res/drawable/ic_surf_*.xml）。
  private val back = surfIconButton(context, theme, R.drawable.ic_surf_back)
  private val forward = surfIconButton(context, theme, R.drawable.ic_surf_forward)
  private val reload = surfIconButton(context, theme, R.drawable.ic_surf_reload)
  private val address = createAddress()
  private val collect = surfIconButton(context, theme, R.drawable.ic_surf_collect)
  // 运行中换成弧线图标并旋转，对应桌面 `surf-navbar-spin 0.8s linear infinite`。
  private val collectSpin = ObjectAnimator.ofFloat(collect, View.ROTATION, 0f, 360f).apply {
    duration = 800
    interpolator = LinearInterpolator()
    repeatCount = ValueAnimator.INFINITE
  }
  private var collectRunning = false
  private val more = surfIconButton(context, theme, R.drawable.ic_surf_more)
  private val close = surfIconButton(context, theme, R.drawable.ic_surf_close)
  private val loadingBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
    isIndeterminate = false
    max = 100
    visibility = View.GONE
    progressTintList = ColorStateList.valueOf(accent)
    progressBackgroundTintList = ColorStateList.valueOf(android.graphics.Color.TRANSPARENT)
    minimumHeight = dp(2)
  }

  private var currentUrl = ""
  private var openLabel = ""
  private var desktopLabel = ""
  private var desktopMode = false
  private var desktopAvailable = false

  private companion object {
    const val MENU_OPEN_IN_BROWSER = 1
    const val MENU_DESKTOP = 2
  }

  init {
    orientation = VERTICAL
    setBackgroundColor(bgColor)

    val row = LinearLayout(context).apply {
      orientation = HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(4), dp(4), dp(4), dp(4))
      // 六个图标按钮 + 地址栏：每格 32dp（与桌面按钮同宽），窄屏也给地址栏留足宽度。
      addView(back, LayoutParams(dp(32), dp(44)))
      addView(forward, LayoutParams(dp(32), dp(44)))
      addView(reload, LayoutParams(dp(32), dp(44)))
      addView(address, LayoutParams(0, dp(40), 1f).apply { marginStart = dp(4); marginEnd = dp(4) })
      addView(collect, LayoutParams(dp(32), dp(44)))
      addView(more, LayoutParams(dp(32), dp(44)))
      addView(close, LayoutParams(dp(32), dp(44)))
    }
    // 高度必须包裹内容：整条工具栏是 LinearLayout 的子项（固定 48dp），进度条不能挤掉内容。
    addView(row, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))
    addView(loadingBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)))
    addView(
      View(context).apply { setBackgroundColor(borderColor) },
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)),
    )

    back.setOnClickListener { onBack?.invoke() }
    forward.setOnClickListener { onForward?.invoke() }
    reload.setOnClickListener { onReload?.invoke() }
    // 空闲=开始，运行中=取消；运行态只由 Rust 回推。
    collect.setOnClickListener { onCollect?.invoke() }
    more.setOnClickListener { showMoreMenu(it) }
    close.setOnClickListener { onClose?.invoke() }
    address.setOnEditorActionListener { _, actionId, _ ->
      if (actionId != EditorInfo.IME_ACTION_GO) return@setOnEditorActionListener false
      val url = normalizeUrl(address.text.toString())
      if (url == null) {
        markInvalid()
        address.setText(currentUrl)
        address.setSelection(address.text.length)
        true
      } else {
        currentUrl = url
        address.clearFocus()
        onNavigate?.invoke(url)
        true
      }
    }
    address.setOnFocusChangeListener { _, hasFocus ->
      setAddressStroke(if (hasFocus) accent else borderColor)
      if (!hasFocus && address.text.toString() != currentUrl) {
        address.setText(currentUrl)
        address.setSelection(address.text.length)
      }
    }
  }

  /** 绑定下发的文案；`lateinit` 参数都在 attach 前填好，这里只负责展示。 */
  fun applyTexts(texts: SurfToolbarTexts) {
    back.contentDescription = texts.back
    forward.contentDescription = texts.forward
    reload.contentDescription = texts.reload
    address.hint = texts.address
    collect.contentDescription = texts.collect
    collectLabel = texts.collect
    more.contentDescription = texts.more
    openLabel = texts.openInBrowser
    desktopLabel = texts.desktopSite
    close.contentDescription = texts.close
    collectCancellation = texts.cancel
  }

  private var collectLabel = ""
  private var collectCancellation = ""

  /** 绑定下发的初始地址：只在还没有任何导航地址时填入，避免覆盖已经开始的真实导航。 */
  fun setInitialUrl(url: String) {
    if (currentUrl.isNotBlank()) return
    setUrl(url)
  }

  fun setUrl(url: String) {
    if (url.isBlank() || url == currentUrl) return
    currentUrl = url
    if (!address.hasFocus()) {
      address.setText(url)
      address.setSelection(address.text.length)
    }
  }

  /** 按内容页历史置灰后退 / 前进。禁用的 View 不进入 pressed 态，ripple 与点击都不触发。 */
  fun setNavigationState(canGoBack: Boolean, canGoForward: Boolean) {
    setButtonEnabled(back, canGoBack)
    setButtonEnabled(forward, canGoForward)
  }

  /** 0–99 显示确定进度，100 表示加载完成并隐藏。进度回退（新导航打断旧导航）不做动画。 */
  fun setProgress(progress: Int) {
    val value = progress.coerceIn(0, 100)
    if (value >= 100) {
      loadingBar.visibility = View.GONE
      loadingBar.setProgress(0, false)
      return
    }
    loadingBar.visibility = View.VISIBLE
    loadingBar.setProgress(value, value > loadingBar.progress)
  }

  /** 只更新「更多」菜单的勾选态；实际切换由 Activity 完成。 */
  fun setDesktopMode(enabled: Boolean) {
    desktopMode = enabled
  }

  /** 派生不出桌面 UA（系统 WebView 默认 UA 尚未登记）时隐藏「桌面版网站」菜单项。 */
  fun setDesktopAvailable(available: Boolean) {
    desktopAvailable = available
  }

  private fun setButtonEnabled(button: ImageView, enabled: Boolean) {
    button.isEnabled = enabled
    button.alpha = if (enabled) 1f else 0.38f
  }

  private fun showMoreMenu(anchor: View) {
    PopupMenu(context, anchor).apply {
      menu.add(0, MENU_OPEN_IN_BROWSER, 0, openLabel)
      if (desktopAvailable) {
        menu.add(0, MENU_DESKTOP, 1, desktopLabel).apply {
          isCheckable = true
          isChecked = desktopMode
        }
      }
      setOnMenuItemClickListener { item ->
        when (item.itemId) {
          MENU_OPEN_IN_BROWSER -> onOpenInBrowser?.invoke(currentUrl)
          MENU_DESKTOP -> onToggleDesktop?.invoke(!desktopMode)
        }
        true
      }
    }.show()
  }

  fun setCollectRunning(running: Boolean) {
    if (running == collectRunning) return
    collectRunning = running
    collect.setImageResource(if (running) R.drawable.ic_surf_collect_busy else R.drawable.ic_surf_collect)
    collect.contentDescription = if (running) collectCancellation else collectLabel
    if (running) {
      if (isAttachedToWindow) collectSpin.start()
    } else {
      collectSpin.cancel()
      collect.rotation = 0f
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (collectRunning && !collectSpin.isStarted) collectSpin.start()
  }

  override fun onDetachedFromWindow() {
    // 无限动画不随 View 脱离自动停止，Activity 销毁前要手动取消。
    collectSpin.cancel()
    super.onDetachedFromWindow()
  }

  private fun createAddress(): EditText = EditText(context).apply {
    setSingleLine(true)
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    imeOptions = EditorInfo.IME_ACTION_GO
    setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(fgColor)
    setHintTextColor(if (theme.night) 0x99FFFFFF.toInt() else 0x99000000.toInt())
    setPadding(dp(10), 0, dp(10), 0)
    background = GradientDrawable().apply {
      cornerRadius = dp(8).toFloat()
      setColor(inputColor)
      setStroke(dp(1), borderColor)
    }
  }

  private fun setAddressStroke(color: Int) {
    (address.background as? GradientDrawable)?.setStroke(dp(1), color)
  }

  private fun markInvalid() {
    setAddressStroke(theme.invalid)
    postDelayed({
      setAddressStroke(if (address.hasFocus()) accent else borderColor)
    }, 900)
  }

  private fun normalizeUrl(raw: String): String? {
    val value = raw.trim()
    if (value.isEmpty()) return null
    val withScheme = if (Regex("^[a-zA-Z][-a-zA-Z0-9+.]*:").containsMatchIn(value)) {
      value
    } else {
      "https://$value"
    }
    val uri = runCatching { Uri.parse(withScheme) }.getOrNull() ?: return null
    if (uri.scheme != "http" && uri.scheme != "https") return null
    return withScheme
  }

  private fun dp(value: Int): Int = surfDp(context, value)
}
