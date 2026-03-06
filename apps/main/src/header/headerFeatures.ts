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
  VideoPause
} from "@element-plus/icons-vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";

import CollectAction from "./comps/CollectAction.vue";
import OrganizeHeaderControl from "./comps/OrganizeHeaderControl.vue";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";

/**
 * 注册所有 header features 到 store
 */
export function registerHeaderFeatures() {
  const store = useHeaderStore();

  store.register([
    // 帮助
    {
      id: HeaderFeatureId.Help,
      label: "帮助",
      icon: QuestionFilled,
    },
    // 快捷设置
    {
      id: HeaderFeatureId.QuickSettings,
      label: "快捷设置",
      icon: Setting,
    },
    // 刷新
    {
      id: HeaderFeatureId.Refresh,
      label: "刷新",
      icon: Refresh,
    },
    // 停止任务
    {
      id: HeaderFeatureId.StopTask,
      label: "停止任务",
      icon: VideoPause,
    },
    // 删除任务（TaskDetail 专用）
    {
      id: HeaderFeatureId.DeleteTask,
      label: "删除任务",
      icon: Delete,
    },
    // 整理（自定义组件：内部维护进度与取消）
    {
      id: HeaderFeatureId.Organize,
      label: "整理",
      icon: FolderOpened,
      comp: OrganizeHeaderControl,
    },
    // 收集（使用自定义组件）
    {
      id: HeaderFeatureId.Collect,
      label: "收集",
      icon: Plus,
      comp: CollectAction,
    },
    // 新建画册
    {
      id: HeaderFeatureId.CreateAlbum,
      label: "新建画册",
      icon: Plus,
    },
    // 去VD查看（画册列表 / 画册详情共用）
    {
      id: HeaderFeatureId.OpenVirtualDrive,
      label: "去VD查看",
      icon: FolderOpened,
    },
    // 一键加入画册（任务详情等）
    {
      id: HeaderFeatureId.AddToAlbum,
      label: "加入画册",
      icon: FolderAdd,
    },
    // 设为轮播壁纸
    {
      id: HeaderFeatureId.SetAsWallpaperCarousel,
      label: "设为轮播壁纸",
      icon: Picture,
    },
    // 删除画册
    {
      id: HeaderFeatureId.DeleteAlbum,
      label: "删除画册",
      icon: Delete,
    },
    // 导入源
    {
      id: HeaderFeatureId.ImportSource,
      label: "导入源",
      icon: Upload,
    },
    // 管理源
    {
      id: HeaderFeatureId.ManageSources,
      label: "管理源",
      icon: Grid,
    },
    // 任务抽屉按钮（使用自定义组件）
    {
      id: HeaderFeatureId.TaskDrawer,
      comp: TaskDrawerButton,
    },
  ]);
}