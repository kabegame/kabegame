import { invoke } from "@/api/rpc";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import { albumChangeBatch, publishLocal, type ChangeBatch } from "@/services/dataChangeHub";
import type { TreePage } from "@/components/tree/types";
import { pathqlEntry, pathqlFetch, type PathqlQuery } from "@/services/pathql";
import { ElMessageBox } from "@kabegame/element-plus";
import { i18n } from "@kabegame/i18n";
import { useSettingsStore } from "@/stores/settings";
import { isLabelForestKind, type AlbumKind, type AlbumSyncMode } from "@/types/album";

export type { AlbumKind, AlbumSyncMode } from "@/types/album";

export const HIDDEN_ALBUM_ID = "00000000-0000-0000-0000-000000000000";
export const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";
export const ALBUM_PAGE_SIZE = 500;

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
  /** null = 图片计数还在路上（与行分开查询，见 `albumPageQueries`）。 */
  count: number | null;
  childCount: number;
}

export interface AddToAlbumResult {
  added: number;
  attempted: number;
  canAdd: number;
  currentCount: number;
  albumChanges: AlbumImagesChangePayload[];
}

export interface RemoveFromAlbumResult {
  removed: number;
  albumChanges: AlbumImagesChangePayload[];
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

const SECTION_KINDS: Record<AlbumRootSection, AlbumKind[]> = {
  normal: ["normal"],
  label: ["label", "label_dir"],
  local_folder: ["local_folder"],
};

/** `album_kind/<kind>/`；多个类型用 PathQL 路径组合器 `~any/.../~or/.../~end/` 取 OR。 */
function albumKindSegment(kinds?: ReadonlyArray<AlbumKind>): string {
  if (!kinds?.length) return "";
  if (kinds.length === 1) return `album_kind/${kinds[0]}/`;
  return `~any/${kinds.map((kind) => `album_kind/${kind}`).join("/~or/")}/~end/`;
}

/** 过滤段 + 分页段：`<scope>/<类型段>x<页大小>x/<页>`；fetch 它即这一页的画册行。 */
function albumPageBase(
  scope: string,
  kinds: ReadonlyArray<AlbumKind> | undefined,
  page: number,
  pageSize: number,
): string {
  return `albums://${scope}/${albumKindSegment(kinds)}x${pageSize}x/${page}`;
}

/** 搜索过滤段 `search/<q>/`：保留自身或子孙的名称 / 标签路径命中的画册，树形不变。 */
function albumSearchSegment(search?: string): string {
  const query = search?.trim();
  return query ? `search/${encodeURIComponent(query)}/` : "";
}

/** `~~` 之后的计数行（每个画册一行，`id` + 计数列）→ id → 计数；没有行的画册计数为 0。 */
function countsById(rows: Record<string, unknown>[], column: "child_count" | "image_count"): Map<string, number> {
  return new Map(rows.map((row) => [String(row.id), Number(row[column] ?? 0)]));
}

/** 描述一页画册：行与子画册数在同一快照，图片计数独立补充，不挡行渲染；没有允许类型时返回 null（不读）。 */
export function albumPageQueries(
  target: { parentId: string } | { section: AlbumRootSection },
  page: number,
  prefix: GalleryPrefix,
  kinds?: ReadonlyArray<AlbumKind>,
  pageSize: number = ALBUM_PAGE_SIZE,
  search?: string,
): TreePage<AlbumNode> | null {
  const scope = "parentId" in target ? `parent/${encodeURIComponent(target.parentId)}` : "roots";
  const effectiveKinds = kinds ?? ("section" in target ? SECTION_KINDS[target.section] : undefined);
  const base = albumPageBase(
    `${scope}/${albumSearchSegment(search)}`.replace(/\/$/, ""),
    effectiveKinds,
    page,
    pageSize,
  );
  const childFilters = `${albumSearchSegment(search)}${albumKindSegment(effectiveKinds)}`.replace(/\/$/, "");
  if (effectiveKinds?.length === 0) return null;
  return {
    queries: [
      { kind: "fetch", path: base },
      { kind: "fetch", path: `${base}/~~/children${childFilters ? `/${childFilters}` : ""}` },
    ],
    parse(results) {
      const children = countsById(results[1] as Record<string, unknown>[], "child_count");
      return (results[0] as Record<string, unknown>[]).map((row) => {
        const album = normalizeAlbumRow(row);
        const childCount = children.get(album.id) ?? 0;
        return { ...album, childCount, count: album.type === "label_dir" ? childCount : null };
      });
    },
    extra: {
      // 分组没有行代表 0；同快照读本页 id，补充结果先于结构到达时也能完整补零。
      queries: [
        { kind: "fetch", path: base },
        { kind: "fetch", path: `${base}/~~/images${prefix === "hide/" ? "/hide" : ""}` },
      ],
      parse(results) {
        const counts = countsById(results[1] as Record<string, unknown>[], "image_count");
        return new Map(
          (results[0] as Record<string, unknown>[])
            .map(normalizeAlbumRow)
            .filter((album) => album.type !== "label_dir")
            .map((album) => [album.id, { count: counts.get(album.id) ?? 0 }]),
        );
      },
    },
  };
}

/** 不限层级地找自身或子孙命中 `query` 的画册（例如查重名时再按 `name` 精确比较）；只取行，不带计数。 */
export async function searchAlbums(
  query: string,
  page: number,
  kinds?: ReadonlyArray<AlbumKind>,
  pageSize: number = ALBUM_PAGE_SIZE,
): Promise<Album[]> {
  const base = albumPageBase(albumSearchSegment(query).replace(/\/$/, ""), kinds, page, pageSize);
  return (await pathqlFetch<Record<string, unknown>>(base)).map(normalizeAlbumRow);
}

export async function fetchAlbum(id: string): Promise<Album | null> {
  if (!id) return null;
  const rows = await pathqlFetch<Record<string, unknown>>(`albums://id_${encodeURIComponent(id)}`);
  return rows[0] ? normalizeAlbumRow(rows[0]) : null;
}

/** 当前画册头部计数：标签目录数直接子画册，其余数直接成员或子树图片，不叠加隐藏过滤。 */
export function albumImageCountQuery(album: Album): PathqlQuery & { kind: "count" } {
  const id = encodeURIComponent(album.id);
  const path =
    album.type === "label_dir"
      ? `albums://parent/${id}`
      : `images://gallery/${album.type === "label" ? "album" : "album-tree"}/${id}`;
  return { kind: "count", path };
}

export async function fetchDescendantCount(id: string): Promise<number> {
  return (await pathqlEntry(`albums://subtree_${encodeURIComponent(id)}`)).total ?? 0;
}

export async function fetchAlbumAncestors(id: string): Promise<Album[]> {
  const rows = await pathqlFetch<Record<string, unknown>>(`albums://ancestors_${encodeURIComponent(id)}`);
  return rows.map(normalizeAlbumRow);
}

/** 图片直接所属的画册；`kinds` 走路径上的 `album_kind` 段由后端过滤，不在前端筛。 */
export async function fetchImageAlbums(imageId: string, kinds?: ReadonlyArray<AlbumKind>): Promise<Album[]> {
  // albumKindSegment 带尾斜杠（供拼分页段用），这里是路径末段，去掉它
  const kindSegment = albumKindSegment(kinds).replace(/\/$/, "");
  const scope = `of_image_${encodeURIComponent(imageId)}`;
  const rows = await pathqlFetch<Record<string, unknown>>(`albums://${scope}${kindSegment ? `/${kindSegment}` : ""}`);
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
    runConfigs: new Map(),
    images: new Set(),
    imageIds: new Set(),
    imagePatches: new Map(),
    taskIds: new Set(),
    surfRecordIds: new Set(),
    pluginIds: new Set(),
    albumImages: new Set(),
    albumIds: new Set(album ? [album.id] : []),
    albumImageIds: new Set(),
    favoriteOps: [],
    albumStructure: new Set([kind]),
    albumPaths: new Set(paths),
    albumPathsWildcard: paths.length === 0,
    wildcard: { task: false, surf: false, plugin: false },
    maxSeq: 0,
  };
}

function errorMessage(error: unknown): Error {
  return new Error(typeof error === "string" ? error : error instanceof Error ? error.message : String(error));
}

export async function createAlbum(name: string, opts: { reload?: boolean; parentId?: string | null } = {}) {
  try {
    const created = normalizeAlbumRow(
      await invoke<Record<string, unknown>>("add_album", { name, parentId: opts.parentId ?? null }),
    );
    publishLocal(structuralBatch(created, "added"));
    return created;
  } catch (error) {
    throw errorMessage(error);
  }
}

export async function createLabelAlbum(args: {
  key: string;
  name?: string | null;
  parentId?: string | null;
  directory?: boolean;
}) {
  try {
    const created = normalizeAlbumRow(
      await invoke<Record<string, unknown>>("add_label_album", {
        key: args.key,
        name: args.name?.trim() || null,
        parentId: args.parentId ?? null,
        directory: args.directory ?? false,
      }),
    );
    publishLocal(structuralBatch(created, "added"));
    return created;
  } catch (error) {
    throw errorMessage(error);
  }
}

export async function createLocalFolderAlbum(
  args: { name: string; syncFolder: string; recursive: boolean; parentId?: string | null },
  _opts: { reload?: boolean } = {},
) {
  try {
    const raw = await invoke<unknown>("add_local_folder_album", {
      name: args.name,
      parentId: args.parentId ?? null,
      syncFolder: args.syncFolder,
      recursive: args.recursive,
    });
    const rows = (Array.isArray(raw) ? raw : [raw]).map((row) => normalizeAlbumRow(row as Record<string, unknown>));
    for (const row of rows) publishLocal(structuralBatch(row, "added"));
    return rows;
  } catch (error) {
    throw errorMessage(error);
  }
}

export async function renameAlbum(albumId: string, newName: string) {
  const album = await fetchAlbum(albumId);
  try {
    await invoke("rename_album", { albumId, newName });
    publishLocal(structuralBatch(album, "name"));
  } catch (error) {
    throw errorMessage(error);
  }
}

export async function moveAlbum(albumId: string, newParentId: string | null) {
  const before = await fetchAlbum(albumId);
  try {
    await invoke("move_album", { albumId, newParentId });
    const after = await fetchAlbum(albumId);
    publishLocal(structuralBatch(after, "parentId", before?.ancestorPath));
  } catch (error) {
    throw errorMessage(error);
  }
}

export async function setLabelKey(albumId: string, newKey: string) {
  const album = await fetchAlbum(albumId);
  try {
    await invoke("set_label_key", { albumId, newKey });
    publishLocal(structuralBatch(album, "labelKey"));
  } catch (error) {
    throw errorMessage(error);
  }
}

export async function deleteAlbum(albumId: string) {
  const album = await fetchAlbum(albumId);
  const settingsStore = useSettingsStore();
  if (settingsStore.values.wallpaperRotationAlbumId === albumId) {
    await ElMessageBox.confirm(
      i18n.global.t("albums.deleteAlbumRotationConfirm"),
      i18n.global.t("albums.deleteAlbumRotationTitle"),
      {
        type: "warning",
        dangerouslyUseHTMLString: true,
        confirmButtonText: i18n.global.t("common.ok"),
        cancelButtonText: i18n.global.t("common.cancel"),
      },
    );
  }
  await invoke("delete_album", { albumId });
  publishLocal(structuralBatch(album, "deleted"));
}

export async function addImagesToAlbum(albumId: string, imageIds: string[]): Promise<AddToAlbumResult> {
  const result = await invoke<AddToAlbumResult>("add_images_to_album", { albumId, imageIds });
  publishAlbumChanges(result.albumChanges);
  return result;
}

export async function addTaskImagesToAlbum(taskId: string, albumId: string): Promise<AddToAlbumResult> {
  const result = await invoke<AddToAlbumResult>("add_task_images_to_album", { taskId, albumId });
  publishAlbumChanges(result.albumChanges);
  return result;
}

export async function removeImagesFromAlbum(albumId: string, imageIds: string[]): Promise<RemoveFromAlbumResult> {
  if (!imageIds.length) return { removed: 0, albumChanges: [] };
  const result = await invoke<RemoveFromAlbumResult>("remove_images_from_album", { albumId, imageIds });
  publishAlbumChanges(result.albumChanges);
  return result;
}
