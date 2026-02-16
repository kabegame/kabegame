import { defineStore } from "pinia";
import { ref, computed, type Component } from "vue";

export interface DesktopSelectionAction {
  key: string;
  label: string;
  icon: Component;
  command: string;
}

/**
 * 全局「当前桌面」选择状态：由当前页面的选择数量决定。
 * 不维护「哪一页激活」的页级状态，仅根据 selectedCount > 0 决定是否显示选择栏。
 */
export const useDesktopSelectionStore = defineStore("desktopSelection", () => {
  const selectedCount = ref(0);
  const actions = ref<DesktopSelectionAction[]>([]);
  const onCommand = ref<((cmd: string) => void) | null>(null);
  const onExit = ref<(() => void) | null>(null);

  const set = (
    count: number,
    actionItems: DesktopSelectionAction[],
    commandHandler: (cmd: string) => void,
    exitHandler: () => void
  ) => {
    selectedCount.value = count;
    actions.value = actionItems;
    onCommand.value = commandHandler;
    onExit.value = exitHandler;
  };

  const update = (count: number, actionItems: DesktopSelectionAction[]) => {
    selectedCount.value = count;
    actions.value = actionItems;
  };

  const clear = () => {
    selectedCount.value = 0;
    actions.value = [];
    onCommand.value = null;
    onExit.value = null;
  };

  const executeCommand = (cmd: string) => {
    if (selectedCount.value <= 0 || !onCommand.value) return;
    onCommand.value(cmd);
  };

  const exit = () => {
    if (onExit.value) onExit.value();
    clear();
  };

  const active = computed(() => selectedCount.value > 0);

  return {
    selectedCount,
    actions,
    active,
    set,
    update,
    clear,
    executeCommand,
    exit,
  };
});
