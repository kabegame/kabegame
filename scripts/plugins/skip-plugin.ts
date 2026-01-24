import { BasePlugin } from "./base-plugin";
import { BuildSystem } from "scripts/build-system";

export class SkipItem {
  static readonly VUE = "vue";
  static readonly CARGO = "cargo";

  static readonly items = [SkipItem.VUE, SkipItem.CARGO] as const;

  static normalizeOrThrow(raw: string): string {
    const v = raw.trim().toLowerCase();
    if (!v) {
      return v;
    }
    if (v === SkipItem.VUE || v === SkipItem.CARGO) {
      return v;
    }
    throw new Error(
      `未知的 --skip 值：${v}（仅支持：${SkipItem.items.join(" | ")}）`,
    );
  }

  constructor(private readonly _item: string) {}

  get item(): string {
    return this._item;
  }

  get isVue(): boolean {
    return this.item === SkipItem.VUE;
  }

  get isCargo(): boolean {
    return this.item === SkipItem.CARGO;
  }
}

export class Skip {
  private readonly _item?: SkipItem;

  constructor(item?: SkipItem) {
    this._item = item;
  }

  static parse(raw: unknown): Skip {
    if (typeof raw === "string") {
      return Skip.fromTokens(splitSkipArg(raw));
    }
    if (Array.isArray(raw)) {
      return Skip.fromTokens(
        raw.flatMap((v) => (typeof v === "string" ? splitSkipArg(v) : [])),
      );
    }
    return new Skip();
  }

  private static fromTokens(tokens: string[]): Skip {
    const cleaned = tokens.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      return new Skip();
    }
    if (cleaned.length !== 1) {
      throw new Error(`--skip 只能指定一个值：${SkipItem.items.join(" | ")}`);
    }
    const normalized = SkipItem.normalizeOrThrow(cleaned[0]);
    if (!normalized) {
      return new Skip();
    }
    return new Skip(new SkipItem(normalized));
  }

  get item(): SkipItem | undefined {
    return this._item;
  }

  get isVue(): boolean {
    return this._item?.isVue ?? false;
  }

  get isCargo(): boolean {
    return this._item?.isCargo ?? false;
  }
}

export class SkipPlugin extends BasePlugin {
  static readonly NAME = "SkipPlugin";

  constructor() {
    super(SkipPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.parseParams.tap(this.name, () => {
      bs.context.skip = Skip.parse(bs.options.skip);
    });
  }
}

function splitSkipArg(v: string): string[] {
  return v
    .split(/[\/,\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}
