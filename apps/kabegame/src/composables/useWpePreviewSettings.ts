import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from "vue";
import { invoke } from "@/api";
import { toast } from "@/components/ui/toast";
import { kbEvent$ } from "@/services/kbEvents/eventSource";
import { useI18n } from "@kabegame/i18n";
import {
  WPE_SETTING_DEFAULTS,
  wpePreviewSettingValues,
  type WpeSettingKey,
  type WpeSettingValues,
} from "@/utils/wpeSettings";

/** 后端 `get_wpe_preview_settings` / `set_wpe_preview_settings` 的视图：`settings` 是存了的键（已规整） */
interface WpePreviewSettingsView {
  imageId: string;
  metadataId: number | null;
  settings: Record<string, unknown>;
}

/** 预览设置里能写的键（暂停不在其中：它是预览弹窗里的内存状态） */
export type WpePreviewSettingKey = Exclude<WpeSettingKey, "paused">;

/**
 * 一张壁纸的预览设置，同一张的全部使用方共用一份（预览右栏的字段组与画面里的 `WpeWallpaperContent`），面板上的改动
 * 当场就被画面读到，不用等写入落地。写入草稿 300 ms 去抖后经 `set_wpe_preview_settings` 改写 metadata；别处写入
 * （另一个窗口、`metadataId` 补丁）时重读。最后一个使用方离开时把未写的草稿写完再释放。
 */
interface Entry {
  id: string;
  users: number;
  view: ShallowRef<WpePreviewSettingsView | null>;
  draft: Ref<Record<string, unknown>>;
  timer?: ReturnType<typeof setTimeout>;
  writing: boolean;
  serial: number;
  landed: number;
  dispose(): void;
}

const entries = new Map<string, Entry>();
let saveFailedText = "保存失败";

function accept(entry: Entry, request: number, result: WpePreviewSettingsView | null) {
  if (request < entry.landed) return;
  entry.landed = request;
  entry.view.value = result;
}

function reload(entry: Entry) {
  const request = ++entry.serial;
  void invoke<WpePreviewSettingsView | null>("get_wpe_preview_settings", { imageId: entry.id }).then(
    (result) => accept(entry, request, result),
    (failure) => console.warn("[useWpePreviewSettings] 读取预览设置失败:", failure),
  );
}

function schedule(entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void flush(entry);
  }, 300);
}

async function flush(entry: Entry) {
  if (entry.writing) return;
  const changes = { ...entry.draft.value };
  if (!Object.keys(changes).length) return;
  entry.writing = true;
  const request = ++entry.serial;
  try {
    const saved = await invoke<WpePreviewSettingsView>("set_wpe_preview_settings", { imageId: entry.id, changes });
    accept(entry, request, saved);
  } catch (failure) {
    toast.error(`${saveFailedText}: ${String(failure)}`);
    reload(entry);
  } finally {
    // 写的这批从草稿里去掉（期间又改过的键留着，下一轮再写）
    const draft = { ...entry.draft.value };
    for (const [key, value] of Object.entries(changes)) if (Object.is(draft[key], value)) delete draft[key];
    entry.draft.value = draft;
    entry.writing = false;
    if (!entry.users) release(entry);
    else if (Object.keys(draft).length) schedule(entry);
  }
}

function acquire(id: string): Entry {
  const existing = entries.get(id);
  if (existing) {
    existing.users++;
    return existing;
  }
  type Patch = { id: string; metadataId?: number };
  const affects = (patch: Patch | null | undefined) =>
    !!patch && patch.id === id && patch.metadataId !== undefined && patch.metadataId !== entry.view.value?.metadataId;
  const changed = kbEvent$<{ patch?: Patch }>("image-changed").subscribe((event) => {
    if (affects(event.payload.patch)) reload(entry);
  });
  const changes = kbEvent$<{ patches?: Patch[] }>("images-change").subscribe((event) => {
    if (event.payload.patches?.some(affects)) reload(entry);
  });
  const entry: Entry = {
    id,
    users: 1,
    view: shallowRef(null),
    draft: ref({}),
    writing: false,
    serial: 0,
    landed: 0,
    dispose() {
      changed.unsubscribe();
      changes.unsubscribe();
    },
  };
  entries.set(id, entry);
  reload(entry);
  return entry;
}

/** 使用方离开：没人用了且草稿写完才真正释放 */
function release(entry: Entry) {
  if (entry.users > 0) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  // 写入在途：它结束时会再来这里；还有草稿：先写完（flush 结束时再来）
  if (entry.writing) return;
  if (Object.keys(entry.draft.value).length) {
    void flush(entry);
    return;
  }
  entry.dispose();
  if (entries.get(entry.id) === entry) entries.delete(entry.id);
}

export function useWpePreviewSettings(imageId: Ref<string | null | undefined>): {
  /** 生效值：默认值 ← 存了的 ← 草稿；`paused` 恒为默认（假），由调用方另给 */
  values: ComputedRef<WpeSettingValues>;
  /** 改过（与默认值不同）的键 */
  modified: ComputedRef<Partial<Record<WpeSettingKey, boolean>>>;
  anyModified: ComputedRef<boolean>;
  set(key: WpePreviewSettingKey, value: unknown): void;
  reset(key: WpePreviewSettingKey): void;
  resetAll(): void;
} {
  saveFailedText = useI18n().t("gallery.wpePropsSaveFailed");
  const current = shallowRef<Entry | null>(null);

  watch(
    imageId,
    (id) => {
      const previous = current.value;
      current.value = id ? acquire(id) : null;
      if (previous) {
        previous.users--;
        release(previous);
      }
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    const entry = current.value;
    current.value = null;
    if (entry) {
      entry.users--;
      release(entry);
    }
  });

  /** 存了的键叠上草稿（草稿 null 表示删键） */
  const merged = computed<Record<string, unknown>>(() => {
    const entry = current.value;
    if (!entry) return {};
    const out: Record<string, unknown> = { ...(entry.view.value?.settings ?? {}) };
    for (const [key, value] of Object.entries(entry.draft.value)) {
      if (value === null) delete out[key];
      else out[key] = value;
    }
    return out;
  });
  const values = computed(() => wpePreviewSettingValues(merged.value));
  const modified = computed(() => {
    const out: Partial<Record<WpeSettingKey, boolean>> = {};
    for (const key of Object.keys(merged.value) as WpeSettingKey[]) {
      if (key in WPE_SETTING_DEFAULTS && !Object.is(values.value[key], WPE_SETTING_DEFAULTS[key])) out[key] = true;
    }
    return out;
  });
  const anyModified = computed(() => Object.keys(modified.value).length > 0);

  function set(key: WpePreviewSettingKey, value: unknown) {
    const entry = current.value;
    if (!entry) return;
    entry.draft.value = { ...entry.draft.value, [key]: value };
    schedule(entry);
  }
  function reset(key: WpePreviewSettingKey) {
    set(key, null);
  }
  function resetAll() {
    const entry = current.value;
    if (!entry) return;
    const draft = { ...entry.draft.value };
    for (const key of Object.keys(modified.value)) draft[key] = null;
    entry.draft.value = draft;
    schedule(entry);
  }

  return { values, modified, anyModified, set, reset, resetAll };
}
