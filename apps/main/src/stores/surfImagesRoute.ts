import { createPathRouteStore } from "./pathRoute";
import { useSettingsStore } from "@kabegame/core/stores/settings";

const DEFAULT_PAGE_SIZE = 100;

type SurfImagesRouteState = {
  host: string;
  page: number;
  pageSize: number;
};

function createDefaultState(): SurfImagesRouteState {
  const settings = useSettingsStore();
  return {
    host: "",
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? DEFAULT_PAGE_SIZE,
  };
}

function parseSurfImagesPath(path: string): SurfImagesRouteState {
  const segs = path.split("/").filter(Boolean);
  const host = segs[1] || "";
  // segs: ["surf", host, ...optional x{n}x..., page]
  let pageSize = DEFAULT_PAGE_SIZE;
  let rest = segs.slice(2);
  const psMatch = rest[0]?.match(/^x(\d+)x$/);
  if (psMatch) {
    pageSize = parseInt(psMatch[1]!, 10) || DEFAULT_PAGE_SIZE;
    rest = rest.slice(1);
  }
  const pageRaw = Number.parseInt(rest[0] ?? "1", 10);
  return {
    host,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    pageSize,
  };
}

export const useSurfImagesRouteStore = createPathRouteStore<SurfImagesRouteState>(
  "surfImagesRoute",
  {
    parse: parseSurfImagesPath,
    build: (state) => {
      const ps = state.pageSize === DEFAULT_PAGE_SIZE ? "" : `x${state.pageSize}x/`;
      return `surf/${state.host}/${ps}${Math.max(1, state.page)}`;
    },
    defaultState: createDefaultState,
    routeName: "SurfImages",
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
