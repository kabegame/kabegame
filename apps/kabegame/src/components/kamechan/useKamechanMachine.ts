import { computed, onBeforeUnmount, ref } from "vue";

export type KamechanState = "standing" | "waving";
export type KamechanEvent = "wave" | "reset";

const WAVE_DURATION_MS = 1200;

export function useKamechanMachine() {
  const state = ref<KamechanState>("standing");
  let waveTimer: ReturnType<typeof setTimeout> | null = null;

  const imageSrc = computed(() =>
    state.value === "waving"
      ? "/kamechan/wave/wave.png"
      : "/kamechan/stand/stand.png"
  );

  function clearWaveTimer() {
    if (waveTimer === null) {
      return;
    }
    clearTimeout(waveTimer);
    waveTimer = null;
  }

  function reset() {
    clearWaveTimer();
    state.value = "standing";
  }

  function send(event: KamechanEvent) {
    if (event === "reset") {
      reset();
      return;
    }
    clearWaveTimer();
    state.value = "waving";
    waveTimer = setTimeout(() => {
      state.value = "standing";
      waveTimer = null;
    }, WAVE_DURATION_MS);
  }

  onBeforeUnmount(clearWaveTimer);

  return {
    state,
    imageSrc,
    send,
    wave: () => send("wave"),
    reset,
  };
}
