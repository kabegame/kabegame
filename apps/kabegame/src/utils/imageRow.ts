import type { ImageInfo } from "@kabegame/core/types/image";

type Row = Record<string, unknown>;

function field(row: Row, snake: string, camel?: string): unknown {
  return row[snake] ?? (camel ? row[camel] : undefined);
}

function stringField(row: Row, snake: string, camel?: string): string | undefined {
  const value = field(row, snake, camel);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function numberField(row: Row, snake: string, camel?: string): number | undefined {
  const value = field(row, snake, camel);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function boolField(row: Row, snake: string, camel?: string): boolean | undefined {
  const value = field(row, snake, camel);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "TRUE", "True"].includes(value);
  return undefined;
}

export function rowToImageInfo(row: Row): ImageInfo {
  const localPath = stringField(row, "local_path", "localPath") ?? "";
  const thumbnailPath = stringField(row, "thumbnail_path", "thumbnailPath") ?? "";
  const image: ImageInfo = {
    id: stringField(row, "id") ?? "",
    localPath,
    thumbnailPath,
    pluginId: stringField(row, "plugin_id", "pluginId") ?? "",
    crawledAt: numberField(row, "crawled_at", "crawledAt") ?? 0,
    hash: stringField(row, "hash") ?? "",
    favorite: boolField(row, "is_favorite", "favorite") ?? false,
    isHidden: boolField(row, "is_hidden", "isHidden") ?? false,
    localExists: boolField(row, "local_exists", "localExists") ?? true,
    displayName: stringField(row, "display_name", "displayName") ?? "",
  };
  const optionalStrings: Array<[keyof ImageInfo, string | undefined]> = [
    ["url", stringField(row, "url")],
    ["taskId", stringField(row, "task_id", "taskId")],
    ["type", stringField(row, "media_type", "type")],
  ];
  for (const [key, value] of optionalStrings) {
    if (value !== undefined) (image as unknown as Record<string, unknown>)[key] = value;
  }

  const optionalNumbers: Array<[keyof ImageInfo, number | undefined]> = [
    ["metadataId", numberField(row, "metadata_id", "metadataId")],
    ["metadataVersion", numberField(row, "metadata_version", "metadataVersion")],
    ["order", numberField(row, "album_order", "albumOrder")],
    ["width", numberField(row, "width")],
    ["height", numberField(row, "height")],
    ["lastSetWallpaperAt", numberField(row, "last_set_wallpaper_at", "lastSetWallpaperAt")],
    ["size", numberField(row, "size")],
  ];
  for (const [key, value] of optionalNumbers) {
    if (value !== undefined) (image as unknown as Record<string, unknown>)[key] = value;
  }

  return image;
}
