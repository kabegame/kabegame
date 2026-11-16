<template>
  <!-- 每个主题一个色样：主色 → 点缀色的渐变圆；色样的颜色取主题自己的值，不跟当前主题 -->
  <RadioGroupRoot
    :model-value="currentId"
    :disabled="disabled || showDisabled"
    orientation="horizontal"
    class="flex flex-wrap justify-end gap-x-2 gap-y-2"
    :aria-label="$t('settings.colorTheme')"
    @update:model-value="onChange"
  >
    <RadioGroupItem
      v-for="theme in themes"
      :key="theme.id"
      :value="theme.id"
      class="group flex min-w-[52px] cursor-pointer flex-col items-center gap-1.5 rounded-kb-md border-0 bg-transparent px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-kb-ring data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
    >
      <span
        class="relative box-border grid size-8 place-items-center rounded-full transition-shadow duration-150 group-data-[state=checked]:shadow-[0_0_0_2px_var(--kb-surface-raised),0_0_0_4px_var(--kb-primary)]"
        :style="{
          background: `linear-gradient(135deg, ${theme.vars['--kb-primary']} 0%, ${theme.vars['--kb-primary']} 45%, ${theme.vars['--kb-secondary']} 100%)`,
        }"
      />
      <span
        class="whitespace-nowrap text-[12px] leading-4 text-kb-fg-muted group-data-[state=checked]:font-600 group-data-[state=checked]:text-kb-fg"
      >
        {{ colorThemeName(theme, locale) }}
      </span>
    </RadioGroupItem>
  </RadioGroupRoot>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RadioGroupItem, RadioGroupRoot } from "reka-ui";
import { useI18n } from "@kabegame/i18n";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { BUILTIN_COLOR_THEMES, colorThemeName, findColorTheme } from "@/theme/colorTheme";

const { locale } = useI18n();
const themes = BUILTIN_COLOR_THEMES;

const { settingValue, set, disabled, showDisabled } = useSettingKeyState("colorTheme");
// 存的 id 不认识时按默认主题显示与选中
const currentId = computed(() => findColorTheme(settingValue.value as string | undefined).id);

const onChange = async (id: unknown) => {
  if (typeof id !== "string" || id === currentId.value) return;
  await set(id, {
    source: location.pathname === "/settings" ? "settings_page" : "settings_dialog",
  });
};
</script>
