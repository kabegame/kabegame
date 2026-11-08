import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePng, encodePng, pngSize } from "../../../scripts/kabegame-dev/png.ts";
import { TEMP_SAVE, imageOutput, tempImageDir, tempImagePath, timeStamp } from "./imageOutput.ts";

/** 不透明 RGB 渐变。 */
function rgbPng(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set([i % 251, (i * 3) % 253, (i >> 3) & 255], i * 3);
  return encodePng({ width, height, channels: 3, data });
}

const textOf = (out: ReturnType<typeof imageOutput>) => (out.content[0] as { text: string }).text;
const imageOf = (out: ReturnType<typeof imageOutput>) => {
  const image = out.content.find((c) => c.type === "image") as { data: string } | undefined;
  return image ? Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)) : null;
};

describe("图片输出", () => {
  test("自动命名：工具名 + 附加 + 本地时间，同名加序号", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kbdev-img-"));
    try {
      const now = new Date(2026, 10, 8, 9, 5, 7, 42);
      assert.equal(timeStamp(now), "20261108-090507-042");
      const first = tempImagePath("render_scene", "13515", now, dir);
      assert.equal(first, path.join(dir, "render_scene-13515-20261108-090507-042.png"));
      writeFileSync(first, "x");
      assert.equal(
        tempImagePath("render_scene", "13515", now, dir),
        path.join(dir, "render_scene-13515-20261108-090507-042-2.png"),
      );
      assert.equal(tempImagePath("a/b:c", undefined, now, dir), path.join(dir, "a_b_c-20261108-090507-042.png"));
      assert.equal(tempImageDir(), path.join(os.tmpdir(), "kabegame-dev"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("缺省：长边缩到 1568 回传，save 路径落原图；报原尺寸与回传尺寸", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-img-"));
    try {
      const png = rgbPng(2000, 100);
      const out = imageOutput(png, { root, tool: "screenshot", label: "截图 main", save: "out/a.png" });
      assert.deepEqual(out.original, { width: 2000, height: 100 });
      assert.deepEqual(out.returned, { width: 1568, height: 78 });
      assert.deepEqual(pngSize(imageOf(out)!), { width: 1568, height: 78 });
      assert.equal(decodePng(imageOf(out)!).channels, 3);
      assert.equal(out.saved, path.join(root, "out", "a.png"));
      assert.deepEqual(new Uint8Array(readFileSync(out.saved!)), png, "落盘的是原图");
      const text = textOf(out);
      assert.match(text, /^截图 main：原尺寸 2000×100，PNG/);
      assert.match(text, /回传：1568×78（已缩小/);
      assert.match(text, /原图已保存：.*a\.png/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('小图原样回；size.maxWidth 只管回传；save: "temp" 落临时目录', () => {
    const png = rgbPng(300, 200);
    const same = imageOutput(png, { root: "/", tool: "screenshot", label: "x" });
    assert.deepEqual(imageOf(same), png);
    assert.match(textOf(same), /回传：原尺寸（300×200）/);
    assert.equal(same.saved, null);

    const out = imageOutput(png, {
      root: "/",
      tool: "host_render",
      extra: "7",
      label: "x",
      save: TEMP_SAVE,
      size: { maxWidth: 100 },
    });
    try {
      assert.deepEqual(out.returned, { width: 100, height: 67 });
      assert.ok(out.saved!.startsWith(tempImageDir()), out.saved!);
      assert.match(path.basename(out.saved!), /^host_render-7-\d{8}-\d{6}-\d{3}\.png$/);
      assert.deepEqual(new Uint8Array(readFileSync(out.saved!)), png);
    } finally {
      if (out.saved) rmSync(out.saved, { force: true });
    }
  });

  test("inline: false 只落盘不回图；没给 save 时报错", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-img-"));
    try {
      const out = imageOutput(rgbPng(10, 10), { root, tool: "screenshot", label: "x", save: "b.png", inline: false });
      assert.equal(out.content.length, 1);
      assert.equal(out.returned, null);
      assert.match(textOf(out), /回传：没有/);
      assert.ok(existsSync(path.join(root, "b.png")));
      assert.throws(() => imageOutput(rgbPng(10, 10), { root, tool: "x", label: "x", inline: false }), /要给 save/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("要缩小但格式不支持：报错带已保存路径，不回错图；scale 1 不解码", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-img-"));
    try {
      const png = rgbPng(2000, 10);
      png[25] = 3; // 改成调色板（CRC 也不对了，一样不能解）
      assert.throws(
        () => imageOutput(png, { root, tool: "screenshot", label: "x", save: "c.png" }),
        (error: Error) => /缩小回传图片失败/.test(error.message) && error.message.includes(path.join(root, "c.png")),
      );
      assert.ok(existsSync(path.join(root, "c.png")), "原图仍然落盘");
      const raw = imageOutput(png, { root, tool: "screenshot", label: "x", size: { scale: 1 } });
      assert.deepEqual(imageOf(raw), png);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
