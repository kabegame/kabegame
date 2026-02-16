import { FolderOpened, Picture, Edit, Delete } from "@element-plus/icons-vue";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import type { Album } from "@/stores/albums";

/**
 * Extended context for album actions (context menu / action sheet on Albums page).
 * Must include ActionContext<Album> so ActionRenderer receives compatible context.
 */
export interface AlbumActionContext extends ActionContext<Album> {
  currentRotationAlbumId: string | null;
  wallpaperRotationEnabled: boolean;
  albumImageCount: number;
  favoriteAlbumId: string;
}

/**
 * Creates album actions for ActionRenderer (desktop ContextMenu / Android ActionSheet).
 * Replaces the legacy AlbumContextMenu.vue menu items.
 */
export function createAlbumActions(): ActionItem<Album>[] {
  return [
    {
      key: "browse",
      label: "浏览",
      icon: FolderOpened,
      command: "browse",
      visible: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "setWallpaperRotation",
      label: "设为桌面轮播",
      icon: Picture,
      command: "setWallpaperRotation",
      visible: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
      suffix: (ctx) => {
        const ext = ctx as AlbumActionContext;
        const isCurrent =
          ext.wallpaperRotationEnabled &&
          ext.target &&
          ext.currentRotationAlbumId === ext.target.id;
        return isCurrent ? "(已设置)" : "";
      },
    },
    {
      key: "rename",
      label: "重命名",
      icon: Edit,
      command: "rename",
      visible: () => true,
      dividerBefore: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "delete",
      label: "删除",
      icon: Delete,
      command: "delete",
      dividerBefore: true,
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return ext.target?.id !== ext.favoriteAlbumId;
      },
    },
  ];
}
