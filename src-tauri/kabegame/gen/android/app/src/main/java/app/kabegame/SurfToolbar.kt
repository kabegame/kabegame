package app.kabegame

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.RippleDrawable
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
import android.widget.ProgressBar
import androidx.annotation.DrawableRes

/**
 * 畅游原生工具栏：后退 / 前进 / 刷新 / 地址栏 / 一键下载 / 在浏览器打开 / 关闭。
 *
 * 全部操作直接落在 `RustWebView` 上，不经 Rust 往返；只有一键下载按钮发给 Rust
 * （`collectToggle`），运行态由 Rust 经 `SurfPlugin.setCollectRunning` 回推。
 */
class SurfToolbar(context: Context) : LinearLayout(context) {
  var onBack: (() -> Unit)? = null
  var onForward: (() -> Unit)? = null
  var onReload: (() -> Unit)? = null
  var onNavigate: ((String) -> Unit)? = null
  var onCollect: (() -> Unit)? = null
  var onOpenInBrowser: ((String) -> Unit)? = null
  var onClose: (() -> Unit)? = null

  private val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
    Configuration.UI_MODE_NIGHT_YES
  private val fgColor = if (night) 0xFFF5F5F7.toInt() else 0xFF1D1D1F.toInt()
  private val bgColor = if (night) 0xFF1D1D1F.toInt() else 0xFFF5F5F7.toInt()
  private val borderColor = if (night) 0xFF3A3A3C.toInt() else 0xFFD2D2D7.toInt()
  private val inputColor = if (night) 0x14FFFFFF else 0x0F000000
  // 桌面 hover 底色，安卓没有 hover，用作按压 ripple 颜色。
  private val pressedColor = if (night) 0xFF3A3A3C.toInt() else 0xFFE5E5EA.toInt()
  private val invalidColor = if (night) 0xFFFF6B5F.toInt() else 0xFFD92D20.toInt()
  private val accent = 0xFF3B82F6.toInt()

  // 图标与桌面 surf-navbar.ts 是同一套 Feather SVG（res/drawable/ic_surf_*.xml）。
  private val back = iconButton(R.drawable.ic_surf_back)
  private val forward = iconButton(R.drawable.ic_surf_forward)
  private val reload = iconButton(R.drawable.ic_surf_reload)
  private val address = createAddress()
  private val collect = iconButton(R.drawable.ic_surf_collect)
  // 运行中换成弧线图标并旋转，对应桌面 `surf-navbar-spin 0.8s linear infinite`。
  private val collectSpin = ObjectAnimator.ofFloat(collect, View.ROTATION, 0f, 360f).apply {
    duration = 800
    interpolator = LinearInterpolator()
    repeatCount = ValueAnimator.INFINITE
  }
  private var collectRunning = false
  private val openInBrowser = iconButton(R.drawable.ic_surf_open_in_browser)
  private val close = iconButton(R.drawable.ic_surf_close)
  private val loadingBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
    isIndeterminate = true
    visibility = View.GONE
    progressTintList = ColorStateList.valueOf(accent)
    minimumHeight = dp(2)
  }

  private var currentUrl = ""

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
      addView(openInBrowser, LayoutParams(dp(32), dp(44)))
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
    openInBrowser.setOnClickListener { onOpenInBrowser?.invoke(currentUrl) }
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
    openInBrowser.contentDescription = texts.openInBrowser
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

  fun setLoading(loading: Boolean) {
    loadingBar.visibility = if (loading) View.VISIBLE else View.GONE
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

  private fun iconButton(@DrawableRes icon: Int): ImageView = ImageView(context).apply {
    setImageResource(icon)
    scaleType = ImageView.ScaleType.CENTER
    imageTintList = ColorStateList.valueOf(fgColor)
    isClickable = true
    isFocusable = true
    // 桌面按钮是 32px、圆角 6px；格宽同为 32dp，高 44dp，ripple 取中间 32dp 方块。
    val mask = InsetDrawable(
      GradientDrawable().apply {
        cornerRadius = dp(6).toFloat()
        setColor(0xFFFFFFFF.toInt())
      },
      0, dp(6), 0, dp(6),
    )
    background = RippleDrawable(ColorStateList.valueOf(pressedColor), null, mask)
  }

  private fun createAddress(): EditText = EditText(context).apply {
    setSingleLine(true)
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    imeOptions = EditorInfo.IME_ACTION_GO
    setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(fgColor)
    setHintTextColor(if (night) 0x99FFFFFF.toInt() else 0x99000000.toInt())
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
    setAddressStroke(invalidColor)
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

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
