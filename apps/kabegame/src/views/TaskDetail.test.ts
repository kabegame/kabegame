// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { reactive, ref, toRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskDetail from "./TaskDetail.vue";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlFetch = vi.hoisted(() => vi.fn());
const route = reactive({ name: "TaskDetail", params: { taskId: "t/a" } });
const routeStore = reactive({
  taskId: "t/a",
  query: [],
  sort: { field: "by-time", desc: false },
  computedPath: "",
  computedContextPath: "",
  effectiveNoAlbum: false,
  contextPathFor: () => "",
  navigate: vi.fn(),
  patch: vi.fn(),
  clear: vi.fn(),
});
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlFetch, pathqlAll: vi.fn() }));
vi.mock("vue-router", () => ({ useRoute: () => route, useRouter: () => ({ back: vi.fn() }) }));
vi.mock("pinia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("pinia")>()),
  storeToRefs: () => ({ taskId: toRef(routeStore, "taskId") }),
}));
vi.mock("@/stores/taskDetailRoute", () => ({
  useTaskDetailRouteStore: () => routeStore,
  rememberTaskDetailSearchModes: vi.fn(),
  taskDetailStickySearchModes: ref([]),
}));
vi.mock("@/stores/crawler", () => ({ useCrawlerStore: () => ({}) }));
vi.mock("@/stores/plugins", () => ({ usePluginStore: () => ({ plugins: [], pluginLabel: (id: string) => id }) }));
vi.mock("@/stores/ui", () => ({ useUiStore: () => ({ isCompact: false }) }));
vi.mock("@/stores/failedImages", () => ({ useFailedImagesStore: () => ({ byTaskId: () => [], loadAll: vi.fn() }) }));
vi.mock("@/composables/useModal", () => ({
  useModal: () => ({ isOpen: ref(false), zIndex: ref(1), open: vi.fn(), close: vi.fn() }),
}));
vi.mock("@/composables/useGithubIssueUrl", () => ({ useGithubIssueUrl: () => ({ openIssue: vi.fn() }) }));
vi.mock("@/composables/useTaskRerun", () => ({ useTaskRerun: () => ({ canRerun: () => false, rerunTask: vi.fn() }) }));
vi.mock("@/components/imageGrid/adapters/task", () => ({ createTaskDetailAdapter: () => ({}) }));
vi.mock("@/track/imageAnalytics", () => ({ createImageAnalytics: () => ({ track: vi.fn() }) }));
vi.mock("@/utils/webpageCollect", () => ({ canOpenTaskWebview: () => false }));
vi.mock("@/utils/kameMessage", () => ({ kameMessage: {} }));
vi.mock("@kabegame/element-plus", () => ({ ElMessageBox: {} }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ImageGrid.vue", () => ({ default: { name: "ImageGrid", render: () => null } }));
vi.mock("@/components/common/EmptyState.vue", () => ({ default: {} }));
vi.mock("@/components/gallery/GalleryQueryBar.vue", () => ({ default: {} }));
vi.mock("@/components/header/TaskDetailPageHeader.vue", () => ({ default: {} }));
vi.mock("@/components/task/TaskLogDialog.vue", () => ({ default: {} }));
vi.mock("@/components/task/TaskParamsDialog.vue", () => ({ default: {} }));
vi.mock("@/components/task/TaskCountsInline.vue", () => ({ default: {} }));
vi.mock("@/components/FailedImagesDialog.vue", () => ({ default: {} }));
vi.mock("@/components/GalleryBigPaginator.vue", () => ({ default: {} }));

function deferred() {
  let resolve!: (value: unknown[]) => void;
  const promise = new Promise<unknown[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const row = (id: string) => ({ id, plugin_id: "test", status: "running", progress: 10, success_count: 1 });
const cleanups: (() => void)[] = [];
beforeEach(() => {
  pathqlFetch.mockReset().mockResolvedValue([row("t/a")]);
  routeStore.taskId = "t/a";
  route.params.taskId = "t/a";
});
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await flushPromises();
  vi.useRealTimers();
});
function fixture() {
  const wrapper = shallowMount(TaskDetail, {
    global: { directives: { "pull-to-refresh": {} }, mocks: { $t: (key: string) => key } },
  });
  cleanups.push(() => wrapper.unmount());
  // 读取真实页面的响应式状态，避免依赖无关的图片网格与页头渲染。
  const state = wrapper.vm as unknown as { task: { id: string; progress: number; successCount: number } | null };
  return { wrapper, state };
}
const emit = (payload: unknown) => listeners.get("tasks-change")?.({ payload });

describe("TaskDetail 任务 rows 观察方", () => {
  it("进入页面请求编码后的 key 一次；已有任务的 diff 仅补丁，不请求", async () => {
    const { state } = fixture();
    expect(pathqlFetch).toHaveBeenCalledExactlyOnceWith("tasks://id_t\\/a");
    await flushPromises();
    expect(state.task).toMatchObject({ id: "t/a", progress: 10, successCount: 1 });
    pathqlFetch.mockClear();
    emit({ type: "TaskChanged", task_id: "t/a", diff: { progress: 80, success_count: 3 } });
    emit({ type: "TaskChanged", taskId: "other", diff: { progress: 99 } });
    await flushPromises();
    expect(state.task).toMatchObject({ id: "t/a", progress: 80, successCount: 3 });
    expect(pathqlFetch).not.toHaveBeenCalled();
  });

  it("首读未回时 TaskChanged 请求自身 key，旧响应不能覆盖已返回的新数据", async () => {
    const old = deferred();
    pathqlFetch.mockReturnValueOnce(old.promise);
    const { state } = fixture();
    pathqlFetch.mockResolvedValueOnce([{ ...row("t/a"), progress: 80 }]);
    emit({ type: "TaskChanged", taskId: "t/a", diff: { progress: 80 } });
    expect(pathqlFetch).toHaveBeenCalledTimes(2);
    await flushPromises();
    old.resolve([row("t/a")]);
    await flushPromises();
    expect(state.task?.progress).toBe(80);
  });

  it("换任务清空旧任务并请求新 key，旧任务迟到结果不能覆盖", async () => {
    const old = deferred();
    pathqlFetch.mockReturnValueOnce(old.promise);
    const { state } = fixture();
    const next = deferred();
    pathqlFetch.mockReturnValueOnce(next.promise);
    routeStore.taskId = "new";
    expect(state.task).toBeNull();
    expect(pathqlFetch.mock.calls.at(-1)).toEqual(["tasks://id_new"]);
    next.resolve([row("new")]);
    await flushPromises();
    old.resolve([row("t/a")]);
    await flushPromises();
    expect(state.task?.id).toBe("new");
  });

  it("仅自身删除触发刷新，读到空行置 null；卸载后不再消费事件", async () => {
    vi.useFakeTimers();
    const { wrapper, state } = fixture();
    await flushPromises();
    pathqlFetch.mockClear();
    emit({ type: "TaskDeleted", taskId: "other" });
    emit({ type: "TaskAdded", task: { id: "new" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlFetch).not.toHaveBeenCalled();
    pathqlFetch.mockResolvedValueOnce([]);
    emit({ type: "TaskDeleted", task_id: "t/a" });
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    expect(state.task).toBeNull();
    wrapper.unmount();
    pathqlFetch.mockClear();
    emit({ type: "TaskDeleted", taskId: "t/a" });
    emit({ type: "TaskChanged", taskId: "t/a", diff: { progress: 90 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlFetch).not.toHaveBeenCalled();
  });
});
