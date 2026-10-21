import { Observable, type OperatorFunction } from "rxjs";

/**
 * 防抖合并：窗口空闲时首个事件立即成批发出并开窗；窗口内到达的事件攒成一串，
 * 窗口结束时由 reduce 合并成消费方自己的批次类型发出，并开下一个窗口。
 * reduce 返回 null 表示这一串与消费方无关，不发出。
 */
export function batchWindow<T, B>(waitMs: number, reduce: (events: T[]) => B | null): OperatorFunction<T, B> {
  return (source) =>
    new Observable<B>((subscriber) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let buffered: T[] = [];
      const emit = (events: T[]) => {
        const batch = reduce(events);
        if (batch !== null) subscriber.next(batch);
      };
      const open = () => {
        timer = setTimeout(() => {
          timer = null;
          if (buffered.length === 0) return;
          const events = buffered;
          buffered = [];
          emit(events);
          open();
        }, waitMs);
      };
      const subscription = source.subscribe({
        next(event) {
          if (timer) {
            buffered.push(event);
            return;
          }
          emit([event]);
          open();
        },
        error: (error) => subscriber.error(error),
        complete: () => {
          if (timer) clearTimeout(timer);
          if (buffered.length > 0) emit(buffered);
          subscriber.complete();
        },
      });
      return () => {
        subscription.unsubscribe();
        if (timer) clearTimeout(timer);
      };
    });
}
