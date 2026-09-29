import { invoke } from "@/api/rpc";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import { albumChangeBatch, publishLocal, type ChangeBatch } from "@/services/dataChangeHub";
import type { ViewQuery, ViewSnapshot } from "@/services/liveQuery";
import { pathqlEntry, pathqlFetch, pathqlList, type ProviderListChild } from "@/services/pathql";
import { ElMessageBox } from "@kabegame/element-plus";
import { i18n } from "@kabegame/i18n";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { isLabelForestKind, type AlbumKind, type AlbumSyncMode } from "@kabegame/core/types/album";

export type { AlbumKind, AlbumSyncMode } from "@kabegame/core/types/album";

export const HIDDEN_ALBUM_ID = "00000000-0000-0000-0000-000000000000";
export const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";
export const ALBUM_PAGE_SIZE = 100;

export type AlbumRootSection = "normal" | "label" | "local_folder";
export type GalleryPrefix = "" | "hide/" | string;

export interface FolderStatus {
  state: "ok" | "missing" | "denied" | "not_a_dir" | "io_error";
  message?: string;
  checkedAt?: number;
  checked_at?: number;
  lastSyncedAtMs?: number;
  last_synced_at_ms?: number;
}

export interface Album {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  type: AlbumKind;
  syncFolder: string | null;
  folderStatus: FolderStatus | null;
  syncMode: AlbumSyncMode;
  ancestorPath: string;
  labelKey: string | null;
  labelPath: string | null;
}

export interface AlbumNode extends Album {
  count: number;
  childCount: number;
}

export interface AlbumSearchNode extends AlbumNode {
  parentPathNames: string | null;
}

export interface AddToAlbumResult {
  added: number;
  attempted: number;
  canAdd: number;
  currentCount: number;
  albumChanges: AlbumImagesChangePayload[];
  view?: ViewSnapshot | null;
}

export interface RemoveFromAlbumResult {
  removed: number;
  albumChanges: AlbumImagesChangePayload[];
  view?: ViewSnapshot | null;
}

function parseParentId(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  return value && value !== "null" && value !== "undefined" ? value : null;
}

function parseFolderStatus(raw: unknown): FolderStatus | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as FolderStatus;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? (parsed as FolderStatus) : null;
  } catch {
    return null;
  }
}

function parseAlbumKind(raw: unknown): AlbumKind {
  return raw === "local_folder" || raw === "label" || raw === "label_dir" ? raw : "normal";
}

function parseAlbumSyncMode(raw: unknown): AlbumSyncMode {
  return raw === "shallow" || raw === "recursive" || raw === "delegated" ? raw : "none";
}

function optionalString(raw: unknown): string | null {
  return raw == null || raw === "" ? null : String(raw);
}

export function normalizeAlbumRow(row: Record<string, unknown>): Album {
  const type = parseAlbumKind(row.type ?? row.albumType);
  const createdAt = row.created_at ?? row.createdAt ?? 0;
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    parentId: parseParentId(row.parent_id ?? row.parentId),
    createdAt: typeof createdAt === "number" ? createdAt : Number(createdAt) || 0,
    type,
    syncFolder: optionalString(row.sync_folder ?? row.syncFolder),
    folderStatus: parseFolderStatus(row.folder_status ?? row.folderStatus),
    syncMode: parseAlbumSyncMode(row.sync_mode ?? row.syncMode),
    ancestorPath: String(row.ancestor_path ?? row.ancestorPath ?? ""),
    labelKey: isLabelForestKind(type) ? optionalString(row.label_key ?? row.labelKey) : null,
    labelPath: isLabelForestKind(type) ? optionalString(row.label_path ?? row.labelPath) : null,
  };
}

function metaRow(entry: ProviderListChild): Record<string, unknown> {
  return entry.meta && typeof entry.meta === "object"
    ? (entry.meta as Record<string, unknown>)
    : {};
}

function kindSegment(kinds?: ReadonlyArray<AlbumKind>): string {
  return kinds?.length ? `kind_${kinds.join(",")}/` : "";
}

function albumPagePaths(
  target: { parentId: string } | { section: AlbumRootSection },
  page: number,
  prefix: GalleryPrefix,
  kinds?: ReadonlyArray<AlbumKind>,
) {
  const kind = kindSegment(kinds);
  if ("parentId" in target) {
    const id = encodeURIComponent(target.parentId);
    return {
      images: `images://gallery/${prefix}album/${id}/${kind}subpage_${page}`,
      albums: `albums://children_${id}/${kind}subpage_${page}`,
    };
  }
  return {
    images: `images://gallery/${prefix}albums/${kind}subpage_${target.section}_${page}`,
    albums: `albums://root_${target.section}/${kind}subpage_${page}`,
  };
}

async function subtreeCount(id: string, prefix: GalleryPrefix): Promise<number> {
  return (await pathqlEntry(`images://gallery/${prefix}album-tree/${encodeURIComponent(id)}`)).total ?? 0;
}

export async function fetchAlbumPage(
  target: { parentId: string } | { section: AlbumRootSection },
  page: number,
  prefix: GalleryPrefix,
  kinds?: ReadonlyArray<AlbumKind>,
): Promise<AlbumNode[]> {
  const paths = albumPagePaths(target, page, prefix, kinds);
  const [imageRows, albumRows] = await Promise.all([
    pathqlList(paths.images, true),
    pathqlList(paths.albums, true),
  ]);
  const imagesById = new Map(imageRows.map((entry) => [entry.name, entry.total ?? 0]));
  const albumsById = new Map(albumRows.map((entry) => [entry.name, entry]));
  const rows = albumRows.map((entry) => normalizeAlbumRow(metaRow(entry)));
  const subtreeCounts = new Map<string, number>();
  await Promise.all(
    rows
      .filter((album) => album.type === "normal" || album.type === "local_folder")
      .map(async (album) => subtreeCounts.set(album.id, await subtreeCount(album.id, prefix))),
  );
  return rows.map((album) => ({
    ...album,
    childCount: albumsById.get(album.id)?.total ?? 0,
    count:
      album.type === "label_dir"
        ? (albumsById.get(album.id)?.total ?? 0)
        : album.type === "label"
          ? (imagesById.get(album.id) ?? 0)
          : (subtreeCounts.get(album.id) ?? 0),
  }));
}

export async function searchAlbums(
  query: string,
  page: number,
  prefix: GalleryPrefix,
  kinds?: ReadonlyArray<AlbumKind>,
): Promise<AlbumSearchNode[]> {
  const encoded = encodeURIComponent(query);
  const kind = kindSegment(kinds);
  const [imageRows, albumRows] = await Promise.all([
    pathqlList(`images://gallery/${prefix}albums/search/${encoded}/${kind}subpage_${page}`, true),
    pathqlList(`albums://search/${encoded}/${kind}subpage_${page}`, true),
  ]);
  const imagesById = new Map(imageRows.map((entry) => [entry.name, entry.total ?? 0]));
  const albumById = new Map(albumRows.map((entry) => [entry.name, entry]));
  const rows = albumRows.map((entry) => {
    const raw = metaRow(entry);
    return { album: normalizeAlbumRow(raw), parentPathNames: optionalString(raw.parent_path_names) };
  });
  const subtreeCounts = new Map<string, number>();
  await Promise.all(
    rows
      .map(({ album }) => album)
      .filter((album) => album.type === "normal" || album.type === "local_folder")
      .map(async (album) => subtreeCounts.set(album.id, await subtreeCount(album.id, prefix))),
  );
  return rows.map(({ album, parentPathNames }) => ({
    ...album,
    parentPathNames,
    childCount: albumById.get(album.id)?.total ?? 0,
    count:
      album.type === "label_dir"
        ? (albumById.get(album.id)?.total ?? 0)
        : album.type === "label"
          ? (imagesById.get(album.id) ?? 0)
          : (subtreeCounts.get(album.id) ?? 0),
  }));
}

export async function fetchAlbum(id: string): Promise<Album | null> {
  if (!id) return null;
  const rows = await pathqlFetch<Record<string, unknown>>(`albums://id_${encodeURIComponent(id)}`);
  return rows[0] ? normalizeAlbumRow(rows[0]) : null;
}

export async function fetchAlbumCount(album: Album, prefix: GalleryPrefix): Promise<number> {
  if (album.type === "label_dir") {
    return (await pathqlEntry(`albums://children_${encodeURIComponent(album.id)}`)).total ?? 0;
  }
  if (album.type === "label") {
    return (await pathqlEntry(`images://gallery/${prefix}album/${encodeURIComponent(album.id)}`)).total ?? 0;
  }
  return subtreeCount(album.id, prefix);
}

export async function fetchDescendantCount(id: string): Promise<number> {
  return (await pathqlEntry(`albums://subtree_${encodeURIComponent(id)}`)).total ?? 0;
}

export async function fetchAlbumAncestors(id: string): Promise<Album[]> {
  const rows = await pathqlFetch<Record<string, unknown>>(`albums://ancestors_${encodeURIComponent(id)}`);
  return rows.map(normalizeAlbumRow);
}

export async function fetchImageAlbums(imageId: string): Promise<Album[]> {
  const rows = await pathqlFetch<Record<string, unknown>>(`albums://of_image_${encodeURIComponent(imageId)}`);
  return rows.map(normalizeAlbumRow);
}

export async function fetchLocalFolderAlbums(): Promise<Album[]> {
  const rows = await pathqlFetch<Record<string, unknown>>("albums://byType/local_folder");
  return rows.map(normalizeAlbumRow);
}

function publishAlbumChanges(changes: AlbumImagesChangePayload[]) {
  for (const change of changes) publishLocal(albumChangeBatch(change));
}

function structuralBatch(album: Album | null, kind: string, extraPath?: string): ChangeBatch {
  const paths = [album?.ancestorPath, extraPath].filter((path): path is string => !!path);
  return {
    images: new Set(), imageIds: new Set(), taskIds: new Set(), surfRecordIds: new Set(), pluginIds: new Set(),
    albumImages: new Set(), albumIds: new Set(album ? [album.id] : []), albumImageIds: new Set(), favoriteOps: [],
    albumStructure: new Set([kind]), albumPaths: new Set(paths), albumPathsWildcard: paths.length === 0,
    wildcard: { task: false, surf: false, plugin: false }, maxSeq: 0,
  };
}

function errorMessage(error: unknown): Error {
  return new Error(typeof error === "string" ? error : error instanceof Error ? error.message : String(error));
}

export async function createAlbum(name: string, opts: { reload?: boolean; parentId?: string | null } = {}) {
  try {
    const created = normalizeAlbumRow(await invoke<Record<string, unknown>>("add_album", { name, parentId: opts.parentId ?? null }));
    publishLocal(structuralBatch(created, "added"));
    return created;
  } catch (error) { throw errorMessage(error); }
}

export async function createLabelAlbum(args: { key: string; name?: string | null; parentId?: string | null; directory?: boolean }) {
  try {
    const created = normalizeAlbumRow(await invoke<Record<string, unknown>>("add_label_album", {
      key: args.key, name: args.name?.trim() || null, parentId: args.parentId ?? null, directory: args.directory ?? false,
    }));
    publishLocal(structuralBatch(created, "added"));
    return created;
  } catch (error) { throw errorMessage(error); }
}

export async function createLocalFolderAlbum(
  args: { name: string; syncFolder: string; recursive: boolean; parentId?: string | null },
  _opts: { reload?: boolean } = {},
) {
  try {
    const raw = await invoke<unknown>("add_local_folder_album", {
      name: args.name, parentId: args.parentId ?? null, syncFolder: args.syncFolder, recursive: args.recursive,
    });
    const rows = (Array.isArray(raw) ? raw : [raw]).map((row) => normalizeAlbumRow(row as Record<string, unknown>));
    for (const row of rows) publishLocal(structuralBatch(row, "added"));
    return rows;
  } catch (error) { throw errorMessage(error); }
}

export async function renameAlbum(albumId: string, newName: string) {
  const album = await fetchAlbum(albumId);
  try {
    await invoke("rename_album", { albumId, newName });
    publishLocal(structuralBatch(album, "name"));
  } catch (error) { throw errorMessage(error); }
}

export async function moveAlbum(albumId: string, newParentId: string | null) {
  const before = await fetchAlbum(albumId);
  try {
    await invoke("move_album", { albumId, newParentId });
    const after = await fetchAlbum(albumId);
    publishLocal(structuralBatch(after, "parentId", before?.ancestorPath));
  } catch (error) { throw errorMessage(error); }
}

export async function setLabelKey(albumId: string, newKey: string) {
  const album = await fetchAlbum(albumId);
  try {
    await invoke("set_label_key", { albumId, newKey });
    publishLocal(structuralBatch(album, "labelKey"));
  } catch (error) { throw errorMessage(error); }
}

export async function deleteAlbum(albumId: string) {
  const album = await fetchAlbum(albumId);
  const settingsStore = useSettingsStore();
  if (settingsStore.values.wallpaperRotationAlbumId === albumId) {
    await ElMessageBox.confirm(
      i18n.global.t("albums.deleteAlbumRotationConfirm"),
      i18n.global.t("albums.deleteAlbumRotationTitle"),
      { type: "warning", dangerouslyUseHTMLString: true, confirmButtonText: i18n.global.t("common.ok"), cancelButtonText: i18n.global.t("common.cancel") },
    );
  }
  await invoke("delete_album", { albumId });
  publishLocal(structuralBatch(album, "deleted"));
}

export async function addImagesToAlbum(albumId: string, imageIds: string[], opts?: { view?: ViewQuery | null }): Promise<AddToAlbumResult> {
  const result = await invoke<AddToAlbumResult>("add_images_to_album", { albumId, imageIds, view: opts?.view ?? null });
  publishAlbumChanges(result.albumChanges);
  return result;
}

export async function addTaskImagesToAlbum(taskId: string, albumId: string, opts?: { view?: ViewQuery | null }): Promise<AddToAlbumResult> {
  const result = await invoke<AddToAlbumResult>("add_task_images_to_album", { taskId, albumId, view: opts?.view ?? null });
  publishAlbumChanges(result.albumChanges);
  return result;
}

export async function removeImagesFromAlbum(albumId: string, imageIds: string[], opts?: { view?: ViewQuery | null }): Promise<RemoveFromAlbumResult> {
  if (!imageIds.length) return { removed: 0, albumChanges: [] };
  const result = await invoke<RemoveFromAlbumResult>("remove_images_from_album", { albumId, imageIds, view: opts?.view ?? null });
  publishAlbumChanges(result.albumChanges);
  return result;
}
