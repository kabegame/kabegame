/**
 * P6b 1e-1：文本对象的字段脚本（`collectScripts` 的 `targetOf` 与 `valueType`，计划「1e」点 1）。
 * - `objects/<i>/<TEXT_RUNTIME_FIELDS 之一>` → 文本目标，形状按字段定：`text` 恒为字符串（不按初值猜，`"Song Title"` 不是 vec2），
 *   `maxwidth` 等数字键 float、向量键 vec2、布尔位 bool、枚举字符串；
 * - `font`、`opaquebackground` 与别的对象、嵌套路径上的同名键仍是 `unsupported`。
 */
import { describe, expect, it } from "vitest";
import { TEXT_RUNTIME_FIELDS } from "./bindings";
import type { SceneJson } from "./model";
import { collectScripts } from "./scripts";

const SCRIPT = "export function update(value) { return value; }";
const scripted = (value: unknown) => ({ script: SCRIPT, value });

async function scriptsOf(objects: unknown[]) {
  const { list } = await collectScripts({ general: {}, objects } as unknown as SceneJson, {}, []);
  return new Map(list.map((script) => [script.id, script]));
}

describe("collectScripts：文本对象的字段脚本（P6b 1e）", () => {
  it.each(["Song Title", "<Time and Date>", "Song Title\nSong Title", "a b c d", "12:34", "12 34", "", null])(
    "text 的初值 %j：文本目标，valueType 恒为 string",
    async (initial) => {
      const scripts = await scriptsOf([{ id: 1, text: scripted(initial), font: "fonts/a.ttf" }]);
      const script = scripts.get("objects/0/text")!;
      expect(script.target).toEqual({ kind: "text", object: 0, field: "text" });
      expect(script.valueType).toBe("string");
      expect(script.initial).toBe(initial);
    },
  );

  it("其余运行中可改的字段：按字段定形状（maxwidth 走 float）", async () => {
    const values: Record<string, unknown> = {
      pointsize: 32,
      padding: "10 10",
      spacing: "0 0",
      maxwidth: 300,
      maxrows: "2",
      limitwidth: true,
      limitrows: false,
      limituseellipsis: true,
      blockalign: false,
      horizontalalign: "left",
      verticalalign: "top",
    };
    const object: Record<string, unknown> = { id: 1, text: "abc" };
    for (const [key, value] of Object.entries(values)) object[key] = scripted(value);
    const scripts = await scriptsOf([object]);
    const shapes = Object.fromEntries(
      [...scripts.values()].map((script) => [script.id.split("/").at(-1), [script.target, script.valueType]]),
    );
    expect(shapes).toEqual({
      pointsize: [{ kind: "text", object: 0, field: "pointsize" }, "float"],
      padding: [{ kind: "text", object: 0, field: "padding" }, "vec2"],
      spacing: [{ kind: "text", object: 0, field: "spacing" }, "vec2"],
      maxwidth: [{ kind: "text", object: 0, field: "maxwidth" }, "float"],
      maxrows: [{ kind: "text", object: 0, field: "maxrows" }, "float"],
      limitwidth: [{ kind: "text", object: 0, field: "limitwidth" }, "bool"],
      limitrows: [{ kind: "text", object: 0, field: "limitrows" }, "bool"],
      limituseellipsis: [{ kind: "text", object: 0, field: "limituseellipsis" }, "bool"],
      blockalign: [{ kind: "text", object: 0, field: "blockalign" }, "bool"],
      horizontalalign: [{ kind: "text", object: 0, field: "horizontalalign" }, "string"],
      verticalalign: [{ kind: "text", object: 0, field: "verticalalign" }, "string"],
    });
    // 表里的字段都覆盖到了（text 见上一条）
    expect([...Object.keys(values), "text"].sort()).toEqual([...TEXT_RUNTIME_FIELDS].sort());
  });

  it("maxwidth 的初值写成字符串、缺省：照样 float（不按初值猜）", async () => {
    const scripts = await scriptsOf([{ id: 1, text: "abc", maxwidth: scripted("300 1"), pointsize: scripted(null) }]);
    expect(scripts.get("objects/0/maxwidth")!.valueType).toBe("float");
    expect(scripts.get("objects/0/pointsize")!.valueType).toBe("float");
  });

  it("font、opaquebackground 仍是 unsupported；文本对象的图层字段照旧", async () => {
    const scripts = await scriptsOf([
      {
        id: 1,
        text: "abc",
        font: scripted("fonts/a.ttf"),
        opaquebackground: scripted(true),
        origin: scripted("0 0 0"),
      },
    ]);
    expect(scripts.get("objects/0/font")!.target).toEqual({ kind: "unsupported", path: "objects/0/font" });
    expect(scripts.get("objects/0/opaquebackground")!.target).toEqual({
      kind: "unsupported",
      path: "objects/0/opaquebackground",
    });
    expect(scripts.get("objects/0/origin")!.target).toEqual({ kind: "layer", object: 0, field: "origin" });
  });

  it("不是文本对象、或不在对象顶层的同名键：不是文本目标", async () => {
    const scripts = await scriptsOf([
      // 图像对象带一个 `text` 键：WPE 按 image 建对象（`objectKind` 先认 image）
      { id: 1, image: "models/a.json", text: scripted("Song Title") },
      // 文本对象里嵌套的同名键
      { id: 2, text: "abc", config: { pointsize: scripted(3) } },
    ]);
    expect(scripts.get("objects/0/text")!.target).toEqual({ kind: "unsupported", path: "objects/0/text" });
    expect(scripts.get("objects/1/config/pointsize")!.target).toEqual({
      kind: "unsupported",
      path: "objects/1/config/pointsize",
    });
  });
});
