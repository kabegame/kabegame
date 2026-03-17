<template>
  <TabLayout :title="title" :subtitle="subtitle" :show-back="showBack" @back="$emit('back')">
    <template #icon>
      <div v-if="plugin?.icon" class="plugin-icon-wrap">
        <el-image :src="plugin.icon" fit="contain" class="plugin-icon-image" />
      </div>
      <div v-else class="plugin-icon-placeholder">
        <el-icon>
          <Grid />
        </el-icon>
      </div>
    </template>

    <template #actions>
      <div v-if="plugin" class="header-actions">
        <el-tooltip :content="t('plugins.uninstall')" placement="bottom" v-if="showUninstall && installed">
          <el-button :icon="Delete" circle type="danger" @click="$emit('uninstall')" />
        </el-tooltip>
      </div>
    </template>

    <div v-if="showSkeleton" class="loading">
      <el-skeleton :rows="5" animated />
    </div>

    <div v-else-if="!loading && !plugin" class="empty">
      <el-empty :description="effectiveEmptyDescription" />
    </div>

    <div v-else class="plugin-detail-content">
      <!-- 基本信息 -->
      <div class="plugin-info-section">
        <PluginDetail v-if="plugin" :show-header="false" :plugin-id="plugin.id" :name="displayName"
          :description="displayDesc" :version="plugin.version" :base-url="plugin.baseUrl" :installed="installed" :show-copy-id="true"
          :show-primary-action="true" :primary-action-loading="installing" :primary-action-disabled="installing"
          :primary-action-text="installing ? effectiveInstallingText : effectiveInstallText" @primary-action="$emit('install')"
          @copy-id="$emit('copy-id', $event)">
          <template #copy-id-button="{ pluginId }">
            <el-button :icon="DocumentCopy" circle size="small" :title="t('plugins.detailCopyId')" @click="$emit('copy-id', pluginId)" />
          </template>
          <template v-if="$slots['detail-extra-items']" #extra-items>
            <slot name="detail-extra-items" />
          </template>
          <template v-if="$slots['detail-actions']" #actions>
            <slot name="detail-actions" />
          </template>
        </PluginDetail>
      </div>

      <!-- 文档（按当前语言解析 doc record） -->
      <div class="plugin-doc-section">
        <PluginDocRenderer v-if="displayDoc" :markdown="displayDoc" :load-image-bytes="loadDocImageBytes"
          :doc-image-base-url="docImageBaseUrl" :empty-description="effectiveDocEmptyDescription" />
        <el-empty v-else :description="effectiveDocEmptyDescription" :image-size="100" />
      </div>
    </div>
  </TabLayout>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import { Delete, DocumentCopy, Grid } from "@element-plus/icons-vue";
import TabLayout from "../../layouts/TabLayout.vue";
import PluginDetail from "./PluginDetail.vue";
import PluginDocRenderer from "./PluginDocRenderer.vue";
import type { PluginManifestDoc, PluginManifestText } from "../../stores/plugins";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;
const t = inject<TranslateFn>("i18n-t") ?? ((k: string) => k);
const localeRef = inject<{ value: string }>("i18n-locale");

type PluginVm = {
  id: string;
  name: PluginManifestText;
  desp: PluginManifestText;
  version?: string;
  icon?: string | null;
  doc?: PluginManifestDoc | null;
  baseUrl?: string | null;
};

function resolveDoc(doc: PluginManifestDoc | null | undefined, locale: string): string {
  if (doc == null || typeof doc !== "object") return "";
  return doc[locale] ?? doc["default"] ?? "";
}

type LoadImageBytes = (imagePath: string) => Promise<Uint8Array | number[]>;


const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    showBack?: boolean;

    loading: boolean;
    showSkeleton: boolean;
    plugin: PluginVm | null;

    installed: boolean;
    installing: boolean;
    showUninstall?: boolean;

    installText?: string;
    installingText?: string;
    emptyDescription?: string;
    docEmptyDescription?: string;

    loadDocImageBytes?: LoadImageBytes;
    /** 插件文档图片 URL 前缀（桌面 HTTP / 安卓 kbg-plugin-doc.localhost），有值时优先用 URL 加载图片 */
    docImageBaseUrl?: string | null;
  }>(),
  {
    showBack: false,
    showUninstall: true,
  }
);

const effectiveInstallText = computed(() => props.installText ?? t("plugins.install"));
const effectiveInstallingText = computed(() => props.installingText ?? t("plugins.installing"));
const effectiveEmptyDescription = computed(() => props.emptyDescription ?? t("common.pluginNotExist"));
const effectiveDocEmptyDescription = computed(() => props.docEmptyDescription ?? t("common.pluginNoDoc"));

const displayDoc = computed(() =>
  resolveDoc(props.plugin?.doc ?? null, localeRef?.value ?? "zh")
);

const resolveManifestText = inject<
  (value: PluginManifestText | null | undefined) => string
>("resolveManifestText");
const displayName = computed(() =>
  resolveManifestText && props.plugin
    ? resolveManifestText(props.plugin.name)
    : (props.plugin?.name && typeof props.plugin.name === "object" && props.plugin.name["default"]) || ""
);
const displayDesc = computed(() =>
  resolveManifestText && props.plugin
    ? resolveManifestText(props.plugin.desp)
    : (props.plugin?.desp && typeof props.plugin.desp === "object" && props.plugin.desp["default"]) || ""
);

defineEmits<{
  (e: "back"): void;
  (e: "install"): void;
  (e: "uninstall"): void;
  (e: "copy-id", pluginId: string): void;
}>();
</script>

<style scoped lang="scss">
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-icon-wrap,
.plugin-icon-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.plugin-icon-image {
  width: 100%;
  height: 100%;
}

.plugin-icon-placeholder {
  background: linear-gradient(135deg,
      rgba(255, 107, 157, 0.2) 0%,
      rgba(167, 139, 250, 0.2) 100%);
  color: var(--anime-primary);
  font-size: 32px;
}

.plugin-detail-content {
  background: var(--anime-bg-card);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--anime-shadow);

  .loading {
    padding: 40px;
  }

  .empty {
    padding: 40px;
    text-align: center;
  }

  .plugin-info-section {
    margin-bottom: 32px;
  }

  .plugin-doc-section {
    border-top: 1px solid var(--anime-border);
    padding-top: 20px;
  }
}
</style>
