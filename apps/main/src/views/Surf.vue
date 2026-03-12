<template>
  <div class="surf-page">
    <div class="surf-scroll-container" :class="{ 'has-records': hasRecords }">
      <PageHeader title="畅游" :show="[]" sticky />

      <div class="surf-content" :class="{ 'has-records': hasRecords }">
        <!-- Logo：搜索栏上方 -->
        <div class="surf-logo">
          <img
            src="/swim.jpeg"
            alt="畅游"
            class="surf-logo-img"
            :style="hasRecords ? { height: logoHeight + 'px' } : undefined"
          />
        </div>
        <!-- 输入区 -->
        <div class="surf-search-row">
          <el-select
            v-model="pluginQuickSelect"
            placeholder="从插件快速进入"
            size="large"
            filterable
            :disabled="surfStore.sessionActive"
            class="surf-plugin-select"
            @change="onPluginQuickSelect"
          >
            <el-option
              v-for="p in pluginsWithHttpRoot"
              :key="p.id"
              :label="p.name"
              :value="p.baseUrl"
            />
          </el-select>
          <el-input
            v-model="inputUrl"
            placeholder="输入 URL 开始畅游，例如 https://pixiv.net"
            :disabled="surfStore.sessionActive"
            size="large"
            @keyup.enter="handleStart"
          />
          <el-button type="primary" size="large" @click="handleStart">
            {{ surfStore.sessionActive ? "打开已有会话" : "开始畅游" }}
          </el-button>
          <el-button v-if="surfStore.sessionActive" size="large" @click="handleCloseSession">
            结束会话
          </el-button>
        </div>

        <!-- 畅游记录列表 -->
        <div class="surf-list-wrap" @wheel="onListWheel">
          <transition-group name="surf-list" tag="div" class="surf-list">
            <el-card
              v-for="record in surfStore.records"
              :key="record.id"
              class="surf-card"
              @click="handleRecordClick(record)"
              @contextmenu.prevent="openRecordContextMenu($event, record)"
            >
              <div class="card-head">
                <img v-if="iconDataUrl(record.icon)" class="site-icon" :src="iconDataUrl(record.icon)" alt="icon" />
                <div v-else class="site-icon fallback">{{ record.host[0]?.toUpperCase() }}</div>
                <div class="site-meta">
                  <div class="host">{{ record.host }}</div>
                  <div class="root-url">{{ record.rootUrl }}</div>
                </div>
                <el-tag size="small" type="info">下载 {{ record.downloadCount }}</el-tag>
              </div>
              <div class="card-foot">
                <span>最近访问：{{ formatTime(record.lastVisitAt) }}</span>
                <span v-if="record.lastImage" class="last-image" @click.stop="goImages(record.id)">
                  查看最近图片
                </span>
              </div>
            </el-card>
          </transition-group>
          <div class="load-more">
            <el-button v-if="surfStore.hasMore" :loading="surfStore.loading" @click="surfStore.loadMore()">
              加载更多
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <ActionRenderer
      :visible="recordMenu.visible.value"
      :position="recordMenu.position.value"
      :actions="(surfRecordActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="recordMenuContext"
      :z-index="3500"
      @close="recordMenu.hide"
      @command="(cmd) => handleRecordMenuCommand(cmd as 'viewImages' | 'delete')"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useSurfStore, type SurfRecord } from "@/stores/surf";
import { usePluginStore } from "@/stores/plugins";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import { createSurfRecordActions } from "@/actions/surfRecordActions";

const router = useRouter();
const surfStore = useSurfStore();
const pluginStore = usePluginStore();
const inputUrl = ref("");
const pluginQuickSelect = ref("");

const surfRecordActions = createSurfRecordActions();
const recordMenu = useActionMenu<SurfRecord>();
const recordMenuContext = computed(() => ({
  target: recordMenu.context.value.target,
  selectedIds: new Set<string>() as ReadonlySet<string>,
  selectedCount: 0,
}));

/** 声明了以 http 开头的根 URL 的插件（用于快速填入输入框） */
const pluginsWithHttpRoot = computed(() =>
  pluginStore.plugins.filter((p) => p.baseUrl && p.baseUrl.toLowerCase().startsWith("http"))
);

const onPluginQuickSelect = (baseUrl: string) => {
  inputUrl.value = baseUrl;
  pluginQuickSelect.value = "";
};


const hasRecords = computed(() => surfStore.records.length > 0);

const LOGO_MAX = 180;
const LOGO_MIN = 80;
const logoHeight = ref(LOGO_MAX);
const logoCollapsed = computed(() => logoHeight.value <= LOGO_MIN);

const onListWheel = (e: WheelEvent) => {
  if (!hasRecords.value) return;
  if (logoHeight.value > LOGO_MIN && e.deltaY > 0) {
    e.preventDefault();
    logoHeight.value = Math.max(LOGO_MIN, logoHeight.value - e.deltaY);
  } else if (e.deltaY < 0) {
    const target = e.currentTarget as HTMLElement;
    if (target.scrollTop <= 0) {
      e.preventDefault();
      logoHeight.value = Math.min(LOGO_MAX, logoHeight.value - e.deltaY);
    }
  }
};

const toBase64 = (bytes: number[]) =>
  btoa(new Uint8Array(bytes).reduce((acc, byte) => acc + String.fromCharCode(byte), ""));

const iconDataUrl = (bytes?: number[] | null) => {
  if (!bytes || bytes.length === 0) return "";
  return `data:image/png;base64,${toBase64(bytes)}`;
};

const formatTime = (ts: number) => {
  if (!ts) return "-";
  const date = new Date(ts * 1000);
  return date.toLocaleString();
};

/** 规范化并校验 URL：仅允许 https；域名字符串自动补 https；http 提示需用 https；其他协议提示不支持 */
function normalizeAndValidateUrl(input: string): { url: string } | { error: string } {
  const v = input.trim();
  if (!v) return { error: "请输入 URL" };
  const lower = v.toLowerCase();
  if (lower.startsWith("https://")) return { url: v };
  if (lower.startsWith("http://")) return { error: "请使用 https 协议" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return { error: "不支持的协议，仅支持 https" };
  return { url: `https://${v}` };
}

const handleStart = async () => {
  try {
    const raw = inputUrl.value || (surfStore.sessionActive ? "https://example.com" : "");
    const result = normalizeAndValidateUrl(raw);
    if ("error" in result) {
      ElMessage.warning(result.error);
      return;
    }
    const normalized = result.url;
    if (surfStore.sessionActive) {
      await surfStore.startSession(normalized);
      return;
    }
    await surfStore.startSession(normalized);
    ElMessage.success("已启动畅游会话");
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || "启动会话失败");
  }
};

const handleCloseSession = async () => {
  try {
    await surfStore.closeSession();
    ElMessage.success("畅游会话已结束");
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || "结束会话失败");
  }
};

const handleRecordClick = async (record: SurfRecord) => {
  if (surfStore.sessionActive) return;
  try {
    inputUrl.value = record.rootUrl;
    await surfStore.startSession(record.rootUrl);
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || "启动会话失败");
  }
};

const goImages = (id: string) => {
  router.push(`/surf/${id}/images`);
};

const openRecordContextMenu = (e: MouseEvent, record: SurfRecord) => {
  recordMenu.show(record, e);
};

const handleRecordMenuCommand = async (command: "viewImages" | "delete") => {
  const record = recordMenu.context.value.target;
  recordMenu.hide();
  if (!record) return;
  if (command === "viewImages") {
    goImages(record.id);
    return;
  }
  if (command === "delete") {
    try {
      await ElMessageBox.confirm(
        `确定要删除畅游记录「${record.host}」吗？关联的图片将保留在画廊中。`,
        "删除畅游记录",
        { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }
      );
      await surfStore.deleteRecord(record.id);
      ElMessage.success("已删除");
    } catch (e: any) {
      if (e !== "cancel") {
        ElMessage.error(e?.message || String(e) || "删除失败");
      }
    }
  }
};

onMounted(async () => {
  await surfStore.checkSession();
  await surfStore.loadRecords();
  if (pluginStore.plugins.length === 0) {
    await pluginStore.loadPlugins();
  }
});
</script>

<style scoped lang="scss">
.surf-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* 外层容器：无记录时整体可滚动；有记录时不滚动，由内部列表独立滚动 */
.surf-scroll-container {
  flex: 1;
  padding: 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;

  &:not(.has-records) {
    overflow-y: auto;
    overflow-x: hidden;
  }

  &.has-records {
    overflow: hidden;
  }
}

/* 内容区：空态居中，有记录时 flex 填满 */
.surf-content {
  width: 80%;
  max-width: 720px;
  margin: 0 auto;

  &:not(.has-records) {
    padding: 24px 0 32px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    min-height: 60vh;
  }

  &.has-records {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    padding-top: 16px;
  }
}

.surf-logo {
  display: flex;
  justify-content: center;
  flex-shrink: 0;

  .surf-content:not(.has-records) & {
    margin-bottom: 24px;
  }

  .surf-content.has-records & {
    margin-bottom: 12px;
  }
}

.surf-logo-img {
  display: block;
  width: auto;
  object-fit: contain;
  border-radius: 12px;

  .surf-content:not(.has-records) & {
    height: 180px;
  }

  .surf-content.has-records & {
    transition: height 0.22s ease-out;
  }
  /* has-records 时 height 由 JS :style 绑定控制 */
}

.surf-search-row {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  flex-shrink: 0;

  .surf-content.has-records & {
    margin-bottom: 16px;
  }

  .surf-plugin-select {
    width: 180px;
    flex-shrink: 0;
  }

  .el-input {
    flex: 1;
    min-width: 0;
  }
}

/* 列表区：有记录时占据剩余空间、独立滚动 */
.surf-list-wrap {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;

  .surf-content.has-records & {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding-bottom: 16px;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }
}

.surf-list {
  width: 92%;
  max-width: 100%;
  display: grid;
  gap: 12px;
}

.surf-card {
  cursor: pointer;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.site-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
}

.site-icon.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ddd;
  font-size: 12px;
}

.site-meta {
  flex: 1;
  min-width: 0;
}

.host {
  font-weight: 600;
}

.root-url {
  color: #888;
  font-size: 12px;
  word-break: break-all;
}

.card-foot {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  color: #888;
  font-size: 12px;
}

.last-image {
  color: var(--el-color-primary);
  cursor: pointer;
}

.load-more {
  margin-top: 16px;
  text-align: center;
  width: 92%;
}

/* 列表进入/离开/重排动画 */
.surf-list-enter-active,
.surf-list-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.surf-list-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

.surf-list-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.surf-list-move {
  transition: transform 0.3s ease;
}
</style>
