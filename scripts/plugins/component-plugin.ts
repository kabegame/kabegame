import { BasePlugin } from "./base-plugin";
import { BuildSystem, SRC_FE_DIR, SRC_TAURI_DIR } from "../build-system";
import * as path from "path";
import {
  ROOT,
  RESOURCES_DIR,
  stageResourceBinary,
  getDevServerHost,
} from "../utils";
import { OSPlugin } from "./os-plugin";
import {
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
import Handlebars from "handlebars";

// 组件对象
export class Component {
  static readonly MAIN = "kabegame";
  static readonly CLI = "kabegame-cli";
  // 独立于 kabegame 的 CEF 验证用二进制:cef-example(浏览器/主进程)+
  // cef-helper(唯一子进程入口)。不并入 isAll(`bun b` 全量构建不含它们)。
  static readonly CEF_EXAMPLE = "cef-example";
  static readonly CEF_HELPER = "cef-helper";

  static readonly components = [
    this.MAIN,
    this.CLI,
    this.CEF_EXAMPLE,
    this.CEF_HELPER,
  ];

  constructor(private readonly _comp: string) {}

  get comp() {
    return this._comp;
  }

  get isMain(): boolean {
    return this.comp === Component.MAIN || this.isAll;
  }

  get isCli(): boolean {
    return this.comp === Component.CLI || this.isAll;
  }

  get isCEFExample(): boolean {
    return this.comp === Component.CEF_EXAMPLE;
  }

  get isCEFHelper(): boolean {
    return this.comp === Component.CEF_HELPER;
  }

  get isAll(): boolean {
    return !this.comp;
  }

  static cargoComp(comp: string): string {
    return comp;
  }

  get cargoComp(): string {
    return Component.cargoComp(this.comp);
  }

  static appDir(cmp: string): string {
    switch (cmp) {
      case this.MAIN: {
        return path.join(SRC_TAURI_DIR, "kabegame");
      }
      case this.CLI: {
        return path.join(SRC_TAURI_DIR, "kabegame-cli");
      }
      case this.CEF_EXAMPLE: {
        return path.join(SRC_TAURI_DIR, "cef-example");
      }
      case this.CEF_HELPER: {
        return path.join(SRC_TAURI_DIR, "cef-helper");
      }
      default: {
        throw new Error(`未知的app: ${cmp}`);
      }
    }
  }

  static appFeDir(comp: string): string {
    return path.join(SRC_FE_DIR, comp);
  }

  get appDir(): string {
    return Component.appDir(this.comp);
  }

  get appFeDir(): string {
    return Component.appFeDir(this.comp);
  }
}

/**
 * 解析组件 component，在上下文中添加
 * isMain、isPluginEditor 等布尔变量直接使用。
 */
export class ComponentPlugin extends BasePlugin {
  static readonly NAME = "ComponentPlugin";

  private component?: Component;

  constructor() {
    super(ComponentPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.parseParams.tap(this.name, () => {
      let component = bs.options.component || "";
      if (component && !Component.components.includes(component)) {
        throw new Error(
          `不存在的组件名称 ${component}，允许的列表：${Component.components}`,
        );
      }
      if (!component && !bs.context.cmd!.isBuild) {
        throw new Error(
          `非构建模式必须用 -c 指定一个组件：${Component.components}`,
        );
      }
      const comp = new Component(component);
      if (
        bs.context.cmd!.isDev &&
        (comp.isCli || comp.isCEFExample || comp.isCEFHelper)
      ) {
        throw new Error(
          `当前 dev 不支持 ${comp.comp}！请用 bun b 构建后用 bun start 测试运行`,
        );
      }
      if (bs.context.cmd!.isStart && comp.isCEFHelper) {
        throw new Error(
          `cef-helper 是子进程可执行文件,无法单独 start；请 bun start -c cef-example`,
        );
      }
      this.component = comp;
      bs.context.component = comp;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_COMPONENT", this.component?.comp || "");
      const devServerHost = bs.context.mode?.isAndroid ? getDevServerHost() : "127.0.0.1";
      this.setEnv("KABEGAME_DEV_SERVER_HOST", devServerHost);
      this.setEnv("KABEGAME_DEV_SERVER_PORT", "1420");
      if (bs.context.cmd!.isDev && this.component && !this.component.isCli) {
        this.setEnv(
          "TAURI_CLI_WATCHER_IGNORE_FILENAME",
          path.join(this.component.appDir, ".taurignore"),
        );
      }
    });

    bs.hooks.beforeBuild.tap(this.name, (comp?: string) => {
      const component = comp ? new Component(comp) : this.component!;
      const isAndroid = !!bs.context.mode?.isAndroid;
      const isWeb = !!bs.context.mode?.isWeb;

      // OSPlugin.bundleLibs 已在本 hook 之前(在同一 beforeBuild 阶段)填充了 bin/linux 与 bin/macos。
      // 这里把目录列表翻译为 tauri.conf.json 的动态片段:
      //   - Linux deb.files entries:`"/usr/lib/kabegame/<file>": "../../bin/linux/<file>"`
      //   - macOS.frameworks:`["../../bin/macos/<file>", ...]`
      // dev/check 等非 build 流程下,bin/{linux,macos} 可能为空,对应片段就是空(deb 段无额外 entry / frameworks 为空数组),tauri.conf.json 仍然合法。
      let linuxDebExtraFilesEntries = "";
      let linuxDebExtraFilesPresent = false;
      let macosFrameworksEntries = "[]";
      let macosFilesEntries = "";
      let macosFilesPresent = false;
      if (!isAndroid && !isWeb && !bs.context.cmd?.isCheck) {
        if (OSPlugin.isLinux) {
          const dir = path.join(ROOT, "bin", "linux");
          if (existsSync(dir)) {
            // 递归收集(含 CEF 的 locales/ 子目录),路径相对 bin/linux。
            const rels: string[] = [];
            const walk = (cur: string) => {
              for (const name of readdirSync(cur)) {
                const abs = path.join(cur, name);
                if (statSync(abs).isDirectory()) {
                  walk(abs);
                } else {
                  rels.push(path.relative(dir, abs).split(path.sep).join("/"));
                }
              }
            };
            walk(dir);
            if (rels.length > 0) {
              linuxDebExtraFilesEntries = rels
                .map(
                  (rel) =>
                    `"/usr/lib/kabegame/${rel}": "../../bin/linux/${rel}"`,
                )
                .join(",\n          ");
              linuxDebExtraFilesPresent = true;
            }
          }
        } else if (OSPlugin.isMacOS) {
          if (bs.context.cmd?.isBuild) {
            const cefPath = process.env.CEF_PATH;
            if (cefPath) {
              const framework = path.join(cefPath, "Chromium Embedded Framework.framework");
              if (existsSync(framework)) {
                macosFrameworksEntries = JSON.stringify([framework]);
              }
            }
            const stagingDir = path.join(ROOT, "target", "cef-helpers-stage");
            if (existsSync(stagingDir)) {
              const helperVariants = ["", " (GPU)", " (Renderer)", " (Plugin)", " (Alerts)"];
              const helperBaseName = "Kabegame Helper";
              const entries: string[] = [];
              for (const variant of helperVariants) {
                const helperName = `${helperBaseName}${variant}`;
                const src = path.join(stagingDir, `${helperName}.app`);
                if (existsSync(src)) {
                  entries.push(`"Frameworks/${helperName}.app": "${src}"`);
                }
              }
              if (entries.length > 0) {
                macosFilesEntries = entries.join(",\n          ");
                macosFilesPresent = true;
              }
            }
          }
        }
      }

      const templateCtx = {
        isWindows: !isAndroid && !isWeb && OSPlugin.isWindows,
        isMacOS: !isAndroid && !isWeb && OSPlugin.isMacOS,
        isLinux: !isAndroid && !isWeb && OSPlugin.isLinux,
        isLight: isAndroid,
        isDev: bs.context.cmd!.isDev,
        isAndroid,
        isWeb,
        isWindowEffect:
          !isAndroid && !isWeb && (OSPlugin.isWindows || OSPlugin.isMacOS),
        noResources: false,
        linuxDebExtraFilesEntries,
        linuxDebExtraFilesPresent,
        macosFrameworksEntries,
        macosFilesEntries,
        macosFilesPresent,
      };

      // 编译 apps/<comp>/index.html.handlebars → index.html（在所有模式下，包括 web）
      if (component.isMain) {
        const indexHandlebars = path.resolve(
          component.appFeDir,
          "index.html.handlebars",
        );
        if (existsSync(indexHandlebars)) {
          const indexOut = path.resolve(component.appFeDir, "index.html");
          const indexTemplate = Handlebars.compile(
            readFileSync(indexHandlebars, { encoding: "utf-8" }).toString(),
          );
          writeFileSync(indexOut, indexTemplate(templateCtx));
          this.log(`生成 ${indexOut}`);
        }
      }

      // web mode 无 Tauri bundle，跳过 tauri.conf.json / capabilities 模板处理
      if (isWeb) return;
      // 编译可能存在的handlebars覆盖 tauri.config.json
      const tauriConfigHandlebars = path.resolve(
        component.appDir,
        "tauri.conf.json.handlebars",
      );
      this.log(`tauriConfigHandlebars: ${tauriConfigHandlebars}`);
      if (existsSync(tauriConfigHandlebars)) {
        const tauriConfig = path.resolve(component.appDir, "tauri.conf.json");
        Handlebars.registerHelper("devServerHost", () => isAndroid ? getDevServerHost() : "localhost");
        const template = Handlebars.compile(
          readFileSync(tauriConfigHandlebars, {
            encoding: "utf-8",
          }).toString(),
        );
        writeFileSync(tauriConfig, template(templateCtx));
        // 仅 main 组件：用 handlebars 生成 capabilities/main.json（桌面不含 picker 权限，移动端含）
        if (component.isMain) {
          const capHandlebars = path.resolve(
            component.appDir,
            "capabilities",
            "main.json.handlebars",
          );
          if (existsSync(capHandlebars)) {
            const capOut = path.resolve(
              component.appDir,
              "capabilities",
              "main.json",
            );
            const capTemplate = Handlebars.compile(
              readFileSync(capHandlebars, { encoding: "utf-8" }).toString(),
            );
            writeFileSync(capOut, capTemplate(templateCtx));
          }
        }
      }
    });

    // cef-example 依赖独立构建的 cef-helper 子进程可执行文件;这里只检查其
    // 存在,不代为 `cargo build`(构建始终是显式的 `bun b -c cef-helper`)。
    // 注:main 组件的 CEF runtime 目前仍走自我重入模型(未接入独立 helper,
    // 见 tauri-runtime-cef/src/runtime.rs),故此检查暂不对 main 启用。
    bs.hooks.beforeBuild.tap(this.name, (comp?: string) => {
      const component = comp ? new Component(comp) : this.component!;
      if (!component.isCEFExample) return;
      const profile = bs.options.release ? "release" : "debug";
      const exeName = OSPlugin.isWindows ? "cef-helper.exe" : "cef-helper";
      const exe = path.join(ROOT, "target", profile, exeName);
      if (!existsSync(exe)) {
        throw new Error(
          [
            `❌ 缺少 cef-helper 可执行文件: ${path.relative(ROOT, exe)}`,
            `请先运行: bun b -c cef-helper${bs.options.release ? " --release" : ""}`,
          ].join("\n"),
        );
      }
    });

    if (bs.context.cmd!.isBuild) {
      bs.hooks.prepareEnv.tap(this.name, (comp?: string) => {
        this.setEnv("KABEGAME_COMPONENT", this.component?.comp || comp || "");
        const component = comp ? new Component(comp) : this.component!;
        if (component.isMain) {
          // 先清空 resources 下所有插件和二进制文件
          const resourcesDir = path.join(RESOURCES_DIR);
          const pluginDir = path.join(resourcesDir, "plugins");
          const binDir = path.join(resourcesDir, "bin");
          if (existsSync(pluginDir)) {
            readdirSync(pluginDir, { recursive: true }).forEach((file) => {
              unlinkSync(path.join(pluginDir, file.toString()));
              this.log(`删除文件 ${file}`);
            });
          }
          if (existsSync(binDir)) {
            readdirSync(binDir, { recursive: true }).forEach((file) => {
              unlinkSync(path.join(binDir, file.toString()));
              this.log(`删除文件 ${file}`);
            });
          }
        }

      });
    }
  }
}
