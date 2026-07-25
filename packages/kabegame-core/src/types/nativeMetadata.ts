/**
 * 必须与 Rust `src-tauri/kabegame-core/src/media/native_metadata/mod.rs`
 * 中的 `PARSER_VERSION` 保持一致。
 */
export const NATIVE_METADATA_PARSER_VERSION = 1;

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

export type NativeMetadataPayload =
  | {
      v: number;
      format: "jpeg" | "png";
      partial?: boolean;
      groups: NativeGroup[];
    }
  | null;
