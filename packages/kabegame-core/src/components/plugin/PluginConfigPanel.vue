<template>
  <div class="flex h-full min-h-0">
    <KbResizable
      v-model="menuWidth"
      side="right"
      class="flex-none flex min-h-0"
      :default-size="menuDefaultWidth"
      :handle-title="t('plugins.detail.configVarsAndPresets')"
    >
      <KbMenuList
        :active="'all'"
        :groups="menuGroups"
        :title="t('plugins.detail.configVarsAndPresets')"
        class="flex-1 min-w-0 min-h-0"
        @select="handleMenuSelect"
      >
        <template v-if="presets.length" #footer>
          <button
            type="button"
            class="mt-3 border border-dashed border-[color-mix(in_srgb,var(--anime-primary)_50%,transparent)] rounded-12px py-2 px-2.5 text-center font-500 text-14px leading-[1.5] text-[var(--anime-text-secondary)] bg-transparent cursor-pointer hover:border-[var(--anime-primary)] hover:bg-[color-mix(in_srgb,white_50%,transparent)]"
            @click="emit('import-all-presets', presets)"
          >
            {{ t("plugins.detail.importAllPresets") }}
          </button>
        </template>
      </KbMenuList>
    </KbResizable>

    <div class="flex-1 min-w-0 min-h-0 flex flex-col">
      <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] py-4 px-5.5">
        <el-empty v-if="!vars.length" :description="t('plugins.detail.noConfigVars')" :image-size="80" />
        <template v-else>
          <div class="text-13.5px text-[var(--anime-text-muted)] mb-3">
            {{ t("plugins.detail.configVarsHint", { n: vars.length }) }}
          </div>
          <el-form ref="formRef" :model="{ vars: formVars }" label-position="top">
            <PluginVarsForm v-model="formVars" :plugin-vars="visibleVars" />
          </el-form>
        </template>
      </div>

      <div class="flex-none flex items-center justify-end py-3 px-5.5 border-t border-t-solid border-[var(--anime-border)]">
        <button
          type="button"
          class="h-9 px-5 border-none rounded-12px kb-grad text-white font-600 text-14.5px shadow-[var(--anime-shadow)] cursor-pointer hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
          :disabled="isRemote || vars.length === 0"
          @click="handleStartTask"
        >
          {{ t("plugins.detail.startTaskWithSource") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n, usePluginConfigI18n } from "@kabegame/i18n";
import KbMenuList, { type KbMenuGroup } from "../common/KbMenuList.vue";
import KbResizable from "../common/KbResizable.vue";
import PluginVarsForm from "../crawler/PluginVarsForm.vue";
import type { Plugin } from "../../stores/plugins";
import {
  parsePluginRecommendedPreset,
  type PluginRecommendedPreset,
} from "../../stores/crawler";
import {
  normalizeVarsForUI,
  expandVarsForBackend,
  type PluginVarDef,
} from "../../utils/pluginVarForm";
import { matchesPluginVarWhen, coerceOptionsVarsToVisibleChoices } from "../../utils/pluginVarWhen";

const props = withDefaults(
  defineProps<{
    plugin: Plugin | null;
    /** 双击把手复位到的左栏宽度；上下限由 kb-side-pane 的 CSS 变量给 */
    menuDefaultWidth?: number;
    /** 看的是不是一个还没安装的包（商店条目 / .kgpg 预览）。true 时不能起任务 */
    isRemote?: boolean;
    /** 表单初值（UI 形态），由宿主页面读好插件磁盘默认配置后传下来；不传时退化为各字段 default */
    initialVars?: Record<string, any> | null;
  }>(),
  {
    isRemote: false,
  }
);

/** 左栏宽度（px），与其它 tab 共用同一个值，由宿主持久化 */
const menuWidth = defineModel<number>("menuWidth");

const emit = defineEmits<{
  (e: "start-task", payload: { pluginId: string; vars?: Record<string, any>; httpHeaders?: Record<string, string> }): void;
  (e: "import-all-presets", presets: PluginRecommendedPreset[]): void;
}>();

const { t } = useI18n();
const { resolveConfigText, locale } = usePluginConfigI18n();

const vars = computed<PluginVarDef[]>(() => {
  const raw = props.plugin?.config?.vars;
  return Array.isArray(raw) ? (raw as PluginVarDef[]) : [];
});

const presets = computed<PluginRecommendedPreset[]>(() => {
  const plugin = props.plugin;
  if (!plugin) return [];
  const raw = plugin.recommendedConfigs;
  if (!Array.isArray(raw) || !raw.length) return [];
  const baseUrlByPluginId = new Map<string, string>([[plugin.id, plugin.baseUrl ?? ""]]);
  return raw
    .map((item) => parsePluginRecommendedPreset(item, baseUrlByPluginId))
    .filter((p): p is PluginRecommendedPreset => p != null)
    .sort((a, b) => a.filename.localeCompare(b.filename));
});

// 左栏菜单：第一组只有「配置」，第二组是推荐配置（无推荐配置时整组不渲染）
const menuGroups = computed<KbMenuGroup[]>(() => {
  const groups: KbMenuGroup[] = [
    {
      key: "all",
      items: [{ name: "all", label: t("plugins.detail.allConfigVars"), count: vars.value.length }],
    },
  ];
  if (presets.value.length) {
    groups.push({
      key: "presets",
      title: t("plugins.detail.recommendedConfigs"),
      count: presets.value.length,
      items: presets.value.map((preset) => ({ name: preset.filename, label: presetTitle(preset) })),
    });
  }
  return groups;
});

function presetTitle(preset: PluginRecommendedPreset): string {
  const s = resolveConfigText(preset.name as any, locale.value).trim();
  return s || preset.filename;
}

// ---- 表单状态 ----
const formVars = ref<Record<string, any>>({});
const presetHeaders = ref<Record<string, string> | undefined>();
const formRef = ref<any>();

watch(
  [() => props.plugin?.id, () => props.initialVars],
  () => {
    formVars.value = props.initialVars ?? normalizeVarsForUI({}, vars.value);
    presetHeaders.value = undefined;
  },
  { immediate: true }
);

const visibleVars = computed(() => vars.value.filter((v) => matchesPluginVarWhen(v.when, formVars.value)));

watch(
  formVars,
  () => {
    coerceOptionsVarsToVisibleChoices(vars.value, formVars.value);
  },
  { deep: true }
);

// 左栏选择「配置」= 复位到初值；选择某个推荐配置 = 把它的 userConfig/httpHeaders 灌进表单
function handleMenuSelect(name: string) {
  if (name === "all") {
    formVars.value = props.initialVars ?? normalizeVarsForUI({}, vars.value);
    presetHeaders.value = undefined;
    return;
  }
  const preset = presets.value.find((p) => p.filename === name);
  if (!preset) return;
  formVars.value = normalizeVarsForUI(preset.userConfig ?? {}, vars.value);
  presetHeaders.value = preset.httpHeaders;
}

async function handleStartTask() {
  if (!props.plugin) return;
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  emit("start-task", {
    pluginId: props.plugin.id,
    vars: expandVarsForBackend(formVars.value, vars.value),
    httpHeaders: presetHeaders.value,
  });
}
</script>
