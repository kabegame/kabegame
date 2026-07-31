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
        v-model:active="selected"
        :groups="menuGroups"
        :title="t('plugins.detail.configVarsAndPresets')"
        class="flex-1 min-w-0 min-h-0"
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

    <div class="flex-1 min-w-0 min-h-0 overflow-y-auto [scrollbar-width:none]">
      <!-- 所有配置项：设计稿两行卡片（key+显示名+type chip / 默认值+when 条件），无描述行 -->
      <div v-if="selected === 'all'" class="flex flex-col gap-3 py-4 px-5.5">
        <el-empty v-if="!vars.length" :description="t('plugins.detail.noConfigVars')" :image-size="80" />
        <template v-else>
          <div class="text-13.5px text-[var(--anime-text-muted)]">
            {{ t("plugins.detail.configVarsHint", { n: vars.length }) }}
          </div>
          <div v-for="v in vars" :key="v.key" class="kb-card py-3 px-4">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="font-700 text-14.5px font-mono overflow-hidden text-ellipsis whitespace-nowrap">{{ v.key }}</span>
              <span class="text-14px font-600 whitespace-nowrap">{{ varDisplayName(v) }}</span>
              <div class="flex-1" />
              <span class="kb-chip bg-[#ecf5ff] text-[#409eff] whitespace-nowrap flex-none">{{ v.type }}</span>
            </div>
            <div class="flex items-baseline gap-1.5 mt-2 text-13.5px text-[var(--anime-text-muted)]">
              <template v-if="defaultValueText(v) !== null">
                <span>{{ t("plugins.detail.varDefaultLabel") }}</span>
                <span class="font-mono font-600 text-[var(--anime-text-secondary)]">{{ defaultValueText(v) }}</span>
              </template>
              <span v-else>{{ t("plugins.detail.varNoDefault") }}</span>
              <span>·</span>
              <span :class="v.when ? 'font-mono text-[var(--anime-text-secondary)]' : ''">{{ whenText(v) }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- 单个推荐配置 -->
      <div v-else-if="activePreset" class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2.5 py-3 px-5.5">
          <div class="font-800 text-15px">{{ presetTitle(activePreset) }}</div>
          <span class="kb-chip bg-[#ecf5ff] text-[#409eff]">json</span>
          <div class="flex-1" />
          <button
            type="button"
            class="h-8 px-4.5 border-none rounded-full kb-grad text-white font-600 text-14px shadow-[var(--anime-shadow)] cursor-pointer hover:brightness-105"
            @click="emit('start-task', { pluginId: plugin!.id, vars: activePreset.userConfig, httpHeaders: activePreset.httpHeaders })"
          >
            {{ t("plugins.detail.startTaskWithPreset") }}
          </button>
          <div class="inline-flex items-center gap-0.5 p-0.75 rounded-14px bg-[var(--anime-bg-sidebar)]">
            <button
              type="button"
              class="w-7.5 h-6.5 border-none rounded-11px flex items-center justify-center cursor-pointer"
              :class="viewMode === 'pretty' ? 'kb-grad text-white' : 'bg-transparent text-[var(--anime-text-primary)]'"
              :title="t('plugins.detail.viewPretty')"
              @click="viewMode = 'pretty'"
            >
              <el-icon :size="14"><Tickets /></el-icon>
            </button>
            <button
              type="button"
              class="w-7.5 h-6.5 border-none rounded-11px flex items-center justify-center cursor-pointer"
              :class="viewMode === 'source' ? 'kb-grad text-white' : 'bg-transparent text-[var(--anime-text-primary)]'"
              :title="t('plugins.detail.viewSource')"
              @click="viewMode = 'source'"
            >
              <el-icon :size="14"><Document /></el-icon>
            </button>
          </div>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] pb-4 px-5.5">
          <template v-if="viewMode === 'pretty'">
            <!-- 设计稿：文件路径（mono）+ 描述段，再到逐项行卡 -->
            <div class="font-mono text-13.5px font-600 text-[var(--anime-text-secondary)] break-all">{{ activePreset.filename }}</div>
            <div v-if="presetDescription(activePreset)" class="mt-1.5 text-13.5px leading-[1.7] text-[var(--anime-text-muted)]">
              {{ presetDescription(activePreset) }}
            </div>
            <div class="flex flex-col gap-3 mt-3.5">
              <div
                v-for="row in prettyPresetRows(activePreset)"
                :key="row.key"
                class="flex items-center gap-2.5 py-2.5 px-4 kb-card text-14px min-w-0"
              >
                <span class="font-700 font-mono whitespace-nowrap">{{ row.key }}</span>
                <span class="whitespace-nowrap">{{ row.label }}</span>
                <span class="kb-chip bg-[#ecf5ff] text-[#409eff] font-mono flex-none max-w-40 overflow-hidden text-ellipsis whitespace-nowrap">{{ row.value }}</span>
                <span v-if="row.note" class="text-[var(--anime-text-secondary)] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ row.note }}</span>
              </div>
            </div>
            <div v-if="presetHiddenCount(activePreset) > 0" class="mt-3 text-13.5px text-[var(--anime-text-muted)]">
              {{ t("plugins.detail.presetHiddenVars", { n: presetHiddenCount(activePreset) }) }}
            </div>
          </template>
          <pre v-else class="m-0 py-2.5 px-3 rounded-10px bg-[color-mix(in_srgb,white_55%,transparent)] border border-solid border-[var(--anime-border)] overflow-auto text-13px font-mono leading-[1.6]">{{ presetSourceText(activePreset) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Document, Tickets } from "@element-plus/icons-vue";
import { useI18n, usePluginConfigI18n, type PluginVarDefI18n } from "@kabegame/i18n";
import KbMenuList, { type KbMenuGroup } from "../common/KbMenuList.vue";
import KbResizable from "../common/KbResizable.vue";
import type { Plugin } from "../../stores/plugins";
import {
  parsePluginRecommendedPreset,
  type PluginRecommendedPreset,
} from "../../stores/crawler";

const props = defineProps<{
  plugin: Plugin | null;
  /** 双击把手复位到的左栏宽度；上下限由 kb-side-pane 的 CSS 变量给 */
  menuDefaultWidth?: number;
}>();

/** 左栏宽度（px），与其它 tab 共用同一个值，由宿主持久化 */
const menuWidth = defineModel<number>("menuWidth");

const emit = defineEmits<{
  (e: "start-task", payload: { pluginId: string; vars?: Record<string, any>; httpHeaders?: Record<string, string> }): void;
  (e: "import-all-presets", presets: PluginRecommendedPreset[]): void;
}>();

const { t } = useI18n();
const { varDisplayName: rawVarDisplayName, varDescripts: rawVarDescripts, optionDisplayName, resolveConfigText, locale } =
  usePluginConfigI18n();

const vars = computed<PluginVarDefI18n[]>(() => {
  const raw = props.plugin?.config?.vars;
  return Array.isArray(raw) ? (raw as PluginVarDefI18n[]) : [];
});

const varByKey = computed(() => {
  const map = new Map<string, PluginVarDefI18n>();
  for (const v of vars.value) map.set(v.key, v);
  return map;
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

const selected = ref<string>("all");
watch(
  () => props.plugin?.id,
  () => {
    selected.value = "all";
  }
);

// 左栏菜单：第一组只有「所有配置项」，第二组是推荐配置（无推荐配置时整组不渲染）
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

const activePreset = computed(() => presets.value.find((p) => p.filename === selected.value) ?? null);
const viewMode = ref<"pretty" | "source">("pretty");
watch(selected, () => {
  viewMode.value = "pretty";
});

function varDisplayName(v: PluginVarDefI18n): string {
  return rawVarDisplayName(v) || v.key;
}
function varDescripts(v: PluginVarDefI18n): string {
  return rawVarDescripts(v);
}
/** 默认值展示文本；无默认返回 null（模板降级为「无默认」）。字符串不带 JSON 引号，空串显示 "" */
function defaultValueText(v: PluginVarDefI18n): string | null {
  if (v.default === undefined) return null;
  if (typeof v.default === "string") return v.default === "" ? '""' : v.default;
  return JSON.stringify(v.default);
}
function whenText(v: PluginVarDefI18n): string {
  if (!v.when || !Object.keys(v.when).length) return t("plugins.detail.varAlwaysShown");
  return Object.entries(v.when)
    .map(([k, values]) => `${k}=${(values ?? []).join(",")}`)
    .join(" · ");
}

function presetTitle(preset: PluginRecommendedPreset): string {
  const s = resolveConfigText(preset.name as any, locale.value).trim();
  return s || preset.filename;
}

function presetSourceText(preset: PluginRecommendedPreset): string {
  return JSON.stringify(preset, null, 2);
}

function presetDescription(preset: PluginRecommendedPreset): string {
  return resolveConfigText(preset.description as any, locale.value).trim();
}

/** 该配置未覆盖的配置项数（设计稿「已隐藏 N 项本配置不使用的配置项」） */
function presetHiddenCount(preset: PluginRecommendedPreset): number {
  const used = new Set(Object.keys(preset.userConfig ?? {}));
  return vars.value.filter((v) => !used.has(v.key)).length;
}

/** 设计稿行卡：key + 显示名 + 值 chip + 值说明（options 选项显示名，否则该配置项描述） */
function prettyPresetRows(
  preset: PluginRecommendedPreset
): Array<{ key: string; label: string; value: string; note: string }> {
  const userConfig = preset.userConfig ?? {};
  // 按插件 vars 定义顺序展示（JSON 键序不稳定且不符合阅读预期），未知 key 排最后
  const order = new Map(vars.value.map((v, i) => [v.key, i]));
  return Object.entries(userConfig)
    .sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))
    .map(([key, value]) => {
    const varDef = varByKey.value.get(key);
    const label = varDef ? varDisplayName(varDef) : key;
    const display = value != null && typeof value === "object" ? JSON.stringify(value) : String(value);
    let note = "";
    if (varDef?.options && typeof value === "string") {
      const opt = varDef.options.find((o) => (typeof o === "string" ? o === value : o.variable === value));
      if (opt) note = optionDisplayName(opt);
    }
    if (!note && varDef) note = varDescripts(varDef);
    return { key, label, value: display, note };
  });
}
</script>
