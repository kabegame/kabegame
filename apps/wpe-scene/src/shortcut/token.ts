/**
 * 快捷方式的点击令牌（P11d，`.claude/plans/wpe-import/3-scene/phase11/phase-11d-shortcuts.md` 点 5，rea-p11-media 4.5，p11-REPORT「P11d 补测」）。
 *
 * WPE 每次点击一个令牌：`engine.openUserShortcut` 调用时先取令牌（取走即清），所以同一次点击里 `cursorDown` / `cursorUp` / `cursorClick` 三个回调
 * 共用一个、第二次调用抛错。令牌在左键**按下沿**、本帧光标派发**之前**发出；在**松开沿**、本帧派发**之后**收回（松开那一帧的 `cursorUp` /
 * `cursorClick` 还能用它）。没点击（按住不放之外的帧、没按下过）时令牌是空的。
 *
 * 顺序由调用方保证：渲染器每个实时帧先 `beginFrame(左键)`、再派发光标回调、最后 `endFrame(左键)`（宿主接在渲染器 `cursor.input` / `events` / `end` 上，
 * dev 探针接在 `ProbeScripts.cursor` 里）。补画帧与暂停期间不调：令牌状态原样保留（WPE 暂停时不采样）。
 */
export class ShortcutToken {
  private token = false;
  /** 上一个实时帧登记的左键：`endFrame` 更新，两个沿都按它判。 */
  private last = false;

  /** 本帧派发之前：左键按下沿发令牌。 */
  beginFrame(down: boolean): void {
    if (down && !this.last) this.token = true;
  }

  /** 本帧派发之后：左键松开沿收令牌，并记下本帧的左键。 */
  endFrame(down: boolean): void {
    if (!down && this.last) this.token = false;
    this.last = down;
  }

  /** 取走令牌：有就返回 true 并清掉；没有返回 false。 */
  take(): boolean {
    const had = this.token;
    this.token = false;
    return had;
  }

  /** 换场景（脚本环境重建）时清空：WPE 的令牌属于场景。 */
  reset(): void {
    this.token = false;
    this.last = false;
  }
}
