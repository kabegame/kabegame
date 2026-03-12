<template>
  <div class="surf-page">
    <div class="surf-header">
      <el-input
        v-model="inputUrl"
        placeholder="输入 URL 开始畅游，例如 https://example.com"
        :disabled="surfStore.sessionActive"
        @keyup.enter="handleStart"
      />
      <el-button type="primary" @click="handleStart">
        {{ surfStore.sessionActive ? "打开已有会话" : "开始畅游" }}
      </el-button>
      <el-button v-if="surfStore.sessionActive" @click="handleCloseSession">结束会话</el-button>
    </div>

    <div class="surf-list">
      <el-card v-for="record in surfStore.records" :key="record.id" class="surf-card" @click="handleRecordClick(record)">
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
    </div>

    <div class="load-more">
      <el-button v-if="surfStore.hasMore" :loading="surfStore.loading" @click="surfStore.loadMore()">
        加载更多
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useSurfStore, type SurfRecord } from "@/stores/surf";

const router = useRouter();
const surfStore = useSurfStore();
const inputUrl = ref("");

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

const normalizeUrl = (url: string) => {
  const v = url.trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `https://${v}`;
};

const handleStart = async () => {
  try {
    if (surfStore.sessionActive) {
      await surfStore.startSession(normalizeUrl(inputUrl.value || "https://example.com"));
      return;
    }
    const normalized = normalizeUrl(inputUrl.value);
    if (!normalized) {
      ElMessage.warning("请输入 URL");
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

onMounted(async () => {
  await surfStore.checkSession();
  await surfStore.loadRecords();
});
</script>

<style scoped lang="scss">
.surf-page {
  padding: 16px;
}

.surf-header {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.surf-list {
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
}

.load-more {
  margin-top: 16px;
  text-align: center;
}
</style>
