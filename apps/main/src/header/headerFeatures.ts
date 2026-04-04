import {
  QuestionFilled,
  Setting,
  Refresh,
  Plus,
  FolderOpened,
  FolderAdd,
  Picture,
  Delete,
  Upload,
  Grid,
  VideoPause,
  Sort,
  Filter,
  Monitor,
  Histogram,
  CircleClose,
  WarningFilled,
  Document,
} from "@element-plus/icons-vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { i18n } from "@kabegame/i18n";

import CollectAction from "./comps/CollectAction.vue";
import OrganizeHeaderControl from "./comps/OrganizeHeaderControl.vue";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";
import FailedImagesHeaderButton from "@/components/common/FailedImagesHeaderButton.vue";
import GalleryFilterControl from "./comps/GalleryFilterControl.vue";
import GallerySortControl from "./comps/GallerySortControl.vue";

const t = (key: string) => i18n.global.t(key);

/**
 * 注册所有 header features 到 store
 */
export function registerHeaderFeatures() {
  const store = useHeaderStore();

  store.register([
    {
      id: HeaderFeatureId.Help,
      label: t("header.help"),
      icon: QuestionFilled,
    },
    {
      id: HeaderFeatureId.QuickSettings,
      label: t("header.quickSettings"),
      icon: Setting,
    },
    {
      id: HeaderFeatureId.Refresh,
      label: t("header.refresh"),
      icon: Refresh,
    },
    {
      id: HeaderFeatureId.StopTask,
      label: t("header.stopTask"),
      icon: VideoPause,
    },
    {
      id: HeaderFeatureId.DeleteTask,
      label: t("header.deleteTask"),
      icon: Delete,
    },
    {
      id: HeaderFeatureId.Organize,
      label: t("header.organize"),
      icon: FolderOpened,
      comp: OrganizeHeaderControl,
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
      icon: Plus,
    },
    {
      id: HeaderFeatureId.OpenVirtualDrive,
      label: t("header.openVirtualDrive"),
      icon: FolderOpened,
    },
    {
      id: HeaderFeatureId.AddToAlbum,
      label: t("header.addToAlbum"),
      icon: FolderAdd,
    },
    {
      id: HeaderFeatureId.SetAsWallpaperCarousel,
      label: t("header.setAsWallpaperCarousel"),
      icon: Picture,
    },
    {
      id: HeaderFeatureId.DeleteAlbum,
      label: t("header.deleteAlbum"),
      icon: Delete,
    },
    {
      id: HeaderFeatureId.ImportSource,
      label: t("header.importSource"),
      icon: Upload,
    },
    {
      id: HeaderFeatureId.ManageSources,
      label: t("header.manageSources"),
      icon: Grid,
    },
    {
      id: HeaderFeatureId.TaskDrawer,
      comp: TaskDrawerButton,
    },
    {
      id: HeaderFeatureId.TaskViewLog,
      label: t("tasks.drawerViewLog"),
      icon: Document,
    },
    {
      id: HeaderFeatureId.FailedImages,
      label: t("header.failedImages"),
      icon: WarningFilled,
      comp: FailedImagesHeaderButton,
    },
    {
      id: HeaderFeatureId.GalleryFilter,
      label: t("gallery.filter"),
      icon: Filter,
      comp: GalleryFilterControl,
    },
    {
      id: HeaderFeatureId.GallerySort,
      label: t("header.gallerySort"),
      icon: Sort,
      comp: GallerySortControl,
    },
    {
      id: HeaderFeatureId.GalleryPageSize,
      label: t("header.galleryPageSize"),
      icon: Histogram,
    },
    {
      id: HeaderFeatureId.AlbumBrowseFilter,
      label: t("gallery.filter"),
      icon: Filter,
    },
    {
      id: HeaderFeatureId.AlbumBrowseSort,
      label: t("header.gallerySort"),
      icon: Sort,
    },
    {
      id: HeaderFeatureId.OpenCrawlerWebview,
      label: t("header.openCrawlerWebview"),
      icon: Monitor,
    },
    {
      id: HeaderFeatureId.FailedImagesCancelWaiting,
      label: t("header.failedImagesCancelWaiting"),
      icon: CircleClose,
    },
    {
      id: HeaderFeatureId.FailedImagesRetryAll,
      label: t("header.failedImagesRetryAll"),
      icon: Refresh,
    },
    {
      id: HeaderFeatureId.FailedImagesDeleteAll,
      label: t("header.failedImagesDeleteAll"),
      icon: Delete,
    },
    {
      id: HeaderFeatureId.FailedImagesFilter,
      label: t("header.failedImagesFilter"),
      icon: Filter,
    },
  ]);
}