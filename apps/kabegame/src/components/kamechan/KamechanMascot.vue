<template>
  <button
    class="kamechan-mascot"
    :class="[`kamechan-mascot`, `is-${state}`]"
    type="button"
    aria-label="Kamechan"
    title="Kamechan"
    @click="wave"
  >
    <img
      class="kamechan-mascot__image"
      :src="imageSrc"
      alt=""
      draggable="false"
    />
  </button>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { useKamechanMachine } from "./useKamechanMachine";

withDefaults(defineProps<{
}>(), {
});

const { state, imageSrc, wave } = useKamechanMachine();

onMounted(() => {
  const waveImage = new Image();
  waveImage.src = "/kamechan/wave/wave.png";
});
</script>

<style scoped lang="scss">
.kamechan-mascot {
  appearance: none;
  border: 0;
  background: transparent;
  cursor: pointer;
  user-select: none;
  -webkit-user-drag: none;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0;
  color: inherit;
  box-sizing: border-box;
  overflow: hidden;
  contain: layout paint;

  &:focus-visible {
    outline: 2px solid var(--anime-primary);
    outline-offset: 2px;
    border-radius: 8px;
  }

  &:active .kamechan-mascot__image {
    transform: translateY(1px);
  }
}

.kamechan-mascot__image {
  display: block;
  width: 100%;
  object-fit: contain;
  pointer-events: none;
  filter: drop-shadow(0 8px 14px rgba(119, 80, 160, 0.22));
  transform-origin: 50% 100%;
  transition: transform 0.16s ease, filter 0.16s ease;
}

.kamechan-mascot:hover .kamechan-mascot__image {
  transform: translateY(-2px);
  filter: drop-shadow(0 10px 18px rgba(119, 80, 160, 0.28));
}

.kamechan-mascot.is-waving .kamechan-mascot__image {
  animation: kamechan-wave-bounce 1.2s ease both;
}

.kamechan-mascot--sidebar {
  width: 100%;
  padding: 4px 10px 12px;
  flex: 0 0 auto;
}

.kamechan-mascot--sidebar .kamechan-mascot__image {

}

.kamechan-mascot--bottom-tab .kamechan-mascot__image {
  width: 54px;
  height: 82px;
}

@keyframes kamechan-wave-bounce {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }

  24% {
    transform: translateY(-4px) rotate(-2deg);
  }

  52% {
    transform: translateY(-2px) rotate(2deg);
  }

  76% {
    transform: translateY(-3px) rotate(-1deg);
  }
}
</style>
