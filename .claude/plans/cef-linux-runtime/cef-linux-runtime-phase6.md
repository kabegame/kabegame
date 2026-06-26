# Phase 6 — 打包分发(Linux .deb 自带 CEF 运行时)

> 父:[根计划](cef-linux-runtime.md)。前置:Phase 1–5 完成(CEF 路线 A:自建顶层窗口 + GPU/ANGLE Vulkan,OSR 软件为 fallback;单二进制子进程模型)。
>
> **目标**:在**干净 Linux 机器**上 `apt install ./kabegame*.deb` 后,无需任何环境变量/手动放库,直接运行 **CEF 版** kabegame(GPU 路线 A,NVIDIA 可用;软件 fallback 兜底)。与现有 FFmpeg(静态)/ FUSE 打包流程不冲突。
>
> **范围**:仅 Linux `.deb`(当前 `tauri.conf` Linux 仅 `deb` target)。AppImage/rpm 暂不在本期(列入风险/后续)。Windows/macOS/Android **完全不受影响**(不进 CEF 分支)。
>
> **重要事实(决定方案)**
> - **单二进制**:`browser_subprocess_path = current_exe`,**无独立 helper 可执行**(根计划"helper 子进程"措辞作废)。
> - **cef-rs 在 Linux 直接链接 `libcef.so`(DT_NEEDED)**,运行期靠 rpath `$ORIGIN/../lib/kabegame` 解析 → libcef.so 出现在 `NEEDED` 是**正确**的(对比 libfuse 的禁止规则)。构建期(link)也需 CEF 在场。
> - **standard 与 light 在 Linux 都走 CEF**(`AppRuntime` gating = `any(standard, light)`)→ 两种 mode 都要打包 CEF。
> - CEF 资源现在**只认 `CEF_PATH` 环境变量**(dev),生产无路径逻辑 → 本期需补**运行期路径解析(代码改动)**。

---

## 现状锚点

### a. CEF 初始化与资源路径(`src-tauri/tauri-runtime-cef/src/runtime.rs:1053`)
```rust
fn initialize_cef(app: &mut cef::App) -> Result<()> {
    let args = Args::new();
    // ...
    let settings = Settings {
        no_sandbox: 1,
        external_message_pump: 1,
        log_severity: LogSeverity::VERBOSE,
        browser_subprocess_path: CefString::from(            // 现状:= 当前可执行文件(单二进制)
            std::env::current_exe().expect("...").to_string_lossy().as_ref(),
        ),
        root_cache_path: CefString::from(                    // 现状:临时目录(非用户数据目录)
            std::env::temp_dir().join("kabegame-cef").to_string_lossy().as_ref(),
        ),
        ..Default::default()
    };
    if let Ok(cef_path) = std::env::var("CEF_PATH") {        // 现状:仅 dev 环境变量
        if !cef_path.is_empty() {
            settings.resources_dir_path = CefString::from(cef_path.as_str());
            settings.locales_dir_path = CefString::from(format!("{cef_path}/locales").as_str());
        }
    }
    // initialize(...) ...
}
```
> 现状:未设 `CEF_PATH` 时 `resources_dir_path` / `locales_dir_path` 留空 → CEF 按默认(可执行文件同目录)找 `.pak`/`icudtl.dat`/`locales`,**安装后必然找不到**。libcef.so 本身靠 rpath 找(见 c)。

### b. 子进程派发(`src-tauri/kabegame/src/main.rs` + `runtime.rs:607`)
```rust
// main.rs:Tauri 启动前最早期
#[cfg(all(target_os = "linux", not(feature = "web"), any(feature = "standard", feature = "light")))]
tauri_runtime_cef::execute_cef_subprocess_and_exit();   // 子进程在此 cef_execute_process 后退出
```
> 关键:CEF 初始化发生在 **Tauri app 构建之前**,因此 **不能用 `tauri-plugin-pathes`/`AppPaths`**(此时还没有 app)。本期的路径计算只能 `std::env::current_exe()` 自算 —— 是 CLAUDE.md「路径逻辑归 tauri-plugin-pathes」规则在 CEF 早期初始化下的**唯一例外**,需在代码注释里写明理由。

### c. Linux rpath 与 SQLite 符号隐藏(`src-tauri/kabegame/build.rs:51`)
```rust
if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/kabegame");   // /usr/bin → /usr/lib/kabegame
    println!("cargo:rustc-link-arg=-Wl,--enable-new-dtags");
    // standard/light:--version-script 隐藏 sqlite3_* 全局符号(防 NSS 绑错 → 崩)
}
```
> 现状:rpath 已指向 `/usr/lib/kabegame`,**libcef.so 放进该目录即可被 loader 解析,build.rs 无需改**。SQLite 版本脚本(Phase 3.3 修复)必须保留。

### d. 构建期库收集(`scripts/plugins/os-plugin.ts:154` `bundleLibs` / `:254` `collectLinuxSharedLibs`)
```ts
private bundleLibs(bs) {
  this.verifyFFmpegBuildArtifacts();
  if (OSPlugin.isWindows) { /* FFmpeg dll */ }
  else if (OSPlugin.isLinux) { this.collectLinuxSharedLibs(); }   // 现状:仅收集 libx264.so.* 到 bin/linux/
  else if (OSPlugin.isMacOS) { /* dylib */ }
}
```
> `bin/linux/` 是**生成目录**(每次构建前清空、`.gitignore`)。CEF 收集要在此分支挂一个新步骤。

### e. deb.files 注入只认顶层文件(`scripts/plugins/component-plugin.ts:145`)
```ts
if (OSPlugin.isLinux) {
  const dir = path.join(ROOT, "bin", "linux");
  const files = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile());  // ← 只顶层、只文件
  linuxDebExtraFilesEntries = files
    .map((f) => `"/usr/lib/kabegame/${f}": "../../bin/linux/${f}"`)
    .join(",\n          ");
}
```
> 现状:`isFile` 过滤会**漏掉 `locales/` 子目录**。CEF 的 `locales/*.pak`(~50 个)装不进 deb → 必须改为**递归**。

### f. Linux deb 模板(`src-tauri/kabegame/tauri.conf.json.handlebars:83`)
```hbs
"linux": { "deb": {
  "depends": [{{#unless isLight}}"fuse3", {{/unless}}"libayatana-appindicator3-1"],
  "files": { ... {{#if linuxDebExtraFilesPresent}},
    {{{linuxDebExtraFilesEntries}}}{{/if}} },
  "postInstallScript": "./deb/postinst.sh", ...
}}
```
> 现状:已有 `postInstallScript` 钩子可用;`depends` 需补 CEF 运行所需系统库;`files` 注入点已就绪(靠 e 的递归)。

### g. 目标安装布局(本期目标)
```
/usr/bin/kabegame                 (主二进制 = browser/render/gpu 子进程;rpath 已设)
/usr/lib/kabegame/
  libcef.so                       (~170MB,release/minimal,stripped)
  libEGL.so libGLESv2.so          (ANGLE)
  libvulkan.so.1 libvk_swiftshader.so vk_swiftshader_icd.json   (Vulkan / 软件兜底)
  icudtl.dat v8_context_snapshot.bin
  chrome_100_percent.pak chrome_200_percent.pak resources.pak
  locales/*.pak                   (白名单 ~6 个:en-US/zh-CN/zh-TW/ja/ko)
  libx264.so.* libav*…            (现有 FFmpeg/x264,保持)
```
> `--no-sandbox` 已硬编码 → **不打包 `chrome-sandbox`**(免 SUID 麻烦)。CEF 内部 `dlopen` ANGLE/SwiftShader 库默认在 **libcef.so 同目录**找 → 全部同放 `/usr/lib/kabegame/` 即可。

---

## 点 1 — 运行期 CEF 路径解析(代码,`runtime.rs`)

- **新增**
  - `fn resolve_cef_resource_dir() -> Option<PathBuf>`:解析顺序
    1. `CEF_PATH` env(非空)→ dev,直接用;
    2. 否则相对 `current_exe()` 推 `../lib/kabegame`(安装态:`/usr/bin/kabegame` → `/usr/lib/kabegame`),若其中存在 `icudtl.dat` 则采用;
    3. 都没有 → `None`(交给 CEF 默认,并 `eprintln!` 警告)。
    > 注释写明:此处自算路径是 CLAUDE.md 路径规则的**CEF 早期初始化例外**(早于 Tauri/AppPaths)。见现状锚点 b。
- **修改**
  - `initialize_cef`:用 `resolve_cef_resource_dir()` 的结果统一设 `resources_dir_path` 与 `locales_dir_path`(`<dir>` 与 `<dir>/locales`),取代当前「仅 `CEF_PATH`」分支。
  - `root_cache_path`:生产改到 `$XDG_CACHE_HOME/kabegame-cef`(回退 `~/.cache/kabegame-cef`);dev 保持 temp 亦可。
    > 标注:与 `tauri-plugin-pathes` 的缓存目录**语义对齐但实现独立**(早期初始化),低优先,可单列子点。
- **核对**
  - `browser_subprocess_path = current_exe` 在安装态 = `/usr/bin/kabegame`,子进程 re-exec 正常(单二进制);无需改。
  - libcef.so 由 rpath 解析,与本点的资源路径**正交**(一个管 .so,一个管 .pak/数据)。

## 点 2 — 构建期收集 CEF 产物(`scripts/plugins/os-plugin.ts`)

- **新增**
  - `verifyCefArtifacts()`(类比 `verifyFFmpegBuildArtifacts`):定位 CEF 目录(env `KABEGAME_CEF_DIR`,默认 `~/.local/share/cef`),校验存在 `libcef.so` + `icudtl.dat`;缺失则抛错并提示运行导出脚本(见点 6 的 `build:cef`)。仅 Linux + standard/light。
  - `collectLinuxCefLibs()`:把下列文件拷进 `bin/linux/`:
    `libcef.so`、`libEGL.so`、`libGLESv2.so`、`libvulkan.so.1`、`libvk_swiftshader.so`、`vk_swiftshader_icd.json`、`icudtl.dat`、`v8_context_snapshot.bin`、`chrome_100_percent.pak`、`chrome_200_percent.pak`、`resources.pak`,以及 **白名单的** `locales/*.pak`(拷成 `bin/linux/locales/` 子目录)。
    > 不拷 `chrome-sandbox`(`--no-sandbox`);不拷 `CMakeLists.txt`/`include`/`libcef_dll`/`CREDITS.html` 等开发件。
  - **locales 白名单(省 ~48MB)**:CEF 的 `locales/` 全量 **220 个 .pak / 共 ~50MB**(纯 Chromium 自身 UI 文案:右键菜单、错误页、`<input type=date>` 等,**与 kabegame 自己的 Vue i18n 无关**)。只保留 kabegame 支持的 UI 语言 + 强制回退 `en-US`:
    `en-US.pak`、`zh-CN.pak`、`zh-TW.pak`、`ja.pak`、`ko.pak`(对应 i18n 的 en/zh/zhtw/ja/ko)→ 约 6 个文件 / ~1.5MB。
    > `en-US.pak` 必留(CEF 找不到当前系统语言时回退它,缺失会启动报错)。系统语言不在白名单时,Chromium 内置 UI 退回英文(可接受);**不影响 app 内容渲染**。白名单常量集中定义,便于增删。
- **修改**
  - `bundleLibs()` 的 `isLinux` 分支:`collectLinuxSharedLibs()` 之后调用 `collectLinuxCefLibs()`;非 standard/light(纯 web 等)跳过。
- **核对**
  - 体积:必须用 **release/minimal** 的 libcef.so(~170MB);若 `~/.local/share/cef` 是带调试符号的 1.3GB,需 `strip` 或改用 minimal 包(见风险)。
  - 复用既有 `appendExtraLibs()` 的 `realpathSync` + 清空-重建 `bin/linux/` 模式,保持一致。

## 点 3 — deb.files 注入支持子目录(`scripts/plugins/component-plugin.ts`)

- **修改**
  - 把 `bin/linux/` 的收集从「顶层 `isFile`」改为**递归遍历**,对每个文件生成
    `"/usr/lib/kabegame/<相对路径>": "../../bin/linux/<相对路径>"`(令 `locales/en-US.pak` → `/usr/lib/kabegame/locales/en-US.pak`)。
  - 保持现有 `linuxDebExtraFilesPresent` 逗号逻辑与 `macos` 分支不变。
- **核对**
  - handlebars(锚点 f)**无需改**:仍走 `{{{linuxDebExtraFilesEntries}}}`。
  - 验证生成的 `tauri.conf.json` 里 CEF 文件 + locales 全部出现在 `linux.deb.files`。

## 点 4 — deb 系统依赖声明(`tauri.conf.json.handlebars` + `component-plugin.ts`)

- **修改**
  - `linux.deb.depends` 增补 CEF 运行所需(Phase 1 §7.5 实测)系统库的 apt 包名:
    `libnss3`、`libnspr4`、`libgbm1`、`libdrm2`、`libxkbcommon0`、`libxcb1`、`libasound2`、`libcups2`、`libdbus-1-3`、`libpango-1.0-0`、`libcairo2`、`libatk1.0-0`、`libatk-bridge2.0-0`、`libgtk-3-0`。
    > 不与 `fuse3`/`libayatana-appindicator3-1` 冲突;**不分 light/standard**(两者都用 CEF)。
- **核对**
  - 用 `ldd /usr/lib/kabegame/libcef.so | grep 'not found'`(目标发行版)反推遗漏/多余;能用 `dpkg -S` 反查包名的就声明,纯系统基础库(libc/libstdc++)由 base 提供不必列。
  - **FUSE(本期改动,详见点 7)**:Linux `fuser` 从纯 Rust 改为**静态链接** C libfuse3。`depends` 仍须保留 `fuse3` 的 `{{#unless isLight}}` 门控(运行时仍需 SUID `fusermount3`);新增的 CEF depends 与之**并列**。仍**不捆 libfuse.so**(静态嵌入,无 `.so` 运行时依赖)。

## 点 5 — 体积 / strip / 签名 / 启动延迟

- **核对 / 修改**
  - 量化 `.deb` 体积(预计 +~170MB);记录到本文件落地记录(README『当前限制』节亦可补)。
  - `strip --strip-unneeded libcef.so`(若来源带符号);或在点 6 的导出脚本里直接拉 minimal release 包。
  - 签名:Debian 非强制,本期**不做**,仅记录后续可加(GPG repo / dpkg-sig)。
  - 启动延迟:量化 CEF init(~2s);**本期仅测量不优化**(首帧前延迟优化列后续)。
  - `release-plugin.ts`:确认 `assertNoLinuxLibfuseLink` 仍通过;**不为 libcef 加禁链检查**(libcef 在 `NEEDED` 是正确的)。可选:加一条「断言 libcef.so 已随包(/usr/lib/kabegame 下存在)」的正向校验。

## 点 6 — CEF 产物准备脚本 + 干净机验证

- **新增**
  - `scripts/build-cef.sh`(或 `bun run build:cef`):用 cef-rs 的 `export-cef-dir` 导出 **minimal release** CEF 到 `~/.local/share/cef`(或 `KABEGAME_CEF_DIR`),供构建期收集。类比 `build:ffmpeg`。
  - `.gitignore`:忽略 CEF 下载产物 / `bin/linux/`(后者已忽略)。
- **核对(验收驱动)**
  - 干净 Ubuntu(容器,无 CEF_PATH、无 `~/.local/share/cef`)`apt install ./kabegame_*.deb` → 启动 GUI:
    - GPU 路线 A 正常(NVIDIA 机);
    - 无 GPU 环境 → 软件 fallback 不崩;
    - 画廊浏览 / IPC / 详情等回归 OK。
  - glibc 跨版本:至少在 22.04(2.35)与开发机(2.42)各验一次。

## 点 7 — Linux FUSE 改为静态链接 C libfuse(与 CEF 正交,可独立做)

> 动机:用 C 参考实现的挂载/卸载逻辑(更成熟的卸载/信号/auto-unmount),同时**静态嵌入**避免 `libfuse3.so` 运行时依赖。本机已确认 `libfuse3.a` 由 `libfuse3-dev` 提供,可行。

### 现状锚点(`src-tauri/kabegame-core/Cargo.toml:70`)
```toml
[target.'cfg(target_os = "linux")'.dependencies]
fuser = { version = "0.16", default-features = false, optional = true }   # 现状:纯 Rust,调 fusermount3
[target.'cfg(target_os = "macos")'.dependencies]
fuser = { version = "0.16", features = ["libfuse"], optional = true }     # macOS 已用 libfuse
```
> `fuser 0.16` build.rs:开 `libfuse` feature 时 `pkg_config::Config::new().probe("fuse3")`;pkg-config crate 认 `FUSE3_STATIC=1` → 在 `libfuse3.a` 存在时静态链接。

- **修改**
  - `Cargo.toml`(Linux 行):`default-features = false` → `features = ["libfuse"]`(与 macOS 对齐)。
  - 构建期注入 `FUSE3_STATIC=1`(`run.ts` 的 `prepareEnv`,**仅 Linux + standard**;light 无虚拟盘不涉及 `virtual-driver`)→ 链接 `libfuse3.a` 而非 `.so`。
- **新增**
  - 构建机前置:`libfuse3-dev`(提供 `libfuse3.a` + pkg-config `fuse3`)。写入构建前置文档(类比 FFmpeg 的前置)。
- **核对 / 不变**
  - **运行时仍需 `fusermount3`**(SUID root):静态化只去掉 `libfuse3.so` 运行时依赖,**不去掉 fusermount3** → deb `depends: fuse3` **保留**(standard,`{{#unless isLight}}`)。
  - `release-plugin.ts` 的 `assertNoLinuxLibfuseLink`:**静态链接不产生 `DT_NEEDED libfuse`**,校验**仍然通过**(我们要的正是"无动态 libfuse")。仅**更新其报错文案/注释**:旧文案「use fuser without the libfuse feature」已过时 → 新策略「libfuse 必须静态链接,禁止动态依赖或捆 `.so`」。可选:加正向断言「二进制确实静态含 libfuse(无 `.so` 依赖且 `virtual-driver` 启用)」。
  - **绝不**把 `libfuse3.so` 放进 `bin/linux/` / `/usr/lib/kabegame/`。
- **风险**
  - 版本偏移:构建机 libfuse(3.18.2)静态嵌入 vs 用户机 `fusermount3` 版本不同 —— libfuse↔fusermount3 协议跨小版本稳定,低风险。
  - 不同发行版 `libfuse3-dev` 是否带 `libfuse3.a`(Debian/Ubuntu 带;构建机需确保)。

---

## 验收

- 干净 Linux 机器 `apt install ./kabegame*.deb`(standard 与 light 各一)后,**无需任何 env**,直接运行 CEF 版前端;`/usr/lib/kabegame/` 下 libcef.so + 资源 + locales 齐备。
- GPU(路线 A)与软件 fallback 两条路径都能起;核心功能(画廊/IPC/详情/设置)回归通过。
- 与现有 FFmpeg(静态)/ x264 打包流程并存;`release-plugin` 的「无动态 libfuse」校验仍通过(静态链接不产生 NEEDED)。
- 虚拟盘(standard)在干净机挂载/卸载正常:静态嵌入的 C libfuse + 系统 `fusermount3`(由 `fuse3` 提供)。
- `bun b -c kabegame --release` 产出可分发 `.deb` 到 `release/`。

## 风险

- **体积**:libcef.so ~170MB → `.deb` 显著变大，light模式也同时变大。
- **CEF 内部 dlopen 查找路径**:ANGLE/SwiftShader 必须与 libcef.so **同目录**;若 CEF 用绝对/相对异常路径找不到,需 `LD_LIBRARY_PATH` 兜底或软链(在 postinst)。
- **locales 注入量**:白名单后仅 ~6 个 `.pak` 进 `deb.files`(全量 220 个已砍掉)。
- **多发行版系统库**:目标机缺 `libnss3`/`libgbm1` 等 → 已用 depends 覆盖,但版本差异(glibc)仍可能炸;需实测。
- **root_cache_path**:改用户缓存目录前,多用户/只读 `/tmp` 场景注意权限。
- **AppImage/rpm 未覆盖**:仅 deb;其它发行版分发列后续。

## 锚点

- `src-tauri/tauri-runtime-cef/src/runtime.rs:1053`(`initialize_cef` / CEF_PATH / root_cache_path)
- `src-tauri/kabegame/src/main.rs`(`execute_cef_subprocess_and_exit`,早于 Tauri)
- `src-tauri/kabegame/build.rs:51`(rpath `$ORIGIN/../lib/kabegame` + SQLite 版本脚本)
- `scripts/plugins/os-plugin.ts:154`(`bundleLibs`)/`:173`(`verifyFFmpegBuildArtifacts`)/`:254`(`collectLinuxSharedLibs`)
- `scripts/plugins/component-plugin.ts:145`(Linux deb.files 注入,需递归)
- `src-tauri/kabegame/tauri.conf.json.handlebars:83`(`linux.deb` depends/files/postInstallScript)
- `scripts/plugins/release-plugin.ts`(`assertNoLinuxLibfuseLink` / 拷贝到 release/)
- 参考文档:`cocs/build/PLATFORM_SHARED_LIBS.md`
- CEF 产物:cef-rs `export-cef-dir`(cef 149,minimal release ≈170MB)

---

## 落地记录(2026-06-27)

### 代码/构建改动(点 1/2/3/4/6/7 已实现)
- ✅ **点 1 运行期路径解析**(`runtime.rs`):新增 `resolve_cef_resource_dir()`(CEF_PATH → `<exe>/../lib/kabegame`(以 `icudtl.dat` 判定)→ None 警告)与 `cef_root_cache_dir()`(XDG/HOME → temp);`initialize_cef` 用其设 `resources_dir_path`/`locales_dir_path`/`root_cache_path`。注释标明 CEF 早期初始化是 tauri-plugin-pathes 规则的例外。
- ✅ **点 7 FUSE 静态**:`kabegame-core/Cargo.toml` Linux 行 `default-features=false` → `features=["libfuse"]`;`mode-plugin.ts` prepareEnv 在 Linux+standard 注入 `FUSE3_STATIC=1`;`release-plugin.ts` 的 `assertNoLinuxLibfuseLink` 文案改为「必须静态链接」(逻辑不变,静态无 DT_NEEDED 故仍通过)。
- ✅ **点 2 收集**(`os-plugin.ts`):新增 `CEF_RUNTIME_FILES`/`CEF_LOCALES` 常量 + `cefDir()`/`verifyCefArtifacts()`/`collectLinuxCefLibs()`;`bundleLibs` Linux 分支在 `collectLinuxSharedLibs()`(会清空 bin/linux)**之后**、standard/light 时收集 CEF(libcef.so + 资源 + locales 白名单;en-US 缺失硬报错)。
- ✅ **点 3 注入**(`component-plugin.ts`):`bin/linux/` 收集从顶层 `isFile` 改为**递归**,生成 `/usr/lib/kabegame/<相对路径>` 映射(locales/ 子目录得以进 deb)。
- ✅ **点 4 依赖**(`tauri.conf.json.handlebars`):`linux.deb.depends` 增补 `libnss3 libnspr4 libgbm1 libdrm2 libxkbcommon0 libxcb1 libasound2 libcups2 libdbus-1-3 libpango-1.0-0 libcairo2 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0`。
- ✅ **点 6 脚本**:新增 `scripts/build-cef.sh`(幂等导出 CEF release/minimal;`export-cef-dir` 缺失则 `cargo install`),`package.json` 注册 `build:cef`。`bin/linux/` 已 gitignore、CEF 下载在仓库外,无需改 .gitignore。

### 校验
```sh
cargo check -p tauri-runtime-cef --features cef-backend            # ✅ 干净
FUSE3_STATIC=1 FFMPEG_PKG_CONFIG_PATH=… FFMPEG_LINK_MODE=static \
  cargo check -p kabegame-core --features virtual-driver           # ✅ 干净(fuser+libfuse FFI 编过)
bunx tsc --noEmit -p tsconfig.json                                 # ✅ 改动的 4 个 plugin 无类型错误
```
- ⚠️ **仅 `cargo check`**:`FUSE3_STATIC` 的**静态链接**只在最终二进制 link(`cargo build`)时生效,check 未覆盖;待一次真实 release 构建确认无 `DT_NEEDED libfuse`。

### 待实测(需真实构建 / 干净机,本次未做)
- ⏭ **点 5**:`.deb` 实际体积、libcef.so strip、启动延迟量化。
- ⏭ **点 6 验收**:干净 Ubuntu `apt install ./kabegame*.deb` 启动(GPU 路线 A + 软件 fallback)、虚拟盘挂载、多 glibc。
- ⏭ 一次 `bun b -c kabegame --release` 端到端:CEF 文件进 deb、`assertNoLinuxLibfuseLink` 通过、`release/` 产出。
- 📌 **待拍板**:light 模式也会带 ~170MB CEF(与"light=小"冲突)—— 保持,还是 light 退回 WebKitGTK。
