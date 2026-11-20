/**
 * P6d3b 点 9：`createLayerConfig` 与 `rewriteWorkshopPath`。期望来自 WPE 实测日志（`ignore/p6/d3/out/wpe-{asset,default,bars}.log`，
 * `__workshopId` 为 `'123'`，工程目录里有 `models/both.json`、assets 里有 `models/util/solidlayer.json`）。
 */
import { describe, expect, it } from "vitest";
import { createLayerConfig, defaultLayerModel, rewriteWorkshopPath, type CreateConfigContext } from "./createConfig";

/** 测试替身：`Vec3` 之类有 `toConfigString` 的先过它（WPE 的 `stringifyConfig` 把 `Vec` 写成 "x y z"），其余 `JSON.stringify`。 */
function stringify(value: unknown): string | undefined {
  const record = value as { toConfigString?: () => string };
  return typeof record.toConfigString === "function" ? record.toConfigString() : JSON.stringify(value);
}

function context(extra: Partial<CreateConfigContext> = {}): CreateConfigContext {
  return {
    stringify,
    orthographic: true,
    workshopId: "123",
    inAssets: (path) => path === "models/util/solidlayer.json" || path === "models/util/solidlayer_depthtest.json",
    ...extra,
  };
}

describe("rewriteWorkshopPath（RP）", () => {
  it("一般规则：第一段 / workshop / <id> / 其余", () => {
    const ctx = context();
    expect(rewriteWorkshopPath("models/bar.json", null, ctx)).toBe("models/workshop/123/bar.json");
    // `wid both`：工程目录里有也一样（只看 assets）
    expect(rewriteWorkshopPath("models/both.json", null, ctx)).toBe("models/workshop/123/both.json");
    expect(rewriteWorkshopPath("models/nothere.json", null, ctx)).toBe("models/workshop/123/nothere.json");
  });

  it("在 assets 里存在不改；没有 id（null / 空串）不改", () => {
    expect(rewriteWorkshopPath("models/util/solidlayer.json", null, context())).toBe("models/util/solidlayer.json");
    expect(rewriteWorkshopPath("models/bar.json", null, context({ workshopId: null }))).toBe("models/bar.json");
    expect(rewriteWorkshopPath("models/bar.json", null, context({ workshopId: "" }))).toBe("models/bar.json");
  });

  it("已带 workshop：去掉旧的 workshop/<旧 id>", () => {
    expect(rewriteWorkshopPath("models/workshop/999/bar.json", null, context())).toBe("models/workshop/123/bar.json");
    expect(rewriteWorkshopPath("models/workshop/999/a/b.json", null, context())).toBe("models/workshop/123/a/b.json");
  });

  it("只有一段时不去第一段（读码字面）：first/workshop/<id>/first", () => {
    expect(rewriteWorkshopPath("bar.json", null, context())).toBe("bar.json/workshop/123/bar.json");
  });

  it("textures 规则：workshop/<id>/<路径>，路径第一段已是 workshop 先去掉两段", () => {
    const ctx = context();
    expect(rewriteWorkshopPath("materials/a.png", "textures", ctx)).toBe("workshop/123/materials/a.png");
    expect(rewriteWorkshopPath("workshop/999/materials/a.png", "textures", ctx)).toBe("workshop/123/materials/a.png");
  });

  it("反斜杠换成斜杠、连续斜杠并成一个", () => {
    expect(rewriteWorkshopPath("models\\sub\\bar.json", null, context())).toBe("models/workshop/123/sub/bar.json");
    expect(rewriteWorkshopPath("models//bar.json", null, context())).toBe("models/workshop/123/bar.json");
  });
});

describe("createLayerConfig：参数个数与缺省模型（wpe-asset `arg none` / `arg two`，wpe-default）", () => {
  it("没有参数、两个参数：缺省模型，正交与透视各一个", () => {
    expect(createLayerConfig([], context())).toEqual({ image: "models/util/solidlayer_depthtest.json" });
    expect(createLayerConfig([1, 2], context())).toEqual({ image: "models/util/solidlayer_depthtest.json" });
    expect(createLayerConfig([], context({ orthographic: false }))).toEqual({ image: "models/util/solidlayer.json" });
    expect(createLayerConfig([1, 2], context({ orthographic: false }))).toEqual({
      image: "models/util/solidlayer.json",
    });
    expect(defaultLayerModel(true)).toBe("models/util/solidlayer_depthtest.json");
    expect(defaultLayerModel(false)).toBe("models/util/solidlayer.json");
  });
});

describe("createLayerConfig：对象参数", () => {
  it("有 color 没有内容键：补缺省模型（`arg color`；透视是 wpe-default 的 `color` / `color+name`）", () => {
    expect(createLayerConfig([{ color: "1 0 0" }], context())).toEqual({
      color: "1 0 0",
      image: "models/util/solidlayer_depthtest.json",
    });
    expect(createLayerConfig([{ color: "1 0 0" }], context({ orthographic: false }))).toEqual({
      color: "1 0 0",
      image: "models/util/solidlayer.json",
    });
    expect(
      createLayerConfig([{ color: "0 1 0", name: "CN", origin: "1 2 3" }], context({ orthographic: false })),
    ).toEqual({ color: "0 1 0", image: "models/util/solidlayer.json", name: "CN", origin: "1 2 3" });
    // 缺省模型是 WPE 自带资源，assets 名单（只收脚本里的路径字面量）查不到它也不改写（`wpe-asset.log` 的 `arg color`，__workshopId 是 123）
    expect(createLayerConfig([{ color: "1 0 0" }], context({ inAssets: () => false }))).toEqual({
      color: "1 0 0",
      image: "models/util/solidlayer_depthtest.json",
    });
  });

  it("有任一内容键就不补（text / light / sound / camera / model …）", () => {
    for (const key of ["model", "particle", "sprite", "image", "text", "light", "sound", "camera"]) {
      const config = createLayerConfig([{ color: "1 0 0", [key]: "x" }], context({ workshopId: null }));
      expect(config).toEqual({ color: "1 0 0", [key]: "x" });
    }
  });

  it("没有 color 也没有内容键：不补（`arg origin`）", () => {
    expect(createLayerConfig([{ name: "ORG", origin: "100 100 0" }], context())).toEqual({
      name: "ORG",
      origin: "100 100 0",
    });
  });

  it("资源键经 RP：particle / sprite / image / font / path 字符串，model / text / 顶层 material 不改", () => {
    const config = createLayerConfig(
      [
        {
          particle: "particles/p.json",
          sprite: "materials/s.json",
          image: "models/bar.json",
          font: "fonts/f.ttf",
          path: "paths/x.json",
          model: "models/x.mdl",
          text: "models/t.json",
          material: "materials/m.json",
        },
      ],
      context(),
    );
    expect(config).toEqual({
      particle: "particles/workshop/123/p.json",
      sprite: "materials/workshop/123/s.json",
      image: "models/workshop/123/bar.json",
      font: "fonts/workshop/123/f.ttf",
      path: "paths/workshop/123/x.json",
      model: "models/x.mdl",
      text: "models/t.json",
      material: "materials/m.json",
    });
  });

  it("sound：字符串或数组里的每个字符串；非字符串元素保留", () => {
    expect(createLayerConfig([{ sound: "sounds/a.mp3" }], context())).toEqual({ sound: "sounds/workshop/123/a.mp3" });
    expect(createLayerConfig([{ sound: ["sounds/a.mp3", 5, "sounds/b.mp3"] }], context())).toEqual({
      sound: ["sounds/workshop/123/a.mp3", 5, "sounds/workshop/123/b.mp3"],
    });
  });

  it("effects[].file 按一般规则，effects[].passes[].textures[] 的每个字符串按 textures 规则", () => {
    const config = createLayerConfig(
      [
        {
          image: "models/util/solidlayer.json",
          effects: [
            {
              file: "effects/tint/effect.json",
              passes: [{ id: 0, textures: [null, "materials/a.png", "workshop/9/materials/b.png"] }, "x"],
            },
            5,
          ],
        },
      ],
      context(),
    );
    expect(config).toEqual({
      image: "models/util/solidlayer.json",
      effects: [
        {
          file: "effects/workshop/123/tint/effect.json",
          passes: [{ id: 0, textures: [null, "workshop/123/materials/a.png", "workshop/123/materials/b.png"] }, "x"],
        },
        5,
      ],
    });
  });

  it("不改入参", () => {
    const arg = { image: "models/bar.json", effects: [{ file: "effects/e.json" }] };
    const snapshot = JSON.stringify(arg);
    createLayerConfig([arg], context());
    expect(JSON.stringify(arg)).toBe(snapshot);
  });

  it("Vec3 经 stringify 变成 'x y z'：不是对象，null（`arg vec3`）", () => {
    const vec = { x: 1, y: 2, z: 3, toConfigString: () => "1 2 3" };
    expect(createLayerConfig([vec], context())).toBeNull();
  });

  it("数组参数：配置原文就是这个数组（建出空名分组节点）", () => {
    expect(createLayerConfig([[1]], context())).toEqual([1]);
    expect(createLayerConfig([[]], context())).toEqual([]);
  });

  it("stringify 抛异常或给不出文本：null", () => {
    expect(
      createLayerConfig(
        [{}],
        context({
          stringify: () => {
            throw new Error("x");
          },
        }),
      ),
    ).toBeNull();
    expect(createLayerConfig([{}], context({ stringify: () => undefined }))).toBeNull();
    expect(createLayerConfig([{}], context({ stringify: () => "not json" }))).toBeNull();
  });
});

describe("createLayerConfig：字符串参数", () => {
  it("JSON 对象字符串：同对象分支（`arg jsonstr`、`cfg bar1` 的 JSON 形态）", () => {
    expect(createLayerConfig(['{"image":"models/bar.json"}'], context())).toEqual({
      image: "models/workshop/123/bar.json",
    });
    expect(createLayerConfig(['{"color":"1 0 0"}'], context())).toEqual({
      color: "1 0 0",
      image: "models/util/solidlayer_depthtest.json",
    });
  });

  it("路径：models/*.json → image（`wid str`、wpe-bars 的 `cfg bar1`）", () => {
    expect(createLayerConfig(["models/bar.json"], context())).toEqual({ image: "models/workshop/123/bar.json" });
    expect(createLayerConfig(["/models/bar.json"], context())).toEqual({ image: "models/workshop/123/bar.json" });
    expect(createLayerConfig(["\\\\models\\bar.JSON"], context())).toEqual({ image: "models/workshop/123/bar.JSON" });
    // assets 里有的不改（`ra-create`）
    expect(createLayerConfig(["models/util/solidlayer.json"], context())).toEqual({
      image: "models/util/solidlayer.json",
    });
  });

  it("路径：models 其它扩展名与无扩展名 → model；particles → particle；materials → sprite；sounds → sound", () => {
    const ctx = context({ workshopId: null });
    expect(createLayerConfig(["models/x.mdl"], ctx)).toEqual({ model: "models/x.mdl" });
    expect(createLayerConfig(["models/x"], ctx)).toEqual({ model: "models/x" });
    expect(createLayerConfig(["particles/x.json"], ctx)).toEqual({ particle: "particles/x.json" });
    expect(createLayerConfig(["materials/x.json"], ctx)).toEqual({ sprite: "materials/x.json" });
    expect(createLayerConfig(["sounds/x.mp3"], ctx)).toEqual({ sound: "sounds/x.mp3" });
  });

  it("目录区分大小写、别的目录 null（`cls fonts`）；路径分支不补缺省模型、不整理", () => {
    const ctx = context();
    expect(createLayerConfig(["fonts/kb.ttf"], ctx)).toBeNull();
    expect(createLayerConfig(["Models/bar.json"], ctx)).toBeNull();
    expect(createLayerConfig([""], ctx)).toBeNull();
    // JSON 但不是对象（数字、数组）：当路径，认不出目录
    expect(createLayerConfig(["123"], ctx)).toBeNull();
    expect(createLayerConfig(["[1]"], ctx)).toBeNull();
  });

  it("没有 id 时路径原样（`no wid`）", () => {
    expect(createLayerConfig(["models/bar.json"], context({ workshopId: null }))).toEqual({
      image: "models/bar.json",
    });
  });
});

describe("createLayerConfig：其它类型 null（`arg 5`、`arg undef`）", () => {
  it("数字、布尔、undefined、null、函数", () => {
    const ctx = context();
    for (const value of [5, true, undefined, null, () => 1]) expect(createLayerConfig([value], ctx)).toBeNull();
  });
});

describe("createLayerConfig：IModelData 句柄（P14，S16）", () => {
  /** 句柄替身：`toConfigString` 返回整数 token（baseclasses 的 `IModelData`）。 */
  const handle = { applyData() {}, toConfigString: () => 7 };
  const handles = new WeakSet<object>([handle]);
  /** 同 realm 的 `stringifyConfig`：JSON.stringify 的替换器对有 `toConfigString` 的值调它。 */
  const replacerStringify = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
      item && typeof (item as { toConfigString?: unknown }).toConfigString === "function"
        ? (item as { toConfigString(): unknown }).toConfigString()
        : item,
    );
  const ctx = (extra: Partial<CreateConfigContext> = {}) =>
    context({ stringify: replacerStringify, isModelData: (value) => handles.has(value as object), ...extra });

  it("单参数句柄先包成 { model: 句柄 }：model 序列化成整数 token，不补缺省模型", () => {
    expect(createLayerConfig([handle], ctx())).toEqual({ model: 7 });
  });

  it("配置对象里写 model: 句柄 走同一条路", () => {
    expect(createLayerConfig([{ model: handle, name: "ML", origin: "0 0 0" }], ctx())).toEqual({
      model: 7,
      name: "ML",
      origin: "0 0 0",
    });
  });

  it("没有 isModelData 时单参数句柄按普通对象序列化（原行为）", () => {
    // `toConfigString` 在顶层被当成 Vec 的写法：整个对象变成数字文本，不是对象 → null
    expect(createLayerConfig([handle], ctx({ isModelData: undefined }))).toBeNull();
  });

  it("不是句柄的对象不受影响", () => {
    expect(createLayerConfig([{ image: "models/a.json" }], ctx())).toEqual({ image: "models/workshop/123/a.json" });
  });
});
