import { createPathRouteStore } from "./pathRoute";

type SurfImagesRouteState = {
  recordId: string;
  page: number;
};

const defaultState: SurfImagesRouteState = {
  recordId: "",
  page: 1,
};

export const useSurfImagesRouteStore = createPathRouteStore<SurfImagesRouteState>(
  "surfImagesRoute",
  {
    parse: (path) => {
      const segs = path.split("/").filter(Boolean);
      const pageRaw = Number.parseInt(segs[2] ?? "1", 10);
      return {
        recordId: segs[1] || "",
        page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      };
    },
    build: (state) => `surf/${state.recordId}/${Math.max(1, state.page)}`,
    defaultState,
  }
);
