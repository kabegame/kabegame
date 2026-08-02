<template>
  <div class="flex flex-col gap-2">
    <template v-for="(node, index) in sequence" :key="nodeKey(index)">
      <div
        v-if="index > 0"
        class="flex items-center gap-2 px-4 text-xs font-medium text-[var(--anime-secondary)]"
      >
        <span class="h-px flex-1 bg-[var(--anime-border)]" />
        <span class="rounded-full bg-[color-mix(in_srgb,var(--anime-secondary)_11%,transparent)] px-2 py-0.5">
          {{ t("gallery.advancedAnd") }}
        </span>
        <span class="h-px flex-1 bg-[var(--anime-border)]" />
      </div>

      <GalleryAdvancedQueryConditionRow
        v-if="conditionFor(node, index)"
        :tree="tree"
        :node-path="conditionFor(node, index)!.atomPath"
        :context-prefix="contextPrefix"
        :negation-wrapper-path="conditionFor(node, index)!.wrapperPath"
        :compact="compact"
        :title="conditionTitle(index)"
        @update:tree="updateTree"
      />

      <section
        v-else-if="groupFor(node, index)"
        class="rounded-2xl border border-[color-mix(in_srgb,var(--anime-secondary)_36%,var(--anime-border))] bg-[color-mix(in_srgb,var(--anime-bg-card)_94%,var(--kb-el-bg-color))] p-3"
      >
        <header class="mb-3 flex flex-wrap items-center gap-2">
          <span class="rounded-lg bg-[linear-gradient(90deg,var(--anime-primary),var(--anime-secondary))] px-2.5 py-1 text-sm font-semibold text-white">
            {{ t("gallery.advancedOrGroup") }}
          </span>
          <span class="text-xs text-[var(--anime-text-secondary)]">
            {{ t("gallery.advancedOrGroupHint") }}
          </span>
          <button
            type="button"
            class="ml-auto rounded-lg border border-dashed border-[var(--anime-border)] bg-transparent px-2.5 py-1.5 text-xs text-[var(--anime-text-secondary)] cursor-pointer"
            :class="{
              '!border-solid !border-[var(--anime-primary)] !bg-[color-mix(in_srgb,var(--anime-primary)_10%,transparent)] !text-[var(--anime-primary)]': !!groupFor(node, index)!.wrapperPath,
            }"
            @click="toggleGroupNegation(groupFor(node, index)!)"
          >
            {{ t("gallery.advancedNegateGroup") }}
          </button>
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded-full border-0 bg-transparent text-[var(--anime-text-secondary)] hover:text-[var(--anime-primary)] cursor-pointer"
            :aria-label="t('common.delete')"
            @click="removeGroup(groupFor(node, index)!)"
          >
            <el-icon><Close /></el-icon>
          </button>
        </header>

        <template
          v-for="(branch, branchIndex) in groupFor(node, index)!.group.any"
          :key="`${nodeKey(index)}-branch-${branchIndex}`"
        >
          <div
            v-if="branchIndex > 0"
            class="my-2 flex items-center gap-2 text-xs font-medium text-[var(--anime-primary)]"
          >
            <span class="h-px flex-1 bg-[color-mix(in_srgb,var(--anime-primary)_24%,transparent)]" />
            <span class="rounded-full border border-[color-mix(in_srgb,var(--anime-primary)_30%,transparent)] bg-[var(--anime-bg-card)] px-2 py-0.5">
              {{ t("gallery.advancedOr") }}
            </span>
            <span class="h-px flex-1 bg-[color-mix(in_srgb,var(--anime-primary)_24%,transparent)]" />
          </div>
          <div class="rounded-xl border border-[var(--anime-border)] bg-[color-mix(in_srgb,var(--anime-bg-card)_94%,var(--kb-el-bg-color))] p-2">
            <div v-if="compact" class="mb-2 text-xs font-medium text-[var(--anime-text-secondary)]">
              {{ t("gallery.advancedBranchN", { n: branchIndex + 1 }) }}
            </div>
            <GalleryAdvancedQuerySequence
              :tree="tree"
              :sequence="branch"
              :base-path="[...groupFor(node, index)!.groupPath, branchIndex]"
              :target="{
                kind: 'any',
                groupPath: groupFor(node, index)!.groupPath,
                branchIndex,
              }"
              :group-depth="groupDepth + 1"
              :compact="compact"
              :context-prefix="contextPrefix"
              @update:tree="updateTree"
            />
          </div>
        </template>

        <button
          type="button"
          class="mt-3 rounded-lg border border-dashed border-[var(--anime-border)] bg-transparent px-3 py-1.5 text-sm text-[var(--anime-primary)] cursor-pointer"
          @click="addBranch(groupFor(node, index)!.groupPath)"
        >
          ＋ {{ t("gallery.advancedAddBranch") }}
        </button>
      </section>

      <section
        v-else-if="'not' in node"
        class="rounded-2xl border border-[var(--anime-border)] bg-[color-mix(in_srgb,var(--anime-bg-card)_94%,var(--kb-el-bg-color))] p-3"
      >
        <header class="mb-3 flex items-center gap-2">
          <span class="rounded-lg bg-[color-mix(in_srgb,var(--anime-primary)_12%,transparent)] px-2 py-1 text-sm font-medium text-[var(--anime-primary)]">
            {{ t("gallery.advancedNegateGroup") }}
          </span>
          <button
            type="button"
            class="ml-auto inline-flex h-7 w-7 items-center justify-center border-0 bg-transparent text-[var(--anime-text-secondary)] cursor-pointer"
            :aria-label="t('common.delete')"
            @click="updateTree(removeNode(tree, nodePath(index)))"
          >
            <el-icon><Close /></el-icon>
          </button>
        </header>
        <GalleryAdvancedQuerySequence
          :tree="tree"
          :sequence="node.not"
          :base-path="nodePath(index)"
          :target="{ kind: 'not', notPath: nodePath(index) }"
          :group-depth="groupDepth"
          :compact="compact"
          :context-prefix="contextPrefix"
          @update:tree="updateTree"
        />
      </section>
    </template>

    <div class="mt-1 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="rounded-lg border border-dashed border-[var(--anime-border)] bg-transparent px-3 py-1.5 text-sm text-[var(--anime-primary)] cursor-pointer"
        @click="appendNode({ is: {} })"
      >
        ＋ {{ t("gallery.advancedAddCondition") }}
      </button>
      <el-tooltip
        :content="t('gallery.advancedNestingLimit')"
        :disabled="canAddGroup"
        placement="top"
      >
        <span>
          <button
            type="button"
            class="rounded-lg border border-dashed border-[var(--anime-border)] bg-transparent px-3 py-1.5 text-sm text-[var(--anime-secondary)] cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
            :disabled="!canAddGroup"
            @click="appendNode(newGroup())"
          >
            ＋ {{ t("gallery.advancedAddOrGroup") }}
          </button>
        </span>
      </el-tooltip>
      <span v-if="!canAddGroup" class="text-xs text-[var(--anime-text-secondary)]">
        {{ t("gallery.advancedNestingLimit") }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElIcon, ElTooltip } from "@kabegame/element-plus";
import { Close } from "@kabegame/element-plus-icons";
import GalleryAdvancedQueryConditionRow from "./GalleryAdvancedQueryConditionRow.vue";
import {
  MAX_GROUP_DEPTH,
  removeNode,
  updateNode,
  type GalleryAdvancedQuery,
  type GalleryQueryNode,
  type NodePath,
} from "@/utils/galleryQuery";

defineOptions({ name: "GalleryAdvancedQuerySequence" });

type SequenceTarget =
  | { kind: "root" }
  | { kind: "any"; groupPath: NodePath; branchIndex: number }
  | { kind: "not"; notPath: NodePath };

interface ConditionDescriptor {
  atomPath: NodePath;
  wrapperPath?: NodePath;
}

interface GroupDescriptor {
  group: Extract<GalleryQueryNode, { any: GalleryQueryNode[][] }>;
  groupPath: NodePath;
  wrapperPath?: NodePath;
}

const props = withDefaults(defineProps<{
  tree: GalleryAdvancedQuery;
  sequence: GalleryQueryNode[];
  basePath?: NodePath;
  target?: SequenceTarget;
  groupDepth?: number;
  compact?: boolean;
  contextPrefix?: string;
}>(), {
  basePath: () => [],
  target: () => ({ kind: "root" }),
  groupDepth: 0,
  compact: false,
  contextPrefix: "images://gallery/",
});

const emit = defineEmits<{
  "update:tree": [tree: GalleryAdvancedQuery];
}>();

const { t } = useI18n();
const canAddGroup = computed(() => props.groupDepth < MAX_GROUP_DEPTH);

function nodePath(index: number): NodePath {
  return [...props.basePath, index];
}

function nodeKey(index: number): string {
  return nodePath(index).join(".") || String(index);
}

function conditionTitle(index: number): string {
  return t("gallery.advancedConditionN", { n: index + 1 });
}

function conditionFor(node: GalleryQueryNode, index: number): ConditionDescriptor | null {
  const path = nodePath(index);
  if ("is" in node) return { atomPath: path };
  if ("not" in node && node.not.length === 1 && "is" in node.not[0]!) {
    return { atomPath: [...path, 0], wrapperPath: path };
  }
  return null;
}

function groupFor(node: GalleryQueryNode, index: number): GroupDescriptor | null {
  const path = nodePath(index);
  if ("any" in node) return { group: node, groupPath: path };
  if ("not" in node && node.not.length === 1 && "any" in node.not[0]!) {
    return {
      group: node.not[0] as Extract<GalleryQueryNode, { any: GalleryQueryNode[][] }>,
      groupPath: [...path, 0],
      wrapperPath: path,
    };
  }
  return null;
}

function newGroup(): GalleryQueryNode {
  return { any: [[{ is: {} }], [{ is: {} }]] };
}

function updateTree(tree: GalleryAdvancedQuery): void {
  emit("update:tree", tree);
}

function appendNode(node: GalleryQueryNode): void {
  if (props.target.kind === "root") {
    updateTree([...props.tree, node]);
    return;
  }
  if (props.target.kind === "any") {
    updateTree(updateNode(props.tree, props.target.groupPath, (current) => {
      if (!("any" in current)) return current;
      const branches = current.any.map((branch) => [...branch]);
      branches[props.target.branchIndex] = [
        ...(branches[props.target.branchIndex] ?? []),
        node,
      ];
      return { any: branches };
    }));
    return;
  }
  updateTree(updateNode(props.tree, props.target.notPath, (current) => {
    if (!("not" in current)) return current;
    return { not: [...current.not, node] };
  }));
}

function addBranch(groupPath: NodePath): void {
  updateTree(updateNode(props.tree, groupPath, (node) => {
    if (!("any" in node)) return node;
    return { any: [...node.any, [{ is: {} }]] };
  }));
}

function toggleGroupNegation(group: GroupDescriptor): void {
  if (group.wrapperPath) {
    updateTree(updateNode(props.tree, group.wrapperPath, (node) => {
      if (!("not" in node) || node.not.length !== 1) return node;
      return node.not[0]!;
    }));
    return;
  }
  updateTree(updateNode(props.tree, group.groupPath, (node) => ({ not: [node] })));
}

function removeGroup(group: GroupDescriptor): void {
  updateTree(removeNode(props.tree, group.wrapperPath ?? group.groupPath));
}

</script>
