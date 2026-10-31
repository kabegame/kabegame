import { onScopeDispose, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { ElMessage } from "@kabegame/element-plus";
import { invoke } from "@/api";
import { kbEvent$ } from "@/services/kbEvents/eventSource";
import { useI18n } from "@kabegame/i18n";

export interface WpeWebPropertyItem {
  key: string;
  kind: "color" | "slider" | "bool" | "combo" | "textinput" | "file" | "directory" | "group" | "text";
  label: string;
  condition?: string | null;
  default?: unknown;
  value?: unknown;
  modified: boolean;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  options: { label: string; value: string | number }[];
  extensions: string[];
  mode?: string | null;
}
export interface WpeWebPropertiesView {
  imageId: string;
  metadataId: number | null;
  items: WpeWebPropertyItem[];
}

export function useWpeWebProperties(imageId: Ref<string | null | undefined>): {
  view: Readonly<ShallowRef<WpeWebPropertiesView | null>>;
  loading: Readonly<Ref<boolean>>;
  error: Readonly<Ref<string | null>>;
  valueOf(key: string): unknown;
  isModified(item: WpeWebPropertyItem): boolean;
  set(key: string, value: unknown): void;
  reset(key: string): void;
  resetAll(): void;
  reload(): void;
} {
  const { t } = useI18n();
  const view = shallowRef<WpeWebPropertiesView | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const draft = ref<Record<string, unknown>>({});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let inFlight: { id: string; changes: Record<string, unknown> } | null = null;
  const queued: { id: string; changes: Record<string, unknown> }[] = [];
  let serial = 0;
  let landed = 0;
  let activeId = imageId.value;
  let disposed = false;

  function accept(id: string, request: number, result: WpeWebPropertiesView | null) {
    if (disposed || activeId !== id || request < landed) return;
    landed = request;
    view.value = result;
    error.value = null;
    loading.value = false;
  }
  function reload() {
    const id = activeId;
    if (!id) {
      view.value = null;
      loading.value = false;
      return;
    }
    const request = ++serial;
    loading.value = true;
    void invoke<WpeWebPropertiesView | null>("get_wpe_web_properties", { imageId: id }).then(
      (result) => accept(id, request, result),
      (failure) => {
        if (disposed || activeId !== id || request < landed) return;
        error.value = String(failure);
        loading.value = false;
      },
    );
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush(activeId);
    }, 300);
  }
  async function flush(id: string | null | undefined, force = false, snapshot?: Record<string, unknown>) {
    if (!id) return;
    if (writing) {
      if (force) {
        const changes = { ...draft.value };
        if (inFlight?.id === id) {
          for (const [key, value] of Object.entries(inFlight.changes))
            if (Object.is(changes[key], value)) delete changes[key];
        }
        if (Object.keys(changes).length) queued.push({ id, changes });
      }
      return;
    }
    const changes = snapshot ?? { ...draft.value };
    if (!Object.keys(changes).length) return;
    writing = true;
    inFlight = { id, changes };
    const request = ++serial;
    try {
      const saved = await invoke<WpeWebPropertiesView>("set_wpe_web_user_properties", { imageId: id, changes });
      if (activeId === id) {
        for (const [key, value] of Object.entries(changes))
          if (Object.is(draft.value[key], value)) delete draft.value[key];
        accept(id, request, saved);
      }
    } catch (failure) {
      ElMessage.error(`${t("gallery.wpePropsSaveFailed")}: ${String(failure)}`);
      if (activeId === id) {
        for (const [key, value] of Object.entries(changes))
          if (Object.is(draft.value[key], value)) delete draft.value[key];
        reload();
      }
    } finally {
      writing = false;
      inFlight = null;
      const next = queued.shift();
      if (next) void flush(next.id, true, next.changes);
      else if (!disposed && Object.keys(draft.value).length) schedule();
    }
  }
  function set(key: string, value: unknown) {
    draft.value = { ...draft.value, [key]: value };
    schedule();
  }
  function reset(key: string) {
    set(key, null);
  }
  function resetAll() {
    for (const item of view.value?.items ?? []) if (isModified(item)) draft.value[item.key] = null;
    draft.value = { ...draft.value };
    schedule();
  }
  function valueOf(key: string): unknown {
    const item = view.value?.items.find((entry) => entry.key === key);
    if (Object.prototype.hasOwnProperty.call(draft.value, key))
      return draft.value[key] === null ? item?.default : draft.value[key];
    return item?.value;
  }
  function isModified(item: WpeWebPropertyItem): boolean {
    if (Object.prototype.hasOwnProperty.call(draft.value, item.key))
      return draft.value[item.key] !== null && !Object.is(draft.value[item.key], item.default);
    return item.modified;
  }
  watch(
    imageId,
    (next, previous) => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (previous && Object.keys(draft.value).length) void flush(previous, true);
      activeId = next;
      draft.value = {};
      view.value = null;
      reload();
    },
    { immediate: true },
  );
  const changed = kbEvent$<{ patch?: { id: string; metadataId?: number } }>("image-changed").subscribe((event) => {
    const patch = event.payload.patch;
    if (patch && patch.id === activeId && patch.metadataId !== undefined && patch.metadataId !== view.value?.metadataId)
      reload();
  });
  const changes = kbEvent$<{ patches?: { id: string; metadataId?: number }[] }>("images-change").subscribe((event) => {
    if (
      event.payload.patches?.some(
        (patch) =>
          patch &&
          patch.id === activeId &&
          patch.metadataId !== undefined &&
          patch.metadataId !== view.value?.metadataId,
      )
    )
      reload();
  });
  const language = kbEvent$<{ changes?: Record<string, unknown>; language?: unknown }>("setting-change").subscribe(
    (event) => {
      if (Object.prototype.hasOwnProperty.call(event.payload.changes ?? event.payload, "language")) reload();
    },
  );
  onScopeDispose(() => {
    if (timer) clearTimeout(timer);
    if (Object.keys(draft.value).length) void flush(activeId, true);
    disposed = true;
    changed.unsubscribe();
    changes.unsubscribe();
    language.unsubscribe();
  });
  return { view, loading, error, valueOf, isModified, set, reset, resetAll, reload };
}
