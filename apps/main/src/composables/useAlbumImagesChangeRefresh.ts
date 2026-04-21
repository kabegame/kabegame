import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { useTrailingThrottleFn } from "@/composables/useTrailingThrottle";
import { listen } from "@/api/rpc";

/** 后端 `DaemonEvent::AlbumImagesChange` / 事件名 `album-images-change` */
export type AlbumImagesChangePayload = {
  reason: "add" | "delete" | string;
  albumIds: string[];
  imageIds: string[];
};

type UnlistenFn = () => void;

/**
 * 监听 `album-images-change`（`album_images` 表增删），节流与 `useImagesChangeRefresh` 一致。
 */
export function useAlbumImagesChangeRefresh(params: {
  enabled: Ref<boolean>;
  waitMs?: number;
  filter?: (payload: AlbumImagesChangePayload) => boolean;
  onRefresh: (payload: AlbumImagesChangePayload) => void | Promise<void>;
}) {
  const waitMs = params.waitMs ?? 250;

  let unlisten: UnlistenFn | null = null;
  const throttled = useTrailingThrottleFn(async (payload: AlbumImagesChangePayload) => {
    await params.onRefresh(payload);
  }, waitMs);

  const stop = () => {
    throttled.cancel();
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  const start = async () => {
    if (unlisten) return;
    unlisten = await listen<AlbumImagesChangePayload>("album-images-change", async (event) => {
      const payload = (event?.payload ?? {}) as AlbumImagesChangePayload;
      if (params.filter && !params.filter(payload)) {
        return;
      }
      await throttled.trigger(payload);
    });
  };

  const sync = async (enabled: boolean) => {
    if (enabled) {
      await start();
    } else {
      stop();
    }
  };

  onMounted(() => void sync(params.enabled.value));
  watch(
    () => params.enabled.value,
    (v) => void sync(v)
  );
  onBeforeUnmount(() => {
    stop();
  });
}
