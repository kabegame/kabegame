package app.kabegame

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.RippleDrawable
import android.widget.ImageView
import androidx.annotation.DrawableRes

/**
 * 畅游原生控件的配色：与桌面 `surf-navbar.ts` 的 CSS 变量一致。
 * 工具栏与弹窗标题栏共用同一套深浅色。
 */
class SurfTheme(context: Context) {
  val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
    Configuration.UI_MODE_NIGHT_YES
  val fg = if (night) 0xFFF5F5F7.toInt() else 0xFF1D1D1F.toInt()
  val bg = if (night) 0xFF1D1D1F.toInt() else 0xFFF5F5F7.toInt()
  val border = if (night) 0xFF3A3A3C.toInt() else 0xFFD2D2D7.toInt()
  val input = if (night) 0x14FFFFFF else 0x0F000000
  // 桌面 hover 底色，安卓没有 hover，用作按压 ripple 颜色。
  val pressed = if (night) 0xFF3A3A3C.toInt() else 0xFFE5E5EA.toInt()
  val invalid = if (night) 0xFFFF6B5F.toInt() else 0xFFD92D20.toInt()
  val accent = 0xFF3B82F6.toInt()
}

/**
 * 与桌面导航栏同形的图标按钮：32dp 见方、圆角 6px、按压 32dp 方块 ripple。
 *
 * 畅游工具栏与弹窗标题栏的关闭按钮共用；图标颜色由 [SurfTheme.fg] 着色。
 */
fun surfIconButton(context: Context, theme: SurfTheme, @DrawableRes icon: Int): ImageView =
  ImageView(context).apply {
    setImageResource(icon)
    scaleType = ImageView.ScaleType.CENTER
    imageTintList = ColorStateList.valueOf(theme.fg)
    isClickable = true
    isFocusable = true
    // 桌面按钮是 32px、圆角 6px；格宽同为 32dp，高 44dp，ripple 取中间 32dp 方块。
    val mask = InsetDrawable(
      GradientDrawable().apply {
        cornerRadius = surfDp(context, 6).toFloat()
        setColor(0xFFFFFFFF.toInt())
      },
      0, surfDp(context, 6), 0, surfDp(context, 6),
    )
    background = RippleDrawable(ColorStateList.valueOf(theme.pressed), null, mask)
  }

fun surfDp(context: Context, value: Int): Int =
  (value * context.resources.displayMetrics.density).toInt()
