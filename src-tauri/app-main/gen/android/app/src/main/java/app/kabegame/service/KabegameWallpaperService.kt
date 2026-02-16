package app.kabegame.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.*
import android.os.Handler
import android.os.Looper
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder
import java.io.File
import kotlin.math.max
import kotlin.math.min

class KabegameWallpaperService : WallpaperService() {
    
    override fun onCreateEngine(): Engine {
        return KabegameWallpaperEngine()
    }
    
    inner class KabegameWallpaperEngine : Engine() {
        // 状态变量
        private var currentBitmap: Bitmap? = null
        private var nextBitmap: Bitmap? = null
        private var style: String = "fill"
        private var transitionType: String = "none"
        private var enableParallax: Boolean = false
        
        // 过渡动画
        private var transitionProgress: Float = 0f
        private var isTransitioning: Boolean = false
        private val transitionHandler = Handler(Looper.getMainLooper())
        
        // 视差滚动
        private var parallaxOffsetX: Float = 0f
        private var parallaxOffsetY: Float = 0f
        
        // 屏幕尺寸
        private var screenWidth: Int = 0
        private var screenHeight: Int = 0

        private val updateReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                reloadSettings()
            }
        }
        
        override fun onCreate(surfaceHolder: SurfaceHolder?) {
            super.onCreate(surfaceHolder)
            val filter = IntentFilter("app.kabegame.WALLPAPER_UPDATE")
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(updateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(updateReceiver, filter)
            }
            reloadSettings()
        }

        override fun onDestroy() {
            super.onDestroy()
            try {
                unregisterReceiver(updateReceiver)
            } catch (e: Exception) {
                // Ignore if not registered
            }
        }

        private fun reloadSettings() {
            val prefs = getSharedPreferences("kabegame_wallpaper", Context.MODE_PRIVATE)
            val path = prefs.getString("image_path", null)
            val newStyle = prefs.getString("style", "fill") ?: "fill"
            val newTransition = prefs.getString("transition", "none") ?: "none"
            val newParallax = prefs.getBoolean("parallax", false)
            
            if (path != null) {
                val file = File(path)
                if (file.exists()) {
                    try {
                        val bitmap = BitmapFactory.decodeFile(path)
                        if (bitmap != null) {
                            setWallpaper(bitmap, newStyle, newTransition, newParallax)
                        }
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
            }
        }

        override fun onSurfaceCreated(holder: SurfaceHolder) {
            super.onSurfaceCreated(holder)
            screenWidth = holder.surfaceFrame.width()
            screenHeight = holder.surfaceFrame.height()
            drawFrame()
        }
        
        override fun onSurfaceChanged(
            holder: SurfaceHolder,
            format: Int,
            width: Int,
            height: Int
        ) {
            super.onSurfaceChanged(holder, format, width, height)
            screenWidth = width
            screenHeight = height
            drawFrame()
        }
        
        override fun onVisibilityChanged(visible: Boolean) {
            super.onVisibilityChanged(visible)
            if (visible) {
                drawFrame()
            } else {
                // 不可见时停止动画以节省资源
                stopTransition()
            }
        }
        
        // 视差滚动回调
        override fun onOffsetsChanged(
            xOffset: Float,
            yOffset: Float,
            xOffsetStep: Float,
            yOffsetStep: Float,
            xPixelOffset: Int,
            yPixelOffset: Int
        ) {
            super.onOffsetsChanged(xOffset, yOffset, xOffsetStep, yOffsetStep, xPixelOffset, yPixelOffset)
            
            if (enableParallax && currentBitmap != null) {
                val bitmap = currentBitmap!!
                // Only calculate parallax if bitmap is larger than screen
                val maxOffsetX = (bitmap.width - screenWidth).coerceAtLeast(0)
                val maxOffsetY = (bitmap.height - screenHeight).coerceAtLeast(0)
                
                parallaxOffsetX = xOffset * maxOffsetX
                parallaxOffsetY = yOffset * maxOffsetY
                
                drawFrame()
            }
        }
        
        // 绘制壁纸
        private fun drawFrame() {
            val holder = surfaceHolder
            var canvas: Canvas? = null
            try {
                canvas = holder.lockCanvas()
                if (canvas != null) {
                    onDraw(canvas)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            } finally {
                if (canvas != null) {
                    try {
                        holder.unlockCanvasAndPost(canvas)
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
            }
        }

        fun onDraw(canvas: Canvas) {
            val current = currentBitmap ?: run {
                canvas.drawColor(Color.BLACK)
                return
            }
            
            // 视差模式：绘制偏移后的区域
            if (enableParallax && (parallaxOffsetX != 0f || parallaxOffsetY != 0f)) {
                drawParallaxWallpaper(canvas, current)
                return
            }
            
            // 过渡模式：绘制过渡效果
            if (isTransitioning && nextBitmap != null) {
                drawTransition(canvas, current, nextBitmap!!)
                return
            }
            
            // 普通模式：根据样式绘制
            drawWallpaperWithStyle(canvas, current)
        }
        
        // 根据样式绘制壁纸
        private fun drawWallpaperWithStyle(canvas: Canvas, bitmap: Bitmap, paint: Paint? = null) {
            canvas.drawColor(Color.BLACK) // Clear background
            when (style) {
                "fill" -> drawFill(canvas, bitmap, paint)
                "fit" -> drawFit(canvas, bitmap, paint)
                "stretch" -> drawStretch(canvas, bitmap, paint)
                "center" -> drawCenter(canvas, bitmap, paint)
                "tile" -> drawTile(canvas, bitmap, paint)
                else -> drawFill(canvas, bitmap, paint)
            }
        }
        
        // 填充模式
        private fun drawFill(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
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
        
        // 适应模式
        private fun drawFit(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
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
        
        // 拉伸模式
        private fun drawStretch(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val destRect = Rect(0, 0, screenWidth, screenHeight)
            canvas.drawBitmap(bitmap, null, destRect, paint)
        }
        
        // 居中模式
        private fun drawCenter(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val dx = (screenWidth - bitmap.width) / 2f
            val dy = (screenHeight - bitmap.height) / 2f
            canvas.drawBitmap(bitmap, dx, dy, paint)
        }
        
        // 平铺模式
        private fun drawTile(canvas: Canvas, bitmap: Bitmap, paint: Paint?) {
            val p = paint ?: Paint()
            for (x in 0 until screenWidth step bitmap.width) {
                for (y in 0 until screenHeight step bitmap.height) {
                    canvas.drawBitmap(bitmap, x.toFloat(), y.toFloat(), p)
                }
            }
        }
        
        // 视差绘制
        private fun drawParallaxWallpaper(canvas: Canvas, bitmap: Bitmap) {
            val srcX = parallaxOffsetX.toInt()
            val srcY = parallaxOffsetY.toInt()
            
            // Ensure we don't go out of bounds
            val safeSrcX = srcX.coerceIn(0, (bitmap.width - screenWidth).coerceAtLeast(0))
            val safeSrcY = srcY.coerceIn(0, (bitmap.height - screenHeight).coerceAtLeast(0))
            
            // If bitmap is smaller than screen in any dimension, we center it or stretch it?
            // Parallax implies bitmap is larger. If smaller, just draw centered or fill.
            // But here we assume we want to draw a window of screenWidth x screenHeight from the bitmap.
            
            if (bitmap.width < screenWidth || bitmap.height < screenHeight) {
                // Fallback to fill if not large enough for parallax in one dimension
                drawFill(canvas, bitmap, null)
                return
            }

            val srcRect = Rect(
                safeSrcX,
                safeSrcY,
                safeSrcX + screenWidth,
                safeSrcY + screenHeight
            )
            val dstRect = Rect(0, 0, screenWidth, screenHeight)
            canvas.drawBitmap(bitmap, srcRect, dstRect, null)
        }
        
        // 过渡效果绘制
        private fun drawTransition(canvas: Canvas, current: Bitmap, next: Bitmap) {
            when (transitionType) {
                "fade" -> {
                    drawWallpaperWithStyle(canvas, current)
                    val alpha = (transitionProgress * 255).toInt()
                    val paint = Paint().apply { this.alpha = alpha }
                    drawWallpaperWithStyle(canvas, next, paint)
                }
                "slide" -> {
                    val offsetX = (transitionProgress * screenWidth).toInt()
                    canvas.save()
                    canvas.translate(-offsetX.toFloat(), 0f)
                    drawWallpaperWithStyle(canvas, current)
                    canvas.restore()
                    canvas.save()
                    canvas.translate((screenWidth - offsetX).toFloat(), 0f)
                    drawWallpaperWithStyle(canvas, next)
                    canvas.restore()
                }
                "zoom" -> {
                    drawWallpaperWithStyle(canvas, current)
                    val scale = 1f + (transitionProgress * 0.1f)
                    val matrix = Matrix().apply {
                        setScale(scale, scale)
                        postTranslate(
                            screenWidth * (1 - scale) / 2,
                            screenHeight * (1 - scale) / 2
                        )
                    }
                    val paint = Paint().apply {
                        alpha = (transitionProgress * 255).toInt()
                    }
                    canvas.save()
                    canvas.concat(matrix)
                    drawWallpaperWithStyle(canvas, next, paint)
                    canvas.restore()
                }
                else -> drawWallpaperWithStyle(canvas, current)
            }
        }
        
        // 设置壁纸
        fun setWallpaper(bitmap: Bitmap, newStyle: String, transition: String, parallax: Boolean) {
            val oldBitmap = currentBitmap
            
            style = newStyle
            transitionType = transition
            enableParallax = parallax
            
            if (transition == "none" || oldBitmap == null) {
                // 无过渡或首次设置
                currentBitmap = bitmap
                nextBitmap = null
                isTransitioning = false
                drawFrame()
            } else {
                // 有过渡
                nextBitmap = bitmap
                startTransition()
            }
        }
        
        // 开始过渡动画
        private fun startTransition() {
            isTransitioning = true
            transitionProgress = 0f
            
            val duration = when (transitionType) {
                "fade" -> 800L
                "slide" -> 800L
                "zoom" -> 900L
                else -> 0L
            }
            
            if (duration == 0L) {
                currentBitmap = nextBitmap
                nextBitmap = null
                isTransitioning = false
                drawFrame()
                return
            }
            
            val startTime = System.currentTimeMillis()
            val updateRunnable = object : Runnable {
                override fun run() {
                    if (!isTransitioning) return
                    
                    val elapsed = System.currentTimeMillis() - startTime
                    transitionProgress = (elapsed.toFloat() / duration).coerceIn(0f, 1f)
                    
                    drawFrame()
                    
                    if (transitionProgress < 1f) {
                        transitionHandler.postDelayed(this, 16) // ~60fps
                    } else {
                        // 过渡完成
                        currentBitmap = nextBitmap
                        nextBitmap = null
                        isTransitioning = false
                        transitionProgress = 0f
                        drawFrame() // Final draw
                    }
                }
            }
            transitionHandler.post(updateRunnable)
        }
        
        // 停止过渡
        private fun stopTransition() {
            isTransitioning = false
            transitionHandler.removeCallbacksAndMessages(null)
        }
    }
}
