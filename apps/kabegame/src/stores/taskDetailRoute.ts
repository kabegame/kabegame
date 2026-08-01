import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  extractRootIdAndBody,
  DEFAULT_GALLERY_SEARCH_MODE,
  type GalleryFilterSet,
  type GallerySearchMode,
  type GallerySort,
} from "@/utils/galleryPath";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import router from "@/router";

const DEFAULT_PAGE_SIZE = 100;

/** 会话内记忆的搜索模式，清空搜索框后兜底用——原理见 galleryRoute.ts 里同名机制的注释。 */
const stickySearchMode = ref<GallerySearchMode>(DEFAULT_GALLERY_SEARCH_MODE);

export function rememberTaskDetailSearchMode(mode: GallerySearchMode): void {
  stickySearchMode.value = mode;
}

type TaskDetailRouteState = {
  taskId: string;
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
  searchMode: GallerySearchMode;
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
    searchMode: DEFAULT_GALLERY_SEARCH_MODE,
  };
}

export const useTaskDetailRouteStore = createPathRouteStore<TaskDetailRouteState>(
  "taskDetailRoute",
  {
    settingKey: "task-detail-path",
    parse: (path) => {
      const { id: taskId, body } = extractRootIdAndBody(path, "task");
      if (!taskId) return createDefaultState();
      const parsed = parseComposablePath(body);
      if (parsed.search.trim()) {
        stickySearchMode.value = parsed.searchMode;
      }
      return {
        taskId,
        filters: parsed.filters,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
        searchMode: parsed.search.trim() ? parsed.searchMode : stickySearchMode.value,
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
        searchMode: state.searchMode,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(
        `task/${state.taskId}`,
        state.search,
        state.searchMode,
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
