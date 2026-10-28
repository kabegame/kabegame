import { Subject, mergeMap } from "rxjs";
import { getCurrentScope, onScopeDispose } from "vue";
import { kbEvent$, type KbEvent } from "@/services/kbEvents";

export interface TauriProxy {
  /** 代为订阅这些后端事件；同名只订阅一次，并入同一条管道交给 `forward`。 */
  listen(names: Iterable<string>): void;
  /** 退订全部；在组件 / effectScope 里创建时随作用域自动调用。 */
  dispose(): void;
}

/**
 * 替不能直接用 IPC 的页面（预览 iframe 里的网页壁纸）代办 Tauri 能力，目前只有 `listen`。
 * 登记过的事件经 `kbEvent$` 合并成一条管道，按到达顺序交给 `forward`。
 */
export function useTauriProxy(forward: (event: KbEvent) => void): TauriProxy {
  const listened = new Set<string>();
  const names$ = new Subject<string>();
  // 新名字并入同一条管道；已有订阅不重建，不会出现退订再订阅的空档
  const subscription = names$.pipe(mergeMap((name) => kbEvent$(name))).subscribe(forward);

  const proxy: TauriProxy = {
    listen(names) {
      for (const name of names) {
        if (listened.has(name)) continue;
        listened.add(name);
        names$.next(name);
      }
    },
    dispose() {
      subscription.unsubscribe();
    },
  };
  if (getCurrentScope()) onScopeDispose(proxy.dispose);
  return proxy;
}
