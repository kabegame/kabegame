import { pathqlEntry, pathqlFetch } from "@/services/pathql";
import { rowToImageInfo } from "@/utils/imageRow";
import { withGalleryPrefix } from "@/utils/path";
import type { Album } from "@/stores/albums";
import type { ImageInfo } from "@kabegame/core/types/image";

export interface AlbumMediaNode {
  album: Album;
  path: string;
  directTotal: number;
  aggregateTotal: number;
  children: AlbumMediaNode[];
}

function normalizePath(path: string): string {
  return (path || "").trim().replace(/^\/+|\/+$/g, "");
}

export function buildGalleryAlbumPath(albumId: string, hide: boolean): string {
  const prefix = hide ? "hide/" : "";
  return `${prefix}album/${encodeURIComponent(albumId)}`;
}

export function buildAlbumMediaNodes(
  roots: Album[],
  allAlbums: Album[],
  directCounts: Record<string, number>,
  hide: boolean,
): AlbumMediaNode[] {
  const childrenByParent = new Map<string | null, Album[]>();
  for (const album of allAlbums) {
    const list = childrenByParent.get(album.parentId) ?? [];
    list.push(album);
    childrenByParent.set(album.parentId, list);
  }

  const sortAlbums = (items: Album[]) =>
    items.slice().sort((a, b) => b.createdAt - a.createdAt);

  const build = (album: Album, ancestors: ReadonlySet<string>): AlbumMediaNode => {
    const directTotal = directCounts[album.id] ?? 0;
    let children: AlbumMediaNode[] = [];
    if (!ancestors.has(album.id)) {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(album.id);
      children = sortAlbums(childrenByParent.get(album.id) ?? []).map((child) =>
        build(child, nextAncestors),
      );
    }
    return {
      album,
      path: buildGalleryAlbumPath(album.id, hide),
      directTotal,
      aggregateTotal:
        directTotal + children.reduce((sum, child) => sum + child.aggregateTotal, 0),
      children,
    };
  };

  return sortAlbums(roots).map((album) => build(album, new Set()));
}

export function flattenAlbumMediaNodes(node: AlbumMediaNode): AlbumMediaNode[] {
  return [node, ...node.children.flatMap((child) => flattenAlbumMediaNodes(child))];
}

export function albumSubtreeContainsAny(
  node: AlbumMediaNode,
  albumIds: ReadonlySet<string>,
): boolean {
  if (albumIds.has(node.album.id)) return true;
  return node.children.some((child) => albumSubtreeContainsAny(child, albumIds));
}

export async function fetchAlbumDirectCount(path: string): Promise<number> {
  const res = await pathqlEntry(withGalleryPrefix(normalizePath(path)));
  const total = res?.total;
  return typeof total === "number" && Number.isFinite(total) ? Math.max(0, total) : 0;
}

export async function fetchAlbumDirectCounts(
  albumIds: Iterable<string>,
  hide: boolean,
): Promise<Record<string, number>> {
  const uniqueIds = Array.from(new Set(Array.from(albumIds).filter(Boolean)));
  const pairs = await Promise.all(
    uniqueIds.map(
      async (id) => {
        try {
          return [id, await fetchAlbumDirectCount(buildGalleryAlbumPath(id, hide))] as const;
        } catch (error) {
          console.warn("fetch album direct count failed:", id, error);
          return [id, 0] as const;
        }
      },
    ),
  );
  return Object.fromEntries(pairs);
}

async function fetchProviderImages(path: string): Promise<ImageInfo[]> {
  const rows = await pathqlFetch<Record<string, unknown>>(withGalleryPrefix(path));
  return rows.map(rowToImageInfo);
}

function albumPreviewPath(path: string, limit: number): string {
  return `${normalizePath(path)}/sort/by-album-order/x${limit}x/1`;
}

function pickRoundRobinImages(buckets: ImageInfo[][], limit: number): ImageInfo[] {
  const selected: ImageInfo[] = [];
  const seen = new Set<string>();
  const offsets = buckets.map(() => 0);

  while (selected.length < limit) {
    let progressed = false;
    for (let idx = 0; idx < buckets.length && selected.length < limit; idx++) {
      const bucket = buckets[idx] ?? [];
      while (offsets[idx] < bucket.length && seen.has(bucket[offsets[idx]]!.id)) {
        offsets[idx]++;
      }
      const image = bucket[offsets[idx]];
      if (!image) continue;
      offsets[idx]++;
      seen.add(image.id);
      selected.push(image);
      progressed = true;
    }
    if (!progressed) break;
  }

  return selected;
}

export async function loadAlbumMediaPreview(
  node: AlbumMediaNode,
  limit: number,
): Promise<ImageInfo[]> {
  const n = Math.max(1, Math.floor(limit) || 1);
  const candidates = flattenAlbumMediaNodes(node).filter((item) => item.directTotal > 0);
  if (candidates.length === 0) return [];

  const buckets = await Promise.all(
    candidates.map(async (item) => {
      try {
        return await fetchProviderImages(albumPreviewPath(item.path, n));
      } catch (error) {
        console.warn("fetch album preview bucket failed:", item.album.id, error);
        return [];
      }
    }),
  );
  return pickRoundRobinImages(buckets, n);
}
