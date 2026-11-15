/**
 * P6d2：编译期扫描脚本导入只看静态导入与再导出（`collectScripts`）。WPE 里动态 `import()` 一律 reject（`Error: Not supported`）、
 * 不影响加载，`import.meta` 也不是导入，所以这两种既不进 `imports`（import map），也不报「不支持的模块说明符」。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneJson } from "./model";
import { collectScripts } from "./scripts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function scene(script: string): SceneJson {
  return {
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [{ id: 1, name: "A", origin: { script, value: "0 0 0" } }],
  } as unknown as SceneJson;
}

describe("collectScripts 的导入扫描（P6d2）", () => {
  it("动态导入与 import.meta 不进 imports、不报错；静态导入与再导出照旧", async () => {
    const source = [
      "import * as W from 'WEMath';",
      "export * from 'WEColor';",
      "export { angleVector2 } from 'WEVector';",
      "const later = import('./not-bare.js');",
      "const dynamic = import('WEOther');",
      "const meta = import.meta;",
      "export function init(value) { return value; }",
    ].join("\n");
    const { list } = await collectScripts(scene(source), {}, []);
    expect(list).toHaveLength(1);
    expect(list[0].imports).toEqual(["WEMath", "WEColor", "WEVector"]);
    expect(list[0].errors).toEqual([]);
  });

  it("非裸名的静态导入仍然整段报错（只能导入 jsmodules）", async () => {
    const { list } = await collectScripts(scene("import './x.js';\nexport function init(v) { return v; }"), {}, []);
    expect(list[0].errors).toEqual(["不支持的模块说明符：./x.js"]);
  });
});
