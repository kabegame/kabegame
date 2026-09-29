import type { Album } from "@/services/albums";

const collator = new Intl.Collator("en", { sensitivity: "base" });

/** 目录以完整 key 路径标识；根级标签统一归入空目录，大小写遵循标签寻址规则。 */
function directoryPath(label: Album): string {
  const path = label.labelPath ?? "";
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator).toLowerCase();
}

function directoryPalette(directory: string) {
  // FNV-1a + 雪崩混合，避免相似目录名只改变少量低位；不依赖随机数或目录出现顺序。
  let hash = 0x811c9dc5;
  for (let i = 0; i < directory.length; i++) {
    hash = Math.imul(hash ^ directory.charCodeAt(i), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash = (hash ^ (hash >>> 16)) >>> 0;

  // 将哈希的三段投射到 OKLCH：L∈[0.94,0.96]、C∈[0.025,0.035]、H∈[0,360)。
  // 同色相配套深色文字与边框；根级无目录时取中性色。
  const hue = ((hash & 0xffff) / 0x10000) * 360;
  const lightness = 0.94 + (((hash >>> 16) & 0xff) / 255) * 0.02;
  const chroma = directory ? 0.025 + ((hash >>> 24) / 255) * 0.01 : 0;
  return {
    "--anime-tag-bg-color": `oklch(${lightness} ${chroma} ${hue})`,
    "--anime-tag-border-color": `oklch(0.82 ${chroma} ${hue})`,
    "--anime-tag-text-color": `oklch(0.38 ${chroma} ${hue})`,
    "--anime-tag-hover-color": `oklch(0.46 ${chroma} ${hue})`,
  };
}

/** 只处理当前图片的标签；同目录共用色板，排序不修改源数组或复制提示词的顺序。 */
export function presentImageLabels(labels: readonly Album[]) {
  const palettes = new Map<string, ReturnType<typeof directoryPalette>>();
  return labels
    .map((label) => {
      const directory = directoryPath(label);
      let style = palettes.get(directory);
      if (!style) {
        style = directoryPalette(directory);
        palettes.set(directory, style);
      }
      return { label, directory, style };
    })
    .sort(
      (a, b) =>
        collator.compare(a.directory, b.directory) ||
        collator.compare(a.label.labelKey ?? a.label.name, b.label.labelKey ?? b.label.name) ||
        collator.compare(a.label.id, b.label.id),
    );
}
