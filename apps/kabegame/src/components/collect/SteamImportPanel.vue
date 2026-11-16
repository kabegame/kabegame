<template>
  <div class="flex flex-col gap-3">
    <!-- 登录购买了 Wallpaper Engine 的 Steam 账号后挑创意工坊订阅，缺 WPE 时任务顺带下载 -->
    <SectionTitle>{{ $t("gallery.wpeSteamTitle") }}</SectionTitle>
    <WpeSteamPanel v-model:account="steamAccount" />
    <template v-if="steamAccount">
      <SectionTitle>{{ $t("gallery.wpeSteamPickTitle") }}</SectionTitle>
      <!-- 我的订阅 / 工坊发现：两个页签都留着（v-show），切换不丢页码与筛选；已选条目共用一份 -->
      <SegmentedControl v-model="steamTab" :options="steamTabOptions" size="sm" class="max-w-[280px]" />
      <WpeSteamWorkshopList
        v-show="steamTab === 'subscriptions'"
        :key="`subs:${steamAccount}`"
        v-model:selected-ids="steamSelectedIds"
        v-model:all-subscriptions="steamAllSubscriptions"
        source="subscriptions"
        :account="steamAccount"
      />
      <WpeSteamWorkshopList
        v-if="steamDiscoverOpened"
        v-show="steamTab === 'discover'"
        :key="`discover:${steamAccount}`"
        v-model:selected-ids="steamSelectedIds"
        source="discover"
        :account="steamAccount"
      />
    </template>

    <WpeImportSaveFields v-model:output-album-id="outputAlbumId" v-model:is-dry-run="isDryRun" />
  </div>
</template>

<script setup lang="ts">
/**
 * 「网络 → Steam」：从 Steam 拉创意工坊订阅 / 工坊发现的壁纸，交给内建 wpe-import 任务。
 * 宿主见 CollectNetworkDialog；本机已有的 WPE 目录在「本地 → WPE 壁纸」（WpeLocalPanel）。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { SegmentedControl } from "@/components/ui";
import { kameMessage } from "@/utils/kameMessage";
import SectionTitle from "@/components/ui/SectionTitle.vue";
import WpeSteamPanel from "@/components/WpeSteamPanel.vue";
import WpeSteamWorkshopList, { type SteamAllSubscriptions } from "@/components/WpeSteamWorkshopList.vue";
import WpeImportSaveFields from "./WpeImportSaveFields.vue";
import { addWpeImportTask } from "./wpeImport";

const emit = defineEmits<{ (e: "done"): void }>();

const { t } = useI18n();

const submitting = ref(false);
const outputAlbumId = ref<string | null>(null);
const isDryRun = ref(false);
/** 面板登录好的账号 */
const steamAccount = ref<string | null>(null);
/** 两个页签共用的已选条目 id */
const steamSelectedIds = ref<string[]>([]);
/** 订阅页签勾了「全部 N 个」时的分级与总数 */
const steamAllSubscriptions = ref<SteamAllSubscriptions | null>(null);
const steamTab = ref<"subscriptions" | "discover">("subscriptions");
const steamTabOptions = computed(() => [
  { label: t("gallery.wpeSteamSubsTitle"), value: "subscriptions" as const },
  { label: t("gallery.wpeSteamDiscoverTitle"), value: "discover" as const },
]);
/** 工坊发现第一次切过去才挂载（才开始查），之后一直留着 */
const steamDiscoverOpened = ref(false);
watch(steamTab, (tab) => {
  if (tab === "discover") steamDiscoverOpened.value = true;
});
// 换账号（或登出）时已选的条目不再算数
watch(steamAccount, () => {
  steamSelectedIds.value = [];
  steamAllSubscriptions.value = null;
});

const canSubmit = computed(
  () => !!steamAccount.value && (steamSelectedIds.value.length > 0 || !!steamAllSubscriptions.value),
);

const hint = computed(() => {
  const all = steamAllSubscriptions.value;
  const picked = steamSelectedIds.value.length;
  if (!steamAccount.value) return t("gallery.wpeSteamNeedLogin");
  if (all) {
    return picked
      ? t("gallery.wpeSteamSubsSummaryAllPlus", { n: all.total, m: picked })
      : t("gallery.wpeSteamSubsSummaryAll", { n: all.total });
  }
  if (!picked) return t("gallery.wpeSteamSubsNeedSelect");
  return t("gallery.wpeSteamSubsSummaryItems", { n: picked });
});

async function submit() {
  if (!canSubmit.value) {
    kameMessage.warning(hint.value);
    return;
  }
  if (submitting.value) return;
  // 不用本机自动来源（sources 传 null），带账号名与选中的条目（或「全部」时的分级），两者由任务取并集；
  // token 在后端插件数据的私有区里，任务按账号取。缺 WPE 时任务先顺带下载，不导入官方默认壁纸。
  const userConfig = {
    sources: null,
    steamAccount: steamAccount.value,
    steamItems: steamSelectedIds.value.length ? steamSelectedIds.value : null,
    steamAllSubscriptions: steamAllSubscriptions.value?.ratings ?? null,
  };
  submitting.value = true;
  try {
    if (await addWpeImportTask(userConfig, outputAlbumId.value, isDryRun.value)) emit("done");
  } finally {
    submitting.value = false;
  }
}

defineExpose({ submit, canSubmit, submitting, hint });
</script>
