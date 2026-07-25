import { defineStore } from "pinia";
import { shallowRef } from "vue";

export interface ToggleBridge {
  get: () => boolean;
  set: (value: boolean) => void;
}

/**
 * 承载「语义上是页面级、但入口收进了全局工具箱」的动作/开关。
 * 当前挂载的页面在 onMounted 里注册，onUnmounted 里清空；
 * 工具箱不关心具体页面是谁，只读取当前注册的桥接。
 */
export const usePageBridgeStore = defineStore("pageBridge", () => {
  const refresh = shallowRef<(() => void) | null>(null);
  const toggleShowHidden = shallowRef<ToggleBridge | null>(null);
  const toggleShowAlbumImages = shallowRef<ToggleBridge | null>(null);

  function setRefresh(fn: (() => void) | null) {
    refresh.value = fn;
  }
  function setToggleShowHidden(bridge: ToggleBridge | null) {
    toggleShowHidden.value = bridge;
  }
  function setToggleShowAlbumImages(bridge: ToggleBridge | null) {
    toggleShowAlbumImages.value = bridge;
  }

  return {
    refresh,
    toggleShowHidden,
    toggleShowAlbumImages,
    setRefresh,
    setToggleShowHidden,
    setToggleShowAlbumImages,
  };
});
