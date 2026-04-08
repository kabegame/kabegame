import { createPathRouteStore } from "./pathRoute";

type SurfImagesRouteState = {
  host: string;
  page: number;
};

const defaultState: SurfImagesRouteState = {
  host: "",
  page: 1,
};

export const useSurfImagesRouteStore = createPathRouteStore<SurfImagesRouteState>(
  "surfImagesRoute",
  {
    parse: (path) => {
      const segs = path.split("/").filter(Boolean);
      const pageRaw = Number.parseInt(segs[2] ?? "1", 10);
      return {
        host: segs[1] || "",
        page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      };
    },
    build: (state) => `surf/${state.host}/${Math.max(1, state.page)}`,
    defaultState,
  }
);
