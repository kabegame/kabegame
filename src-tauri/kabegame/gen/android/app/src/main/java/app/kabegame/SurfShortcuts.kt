package app.kabegame

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.util.Base64
import android.widget.Toast
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject

/**
 * 畅游站点的桌面快捷方式。
 *
 * 快捷方式的 intent 指向 `MainActivity`（`SurfActivity` 由 Rust 建窗，不能被单独拉起），只带
 * 站点 host；打开哪个地址由 Rust 按已有的站点记录决定，外部应用伪造 intent 也只能打开已有记录。
 *
 * 冷启动时 intent 先于 Rust 注册监听到达：[deliver] 先暂存，[listen] 注册 Channel 时再投递。
 */
object SurfShortcuts {
  const val ACTION_OPEN_SURF = "app.kabegame.action.OPEN_SURF"
  const val EXTRA_HOST = "host"

  private const val ID_PREFIX = "surf:"
  /** 自适应图标画布 108dp，取 4 倍密度；安全区是中间 66dp 的圆。 */
  private const val ICON_SIZE = 432

  private var listener: Channel? = null
  private var pendingHost: String? = null

  fun listen(channel: Channel) {
    listener = channel
    pendingHost?.let {
      pendingHost = null
      send(channel, it)
    }
  }

  /** 由 `MainActivity.handleIntent` 调用（主线程）。 */
  fun deliver(host: String) {
    val channel = listener
    if (channel == null) {
      pendingHost = host
    } else {
      send(channel, host)
    }
  }

  private fun send(channel: Channel, host: String) {
    channel.send(JSObject().apply { put("host", host) })
  }

  fun isSupported(context: Context): Boolean = ShortcutManagerCompat.isRequestPinShortcutSupported(context)

  /**
   * 请求固定到桌面。返回是否成功发出请求；用户是否同意、国产 ROM 是否静默拦截都拿不到回调，
   * 所以发出后统一弹 [hint] 提示去系统设置开启权限。已固定且启用时只刷新名称与图标，弹
   * [alreadyPinnedHint]。用户从桌面移除图标后系统会取消固定，可以再次添加。
   */
  fun requestPin(
    context: Context,
    host: String,
    label: String,
    icon: ByteArray?,
    hint: String,
    alreadyPinnedHint: String,
  ): Boolean {
    val shortcut = build(context, ID_PREFIX + host, host, label, icon)
    if (isPinned(context, shortcut.id)) {
      ShortcutManagerCompat.updateShortcuts(context, listOf(shortcut))
      Toast.makeText(context, alreadyPinnedHint, Toast.LENGTH_SHORT).show()
      return true
    }
    // 删除站点时快捷方式被禁用过；同一 host 再次固定前先恢复，否则系统拒绝更新被禁用的快捷方式。
    ShortcutManagerCompat.enableShortcuts(context, listOf(shortcut))
    val requested = ShortcutManagerCompat.requestPinShortcut(context, shortcut, null)
    if (requested) Toast.makeText(context, hint, Toast.LENGTH_LONG).show()
    return requested
  }

  /** 已固定的快捷方式跟随站点名称与图标更新；未固定时系统忽略。 */
  fun update(context: Context, host: String, label: String, icon: ByteArray?) {
    val id = ID_PREFIX + host
    if (!isPinned(context, id)) return
    ShortcutManagerCompat.updateShortcuts(context, listOf(build(context, id, host, label, icon)))
  }

  private fun isPinned(context: Context, id: String): Boolean =
    ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED)
      .any { it.id == id && it.isEnabled }

  /** 站点记录已删除：桌面上的图标应用删不掉，只能禁用，点击时系统显示 [message]。 */
  fun disable(context: Context, host: String, message: String) {
    ShortcutManagerCompat.disableShortcuts(context, listOf(ID_PREFIX + host), message)
  }

  private fun build(context: Context, id: String, host: String, label: String, icon: ByteArray?): ShortcutInfoCompat {
    val intent = Intent(context, MainActivity::class.java).apply {
      action = ACTION_OPEN_SURF
      putExtra(EXTRA_HOST, host)
    }
    return ShortcutInfoCompat.Builder(context, id)
      .setShortLabel(label)
      .setLongLabel(label)
      .setIcon(IconCompat.createWithAdaptiveBitmap(iconBitmap(host, icon)))
      .setIntent(intent)
      .build()
  }

  /** favicon（ico / png 等，常只有 16–32px）放大居中垫白底；解不出时用首字母图标。 */
  private fun iconBitmap(host: String, icon: ByteArray?): Bitmap {
    val bitmap = Bitmap.createBitmap(ICON_SIZE, ICON_SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val favicon = icon?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
    if (favicon != null) {
      canvas.drawColor(Color.WHITE)
      // 边长取画布的 44%，留在安全区内，各家桌面的圆形 / 方形遮罩都不会裁到图标。
      val side = ICON_SIZE * 0.44f
      val offset = (ICON_SIZE - side) / 2
      val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
      canvas.drawBitmap(
        favicon,
        Rect(0, 0, favicon.width, favicon.height),
        RectF(offset, offset, offset + side, offset + side),
        paint,
      )
      favicon.recycle()
    } else {
      canvas.drawColor(fallbackColor(host))
      val letter = host.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "?"
      val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = ICON_SIZE * 0.36f
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
      }
      val y = ICON_SIZE / 2f - (paint.descent() + paint.ascent()) / 2
      canvas.drawText(letter, ICON_SIZE / 2f, y, paint)
    }
    return bitmap
  }

  private fun fallbackColor(host: String): Int {
    val hue = ((host.hashCode() % 360) + 360) % 360
    return Color.HSVToColor(floatArrayOf(hue.toFloat(), 0.55f, 0.75f))
  }

  fun decodeIcon(base64: String?): ByteArray? =
    base64?.takeIf { it.isNotEmpty() }?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() }
}
