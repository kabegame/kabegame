import { i18n } from "@kabegame/i18n";

// 直接调用 te() 的泛型签名会触发 TS2589（类型实例化过深），收窄成普通函数签名再用。
const hasMessage = i18n.global.te as unknown as (key: string) => boolean;

/** 回填作业的展示名：`header.backfill.<id>`，缺省回落 id。启动页与忙碌卡片共用。 */
export function backfillName(id: string): string {
  const key = `header.backfill.${id}`;
  return hasMessage(key) ? i18n.global.t(key) : id;
}
