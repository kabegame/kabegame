/** Hub 一帧的结构（`wpe_media/mod.rs`）：每声道 64 段，左声道在前，共 128 个值。 */
const CHANNEL_BANDS = 64;
const FRAME_VALUES = CHANNEL_BANDS * 2;

/** `engine.registerAudioBuffers` 给脚本的三个数组，长度等于分辨率（16 / 32 / 64）。 */
export interface AudioBuffers {
  left: Float32Array;
  right: Float32Array;
  average: Float32Array;
}

/**
 * 把 Hub 的一帧合并进一组缓冲：原地写，脚本持有的数组不变。
 *
 * `frame`：128 个值（左声道 0–63、右声道 64–127，各自低频在前）。
 * 分辨率 n 的每一段取对应 64 / n 个原始段的最大值（`spectrum.rs` 的段内也取最大，含义是推断）；
 * `average[i] = (left[i] + right[i]) / 2`。长度不是 128 的帧忽略。
 */
export function fillAudioBuffers(frame: ArrayLike<number>, buffers: AudioBuffers): void {
  if (frame.length !== FRAME_VALUES) return;
  const { left, right, average } = buffers;
  const span = CHANNEL_BANDS / left.length;
  for (let band = 0; band < left.length; band++) {
    const start = band * span;
    let leftPeak = frame[start];
    let rightPeak = frame[CHANNEL_BANDS + start];
    for (let offset = 1; offset < span; offset++) {
      leftPeak = Math.max(leftPeak, frame[start + offset]);
      rightPeak = Math.max(rightPeak, frame[CHANNEL_BANDS + start + offset]);
    }
    left[band] = leftPeak;
    right[band] = rightPeak;
    average[band] = (leftPeak + rightPeak) / 2;
  }
}
