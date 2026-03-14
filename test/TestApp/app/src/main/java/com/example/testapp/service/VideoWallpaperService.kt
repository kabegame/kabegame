package com.example.testapp.service

import android.content.Context
import android.media.MediaPlayer
import android.net.Uri
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder

/**
 * 动态壁纸：在桌面上循环播放选中的视频（静音）。
 * 通过 SharedPreferences 读取 "video_wallpaper_uri"，支持 content:// 或 file 路径。
 */
class VideoWallpaperService : WallpaperService() {

    override fun onCreateEngine(): Engine = VideoWallpaperEngine()

    inner class VideoWallpaperEngine : Engine() {

        private var mediaPlayer: MediaPlayer? = null
        private var surfaceHolder: SurfaceHolder? = null

        override fun onCreate(surfaceHolder: SurfaceHolder?) {
            super.onCreate(surfaceHolder)
            this.surfaceHolder = surfaceHolder
            loadAndPlay()
        }

        override fun onSurfaceCreated(holder: SurfaceHolder) {
            super.onSurfaceCreated(holder)
            surfaceHolder = holder
            mediaPlayer?.setDisplay(holder)
            mediaPlayer?.start()
        }

        override fun onSurfaceDestroyed(holder: SurfaceHolder) {
            super.onSurfaceDestroyed(holder)
            mediaPlayer?.setDisplay(null)
            if (surfaceHolder == holder) surfaceHolder = null
        }

        override fun onVisibilityChanged(visible: Boolean) {
            super.onVisibilityChanged(visible)
            if (visible) {
                mediaPlayer?.start()
            } else {
                mediaPlayer?.pause()
            }
        }

        override fun onDestroy() {
            releasePlayer()
            surfaceHolder = null
            super.onDestroy()
        }

        private fun loadAndPlay() {
            releasePlayer()
            val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val uriString = prefs.getString(KEY_VIDEO_URI, null) ?: return
            val uri = Uri.parse(uriString)
            val holder = surfaceHolder ?: return

            try {
                val mp = MediaPlayer().apply {
                    setDataSource(applicationContext, uri)
                    setDisplay(holder)
                    isLooping = true
                    setVolume(0f, 0f)
                    setOnPreparedListener { it.start() }
                    setOnErrorListener { _, _, _ -> true }
                    prepareAsync()
                }
                mediaPlayer = mp
            } catch (e: Exception) {
                releasePlayer()
            }
        }

        private fun releasePlayer() {
            try {
                mediaPlayer?.apply {
                    stop()
                    release()
                }
            } catch (_: Exception) { }
            mediaPlayer = null
        }
    }

    companion object {
        const val PREFS_NAME = "video_wallpaper"
        const val KEY_VIDEO_URI = "video_uri"
    }
}
