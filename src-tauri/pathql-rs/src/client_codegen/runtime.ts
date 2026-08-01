const encodeSeg = (s: string) =>
  encodeURIComponent(s.startsWith("~") ? "~" + s : s);

type NodeCtor<T extends NodeBase> = new (segments: readonly string[]) => T;

class NodeBase {
  protected readonly _segments: readonly string[];

  constructor(segments: readonly string[]) {
    this._segments = segments;
  }

  $path(): string {
    if (this._segments.length === 0) {
      return "";
    }
    const [head, ...tail] = this._segments;
    return head.endsWith("://")
      ? head + tail.join("/")
      : this._segments.join("/");
  }

  protected _spawn(segments: readonly string[]): this {
    const ctor = this.constructor as NodeCtor<this>;
    return new ctor(segments);
  }

  protected _seg<T extends NodeBase>(seg: string, ctor: NodeCtor<T>): T {
    return new ctor([...this._segments, encodeSeg(seg)]);
  }

  protected _anySeg(seg: string): AnyProviderNode {
    return makeAnyProviderNode([...this._segments, encodeSeg(seg)]);
  }

  $raw(seg: string): AnyProviderNode {
    return this._anySeg(seg);
  }

  $any(cb: (b: this) => NodeBase | NodeBase[]): this {
    const result = cb(this._spawn([]));
    const branches = Array.isArray(result) ? result : [result];
    const grouped: string[] = ["~any"];
    branches.forEach((branch, index) => {
      if (index > 0) {
        grouped.push("~or");
      }
      grouped.push(...branch._segments);
    });
    grouped.push("~end");
    return this._spawn([...this._segments, ...grouped]);
  }

  $not(cb: (b: this) => NodeBase): this {
    const branch = cb(this._spawn([]));
    return this._spawn([
      ...this._segments,
      "~not",
      ...branch._segments,
      "~end",
    ]);
  }
}

type AnyProviderMethods = {
  readonly $path: () => string;
  readonly $raw: (seg: string) => AnyProviderNode;
  readonly $any: (
    cb: (b: AnyProviderNode) => AnyProviderNode | AnyProviderNode[],
  ) => AnyProviderNode;
  readonly $not: (
    cb: (b: AnyProviderNode) => AnyProviderNode,
  ) => AnyProviderNode;
};

type AnyProviderNode = AnyProviderMethods & {
  readonly [key: string]: AnyProviderNode;
};

class AnyProviderImpl extends NodeBase {
  protected override _spawn(segments: readonly string[]): this {
    return makeAnyProviderNode(segments) as unknown as this;
  }
}

function makeAnyProviderNode(segments: readonly string[]): AnyProviderNode {
  const target = new AnyProviderImpl(segments);
  return new Proxy(target, {
    get(current, property, receiver) {
      if (typeof property === "string" && !(property in current)) {
        return makeAnyProviderNode([...segments, encodeSeg(property)]);
      }
      return Reflect.get(current, property, receiver);
    },
  }) as unknown as AnyProviderNode;
}
