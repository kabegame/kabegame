import { BasePlugin } from "./base-plugin";
import { BuildSystem, SRC_FE_DIR, SRC_TAURI_DIR } from "../build-system";
import * as path from "path";
import {
  ROOT,
  RESOURCES_DIR,
  TARGET_DIR,
  stageResourceBinary,
  run,
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
  static readonly components = [this.MAIN, this.CLI];

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
      if (bs.context.cmd!.isDev && comp.isCli) {
        throw new Error(
          `当前 dev 不支持 ${comp.comp}！请用 bun b 构建后用 bun start 测试运行`,
        );
      }
      this.component = comp;
      bs.context.component = comp;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_COMPONENT", this.component?.comp || "");
      // Android 真机/模拟器 dev 也走回环：adb reverse tcp:1420 把设备 127.0.0.1:1420
      // 隧道到开发机（fork cargo-tauri patch 5 保留 localhost devUrl + stock
      // android-studio-script localhost 分支），debug ingest 不再依赖局域网 IP/10.0.2.2。
      this.setEnv("KABEGAME_DEV_SERVER_HOST", "127.0.0.1");
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
      //   - linuxBins: bin/linux 下所有文件的相对路径,模板里用 #each 生成 deb.files entries
      //   - macosFrameworks: CEF framework 绝对路径列表,模板里用 #each 生成 frameworks 数组
      // dev/check 等非 build 流程下,bin/{linux,macos} 可能为空,对应片段就是空数组,tauri.conf.json 仍然合法。
      let linuxBins: string[] = [];
      let macosFrameworks: string[] = [];
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
            linuxBins = rels;
          }
        } else if (OSPlugin.isMacOS) {
          if (bs.context.cmd?.isBuild) {
            const cefPath = process.env.CEF_PATH;
            if (cefPath) {
              const framework = path.join(cefPath, "Chromium Embedded Framework.framework");
              if (existsSync(framework)) {
                macosFrameworks = [framework];
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
        linuxBins,
        macosFrameworks,
        // cargo 产物目录(尊重 CARGO_TARGET_DIR,见 utils.TARGET_DIR)。模板里
        // bundle files 的源路径(如 kabegame-cef-helper)必须用它,不能写死
        // ../../target——否则 CARGO_TARGET_DIR 构建(如 VM 的 target-22)会把
        // host 旧产物打进包(见 cocs/build/LINUX_BUILD_WORKFLOW.md 踩坑 4)。
        targetDir: TARGET_DIR.split(path.sep).join("/"),
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
        // devUrl/CSP 一律 localhost：Android 真机由 fork cargo-tauri 保留 localhost devUrl
        // （patch 5，见 cocs/tauri/TAURI_CLI_FORK.md）并经 stock localhost 分支自动
        // adb reverse tcp:1420，页面与 HMR WebSocket 全走 USB 回环，不再按局域网 IP 渲染。
        Handlebars.registerHelper("devServerHost", () => "localhost");
        const template = Handlebars.compile(
          readFileSync(tauriConfigHandlebars, {
            encoding: "utf-8",
          }).toString(),
        );
        writeFileSync(tauriConfig, template(templateCtx));
        // Android 的 Java 包/源码目录固定为 app.kabegame,不随 identifier(按 mode)变化——
        // 由 fork 的 cargo-tauri 按 TAURI_ANDROID_PACKAGE 解耦(见 tauri-cli-plugin.ts /
        // cocs/tauri/TAURI_CLI_FORK.md),这里无需再按 mode 渲染 Kotlin 源码。

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

    // dev/build 的桌面端 kabegame 在主程序编译前先产出 CEF helper。
    // start 不触发 beforeBuild，仍使用已有产物。
    bs.hooks.beforeBuild.tap(`${this.name}:build-kabegame-cef-helper`, (comp?: string) => {
      const component = comp ? new Component(comp) : this.component!;
      if (!component.isMain) return;
      if (bs.context.mode?.isAndroid || bs.context.mode?.isWeb) return;
      if (bs.context.skip?.isCargo) return;

      const release = !!bs.context.cmd?.isBuild;
      const args = [
        "build",
        "-p",
        Component.MAIN,
        "--bin",
        "kabegame-cef-helper",
        "--features",
        "standard",
        ...(release ? ["--release"] : []),
      ];
      // helper 走裸 cargo build(不经 cargo tauri),tauri-build 只在
      // STATIC_VCRUNTIME=true 时才静态链接 vcruntime。主 exe 由 cargo tauri
      // 设了这个 env,helper 没有 → 干净 Windows(无 VC++ 运行库)上启动报
      // 找不到 VCRUNTIME140.dll。这里手动补上,让 build.rs 的 tauri_build::try_build
      // 触发 static_vcruntime(其 rustc-link-arg 覆盖本包所有 bin,含 helper)。
      const helperEnv = OSPlugin.isWindows
        ? { ...process.env, STATIC_VCRUNTIME: "true" }
        : process.env;
      run("cargo", args, { cwd: SRC_TAURI_DIR, env: helperEnv });
      if (release && OSPlugin.isWindows) {
        stageResourceBinary("kabegame-cef-helper");
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
