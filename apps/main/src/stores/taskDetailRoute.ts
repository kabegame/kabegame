import { createPathRouteStore } from "./pathRoute";

type TaskDetailRouteState = {
  taskId: string;
  page: number;
};

const defaultState: TaskDetailRouteState = {
  taskId: "",
  page: 1,
};

export const useTaskDetailRouteStore = createPathRouteStore<TaskDetailRouteState>(
  "taskDetailRoute",
  {
    parse: (path) => {
      const segs = path.split("/").filter(Boolean);
      const pageRaw = Number.parseInt(segs[2] ?? "1", 10);
      return {
        taskId: segs[1] || "",
        page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      };
    },
    build: (state) => `task/${state.taskId}/${Math.max(1, state.page)}`,
    defaultState,
    routeName: "TaskDetail",
    // TaskDetail 永远不参与 hide：URL 里永不出现 `hide/` 前缀
    ignoreHide: () => true,
  }
);
