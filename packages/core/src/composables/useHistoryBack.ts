/**
 * Composable that ties a boolean visibility ref to a browser history entry.
 *
 * - When `visible` becomes `true`  → `history.pushState()`.
 * - When the user navigates back (popstate) → calls `close()` (and
 *   the caller is expected to set `visible` to `false`).
 * - When `visible` becomes `false` by other means (close button, overlay click, …)
 *   → the stale history entry is cleaned up via `history.back()`.
 *
 * Works on both Android (via Tauri `onBackButtonPress` → `history.back()`) and
 * desktop (browser / mouse-back button naturally triggers popstate).
 */

import { watch, ref, readonly, onScopeDispose, type Ref } from "vue";

/* ------------------------------------------------------------------ */
/*  Module-level state shared across all composable instances          */
/* ------------------------------------------------------------------ */

interface HistoryEntry {
  id: string;
  onPop: () => void;
  /** `false` when the modal was closed manually (not via back) but its
   *  history entry hasn't been popped yet (entry is in the middle). */
  active: boolean;
}

const entries: HistoryEntry[] = [];
let skipCount = 0;
const _count = ref(0);

function updateCount() {
  _count.value = entries.filter((e) => e.active).length;
}

/** Reactive count of currently-active history-back entries.
 *  Use in `onBackButtonPress` to decide whether to call `history.back()`. */
export const historyBackCount = readonly(_count);

/* ------------------------------------------------------------------ */
/*  Single global popstate listener (installed lazily, once)           */
/* ------------------------------------------------------------------ */

let installed = false;

function ensureListener() {
  if (installed) return;
  installed = true;

  window.addEventListener("popstate", () => {
    if (skipCount > 0) {
      skipCount--;
      return;
    }

    if (entries.length === 0) return;

    const entry = entries.pop()!;
    updateCount();

    if (entry.active) {
      entry.onPop();
      return;
    }

    // Inactive (manually-closed) entry – its history entry just got popped,
    // but there's nothing to close. Cascade: pop the next one too.
    history.back();
  });
}

/* ------------------------------------------------------------------ */
/*  Public composable                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param visible  A reactive boolean (Ref or getter) indicating open/close.
 * @param close    Called when the user navigates back. The callback should
 *                 set `visible` to `false`.  If omitted and `visible` is a
 *                 writable `Ref`, it is set to `false` automatically.
 */
export function useHistoryBack(
  visible: Ref<boolean> | (() => boolean),
  close?: () => void,
): void {
  ensureListener();

  const id = crypto.randomUUID();
  let registered = false;

  const getter =
    typeof visible === "function" ? visible : () => visible.value;

  const doClose =
    close ??
    (() => {
      if (typeof visible !== "function") visible.value = false;
    });

  function handlePop() {
    if (!registered) return;
    registered = false;
    doClose();
  }

  function cleanup() {
    if (!registered) return;
    registered = false;

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return;

    if (idx === entries.length - 1) {
      entries.pop();
      skipCount++;
      history.back();
    } else {
      entries[idx].active = false;
    }
    updateCount();
  }

  watch(getter, (val) => {
    if (val && !registered) {
      registered = true;
      history.pushState({ historyBack: true }, "");
      entries.push({ id, onPop: handlePop, active: true });
      updateCount();
    } else if (!val && registered) {
      cleanup();
    }
  });

  onScopeDispose(cleanup);
}
