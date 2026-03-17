<template>
  <!-- 安卓：单按钮打开「本地/远程」选择 picker，无下拉箭头 -->
  <el-button v-if="IS_ANDROID" type="primary" class="collect-btn" @click="emit('action', { type: 'openMenu' })">
    <el-icon>
      <Plus />
    </el-icon>
    {{ t('gallery.startCollect') }}
  </el-button>
  <el-dropdown v-else trigger="click" @command="handleCommand">
    <el-button type="primary" class="collect-btn">
      <el-icon>
        <Plus />
      </el-icon>
      {{ t('gallery.startCollect') }}
      <el-icon class="el-icon--right">
        <ArrowDown />
      </el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="local">
          <el-icon><FolderOpened /></el-icon>
          {{ t('gallery.local') }}
        </el-dropdown-item>
        <el-dropdown-item command="network">
          <el-icon><Connection /></el-icon>
          {{ t('gallery.network') }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Plus, ArrowDown, FolderOpened, Connection } from "@element-plus/icons-vue";
import { IS_ANDROID } from "@kabegame/core/env";

const { t } = useI18n();

const emit = defineEmits<{
  action: [data: { type: string; value?: string }];
}>();

const handleCommand = (command: string) => {
  emit("action", { type: "select", value: command });
};
</script>

<style scoped lang="scss">
.collect-btn {
  box-shadow: var(--anime-shadow);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}
</style>