<template>
  <div class="flex flex-col gap-2">
    <template v-for="(node, index) in sequence" :key="nodeKey(index)">
      <!-- 序列内相邻节点是「且」：左对齐的竖线 + 小胶囊 -->
      <div v-if="index > 0" class="flex items-center gap-2 py-0.5 pl-5">
        <span class="h-4 w-px flex-none bg-kb-line-strong" />
        <span class="rounded-kb-sm bg-kb-fill px-1.5 py-0.5 text-[11.5px] font-600 text-kb-fg-muted">
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

      <!-- 或组：浅灰底的容器，嵌套一层更深一档；取非时转危险色调 -->
      <section
        v-else-if="groupFor(node, index)"
        class="box-border rounded-kb-lg border border-solid p-3"
        :class="
          groupFor(node, index)!.wrapperPath
            ? 'border-[color-mix(in_srgb,var(--kb-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--kb-danger)_4%,transparent)]'
            : groupDepth === 0
              ? 'border-kb-line bg-kb-fill'
              : 'border-kb-line-strong bg-[color-mix(in_srgb,var(--kb-fg)_6%,transparent)]'
        "
      >
        <header class="mb-3 flex flex-wrap items-center gap-2">
          <span class="rounded-kb-sm bg-kb-fg px-2 py-0.5 text-[12px] font-600 text-white">
            {{ t("gallery.advancedOrGroup") }}
          </span>
          <span class="text-[12px] text-kb-fg-muted">
            {{ t("gallery.advancedOrGroupHint") }}
          </span>
          <button
            type="button"
            class="ml-auto box-border h-7 cursor-pointer rounded-kb-md border border-solid px-2.5 text-[12px] [font-family:inherit] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring"
            :class="
              groupFor(node, index)!.wrapperPath
                ? 'border-[color-mix(in_srgb,var(--kb-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--kb-danger)_10%,transparent)] font-600 text-kb-danger'
                : 'border-dashed border-kb-line-strong bg-kb-surface-raised text-kb-fg-muted hover:border-kb-fg-subtle hover:text-kb-fg'
            "
            :aria-pressed="!!groupFor(node, index)!.wrapperPath"
            @click="toggleGroupNegation(groupFor(node, index)!)"
          >
            {{ t("gallery.advancedNegateGroup") }}
          </button>
          <Button
            variant="ghost-danger"
            size="icon-sm"
            :aria-label="t('common.delete')"
            @click="removeGroup(groupFor(node, index)!)"
          >
            <X />
          </Button>
        </header>

        <template
          v-for="(branch, branchIndex) in groupFor(node, index)!.group.any"
          :key="`${nodeKey(index)}-branch-${branchIndex}`"
        >
          <!-- 分支之间是「或」 -->
          <div v-if="branchIndex > 0" class="my-2 flex items-center gap-2 text-[11.5px] font-600 text-kb-fg-muted">
            <span class="h-px w-3.5 flex-none bg-kb-line-strong" />
            <span class="rounded-kb-sm border border-solid border-kb-line-strong bg-kb-surface-raised px-2 py-0.5">
              {{ t("gallery.advancedOr") }}
            </span>
            <span class="h-px flex-1 bg-kb-line" />
          </div>

          <div>
            <div v-if="compact" class="mb-1 text-[12px] font-500 text-kb-fg-muted">
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

        <!-- 组里只加「或」：分支之间是或，分支内部不再提供任何添加口 -->
        <div class="mt-3">
          <Button size="sm" @click="addBranch(groupFor(node, index)!.groupPath, [{ is: {} }])">
            <Plus />
            {{ t("gallery.advancedAddBranch") }}
          </Button>
        </div>
      </section>

      <section
        v-else-if="'not' in node"
        class="box-border rounded-kb-lg border border-solid border-[color-mix(in_srgb,var(--kb-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--kb-danger)_4%,transparent)] p-3"
      >
        <header class="mb-3 flex items-center gap-2">
          <span
            class="rounded-kb-sm bg-[color-mix(in_srgb,var(--kb-danger)_12%,transparent)] px-2 py-0.5 text-[12px] font-600 text-kb-danger"
          >
            {{ t("gallery.advancedNegateGroup") }}
          </span>
          <Button
            variant="ghost-danger"
            size="icon-sm"
            class="ml-auto"
            :aria-label="t('common.delete')"
            @click="updateTree(removeNode(tree, nodePath(index)))"
          >
            <X />
          </Button>
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

    <!-- 添加口只在顶层：条件之间是「且」，或组作为一个整体参与这个「且」 -->
    <div v-if="target.kind === 'root'" class="mt-1 flex flex-wrap items-center gap-2">
      <Button @click="appendNode({ is: {} })">
        <Plus />
        {{ t("gallery.advancedAddCondition") }}
      </Button>
      <Button @click="appendNode(newGroup())">
        <Plus />
        {{ t("gallery.advancedAddOrGroup") }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { Plus, X } from "@lucide/vue";
import { Button } from "@/components/ui";
import GalleryAdvancedQueryConditionRow from "./GalleryAdvancedQueryConditionRow.vue";
import { removeNode, updateNode, type GalleryQuery, type GalleryQueryNode, type NodePath } from "@/utils/galleryQuery";

defineOptions({ name: "GalleryAdvancedQuerySequence" });

type SequenceTarget =
  { kind: "root" } | { kind: "any"; groupPath: NodePath; branchIndex: number } | { kind: "not"; notPath: NodePath };

interface ConditionDescriptor {
  atomPath: NodePath;
  wrapperPath?: NodePath;
}

interface GroupDescriptor {
  group: Extract<GalleryQueryNode, { any: GalleryQueryNode[][] }>;
  groupPath: NodePath;
  wrapperPath?: NodePath;
}

const props = withDefaults(
  defineProps<{
    tree: GalleryQuery;
    sequence: GalleryQueryNode[];
    basePath?: NodePath;
    target?: SequenceTarget;
    groupDepth?: number;
    compact?: boolean;
    contextPrefix?: string;
  }>(),
  {
    basePath: () => [],
    target: () => ({ kind: "root" }),
    groupDepth: 0,
    compact: false,
    contextPrefix: "images://gallery/",
  },
);

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
  // 取成局部常量：对 props.target 的收窄进不了下面的回调闭包
  const target: SequenceTarget = props.target;
  if (target.kind === "root") {
    updateTree([...props.tree, node]);
    return;
  }
  if (target.kind === "any") {
    updateTree(
      updateNode(props.tree, target.groupPath, (current) => {
        if (!("any" in current)) return current;
        const branches = current.any.map((branch) => [...branch]);
        branches[target.branchIndex] = [...(branches[target.branchIndex] ?? []), node];
        return { any: branches };
      }),
    );
    return;
  }
  updateTree(
    updateNode(props.tree, target.notPath, (current) => {
      if (!("not" in current)) return current;
      return { not: [...current.not, node] };
    }),
  );
}

function addBranch(groupPath: NodePath, branch: GalleryQueryNode[]): void {
  updateTree(
    updateNode(props.tree, groupPath, (node) => {
      if (!("any" in node)) return node;
      return { any: [...node.any, branch] };
    }),
  );
}

function toggleGroupNegation(group: GroupDescriptor): void {
  if (group.wrapperPath) {
    updateTree(
      updateNode(props.tree, group.wrapperPath, (node) => {
        if (!("not" in node) || node.not.length !== 1) return node;
        return node.not[0]!;
      }),
    );
    return;
  }
  updateTree(updateNode(props.tree, group.groupPath, (node) => ({ not: [node] })));
}

function removeGroup(group: GroupDescriptor): void {
  updateTree(removeNode(props.tree, group.wrapperPath ?? group.groupPath));
}
</script>
