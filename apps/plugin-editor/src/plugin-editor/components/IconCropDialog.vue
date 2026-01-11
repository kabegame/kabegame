<template>
    <el-dialog :model-value="modelValue" title="裁剪图标" width="760px" align-center destroy-on-close
        @update:model-value="(v: boolean) => emit('update:modelValue', v)">
        <div class="hint">固定正方形（1:1），可拖动/缩放图片。确认后将导出 PNG。</div>

        <div class="cropper-container">
            <Cropper ref="cropperRef" class="cropper" :src="src" :stencil-props="{ aspectRatio: 1 }" :min-width="64"
                :min-height="64" image-restriction="stencil" />
        </div>

        <template #footer>
            <el-button :disabled="isExporting" @click="emit('update:modelValue', false)">取消</el-button>
            <el-button type="primary" :loading="isExporting" @click="confirm">确定</el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { Cropper } from "vue-advanced-cropper";

type Props = {
    modelValue: boolean;
    src: string;
};

const props = defineProps<Props>();

const emit = defineEmits<{
    (e: "update:modelValue", v: boolean): void;
    (e: "confirm", blob: Blob): void;
}>();

const cropperRef = ref<InstanceType<typeof Cropper> | null>(null);
const isExporting = ref(false);

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) return reject(new Error("导出 PNG 失败（空 blob）"));
                resolve(blob);
            },
            "image/png",
            1
        );
    });
}

async function confirm() {
    if (!props.src) {
        ElMessage.error("图片为空");
        return;
    }
    if (!cropperRef.value) {
        ElMessage.error("裁剪器未就绪");
        return;
    }
    try {
        isExporting.value = true;
        const res: any = cropperRef.value.getResult?.();
        const canvas: HTMLCanvasElement | undefined = res?.canvas;
        if (!canvas) {
            ElMessage.error("未获取到裁剪结果");
            return;
        }
        const blob = await canvasToPngBlob(canvas);
        emit("confirm", blob);
    } catch (e) {
        ElMessage.error(`裁剪失败：${String(e)}`);
    } finally {
        isExporting.value = false;
    }
}
</script>

<style scoped>
.hint {
    color: var(--anime-text-muted);
    font-size: 12px;
    margin-bottom: 8px;
}

.cropper-container {
    height: 520px;
    border-radius: 10px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.08);
}

.cropper {
    width: 100%;
    height: 100%;
}
</style>
