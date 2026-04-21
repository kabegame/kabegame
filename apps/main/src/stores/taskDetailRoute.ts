import { createPathRouteStore } from "./pathRoute";
import { useSettingsStore } from "@kabegame/core/stores/settings";

const DEFAULT_PAGE_SIZE = 100;

type TaskDetailRouteState = {
  taskId: string;
  page: number;
  pageSize: number;
};

function createDefaultState(): TaskDetailRouteState {
  const settings = useSettingsStore();
  return {
    taskId: "",
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? DEFAULT_PAGE_SIZE,
  };
}

function parseTaskDetailPath(path: string): TaskDetailRouteState {
  const segs = path.split("/").filter(Boolean);
  const taskId = segs[1] || "";
  // segs: ["task", taskId, ...optional x{n}x..., page]
  let pageSize = DEFAULT_PAGE_SIZE;
  let rest = segs.slice(2);
  const psMatch = rest[0]?.match(/^x(\d+)x$/);
  if (psMatch) {
    pageSize = parseInt(psMatch[1]!, 10) || DEFAULT_PAGE_SIZE;
    rest = rest.slice(1);
  }
  const pageRaw = Number.parseInt(rest[0] ?? "1", 10);
  return {
    taskId,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    pageSize,
  };
}

export const useTaskDetailRouteStore = createPathRouteStore<TaskDetailRouteState>(
  "taskDetailRoute",
  {
    parse: parseTaskDetailPath,
    build: (state) => {
      const ps = state.pageSize === DEFAULT_PAGE_SIZE ? "" : `x${state.pageSize}x/`;
      return `task/${state.taskId}/${ps}${Math.max(1, state.page)}`;
    },
    defaultState: createDefaultState,
    routeName: "TaskDetail",
    // TaskDetail 永远不参与 hide：URL 里永不出现 `hide/` 前缀
    ignoreHide: () => true,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
