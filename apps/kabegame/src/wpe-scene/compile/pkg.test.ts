import { closeSync, existsSync, openSync, readdirSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PkgFormatError, ScenePkg, type RangeRead } from "./pkg";

const encoder = new TextEncoder();

function sizedString(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** 按工坊样本的布局造一个包：条目数据首尾相接。 */
function buildPkg(files: [string, string][], version = "PKGV0024"): Uint8Array {
  const table: Uint8Array[] = [sizedString(version), u32(files.length)];
  const data: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const bytes = encoder.encode(content);
    table.push(sizedString(name), u32(offset), u32(bytes.length));
    data.push(bytes);
    offset += bytes.length;
  }
  return concat([...table, ...data]);
}

/** 内存读取方，行为对齐 `fetch(file:)` 的 Range：跨过末尾截短，起点越界抛错。 */
function memoryReader(bytes: Uint8Array, calls?: [number, number][]): RangeRead {
  return async (start, end) => {
    calls?.push([start, end]);
    if (start >= bytes.length && bytes.length > 0) throw new Error("Failed to fetch");
    return bytes.slice(start, Math.min(end, bytes.length));
  };
}

const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

describe("ScenePkg", () => {
  it("读目录表并按条目名取数据", async () => {
    const pkg = buildPkg([
      ["scene.json", '{"objects":[]}'],
      ["materials/妃咲 60帧 .json", '{"passes":[]}'],
      ["shaders/a.frag", "void main() {}"],
    ]);
    const opened = await ScenePkg.open(memoryReader(pkg));
    expect(opened.version).toBe("PKGV0024");
    expect(opened.entries.map((e) => e.name)).toEqual(["scene.json", "materials/妃咲 60帧 .json", "shaders/a.frag"]);
    expect(decode(await opened.readEntry("materials/妃咲 60帧 .json"))).toBe('{"passes":[]}');
    expect(decode(await opened.readEntry("shaders/a.frag"))).toBe("void main() {}");
    expect(await opened.readEntry("missing.json")).toBeNull();
    expect(opened.has("scene.json")).toBe(true);
  });

  it("条目按区间读取，不读整包", async () => {
    const pkg = buildPkg([
      ["a", "x".repeat(1000)],
      ["b", "yz"],
    ]);
    const calls: [number, number][] = [];
    const opened = await ScenePkg.open(memoryReader(pkg, calls), { initialChunk: 64 });
    calls.length = 0;
    expect(decode(await opened.readEntry("b"))).toBe("yz");
    expect(calls).toEqual([[opened.baseOffset + 1000, opened.baseOffset + 1002]]);
  });

  it("目录表超过首次读取量时加倍重读", async () => {
    const files: [string, string][] = Array.from({ length: 40 }, (_, i) => [`materials/m${i}.json`, `{"i":${i}}`]);
    const pkg = buildPkg(files);
    const calls: [number, number][] = [];
    const opened = await ScenePkg.open(memoryReader(pkg, calls), { initialChunk: 16 });
    expect(opened.entries).toHaveLength(40);
    expect(calls.length).toBeGreaterThan(1);
    expect(decode(await opened.readEntry("materials/m39.json"))).toBe('{"i":39}');
  });

  it("同名条目取第一条", async () => {
    const opened = await ScenePkg.open(
      memoryReader(
        buildPkg([
          ["dup", "first"],
          ["dup", "second"],
        ]),
      ),
    );
    expect(decode(await opened.readEntry("dup"))).toBe("first");
  });

  it("拒绝非 PKGV 头", async () => {
    await expect(ScenePkg.open(memoryReader(buildPkg([], "NOTAPKG")))).rejects.toBeInstanceOf(PkgFormatError);
  });

  it("目录表被截断时报错", async () => {
    const pkg = buildPkg([["scene.json", "{}"]]);
    const truncated = pkg.slice(0, 20);
    await expect(ScenePkg.open(memoryReader(truncated), { initialChunk: 8 })).rejects.toThrow("目录表被截断");
  });

  it("条目数据被截断时报错", async () => {
    const pkg = buildPkg([["scene.json", '{"objects":[]}']]);
    const opened = await ScenePkg.open(memoryReader(pkg.slice(0, pkg.length - 3)));
    await expect(opened.readEntry("scene.json")).rejects.toBeInstanceOf(PkgFormatError);
  });

  it("读取方忽略区间、返回过长时报错", async () => {
    const pkg = buildPkg([
      ["a", "aaaa"],
      ["b", "bbbb"],
    ]);
    const opened = await ScenePkg.open(async () => pkg);
    await expect(opened.readEntry("a")).rejects.toThrow("应为 4 字节");
  });
});

// 本机创意工坊语料：`KABEGAME_WPE_ROOT` 指向 WPE 安装目录（`<库>/steamapps/common/wallpaper_engine`），
// 工坊目录在 `<库>/steamapps/workshop/content/431960`。只读访问，未设置时跳过。
const WPE_ROOT = process.env.KABEGAME_WPE_ROOT;
const WORKSHOP = WPE_ROOT ? join(WPE_ROOT, "..", "..", "workshop", "content", "431960") : null;
const corpus =
  WORKSHOP && existsSync(WORKSHOP)
    ? readdirSync(WORKSHOP)
        .map((id) => join(WORKSHOP, id, "scene.pkg"))
        .filter((path) => existsSync(path))
    : [];

function fileReader(fd: number, size: number): RangeRead {
  return async (start, end) => {
    if (start >= size) throw new Error("Failed to fetch");
    const out = new Uint8Array(Math.min(end, size) - start);
    readSync(fd, out, 0, out.length, start);
    return out;
  };
}

describe.skipIf(corpus.length === 0)("本机工坊 scene.pkg", () => {
  it.each(corpus)("%s", async (path) => {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const read = fileReader(fd, size);
      const pkg = await ScenePkg.open(read);
      expect(pkg.version).toMatch(/^PKGV\d{4}$/);
      // 条目都落在文件内，最后一条结束在文件末尾
      const end = Math.max(...pkg.entries.map((e) => e.offset + e.length));
      expect(pkg.baseOffset + end).toBe(size);
      const scene = await pkg.readEntry("scene.json");
      expect(scene).not.toBeNull();
      expect(() => JSON.parse(new TextDecoder().decode(scene!).replace(/^﻿/, ""))).not.toThrow();
      // 纹理可能有几百 MB（视频纹理），只读魔数验证偏移
      const tex = pkg.entries.find((e) => e.name.endsWith(".tex"));
      if (tex) {
        const start = pkg.baseOffset + tex.offset;
        expect(new TextDecoder().decode(await read(start, start + 8))).toBe("TEXV0005");
      }
    } finally {
      closeSync(fd);
    }
  });
});
