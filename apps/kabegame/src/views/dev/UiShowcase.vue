<template>
  <div class="box-border h-full overflow-y-auto bg-kb-bg px-6 pb-16 pt-5 text-kb-fg">
    <h1 class="m-0 text-[20px] font-600 tracking-[-0.01em]">新界面组件陈列</h1>
    <p class="m-0 mt-1 text-[12.5px] text-kb-fg-muted">
      dev 专用（/dev/ui）。改组件后在这里对照外观与键盘行为；「嵌套」一节验证层叠、焦点与 Esc。
    </p>

    <section :class="SECTION">
      <h2 :class="H2">按钮与标签</h2>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="primary">
          <Plus />
          主操作
        </Button>
        <Button>次操作</Button>
        <Button variant="ghost">幽灵</Button>
        <Button variant="ghost-danger">
          <Trash2 />
          删除
        </Button>
        <Button variant="danger">危险实心</Button>
        <Button size="sm">小号</Button>
        <Button disabled>禁用</Button>
        <Tooltip content="提示文字">
          <Button size="icon" variant="ghost"><Info /></Button>
        </Tooltip>
        <Spinner />
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <Tag>中性</Tag>
        <Tag tone="accent">强调</Tag>
        <Tag tone="success">成功</Tag>
        <Tag tone="warning">警告</Tag>
        <Tag tone="danger">失败</Tag>
        <Tag size="sm" closable @close="toast.info('关闭了标签')">可关闭</Tag>
      </div>
    </section>

    <section :class="SECTION">
      <h2 :class="H2">提示与反馈</h2>
      <div class="flex flex-wrap gap-2">
        <Button @click="toast.success('已保存')">toast.success</Button>
        <Button @click="toast.info('正在后台整理，完成后会通知你')">toast.info</Button>
        <Button @click="toast.warning('有 3 张图片没有导入')">toast.warning</Button>
        <Button @click="toast.error('下载失败：连接超时（https://example.com/very/long/path/to/image.jpg）')">
          toast.error
        </Button>
        <Button @click="toast({ type: 'info', message: '不会自动关闭', duration: 0 })">duration 0</Button>
        <Button @click="toast.closeAll()">closeAll</Button>
        <Button @click="confirmDemo">messageBox.confirm</Button>
        <Button @click="alertOpen = true">AlertDialog</Button>
      </div>
      <div class="mt-3 grid gap-2">
        <Alert title="信息" description="页内提示条，正文是中性色。" />
        <Alert tone="success" description="同步完成。" />
        <Alert tone="warning" title="需要窗口模式" description="网页壁纸只能在窗口模式下显示。" />
        <Alert tone="danger" description="插件版本与应用不兼容。" />
      </div>
      <div class="mt-3 flex items-center gap-3">
        <Switch v-model="loadingOn" />
        <span class="text-[13px]">v-loading</span>
      </div>
      <div v-loading="loadingOn" class="mt-2 h-24 rounded-kb-lg bg-kb-surface-raised p-3 text-[13px] shadow-kb-sm">
        加载遮罩铺满这块区域
      </div>
      <div class="mt-3 flex items-center gap-3">
        <Skeleton class="size-10 rounded-full" />
        <div class="flex flex-col gap-1.5">
          <Skeleton class="h-3.5 w-48" />
          <Skeleton class="h-3 w-32" />
        </div>
      </div>
    </section>

    <section :class="SECTION">
      <h2 :class="H2">弹层</h2>
      <div class="flex flex-wrap gap-2">
        <Button @click="dialogOpen = true">Dialog</Button>
        <Button @click="sheetSide = 'right'">Sheet 右</Button>
        <Button @click="sheetSide = 'bottom'">Sheet 底</Button>
        <Popover>
          <PopoverTrigger as-child><Button>Popover</Button></PopoverTrigger>
          <PopoverContent :width="260">
            <div class="p-2 text-[13px]">气泡卡片，点外部关闭。</div>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button>
              下拉菜单
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <MenuLabel>视图</MenuLabel>
            <MenuItem shortcut="⌘R">
              <RefreshCw />
              刷新
            </MenuItem>
            <MenuCheckboxItem v-model="showHidden" keep-open>显示隐藏图片</MenuCheckboxItem>
            <MenuSub label="排序">
              <MenuRadioGroup v-model="sortBy" :items="SORTS" />
            </MenuSub>
            <MenuSeparator />
            <MenuItem danger>
              <Trash2 />
              删除
            </MenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ContextMenu>
        <div
          class="mt-3 grid h-24 place-items-center rounded-kb-lg border border-dashed border-kb-line-strong text-[12.5px] text-kb-fg-muted"
        >
          在这里右键
        </div>
        <template #menu>
          <MenuItem @select="toast.info('复制')">
            <Copy />
            复制
          </MenuItem>
          <MenuSub label="加入画册">
            <MenuItem>收藏</MenuItem>
            <MenuItem>壁纸</MenuItem>
          </MenuSub>
          <MenuSeparator />
          <MenuItem danger>
            <Trash2 />
            删除
          </MenuItem>
        </template>
      </ContextMenu>
    </section>

    <section :class="SECTION">
      <h2 :class="H2">表单</h2>
      <div class="grid max-w-[560px] gap-4">
        <Field label="名称" description="画册名不能和同级重复" required>
          <Input v-model="text" placeholder="输入名称" clearable />
        </Field>
        <Field label="搜索" :error="text.length > 12 ? '最多 12 个字' : ''">
          <Input v-model="text" placeholder="带前缀">
            <template #prefix><Search /></template>
          </Input>
        </Field>
        <Field label="说明">
          <Textarea v-model="longText" autosize :max-rows="6" placeholder="多行，高度随内容" />
        </Field>
        <Field label="并发数" orientation="horizontal">
          <NumberField v-model="count" :min="1" :max="16" unit="个" class="!w-40" />
        </Field>
        <Field label="分辨率" orientation="horizontal">
          <Select v-model="resolution" :options="RESOLUTIONS" placeholder="选择分辨率" class="!w-48" />
        </Field>
        <Field label="插件" orientation="horizontal">
          <Combobox v-model="plugin" :options="PLUGINS" placeholder="搜索插件" search-icon class="!w-60" />
        </Field>
        <Field label="音量" orientation="horizontal">
          <div class="flex h-8 items-center gap-3">
            <Slider v-model="volume" class="w-48" label="音量" />
            <span class="w-8 text-[12.5px] tabular-nums text-kb-fg-muted">{{ volume }}</span>
          </div>
        </Field>
        <Field label="选项" orientation="horizontal">
          <div class="flex h-8 items-center gap-5">
            <Checkbox v-model="agree" label="同意" />
            <Checkbox :model-value="'indeterminate'" label="部分" />
            <Checkbox disabled label="禁用" />
          </div>
        </Field>
        <Field label="类型" orientation="horizontal">
          <CheckboxGroup v-model="kinds" :items="KINDS" />
        </Field>
        <Field label="壁纸模式">
          <RadioGroup v-model="mode" :items="MODES" />
        </Field>
      </div>
    </section>

    <section :class="SECTION">
      <h2 :class="H2">展示</h2>
      <DescriptionList :columns="2" :items="DESC" />
      <Separator class="my-4" />
      <ScrollArea class="h-32 w-72 rounded-kb-md bg-kb-surface-raised">
        <div class="p-3 text-[13px] leading-7">
          <div v-for="i in 20" :key="i">第 {{ i }} 行</div>
        </div>
      </ScrollArea>
    </section>

    <section :class="SECTION">
      <h2 :class="H2">嵌套</h2>
      <p class="m-0 mb-2 text-[12.5px] text-kb-fg-muted">
        对话框里放选择框、组合框、下拉菜单、气泡，再从里面弹确认框、输入框、滚轮与第二个对话框。都应能点、能用键盘，Esc
        只关最上面一层。
      </p>
      <div class="flex gap-2">
        <Button @click="nestOpen = true">对话框 ⊃ 各种浮层</Button>
        <Button @click="pickerOpen = true">滚轮（级联）</Button>
      </div>
    </section>

    <Dialog v-model:open="dialogOpen" title="新建画册" description="画册可以嵌套，名字在同级里不能重复。">
      <div class="grid gap-3">
        <Field label="名称"><Input v-model="text" placeholder="输入名称" /></Field>
        <Field label="放在"><Select v-model="resolution" :options="RESOLUTIONS" /></Field>
      </div>
      <template #footer>
        <Button @click="dialogOpen = false">取消</Button>
        <Button variant="primary" @click="dialogOpen = false">创建</Button>
      </template>
    </Dialog>

    <Sheet
      :open="sheetSide !== null"
      :side="sheetSide ?? 'right'"
      title="任务"
      @update:open="(v) => !v && (sheetSide = null)"
    >
      <div class="grid gap-2">
        <div v-for="i in 8" :key="i" class="h-12 rounded-kb-md bg-kb-fill-light" />
      </div>
    </Sheet>

    <AlertDialog
      v-model:open="alertOpen"
      title="删除 12 张图片？"
      description="只删除记录，不删除磁盘上的文件。"
      tone="danger"
      confirm-text="删除"
      :action="fakeDelete"
    />

    <Dialog v-model:open="nestOpen" title="对话框 ⊃ 各种浮层" width="480px">
      <div class="grid gap-3">
        <Field label="选择框"><Select v-model="resolution" :options="RESOLUTIONS" /></Field>
        <Field label="组合框"><Combobox v-model="plugin" :options="PLUGINS" /></Field>
        <div class="flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger as-child><Button>下拉菜单</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <MenuItem @select="toast.success('选中了')">选项一</MenuItem>
              <MenuSub label="子菜单"><MenuItem>子项</MenuItem></MenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger as-child><Button>气泡</Button></PopoverTrigger>
            <PopoverContent :width="240">
              <div class="p-1"><Input v-model="text" placeholder="气泡里的输入框" /></div>
            </PopoverContent>
          </Popover>
          <Button @click="confirmDemo">确认框</Button>
          <Button @click="promptDemo">输入框</Button>
          <Button @click="pickerOpen = true">滚轮</Button>
          <Button @click="dialogOpen = true">再开一个对话框</Button>
        </div>
      </div>
    </Dialog>

    <PickerSheet
      v-model:open="pickerOpen"
      v-model="pickerValues"
      title="跳到第几页"
      :columns="PICKER_COLUMNS"
      @confirm="(p) => toast.info(`选了 ${p.selectedValues.join('')}`)"
    />
  </div>
</template>

<script setup lang="ts">
/** dev 专用的组件陈列页（路由 /dev/ui，生产构建不注册）。 */
import { ref } from "vue";
import { ChevronDown, Copy, Info, Plus, RefreshCw, Search, Trash2 } from "@lucide/vue";
import {
  Alert,
  AlertDialog,
  Button,
  Checkbox,
  CheckboxGroup,
  Combobox,
  ContextMenu,
  DescriptionList,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Field,
  Input,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  NumberField,
  PickerSheet,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  ScrollArea,
  Select,
  Separator,
  Sheet,
  Skeleton,
  Slider,
  Spinner,
  Switch,
  Tag,
  Textarea,
  Tooltip,
  messageBox,
  toast,
  vLoading,
} from "@/components/ui";

const SECTION = "mt-6 rounded-kb-lg bg-kb-surface-raised p-5 shadow-kb-sm";
const H2 = "m-0 mb-3 text-[14px] font-600";

const SORTS = [
  { label: "最新", value: "time" },
  { label: "名称", value: "name" },
  { label: "随机", value: "random" },
];
const RESOLUTIONS = [
  { label: "1920 × 1080", value: "1080p" },
  { label: "2560 × 1440", value: "1440p" },
  { label: "3840 × 2160", value: "2160p" },
  { label: "不限", value: "any", disabled: true },
];
const PLUGINS = ["pixiv", "konachan", "yande.re", "danbooru", "wallhaven", "safebooru", "zerochan"].map((p) => ({
  label: p,
  value: p,
}));
const KINDS = [
  { label: "图片", value: "image" },
  { label: "视频", value: "video" },
  { label: "WPE", value: "wpe" },
];
const MODES = [
  { label: "原生", value: "native", description: "交给系统设置壁纸，省资源" },
  { label: "窗口", value: "window", description: "支持视频与网页壁纸" },
];
const DESC = [
  { label: "尺寸", value: "3840 × 2160" },
  { label: "大小", value: "4.2 MB" },
  { label: "来源", value: "pixiv" },
  { label: "收集时间", value: "2026-11-13 17:20" },
  { label: "路径", value: "/Users/me/Pictures/kabegame/pixiv/123456_p0.png", span: 2 },
  { label: "任务", value: null },
];

const loadingOn = ref(false);
const showHidden = ref(false);
const sortBy = ref("time");
const text = ref("");
const longText = ref("");
const count = ref<number | undefined>(4);
const resolution = ref<string>();
const plugin = ref<string>();
const volume = ref(60);
const agree = ref(true);
const kinds = ref(["image"]);
const mode = ref("window");
const dialogOpen = ref(false);
const sheetSide = ref<"right" | "bottom" | null>(null);
const alertOpen = ref(false);
const nestOpen = ref(false);
const pickerOpen = ref(false);
const pickerValues = ref<number[]>([1, 2]);
/** 两位页码 1–35 的级联：十位 0–3，个位按十位裁剪 */
const PICKER_COLUMNS = [0, 1, 2, 3].map((tens) => ({
  text: String(tens),
  value: tens,
  children: Array.from({ length: tens === 3 ? 6 : 10 }, (_, d) => d)
    .filter((d) => tens * 10 + d >= 1)
    .map((d) => ({ text: String(d), value: d })),
}));

async function confirmDemo() {
  try {
    await messageBox.confirm("确认框门面：在 Reka AlertDialog 上实现，签名同 ElMessageBox。", "确认", {
      distinguishCancelAndClose: true,
    });
    toast.success("确认");
  } catch (action) {
    toast.info(String(action));
  }
}

async function promptDemo() {
  try {
    const { value } = await messageBox.prompt("新名称", "改名", {
      inputValue: "旧名称",
      inputValidator: (v) => (v.trim() ? true : "不能为空"),
    });
    toast.success(value);
  } catch (action) {
    toast.info(String(action));
  }
}

function fakeDelete() {
  return new Promise<void>((resolve) => setTimeout(resolve, 800)).then(() => toast.success("已删除"));
}
</script>
