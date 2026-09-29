import type { AlbumKind } from "@/services/albums";

export interface AlbumTreeViewScope {
  sections?: ReadonlyArray<"system" | "normal" | "label" | "local_folder">;
  kinds?: ReadonlyArray<AlbumKind>;
  excludeIds?: readonly string[];
  excludeSubtreeOf?: readonly string[];
}
