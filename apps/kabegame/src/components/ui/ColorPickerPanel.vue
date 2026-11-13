<template>
  <div class="flex flex-col gap-2.5" :class="disabled ? 'pointer-events-none opacity-60' : ''">
    <!-- 饱和度 × 明度 -->
    <ColorAreaRoot
      v-slot="{ style }"
      :model-value="color"
      color-space="hsb"
      x-channel="saturation"
      y-channel="brightness"
      :disabled="disabled"
      @update:color="setColor"
    >
      <ColorAreaArea class="relative h-36 w-full touch-none rounded-kb-md" :style="style">
        <ColorAreaThumb :class="THUMB" />
      </ColorAreaArea>
    </ColorAreaRoot>

    <!-- 色相 -->
    <ColorSliderRoot
      :model-value="color"
      channel="hue"
      color-space="hsb"
      :disabled="disabled"
      class="relative flex h-3.5 w-full touch-none select-none items-center"
      @update:color="setColor"
    >
      <ColorSliderTrack class="relative h-3 w-full grow rounded-full" />
      <ColorSliderThumb :class="THUMB" />
    </ColorSliderRoot>

    <div class="flex items-center gap-2">
      <span
        class="size-7 flex-none rounded-kb-md border border-solid border-kb-line-strong"
        :style="{ backgroundColor: hex }"
        aria-hidden="true"
      />
      <ColorFieldRoot :model-value="color" :disabled="disabled" class="min-w-0 flex-1" @update:color="setColor">
        <ColorFieldInput
          class="kb-control h-7 w-full px-2.5 font-mono text-[12.5px] uppercase outline-none [font-family:ui-monospace,SFMono-Regular,Menlo,monospace]"
        />
      </ColorFieldRoot>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 取色面板（v-model 是 #rrggbb）：饱和度 / 明度区 + 色相条 + 十六进制输入，取代 el-color-picker-panel。
 * 不带透明度。内部持有 HSB 颜色，拖到灰色时色相不丢。
 */
import { computed, ref, watch } from "vue";
import {
  ColorAreaArea,
  ColorAreaRoot,
  ColorAreaThumb,
  ColorFieldInput,
  ColorFieldRoot,
  ColorSliderRoot,
  ColorSliderThumb,
  ColorSliderTrack,
  colorToHex,
  convertToHsb,
  parseColor,
  type Color,
} from "reka-ui";

defineProps<{ disabled?: boolean }>();

const model = defineModel<string | null>({ default: null });

const THUMB =
  "block size-3.5 cursor-grab rounded-full border-2 border-solid border-white shadow-[0_0_0_1px_rgba(0,0,0,0.25),0_1px_3px_rgba(0,0,0,0.3)] outline-none focus-visible:shadow-[0_0_0_2px_var(--kb-ring)]";

function toHsb(value: string | null | undefined): Color {
  try {
    return convertToHsb(parseColor(value || "#000000"));
  } catch {
    return convertToHsb(parseColor("#000000"));
  }
}

const color = ref<Color>(toHsb(model.value));
const hex = computed(() => colorToHex(color.value).toLowerCase());

// 外部改值（打开时从当前颜色起步）：与内部一致时不覆盖，免得把色相冲掉
watch(model, (value) => {
  if (value && value.toLowerCase() !== hex.value) color.value = toHsb(value);
});

function setColor(next: Color) {
  color.value = convertToHsb(next);
  if (model.value?.toLowerCase() !== hex.value) model.value = hex.value;
}
</script>
