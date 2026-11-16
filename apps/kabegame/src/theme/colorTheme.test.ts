// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "@kabegame/i18n";
import {
  BUILTIN_COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  REQUIRED_THEME_VARIABLES,
  applyColorTheme,
  colorThemeName,
  findColorTheme,
  parseColorTheme,
} from "./colorTheme";

describe("内置颜色主题", () => {
  it("id 唯一、含默认主题，按设置里的顺序排列", () => {
    const ids = BUILTIN_COLOR_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["fresh-blue", "anime-pink", "premium-gray", "fresh-green", "elegant-purple"]);
    expect(ids).toContain(DEFAULT_COLOR_THEME_ID);
  });

  it("每个主题都给全基色、只写 --kb-*，并有全部界面语言的名字", () => {
    for (const theme of BUILTIN_COLOR_THEMES) {
      for (const key of REQUIRED_THEME_VARIABLES) expect(theme.vars[key], `${theme.id} ${key}`).toBeTruthy();
      for (const key of Object.keys(theme.vars)) expect(key.startsWith("--kb-")).toBe(true);
      for (const { value } of SUPPORTED_LANGUAGES) expect(theme.name[value], `${theme.id} ${value}`).toBeTruthy();
    }
  });

  it("名字按语言取，缺失回落 default", () => {
    const pink = findColorTheme("anime-pink");
    expect(colorThemeName(pink, "zh")).toBe("动漫粉");
    expect(colorThemeName(pink, "xx")).toBe("Anime Pink");
  });

  it("不认识的 id 回落默认主题", () => {
    expect(findColorTheme("no-such-theme").id).toBe(DEFAULT_COLOR_THEME_ID);
    expect(findColorTheme(null).id).toBe(DEFAULT_COLOR_THEME_ID);
  });
});

describe("parseColorTheme", () => {
  const base = findColorTheme(DEFAULT_COLOR_THEME_ID);

  it("拒绝白名单之外的变量、缺基色或缺 default 名字", () => {
    expect(parseColorTheme({ ...base, vars: { ...base.vars, "--anime-primary": "#fff" } })).toBeNull();
    expect(parseColorTheme({ ...base, vars: { ...base.vars, "--kb-radius-md": "0" } })).toBeNull();
    const { "--kb-primary": _drop, ...missing } = base.vars;
    expect(parseColorTheme({ ...base, vars: missing })).toBeNull();
    expect(parseColorTheme({ ...base, name: { zh: "x" } })).toBeNull();
    expect(parseColorTheme({ ...base, id: "Bad Id" })).toBeNull();
  });

  it("接受可选的派生 token 覆盖", () => {
    expect(parseColorTheme({ ...base, vars: { ...base.vars, "--kb-hover": "#eee" } })).not.toBeNull();
  });
});

describe("applyColorTheme", () => {
  const root = document.documentElement;
  afterEach(() => {
    root.removeAttribute("style");
    delete root.dataset.kbTheme;
  });

  it("把 vars 写到 <html> 并标出当前主题", () => {
    applyColorTheme("fresh-blue");
    expect(root.style.getPropertyValue("--kb-primary")).toBe(findColorTheme("fresh-blue").vars["--kb-primary"]);
    expect(root.dataset.kbTheme).toBe("fresh-blue");

    applyColorTheme("premium-gray");
    expect(root.style.getPropertyValue("--kb-primary")).toBe(findColorTheme("premium-gray").vars["--kb-primary"]);
    expect(root.dataset.kbTheme).toBe("premium-gray");
  });
});
