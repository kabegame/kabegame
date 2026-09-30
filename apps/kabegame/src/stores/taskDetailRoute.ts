import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  extractRootIdAndBody,
  DEFAULT_GALLERY_SEARCH_MODES,
  type GalleryQuery,
  type GallerySearchPathMode,
  type GallerySort,
  querySearchTerm,
} from "@/utils/galleryPath";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import router from "@/router";

const DEFAULT_PAGE_SIZE = 100;

/** 会话内记忆的搜索维度勾选，搜索词清空后兜底用——原理见 galleryRoute.ts 里同名机制的注释。 */
export const taskDetailStickySearchModes = ref<GallerySearchPathMode[]>([...DEFAULT_GALLERY_SEARCH_MODES]);

export function rememberTaskDetailSearchModes(modes: readonly GallerySearchPathMode[]): void {
  taskDetailStickySearchModes.value = [...modes];
}

type TaskDetailRouteState = {
  taskId: string;
  /** 唯一查询对象：简单过滤只是单原子查询的退化形态。 */
  query: GalleryQuery;
  sort: GallerySort;
  page: number;
  pageSize: number;
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
    query: [],
    sort: { field: "by-time", desc: false },
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? DEFAULT_PAGE_SIZE,
  };
}

export const useTaskDetailRouteStore = createPathRouteStore<TaskDetailRouteState>("taskDetailRoute", {
  settingKey: "task-detail-path",
  parse: (path) => {
    const { id: taskId, body } = extractRootIdAndBody(path, "task");
    if (!taskId) return createDefaultState();
    const parsed = parseComposablePath(body);
    const term = querySearchTerm(parsed.query);
    if (term?.query.trim()) {
      taskDetailStickySearchModes.value = [...term.modes];
    }
    return {
      taskId,
      query: parsed.query,
      sort: parsed.sort,
      page: parsed.page,
      pageSize: parsed.pageSize,
    };
  },
  build: (state, { noAlbum }) =>
    buildComposablePath({
      rootPrefix: `task/${state.taskId}`,
      noAlbum,
      query: state.query,
      sort: state.sort,
      page: state.page,
      pageSize: state.pageSize,
    }),
  buildContext: (state) => buildComposableContextPrefix(`task/${state.taskId}`, state.query),
  defaultState: createDefaultState,
  onStateChange: (state) => {
    const settings = useSettingsStore();
    if (state.pageSize !== settings.values.galleryPageSize) {
      void settings.save("galleryPageSize", state.pageSize);
    }
  },
});
