<template>
  <Dialog :open="visible" :title="title" :width="520" @update:open="onVisibleChange" @open-auto-focus="focusSelected">
    <div ref="bodyRef" class="flex flex-col gap-3">
      <p class="m-0 text-[13px] leading-[1.6] text-kb-fg-muted">
        {{ t("settings.pickTargetHint") }}
      </p>
      <WallpaperScreenLayout
        :selected="selected"
        display-mode="single"
        :default-screen="settingsStore.values.wallpaperDefaultScreen"
        @update:selected="selected = $event"
        @confirm="confirm"
      />
    </div>
    <template #footer>
      <Button @click="onVisibleChange(false)">{{ t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="!selected" @click="confirm()">{{ t("common.confirm") }}</Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import { Button, Dialog } from "@/components/ui";
import WallpaperScreenLayout from "@/components/wallpaper/WallpaperScreenLayout.vue";
import { useActiveWallpaperTargets } from "@/composables/useWallpaperTarget";
import { resolveWallpaperTargetPick, wallpaperTargetPickRequest } from "@/composables/useWallpaperTargetPicker";
import { useSettingsStore } from "@/stores/settings";

/**
 * 目标选择弹窗的宿主：全应用一个，挂在 `App.vue`。`pickWallpaperTarget` 放进待处理请求时打开，
 * 用户点一块屏后「确定」（或双击屏块、回车）返回那块屏的目标，「取消」/ 关闭返回 null。
 *
 * 只在逐屏独立且在线屏不止一块时才会被打开（否则 `pickWallpaperTarget` 直接返回唯一目标），所以布局图
 * 固定按逐屏独立画、不列断开的屏。弹窗不带「记住选择」：默认屏只作预选。
 */
const { t } = useI18n();
const settingsStore = useSettingsStore();
const request = wallpaperTargetPickRequest;
// 活跃目标，默认目标在前；与 `pickWallpaperTarget` 判断弹不弹用的是同一份
const targets = useActiveWallpaperTargets();

const selected = ref<string | null>(null);
const bodyRef = ref<HTMLElement | null>(null);

// 有待处理请求就开着。层级、Android 返回键由 Dialog 自己接（压在预览等已打开的弹层之上）。
const visible = ref(false);

const title = computed(() =>
  request.value?.action === "setRotation"
    ? t("settings.pickTargetTitleSetRotation")
    : t("settings.pickTargetTitleSetWallpaper"),
);

watch(request, (pending) => {
  if (!pending) {
    visible.value = false;
    return;
  }
  // 新请求（包括顶掉前一个的）：预选默认屏
  selected.value = targets.value[0] ?? null;
  visible.value = true;
});

// 打开期间屏幕变化：只剩一个目标时没什么可选，直接以它返回；选中的屏断开了就预选回默认屏
watch(targets, (ids) => {
  if (!request.value) return;
  if (ids.length <= 1) {
    resolveWallpaperTargetPick(ids[0] ?? null);
    return;
  }
  if (!selected.value || !ids.includes(selected.value)) selected.value = ids[0];
});

// 任何途径关掉（取消、右上角、Esc、点遮罩、返回键）都当作取消；已经返回过时这里什么都不会做
function onVisibleChange(next: boolean) {
  if (next || !visible.value) return;
  visible.value = false;
  resolveWallpaperTargetPick(null);
}

/** 以 `targetId`（缺省为当前选中的）返回；不在活跃目标里的不认。 */
function confirm(targetId?: string) {
  const id = targetId ?? selected.value;
  if (!id || !targets.value.includes(id)) return;
  resolveWallpaperTargetPick(id);
}

/** 打开后把焦点放到预选的屏块上：回车即确定，Tab 可在屏块与按钮间移动。 */
function focusSelected(event: Event) {
  event.preventDefault();
  nextTick(() => bodyRef.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus());
}

// 焦点不在任何按钮上时（点过弹窗空白处）回车也算确定；按钮自己的回车各管各的：
// 屏块是选中并确定，「取消」是取消
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (!request.value || event.key !== "Enter" || event.isComposing) return;
  if (event.target instanceof HTMLButtonElement) return;
  event.preventDefault();
  confirm();
});
</script>
