import { defineStore } from "pinia";
import { ref } from "vue";

/** 全局「运行配置」详情 / 编辑弹窗（任务抽屉闹钟、自动配置列表等共用） */
export const useAutoConfigDialogStore = defineStore("autoConfigDialog", () => {
  const visible = ref(false);
  const isCreate = ref(false);
  const configId = ref<string | null>(null);
  /** 打开已有配置时的初始面板：查看或直接进入编辑 */
  const initialPanel = ref<"view" | "edit">("view");
  /** 打开后是否滚动到定时区域（任务闹钟） */
  const scrollSchedule = ref(false);
  /** 每次打开递增，供弹窗在「已打开再打开另一配置」时重新初始化 */
  const openGeneration = ref(0);

  function openCreate() {
    isCreate.value = true;
    configId.value = null;
    initialPanel.value = "edit";
    scrollSchedule.value = false;
    openGeneration.value += 1;
    visible.value = true;
  }

  function openExisting(
    id: string,
    panel: "view" | "edit" = "view",
    opts?: { scrollSchedule?: boolean },
  ) {
    const sid = String(id || "").trim();
    if (!sid) return;
    isCreate.value = false;
    configId.value = sid;
    initialPanel.value = panel;
    scrollSchedule.value = opts?.scrollSchedule ?? false;
    openGeneration.value += 1;
    visible.value = true;
  }

  function close() {
    visible.value = false;
    scrollSchedule.value = false;
  }

  /** 滚动到定时区后调用，避免重复滚动 */
  function clearScrollSchedule() {
    scrollSchedule.value = false;
  }

  return {
    visible,
    isCreate,
    configId,
    initialPanel,
    scrollSchedule,
    openGeneration,
    openCreate,
    openExisting,
    close,
    clearScrollSchedule,
  };
});
