import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Album } from "@/services/albums";

/** 从图片所属画册 id 中挑出标签画册（保持画册 id 的原顺序）。 */
export function pickLabelAlbums(albumIds: readonly string[], albums: readonly Album[]): Album[] {
  const byId = new Map(albums.map((album) => [album.id, album]));
  const out: Album[] = [];
  for (const id of albumIds) {
    const album = byId.get(id);
    if (album?.type === "label") out.push(album);
  }
  return out;
}

/**
 * 转义 Stable Diffusion 提示词里有语法含义的符号：`()` 加权、`[]` 降权、`\` 转义本身。
 * 空格没有语法含义，不转义。
 */
export function escapeSdPrompt(key: string): string {
  return key.replace(/[\\()[\]]/g, (ch) => `\\${ch}`);
}

/** 复制用文本：标签 key 按 SD 提示词转义后以英文逗号 + 空格连接，可直接粘进 SD 提示词。 */
export function labelKeysText(labels: readonly Album[]): string {
  return labels
    .map((label) => label.labelKey)
    .filter((key): key is string => !!key)
    .map(escapeSdPrompt)
    .join(", ");
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}
