import { type Component, computed, shallowRef } from "vue";
import {
  type AppSettingKey,
  type AppSettings,
  useSettingsStore,
} from "../stores/settings";

type OptionItem = {
  id: string;
  title: string;
  desc?: string;
  icon: Component;
};

export interface SettingChoiceRequest {
  key: string;
  title: string;
  options: OptionItem[];
}

export type SettingChoiceResult = {
  id: string;
  persist: boolean;
};

interface PendingSettingChoice {
  request: SettingChoiceRequest;
  resolve: (value: SettingChoiceResult | null) => void;
}

type StringSettingKey = {
  [K in AppSettingKey]: AppSettings[K] extends string ? K : never;
}[AppSettingKey];

const currentChoice = shallowRef<PendingSettingChoice | null>(null);
const choiceQueue: PendingSettingChoice[] = [];
const pendingPromiseByKey = new Map<
  string,
  Promise<SettingChoiceResult | null>
>();
let advanceScheduled = false;

export const settingChoiceRequest = computed(
  () => currentChoice.value?.request ?? null,
);

function showNextChoice() {
  if (currentChoice.value || choiceQueue.length === 0) return;
  currentChoice.value = choiceQueue.shift() ?? null;
}

function scheduleNextChoice() {
  if (advanceScheduled) return;
  advanceScheduled = true;
  queueMicrotask(() => {
    advanceScheduled = false;
    showNextChoice();
  });
}

export function askSettingChoice(
  req: SettingChoiceRequest,
): Promise<SettingChoiceResult | null> {
  const existing = pendingPromiseByKey.get(req.key);
  if (existing) return existing;

  let resolve!: (value: SettingChoiceResult | null) => void;
  const promise = new Promise<SettingChoiceResult | null>((promiseResolve) => {
    resolve = promiseResolve;
  });

  pendingPromiseByKey.set(req.key, promise);
  choiceQueue.push({ request: req, resolve });
  showNextChoice();
  return promise;
}

export function resolveSettingChoice(value: SettingChoiceResult | null) {
  const pending = currentChoice.value;
  if (!pending) return;

  currentChoice.value = null;
  pendingPromiseByKey.delete(pending.request.key);
  pending.resolve(value);
  scheduleNextChoice();
}

export async function resolveSettingWithPrompt<K extends StringSettingKey>(
  key: K,
  req: { title: string; options: OptionItem[] },
): Promise<AppSettings[K] | null> {
  const store = useSettingsStore();
  const current = store.values[key];
  if (current && current !== "unconfigured") return current as AppSettings[K];

  const picked = await askSettingChoice({ key, ...req });
  if (!picked) return null;

  const selected = picked.id as AppSettings[K];
  if (picked.persist) {
    // 只有用户勾选「下次保持」才写入设置；不勾选时只执行本次选择。
    void store.save(key, selected, { source: "unconfigured_prompt" }).catch(
      () => undefined,
    );
  }
  return selected;
}
