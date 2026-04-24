import { createPathRouteStore } from "./pathRoute";
import { useSettingsStore } from "@kabegame/core/stores/settings";

const DEFAULT_PAGE_SIZE = 100;
const SEARCH_PREFIX = "search/display-name/";

type TaskDetailRouteState = {
  taskId: string;
  page: number;
  pageSize: number;
  /** `display_name` 子串搜索，空串表示不过滤 */
  search: string;
};

function createDefaultState(): TaskDetailRouteState {
  const settings = useSettingsStore();
  return {
    taskId: "",
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? DEFAULT_PAGE_SIZE,
    search: "",
  };
}

function parseTaskDetailPath(path: string): TaskDetailRouteState {
  const allSegs = path.split("/").filter(Boolean);
  let segs = allSegs;
  let search = "";
  if (segs.length >= 3 && segs[0] === "search" && segs[1] === "display-name") {
    try {
      search = decodeURIComponent(segs[2] ?? "");
    } catch {
      search = segs[2] ?? "";
    }
    segs = segs.slice(3);
  }
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
    search,
  };
}

export const useTaskDetailRouteStore = createPathRouteStore<TaskDetailRouteState>(
  "taskDetailRoute",
  {
    parse: parseTaskDetailPath,
    build: (state) => {
      const ps = state.pageSize === DEFAULT_PAGE_SIZE ? "" : `x${state.pageSize}x/`;
      const q = (state.search ?? "").trim();
      const sp = q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
      return `${sp}task/${state.taskId}/${ps}${Math.max(1, state.page)}`;
    },
    defaultState: createDefaultState,
    routeName: "TaskDetail",
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
