package app.kabegame.util

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import kotlin.math.max
import kotlin.math.min

object BitmapStyleProcessor {
    fun process(bitmap: Bitmap, style: String, screenWidth: Int, screenHeight: Int): Bitmap {
        val resultBitmap = Bitmap.createBitmap(screenWidth, screenHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(resultBitmap)
        canvas.drawColor(Color.BLACK)

        val paint = Paint().apply { isFilterBitmap = true }

        when (style) {
            "fill" -> drawFill(canvas, bitmap, screenWidth, screenHeight, paint)
            "fit" -> drawFit(canvas, bitmap, screenWidth, screenHeight, paint)
            "stretch" -> drawStretch(canvas, bitmap, screenWidth, screenHeight, paint)
            "center" -> drawCenter(canvas, bitmap, screenWidth, screenHeight, paint)
            "tile" -> drawTile(canvas, bitmap, screenWidth, screenHeight, paint)
            else -> drawFill(canvas, bitmap, screenWidth, screenHeight, paint)
        }

        return resultBitmap
    }

    private fun drawFill(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val scale = max(
            screenWidth.toFloat() / bitmap.width,
            screenHeight.toFloat() / bitmap.height
        )
        val scaledWidth = (bitmap.width * scale).toInt()
        val scaledHeight = (bitmap.height * scale).toInt()

        val dx = (screenWidth - scaledWidth) / 2
        val dy = (screenHeight - scaledHeight) / 2

        val destRect = Rect(dx, dy, dx + scaledWidth, dy + scaledHeight)
        canvas.drawBitmap(bitmap, null, destRect, paint)
    }

    private fun drawFit(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val scale = min(
            screenWidth.toFloat() / bitmap.width,
            screenHeight.toFloat() / bitmap.height
        )
        val scaledWidth = (bitmap.width * scale).toInt()
        val scaledHeight = (bitmap.height * scale).toInt()

        val dx = (screenWidth - scaledWidth) / 2
        val dy = (screenHeight - scaledHeight) / 2

        val destRect = Rect(dx, dy, dx + scaledWidth, dy + scaledHeight)
        canvas.drawBitmap(bitmap, null, destRect, paint)
    }

    private fun drawStretch(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val destRect = Rect(0, 0, screenWidth, screenHeight)
        canvas.drawBitmap(bitmap, null, destRect, paint)
    }

    private fun drawCenter(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        val dx = (screenWidth - bitmap.width) / 2
        val dy = (screenHeight - bitmap.height) / 2
        canvas.drawBitmap(bitmap, dx.toFloat(), dy.toFloat(), paint)
    }

    private fun drawTile(canvas: Canvas, bitmap: Bitmap, screenWidth: Int, screenHeight: Int, paint: Paint) {
        for (x in 0 until screenWidth step bitmap.width) {
            for (y in 0 until screenHeight step bitmap.height) {
                canvas.drawBitmap(bitmap, x.toFloat(), y.toFloat(), paint)
            }
        }
    }
}
