/**
 * 按封装分派拆包（P9d 步骤 3）：前 4 字节是 EBML 魔数 `1A 45 DF A3` 走 `indexMatroska`，否则 `indexMp4`。两边产出同一个
 * `VideoTrackIndex`，播放器不分格式。从不抛错（`read` reject 也变成 `{ error }`）。
 */
import { EBML_MAGIC, indexMatroska } from "./mkv";
import { indexMp4, type ReadRange, type VideoTrackIndex } from "./mp4";

export async function indexVideo(read: ReadRange, length: number): Promise<VideoTrackIndex | { error: string }> {
  if (Number.isSafeInteger(length) && length >= 4) {
    let head: Uint8Array;
    try {
      head = await read(0, 4);
    } catch (error) {
      return { error: `读取或解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (head.length === 4 && new DataView(head.buffer, head.byteOffset, 4).getUint32(0) === EBML_MAGIC) {
      return indexMatroska(read, length);
    }
  }
  return indexMp4(read, length);
}
