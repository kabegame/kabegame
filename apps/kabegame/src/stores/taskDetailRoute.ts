import { createPathRouteStore } from "./pathRoute";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import router from "@/router";

const DEFAULT_PAGE_SIZE = 100;
const SEARCH_PREFIX = "search/display-name/";

type TaskDetailRouteState = {
  taskId: string;
  page: number;
  pageSize: number;
  /** `display_name` 子串搜索，空串表示不过滤 */
  search: string;
};

/**
 * 当前路由的 task id（本 store 绑定在 `/tasks/:id`，`route.params.id` 才是权威）。
 * 仅在 TaskDetail 路由下取值，其它路由返回空串，避免误把别的页面 `:id` 当成 task。
 */
function currentRouteTaskId(): string {
  if (router.currentRoute.value.name !== "TaskDetail") return "";
  const raw = router.currentRoute.value.params.id;
  return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
}

function createDefaultState(): TaskDetailRouteState {
  const settings = useSettingsStore();
  return {
    // 默认 taskId 取自当前路由：切任务时 URL→state 监听在空 `?path=` 下会用 getDefault()
    // 重置 local，若此处给空串就会拼出 `task//page` 脏路径。取 route.params.id 后，
    // “重置”只把视图退回该任务第 1 页，不再抹掉 taskId。
    taskId: currentRouteTaskId(),
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
    settingKey: "task-detail-path",
    parse: parseTaskDetailPath,
    build: (state) => {
      const ps = state.pageSize === DEFAULT_PAGE_SIZE ? "" : `x${state.pageSize}x/`;
      const q = (state.search ?? "").trim();
      const sp = q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
      return `${sp}task/${state.taskId}/${ps}${Math.max(1, state.page)}`;
    },
    buildContext: (state) => {
      const q = (state.search ?? "").trim();
      const sp = q ? `${SEARCH_PREFIX}${encodeURIComponent(q)}/` : "";
      return `${sp}task/${state.taskId}`;
    },
    defaultState: createDefaultState,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
