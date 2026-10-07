import { pathqlFetch } from "@/services/pathql";
import type { ImageInfo } from "@/types/image";

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
    crawledAt: numberField(row, "crawled_at", "crawledAt") ?? 0,
    hash: stringField(row, "hash") ?? "",
    favorite: boolField(row, "is_favorite", "favorite") ?? false,
    isHidden: boolField(row, "is_hidden", "isHidden") ?? false,
    localExists: boolField(row, "local_exists", "localExists") ?? true,
    displayName: stringField(row, "display_name", "displayName") ?? "",
  };
  const optionalStrings: Array<[keyof ImageInfo, string | undefined]> = [
    ["url", stringField(row, "url")],
    ["pluginId", stringField(row, "plugin_id", "pluginId")],
    ["taskId", stringField(row, "task_id", "taskId")],
    ["surfRecordId", stringField(row, "surf_record_id", "surfRecordId")],
    // 列名统一为 type；media_type 已从 provider 树与 storage SQL 中移除。
    ["type", stringField(row, "type")],
    ["compatiblePath", stringField(row, "compatible_path", "compatiblePath")],
    ["postUrl", stringField(row, "post_url")],
  ];
  for (const [key, value] of optionalStrings) {
    if (value !== undefined) (image as unknown as Record<string, unknown>)[key] = value;
  }

  const optionalNumbers: Array<[keyof ImageInfo, number | undefined]> = [
    ["metadataId", numberField(row, "metadata_id", "metadataId")],
    ["pluginVersion", numberField(row, "plugin_version", "pluginVersion")],
    ["imageMetadataId", numberField(row, "image_metadata_id", "imageMetadataId")],
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

/**
 * 按 id 取单张图片。走 `gallery/by_id`——与画廊视图查询同一个 provider，
 * 所以 `is_favorite` / `is_hidden` 等画册派生字段都在。
 *
 * `images://id_<id>` 只给裸 image 行，缺这些字段（`rowToImageInfo` 会把收藏降级成
 * false），所以**不作回退**，这里只有一条路。
 *
 * 返回 null 表示该行确认不存在；查询本身失败会抛出，由调用方区分这两种情况。
 */
export async function fetchImageById(imageId: string): Promise<ImageInfo | null> {
  const id = imageId.trim();
  if (!id) return null;
  const rows = await pathqlFetch<Row>(`images://gallery/by_id/${encodeURIComponent(id)}`);
  const row = rows[0];
  return row ? rowToImageInfo(row) : null;
}
