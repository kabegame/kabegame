# 桌面三平台动态库随包打包

## 目的

让 release 安装包自带 FFmpeg/x264/macFUSE 等运行时动态库,避免在最终用户机器上出现 `libx264.so.163: cannot open shared object file` 或 macOS `Library not loaded` 类错误。

三个平台的策略统一为:**从开发机/构建机的系统位置(apt/brew/MSYS2)收集 SONAME 实文件 → 暂存到 `bin/{platform}/` → 由 Tauri 打入安装包 → 二进制通过 rpath / @executable_path 解析**。

## 三平台暂存目录

| 平台 | 暂存目录 | git 跟踪 | 内容 |
|---|---|---|---|
| Windows | `bin/windows/` | 部分 | dokan2/libwinpthread/libva 等预置 DLL 跟踪;av*/swscale-*/swresample-*/libx264-* 由 os-plugin 在 build 期从 `third/FFmpeg-build/install/bin` 与 `/mingw64/bin` 收集(`.gitignore` 已忽略) |
| Linux | `bin/linux/` | 否 | os-plugin 经 `pkg-config --variable=libdir x264` 收集 `libx264.so.*`(SONAME 实文件) |
| macOS | `bin/macos/` | 否 | os-plugin 经 `brew --prefix x264` 收集 x264 dylib;经 `MACFUSE_LIB_DIR` / `/Library/Frameworks/macFUSE.framework/Versions/A/Frameworks/` 收集 libfuse dylib |

收集逻辑集中在 [scripts/plugins/os-plugin.ts](../../scripts/plugins/os-plugin.ts) 的 `OSPlugin.bundleLibs()`,挂在 `beforeBuild` hook,**只在 `bun b` build 期、main 组件、非 android/web 时触发**。android/web 不需要捆这些库,光 light 模式在 Linux 不收 fuse 但仍收 x264(FFmpeg 仍是 light 必需的)。

## 运行时解析约定

| 平台 | 解析机制 | 二进制位置 | 库位置 |
|---|---|---|---|
| Windows | DLL 与 .exe 同目录(MS 默认搜索) | `$INSTDIR\kabegame.exe` | `$INSTDIR\*.dll` |
| Linux | ELF `DT_RUNPATH` = `$ORIGIN/../lib/kabegame` | `/usr/bin/kabegame` `/usr/bin/kabegame-cli` | `/usr/lib/kabegame/lib*.so.*` |
| macOS | Mach-O 依赖记录改写为 `@executable_path/{相对路径}/lib*.dylib` | `Kabegame.app/Contents/MacOS/Kabegame`、`Kabegame.app/Contents/Resources/bin/kabegame-cli` | `Kabegame.app/Contents/Frameworks/lib*.dylib` |

### Linux rpath

[src-tauri/kabegame/build.rs](../../src-tauri/kabegame/build.rs) 与 [src-tauri/kabegame-cli/build.rs](../../src-tauri/kabegame-cli/build.rs) 在 `CARGO_CFG_TARGET_OS == linux` 下注入:

```rust
println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/kabegame");
println!("cargo:rustc-link-arg=-Wl,--enable-new-dtags");
```

`$ORIGIN` 是 ELF 动态加载器变量,指向可执行文件所在目录。`/usr/bin/kabegame` 配合 `$ORIGIN/../lib/kabegame` 解析为 `/usr/lib/kabegame/`。

### macOS rpath + install_name fixup

build.rs 在 macOS 注入 `-Wl,-rpath,@executable_path/../Frameworks`(对位于 `Contents/MacOS/` 的二进制有效)。但 CLI 在 `Contents/Resources/bin/` 下,正确路径是 `@executable_path/../../Frameworks/`,不能靠单一 rpath 解决。

更关键的是:链接时的 dylib 依赖记录里存的是 brew **绝对路径**(如 `/opt/homebrew/opt/x264/lib/libx264.165.dylib`),不论 rpath 是什么,dyld 会先尝试这个绝对路径。这必须靠 `install_name_tool` 改写。

**fixup 流程**(`OSPlugin.fixupMacOSAppBundle`,挂在 `afterBuild`):

1. 遍历 `Contents/Frameworks/*.dylib`,记录每个 dylib 的原 install_name(brew 绝对路径),并把 dylib 自身 ID 改为 `@executable_path/../Frameworks/<name>`。
2. 扫 `Contents/MacOS/` 与 `Contents/Resources/bin/` 下所有 Mach-O 二进制(通过 magic 头识别),为每个二进制:
   - 计算相对 Frameworks 的路径:`Contents/MacOS/Kabegame` → `../Frameworks`;`Contents/Resources/bin/kabegame-cli` → `../../Frameworks`。
   - 对每个 dylib 跑 `install_name_tool -change <brew_abs_path> @executable_path/<rel>/<name> <binary>`。
3. 改完每个 Mach-O 后 `codesign --force --sign - <binary>` ad-hoc 重签(改写过的 Mach-O 签名失效,Gatekeeper 会拒绝)。

### macOS .dmg fixup

Tauri 的 `tauri build` 流程内部依次产生 .app 与 .dmg,**无中间 hook**。因此 OSPlugin 在 afterBuild 里:

- 先 fixup `target/release/bundle/macos/Kabegame.app/`(裸 .app)。
- 再对 `target/release/bundle/dmg/Kabegame_*.dmg` 走 **convert→attach RW→fixup→detach→convert UDZO** 流程:`hdiutil convert -format UDRW` 把只读 dmg 转为可写,挂载,fixup 内部的 .app,卸载,再 `hdiutil convert -format UDZO` 转回压缩格式覆盖原 dmg。这样保留了 Tauri 配置的 background.jpg 等所有 dmg 特性,无需重写 dmg 生成逻辑。

## Tauri 配置如何感知动态库

[scripts/plugins/component-plugin.ts](../../scripts/plugins/component-plugin.ts) 在渲染 `tauri.conf.json.handlebars` 前,扫描 `bin/{linux,macos}/` 并向 `templateCtx` 注入:

- `linuxDebExtraFilesEntries`:形如 `"/usr/lib/kabegame/libx264.so.163": "../../bin/linux/libx264.so.163"` 的逗号分隔字符串。
- `linuxDebExtraFilesPresent`:布尔位,控制 deb files 段是否补逗号。
- `macosFrameworksEntries`:形如 `["../../bin/macos/libx264.165.dylib","../../bin/macos/libfuse.2.dylib"]` 的 JSON 数组字符串。

`tauri.conf.json.handlebars` 用 triple-mustache `{{{...}}}` 注入这些片段,渲染出的 `tauri.conf.json`:

```jsonc
"linux": {
  "deb": {
    "depends": ["fuse3", "libayatana-appindicator3-1"],
    "files": {
      "/usr/bin/kabegame-cli": "../../target/release/kabegame-cli",
      "/usr/share/mime/packages/kabegame-kgpg.xml": "./deb/kabegame-kgpg.xml",
      "/usr/share/icons/.../application-x-kabegame-kgpg.png": "./icons/icon.png",
      "/usr/lib/kabegame/libx264.so.163": "../../bin/linux/libx264.so.163"
    }
  }
},
"macOS": {
  "frameworks": ["../../bin/macos/libx264.165.dylib", "../../bin/macos/libfuse.2.dylib"],
  "dmg": { "background": "dmg/background.jpg" }
}
```

`linux.deb.depends` 保留 `fuse3` 是因为 Linux 端 `fuser` 用 `default-features=false`(纯 Rust FUSE 实现),运行时仍调用 `fusermount3` 二进制(由 apt 包 `fuse3` 提供);**不**捆 libfuse,这点也由 [release-plugin.ts](../../scripts/plugins/release-plugin.ts) 的 `assertNoLinuxLibfuseLink` 强制校验。

## 升级与运维

- **升级 FFmpeg/x264 主版本**:重新运行 `bun run build:ffmpeg`(脚本只产出 `third/FFmpeg-build/install/`),下次 `bun b` 时 os-plugin 会重新收集 `bin/{platform}/`。
- **系统 x264 版本变化**(如 Ubuntu 升级 libx264.so.163 → .166):什么都不用做,os-plugin 在 build 期按 SONAME 模式 `libx264.so.\d+` 重新收集。
- **覆盖额外库**:设 env `KABEGAME_BUNDLE_LIBS_EXTRA="/path/to/extra.so,/another.so"`,会被复制到 `bin/{linux,macos}/`(Windows 暂不支持此 env,有需要可扩展)。
- **macOS macFUSE 路径**:默认从 `/Library/Frameworks/macFUSE.framework/Versions/A/Frameworks/` 找;若 macFUSE 装在别处,设 `MACFUSE_LIB_DIR` env 指向 `libfuse.dylib` 所在目录。

## 维护清单(改动牵涉的文件)

| 文件 | 角色 |
|---|---|
| `scripts/plugins/os-plugin.ts` | 主入口 `bundleLibs` + 平台收集 + `verifyFFmpegBuildArtifacts` + `fixupMacOSAppBundle` + `fixupMacOSDmg` |
| `scripts/plugins/component-plugin.ts` | 渲染 tauri.conf 前注入 `linuxDebExtraFiles*` / `macosFrameworksEntries` |
| `scripts/plugins/mode-plugin.ts` | dev/start 时 Windows PATH 注入(`OSPlugin.binDir`);copyBin 已并入 OSPlugin |
| `scripts/plugins/release-plugin.ts` | Linux assertNoLinuxLibfuseLink(强制 Linux 不链 libfuse) |
| `scripts/build-ffmpeg.sh` | 只编 FFmpeg + 生成 MSVC 导入库;**不再**复制 DLL 到 bin/ |
| `scripts/utils.ts` | 通用工具;Windows DLL 复制函数已迁到 os-plugin |
| `src-tauri/kabegame/build.rs` | Linux `$ORIGIN/../lib/kabegame` + macOS `@executable_path/../Frameworks` rpath |
| `src-tauri/kabegame-cli/build.rs` | 同上(CLI 也吃同一份 libx264) |
| `src-tauri/kabegame/tauri.conf.json.handlebars` | Linux deb files + macOS frameworks 动态注入点 |
| `.gitignore` | `/bin/linux/`、`/bin/macos/`、`/bin/windows/av*-*.dll` 等 |
