import type { QuickSettingsPageId } from "../stores/quick-settings-drawer";
import type { QuickSettingGroup } from "@kabegame/core/components/settings/quick-settings-registry-types";

import SettingNumberControl from "@kabegame/core/components/settings/controls/SettingNumberControl.vue";
import SettingSwitchControl from "@kabegame/core/components/settings/controls/SettingSwitchControl.vue";
import DefaultDownloadDirSetting from "@kabegame/core/components/settings/items/DefaultDownloadDirSetting.vue";

export const QUICK_SETTINGS_GROUPS: QuickSettingGroup<QuickSettingsPageId>[] = [
  {
    id: "download",
    title: "下载 / 调试",
    description:
      "影响测试任务的下载行为与默认输出目录（与主程序共用，落盘生效）",
    items: [
      {
        key: "maxConcurrentDownloads",
        label: "最大并发下载量",
        description: "同时下载的图片数量（1-10）",
        comp: SettingNumberControl,
        props: {
          settingKey: "maxConcurrentDownloads",
          command: "set_max_concurrent_downloads",
          buildArgs: (value: number) => ({ count: value }),
          min: 1,
          max: 10,
          step: 1,
        },
        pages: ["plugin-editor"],
      },
      {
        key: "networkRetryCount",
        label: "网络失效重试次数",
        description: "下载图片遇到网络错误/超时等情况时，额外重试次数（0-10）",
        comp: SettingNumberControl,
        props: {
          settingKey: "networkRetryCount",
          command: "set_network_retry_count",
          buildArgs: (value: number) => ({ count: value }),
          min: 0,
          max: 10,
          step: 1,
        },
        pages: ["plugin-editor"],
      },
      {
        key: "autoDeduplicate",
        label: "自动去重",
        description: "根据文件哈希值自动跳过重复图片",
        comp: SettingSwitchControl,
        props: {
          settingKey: "autoDeduplicate",
          command: "set_auto_deduplicate",
          buildArgs: (value: boolean) => ({ enabled: value }),
        },
        pages: ["plugin-editor"],
      },
      {
        key: "defaultDownloadDir",
        label: "默认下载目录",
        description:
          "未在任务里指定输出目录时，将下载到该目录（按插件分文件夹保存）",
        comp: DefaultDownloadDirSetting,
        pages: ["plugin-editor"],
      },
    ],
  },
];
