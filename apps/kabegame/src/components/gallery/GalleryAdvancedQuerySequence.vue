<template>
  <div class="flex flex-col gap-2">
    <template v-for="(node, index) in sequence" :key="nodeKey(index)">
      <!-- 序列内相邻节点是「且」:左对齐的竖线 + 胶囊(设计稿) -->
      <div
        v-if="index > 0"
        class="flex items-center gap-2 py-0.5 pl-5"
      >
        <span class="h-4 w-px flex-none bg-[color-mix(in_srgb,var(--anime-secondary)_35%,transparent)]" />
        <span class="rounded-md bg-[color-mix(in_srgb,var(--anime-secondary)_12%,transparent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--anime-secondary-dark)]">
          {{ t("gallery.advancedAnd") }}
        </span>
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
        class="rounded-2xl border border-solid p-3"
        :class="groupFor(node, index)!.wrapperPath
          ? 'border-[color-mix(in_srgb,var(--el-color-error)_38%,transparent)] bg-[color-mix(in_srgb,var(--el-color-error)_5%,transparent)]'
          : groupDepth === 0
            ? 'border-[color-mix(in_srgb,var(--anime-secondary)_45%,transparent)] bg-[color-mix(in_srgb,var(--anime-secondary)_6%,transparent)]'
            : 'border-[color-mix(in_srgb,var(--anime-secondary)_55%,transparent)] bg-[color-mix(in_srgb,var(--anime-secondary)_12%,transparent)]'"
      >
        <header class="mb-3 flex flex-wrap items-center gap-2">
          <span class="rounded-lg bg-[linear-gradient(135deg,var(--anime-secondary),var(--anime-secondary-dark))] px-2.5 py-1 text-sm font-bold text-white">
            {{ t("gallery.advancedOrGroup") }}
          </span>
          <span class="text-xs text-[var(--anime-text-secondary)]">
            {{ t("gallery.advancedOrGroupHint") }}
          </span>
          <button
            type="button"
            class="ml-auto rounded-lg border border-dashed border-[var(--anime-border)] bg-[var(--anime-bg-card)] px-2.5 py-1.5 text-xs text-[var(--anime-text-secondary)] cursor-pointer"
            :class="{
              '!border-solid !border-[color-mix(in_srgb,var(--el-color-error)_45%,transparent)] !bg-[color-mix(in_srgb,var(--el-color-error)_10%,transparent)] !font-bold !text-[var(--el-color-error)]': !!groupFor(node, index)!.wrapperPath,
            }"
            @click="toggleGroupNegation(groupFor(node, index)!)"
          >
            {{ t("gallery.advancedNegateGroup") }}
          </button>
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded-lg border-0 bg-transparent text-[var(--anime-text-secondary)] hover:bg-[color-mix(in_srgb,var(--el-color-error)_10%,transparent)] hover:text-[var(--el-color-error)] cursor-pointer"
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
          <!-- 分支之间是「或」 -->
          <div
            v-if="branchIndex > 0"
            class="my-2 flex items-center gap-2 text-xs font-bold text-[var(--anime-secondary-dark)]"
          >
            <span class="h-px w-3.5 flex-none bg-[color-mix(in_srgb,var(--anime-secondary)_40%,transparent)]" />
            <span class="rounded-md border border-solid border-[color-mix(in_srgb,var(--anime-secondary)_40%,transparent)] bg-[var(--anime-bg-card)] px-2 py-0.5">
              {{ t("gallery.advancedOr") }}
            </span>
            <span class="h-px flex-1 bg-[color-mix(in_srgb,var(--anime-secondary)_22%,transparent)]" />
          </div>

          <div>
            <div v-if="compact" class="mb-1 text-xs font-medium text-[var(--anime-secondary)]">
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

        <!-- 组里只加「或」:分支之间是或,分支内部不再提供任何添加口 -->
        <div class="mt-3">
          <button
            type="button"
            class="rounded-lg border border-dashed border-[color-mix(in_srgb,var(--anime-secondary)_50%,transparent)] bg-[var(--anime-bg-card)] px-3 py-1.5 text-sm font-semibold text-[var(--anime-secondary-dark)] cursor-pointer"
            @click="addBranch(groupFor(node, index)!.groupPath, [{ is: {} }])"
          >
            ＋ {{ t("gallery.advancedAddBranch") }}
          </button>
        </div>
      </section>

      <section
        v-else-if="'not' in node"
        class="rounded-2xl border border-solid border-[color-mix(in_srgb,var(--el-color-error)_38%,transparent)] bg-[color-mix(in_srgb,var(--el-color-error)_5%,transparent)] p-3"
      >
        <header class="mb-3 flex items-center gap-2">
          <span class="rounded-lg bg-[color-mix(in_srgb,var(--el-color-error)_12%,transparent)] px-2 py-1 text-sm font-bold text-[var(--el-color-error)]">
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

    <!-- 添加口只在顶层:条件之间是「且」,或组作为一个整体参与这个「且」 -->
    <div v-if="target.kind === 'root'" class="mt-1 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="rounded-lg border border-dashed border-[color-mix(in_srgb,var(--anime-primary)_50%,transparent)] bg-[var(--anime-bg-card)] px-3 py-1.5 text-sm font-semibold text-[var(--anime-primary)] cursor-pointer"
        @click="appendNode({ is: {} })"
      >
        ＋ {{ t("gallery.advancedAddCondition") }}
      </button>
      <button
        type="button"
        class="rounded-lg border border-dashed border-[color-mix(in_srgb,var(--anime-secondary)_50%,transparent)] bg-[var(--anime-bg-card)] px-3 py-1.5 text-sm font-semibold text-[var(--anime-secondary-dark)] cursor-pointer"
        @click="appendNode(newGroup())"
      >
        ＋ {{ t("gallery.advancedAddOrGroup") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { ElIcon } from "@kabegame/element-plus";
import { Close } from "@kabegame/element-plus-icons";
import GalleryAdvancedQueryConditionRow from "./GalleryAdvancedQueryConditionRow.vue";
import {
  removeNode,
  updateNode,
  type GalleryQuery,
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
  tree: GalleryQuery;
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
  "update:tree": [tree: GalleryQuery];
}>();

const { t } = useI18n();


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

function updateTree(tree: GalleryQuery): void {
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

function addBranch(groupPath: NodePath, branch: GalleryQueryNode[]): void {
  updateTree(updateNode(props.tree, groupPath, (node) => {
    if (!("any" in node)) return node;
    return { any: [...node.any, branch] };
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
