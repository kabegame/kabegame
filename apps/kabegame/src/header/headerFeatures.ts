import {
  AppWindow,
  ArrowUpDown,
  CircleStop,
  CircleX,
  EyeOff,
  FileText,
  FolderOpen,
  FolderPlus,
  Funnel,
  HardDrive,
  Info,
  LayoutGrid,
  PanelLeft,
  Plus,
  RefreshCw,
  RotateCw,
  Rows3,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Upload,
} from "@lucide/vue";
import { useHeaderStore, HeaderFeatureId } from "@/stores/header";
import { i18n } from "@kabegame/i18n";

import CollectAction from "./comps/CollectAction.vue";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";
import FailedImagesHeaderButton from "@/components/common/FailedImagesHeaderButton.vue";
import GallerySortControl from "./comps/GallerySortControl.vue";

const t = (key: string) => i18n.global.t(key);

/**
 * 注册所有 header features 到 store
 */
export function registerHeaderFeatures() {
  const store = useHeaderStore();

  store.register([
    {
      id: HeaderFeatureId.Refresh,
      label: t("header.refresh"),
      icon: RefreshCw,
    },
    {
      id: HeaderFeatureId.AlbumTree,
      label: t("header.albumTree"),
      icon: PanelLeft,
    },
    {
      id: HeaderFeatureId.AlbumInfo,
      label: t("header.albumInfo"),
      icon: Info,
    },
    {
      id: HeaderFeatureId.StopTask,
      label: t("header.stopTask"),
      icon: CircleStop,
    },
    {
      id: HeaderFeatureId.DeleteTask,
      label: t("header.deleteTask"),
      icon: Trash2,
    },
    {
      id: HeaderFeatureId.Collect,
      label: t("header.collect"),
      icon: Plus,
      comp: CollectAction,
    },
    {
      id: HeaderFeatureId.CreateAlbum,
      label: t("header.createAlbum"),
      icon: FolderPlus,
    },
    {
      id: HeaderFeatureId.OpenVirtualDrive,
      label: t("header.openVirtualDrive"),
      icon: HardDrive,
    },
    {
      id: HeaderFeatureId.AddToAlbum,
      label: t("header.addToAlbum"),
      icon: FolderPlus,
    },
    {
      id: HeaderFeatureId.ImportSource,
      label: t("header.importSource"),
      icon: Upload,
    },
    {
      id: HeaderFeatureId.ManageSources,
      label: t("header.manageSources"),
      icon: LayoutGrid,
    },
    {
      id: HeaderFeatureId.TaskDrawer,
      comp: TaskDrawerButton,
    },
    {
      id: HeaderFeatureId.TaskViewLog,
      label: t("tasks.drawerViewLog"),
      icon: FileText,
    },
    {
      id: HeaderFeatureId.TaskViewParams,
      label: t("tasks.drawerViewParams"),
      icon: SlidersHorizontal,
    },
    {
      id: HeaderFeatureId.TaskRerun,
      label: t("contextMenu.rerunTask"),
      icon: RotateCw,
    },
    {
      id: HeaderFeatureId.OpenTaskWebview,
      label: t("tasks.openTaskWebview"),
      icon: AppWindow,
    },
    {
      id: HeaderFeatureId.FailedImages,
      label: t("header.failedImages"),
      icon: TriangleAlert,
      comp: FailedImagesHeaderButton,
    },
    {
      id: HeaderFeatureId.GallerySort,
      label: t("header.gallerySort"),
      icon: ArrowUpDown,
      comp: GallerySortControl,
    },
    {
      id: HeaderFeatureId.GalleryPageSize,
      label: t("header.galleryPageSize"),
      icon: Rows3,
    },
    {
      id: HeaderFeatureId.FailedImagesCancelWaiting,
      label: t("header.failedImagesCancelWaiting"),
      icon: CircleX,
    },
    {
      id: HeaderFeatureId.FailedImagesRetryAll,
      label: t("header.failedImagesRetryAll"),
      icon: RefreshCw,
    },
    {
      id: HeaderFeatureId.FailedImagesDeleteAll,
      label: t("header.failedImagesDeleteAll"),
      icon: Trash2,
    },
    {
      id: HeaderFeatureId.FailedImagesFilter,
      label: t("header.failedImagesFilter"),
      icon: Funnel,
    },
    {
      id: HeaderFeatureId.ToggleShowHidden,
      label: t("header.hideHidden"),
      icon: EyeOff,
    },
    {
      id: HeaderFeatureId.ToggleShowAlbumImages,
      label: t("header.hideAlbumImages"),
      icon: FolderOpen,
    },
  ]);
}
