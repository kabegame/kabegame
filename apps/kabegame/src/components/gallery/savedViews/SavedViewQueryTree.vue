<template>
  <!-- 高级条件的只读展示：数组是「且」序列；is 原子里各维度也是「且」；any 画成框、分支之间「或」；
       not 画成带「非」的虚线框。自引用递归（与高级查询的嵌套深度同上限）。 -->
  <div class="flex min-w-0 flex-col gap-1.5">
    <template v-for="(node, index) in query" :key="index">
      <span v-if="index > 0" class="text-[11px] text-[var(--kb-fg-muted)]">
        {{ t("gallery.advancedAnd") }}
      </span>
      <div v-if="isAtom(node)" class="flex flex-wrap items-center gap-1">
        <template v-for="(pill, i) in filterSetPills(node.is, ctx)" :key="pill.key">
          <span v-if="i > 0" class="text-[11px] text-[var(--kb-fg-muted)]">
            {{ t("gallery.advancedAnd") }}
          </span>
          <SavedViewPill :pill="pill" :variant="newKeys?.has(pill.key) ? 'new' : 'normal'" />
        </template>
      </div>
      <div
        v-else-if="isAny(node)"
        class="flex flex-col gap-1.5 rounded-lg border border-solid border-[var(--kb-line-strong)] p-2"
      >
        <template v-for="(branch, b) in node.any" :key="b">
          <div v-if="b > 0" class="flex items-center gap-2 text-[11px] text-[var(--kb-fg-muted)]">
            <span class="h-px flex-1 bg-[var(--kb-line-strong)]" />
            {{ t("gallery.advancedOr") }}
            <span class="h-px flex-1 bg-[var(--kb-line-strong)]" />
          </div>
          <SavedViewQueryTree :query="branch" :ctx="ctx" :new-keys="newKeys" />
        </template>
      </div>
      <div v-else class="flex items-start gap-2 rounded-lg border border-dashed border-[var(--kb-line-strong)] p-2">
        <span class="pt-[3px] text-[11px] text-[var(--kb-fg-muted)]">{{ t("gallery.advancedNot") }}</span>
        <SavedViewQueryTree class="flex-1" :query="notBody(node)" :ctx="ctx" :new-keys="newKeys" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import type { GalleryLabelContext } from "@/utils/galleryFilterLabels";
import type { GalleryFilterSet, GalleryQuery, GalleryQueryNode } from "@/utils/galleryQuery";
import SavedViewPill from "./SavedViewPill.vue";
import { filterSetPills } from "./savedViewPills";

defineOptions({ name: "SavedViewQueryTree" });

defineProps<{
  query: GalleryQuery;
  ctx: GalleryLabelContext;
  /** 差异对比：命中的条件画成「新增」。 */
  newKeys?: ReadonlySet<string> | null;
}>();

const { t } = useI18n();

const isAtom = (node: GalleryQueryNode): node is { is: GalleryFilterSet } => "is" in node;
const isAny = (node: GalleryQueryNode): node is { any: GalleryQuery[] } => "any" in node;
const notBody = (node: GalleryQueryNode): GalleryQuery => ("not" in node ? node.not : []);
</script>
