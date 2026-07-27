export interface NativeEntry {
  tag: string;
  value: string;
  note?: string;
  long?: boolean;
  byteLen?: number;
}

export interface NativeGroup {
  id: string;
  subtitle: string;
  entries: NativeEntry[];
}

/** 与 Rust `NativeMetadata` enum 的 `#[serde(tag = "format")]` 取值一一对应。 */
export type NativeMetadataFormat = "jpeg" | "png" | "webp" | "gif";

/**
 * 必须与 Rust `src-tauri/kabegame-core/src/media/native_metadata/mod.rs`
 * 中的 `{JPEG,PNG,WEBP,GIF}_PARSER_VERSION` 逐一保持一致。
 * 每个格式独立计版本：改哪个解析器就只失效哪个格式的缓存。
 */
export const NATIVE_METADATA_PARSER_VERSIONS = {
  jpeg: 1,
  png: 1,
  webp: 1,
  gif: 1,
} as const satisfies Record<NativeMetadataFormat, number>;

/**
 * 前端缓存 key 用的聚合版本。请求发出前拿不到图片格式，做不到按格式精确失效，
 * 所以任一解析器升版都整体失效——前端这层只是读取缓存，重取代价小；
 * 后端仍按格式精确判断，不会因此重算解析结果。
 */
export const NATIVE_METADATA_CACHE_VERSION = Object.values(
  NATIVE_METADATA_PARSER_VERSIONS,
).join(".");

export type NativeMetadataPayload =
  | {
      v: number;
      format: NativeMetadataFormat;
      partial?: boolean;
      groups: NativeGroup[];
    }
  | null;
