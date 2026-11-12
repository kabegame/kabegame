import type { SpectrumBlock } from "../audio/spectrum";

/** `engine.registerAudioBuffers` 给脚本的三个数组，长度等于分辨率（16 / 32 / 64）。 */
export interface AudioBuffers {
  left: Float32Array;
  right: Float32Array;
  average: Float32Array;
}

/**
 * 把场景频谱（`audio/spectrum.ts` 的 `SceneSpectrum`）同分辨率的一块拷进一组缓冲：原地写，脚本持有的数组不变（P4e 步骤 4，「决定」5）。
 * `source` 是 `SceneSpectrum.block(缓冲长度)`：WPE 的接口按分辨率返回 `ctx+0x2c0` / `0x2c8` / `0x2d0` 块，块布局 `[L | R | A]` 正好对上
 * left / right / average（rea-p4e-audio.md 3.4【推】）；`average` 是 `A` 段（先平均、再逐级取最大，3.3），不是 left、right 的平均。
 * 以前从 Hub 的原值段内取最大、没有归一化，P4e 步骤 4 起改读归一化频谱，和 WPE 对齐（p6-REPORT 实测过 WPE 有自适应归一化）。
 */
export function copySpectrumToBuffers(source: SpectrumBlock, buffers: AudioBuffers): void {
  buffers.left.set(source.left);
  buffers.right.set(source.right);
  buffers.average.set(source.average);
}
