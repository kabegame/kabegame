import { onUnmounted } from "vue";

/**
 * 音频输出设备 keep-alive。
 *
 * WebView 媒体栈（macOS WKWebView→AVFoundation、Windows WebView2）在 <video> 暂停后
 * 会停用/释放音频输出设备，恢复播放时设备需冷启动几十~几百毫秒，而视频帧按时间戳立即
 * 呈现、播放时钟不为音频停等，于是恢复瞬间会漏掉开头的声音。
 *
 * 这里用一个全程运行、增益为 0 的静音 WebAudio 图（oscillator → gain(0) → destination）
 * 保持 OS 共享音频输出设备活跃，消除恢复时的冷启动延迟。刻意不走
 * createMediaElementSource（跨域 media 会被静音污染且连接不可撤销，风险高），用独立的
 * 静音上下文与 <video> 解耦即可。
 */

// 模块级单例：避免每次预览都新建音频设备。
let sharedCtx: AudioContext | null = null;
let oscillator: OscillatorNode | null = null;
let started = false;
let suspendTimer: ReturnType<typeof setTimeout> | null = null;

/** 暂停后延迟挂起，避免连续切换视频时反复开关设备。 */
const SUSPEND_DELAY_MS = 1000;

function ensureGraph(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (sharedCtx) return sharedCtx;
  try {
    sharedCtx = new Ctor();
    const gain = sharedCtx.createGain();
    gain.gain.value = 0;
    oscillator = sharedCtx.createOscillator();
    oscillator.connect(gain);
    gain.connect(sharedCtx.destination);
    oscillator.start();
    return sharedCtx;
  } catch {
    sharedCtx = null;
    oscillator = null;
    return null;
  }
}

export function useAudioKeepAlive() {
  /** 必须在用户手势调用栈内首次触发（预览 open() 来自点击，满足自动播放策略）。 */
  const start = () => {
    if (suspendTimer) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    const ctx = ensureGraph();
    if (!ctx) return;
    started = true;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        /* ignore resume rejection (no user gesture / unsupported) */
      });
    }
  };

  /** 延迟挂起，避免连续切换视频时反复开关设备。 */
  const stop = () => {
    started = false;
    if (suspendTimer) clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      if (started || !sharedCtx) return;
      if (sharedCtx.state === "running") {
        void sharedCtx.suspend().catch(() => {
          /* ignore */
        });
      }
    }, SUSPEND_DELAY_MS);
  };

  onUnmounted(() => {
    stop();
  });

  return { start, stop };
}
