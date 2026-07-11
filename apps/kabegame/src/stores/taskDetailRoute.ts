import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  type GalleryFilterSet,
  type GallerySort,
} from "@/utils/galleryPath";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import router from "@/router";

const DEFAULT_PAGE_SIZE = 100;
const SEARCH_PREFIX = "search/display-name/";

type TaskDetailRouteState = {
  taskId: string;
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
};

function currentRouteTaskId(): string {
  if (router.currentRoute.value.name !== "TaskDetail") return "";
  const raw = router.currentRoute.value.params.id;
  return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
}

function createDefaultState(): TaskDetailRouteState {
  const settings = useSettingsStore();
  return {
    taskId: currentRouteTaskId(),
    filters: {},
    sort: { field: "by-time", desc: false },
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? DEFAULT_PAGE_SIZE,
    search: "",
  };
}

function extractTaskIdAndBody(path: string): { taskId: string; body: string } {
  const trimmed = (path || "").trim();
  let segs = trimmed.split("/").filter(Boolean);
  let search = "";
  if (segs.length >= 3 && segs[0] === "search" && segs[1] === "display-name") {
    try {
      search = segs[2] ?? "";
    } catch {
      search = segs[2] ?? "";
    }
    segs = segs.slice(3);
  }
  if (segs.length >= 2 && segs[0] === "task") {
    const taskId = segs[1]!;
    const body = segs.slice(2).join("/");
    const searchPrefix = search
      ? `${SEARCH_PREFIX}${search}/`
      : "";
    return { taskId, body: searchPrefix + body };
  }
  return { taskId: "", body: trimmed };
}

export const useTaskDetailRouteStore = createPathRouteStore<TaskDetailRouteState>(
  "taskDetailRoute",
  {
    settingKey: "task-detail-path",
    parse: (path) => {
      const { taskId, body } = extractTaskIdAndBody(path);
      if (!taskId) return createDefaultState();
      const parsed = parseComposablePath(body);
      return {
        taskId,
        filters: parsed.filters,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
      };
    },
    build: (state) =>
      buildComposablePath({
        rootPrefix: `task/${state.taskId}`,
        filters: state.filters,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
        search: state.search,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(
        `task/${state.taskId}`,
        state.search,
      ),
    defaultState: createDefaultState,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
