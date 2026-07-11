# 桌面三平台动态库随包打包

## 目的

让 release 安装包自带 FFmpeg/x264/macFUSE 等运行时动态库,避免在最终用户机器上出现 `libx264.so.163: cannot open shared object file` 或 macOS `Library not loaded` 类错误。

三个平台的策略统一为:**从开发机/构建机的系统位置(apt/brew/MSYS2)收集 SONAME 实文件 → 暂存到 `bin/{platform}/` → 由 Tauri 打入安装包 → 二进制通过 rpath / @executable_path 解析**。

## 三平台暂存目录

| 平台 | 暂存目录 | git 跟踪 | 内容 |
|---|---|---|---|
| Windows | `bin/windows/` | 部分 | dokan2 等预置文件跟踪;av*/swscale-*/swresample-* 由 os-plugin 在 build 期从 `third/FFmpeg-build/install/bin` 收集(`.gitignore` 已忽略)。x264 静态嵌入 avcodec-\*.dll、libwinpthread 静态嵌入 avutil-\*.dll(见 `scripts/build-ffmpeg.sh`),均无需单独收集/打包 |
| Linux | `bin/linux/` | 否 | FFmpeg、x264 均静态链接；仅保留 `KABEGAME_BUNDLE_LIBS_EXTRA` 指定的额外动态库 |
| macOS | `bin/macos/` | 否 | 仅保留 `KABEGAME_BUNDLE_LIBS_EXTRA` 逃生口；x264 已静态嵌入 FFmpeg,libfuse 弱链接懒加载,不随包分发任何 brew dylib |

收集逻辑集中在 [scripts/plugins/os-plugin.ts](../../scripts/plugins/os-plugin.ts) 的 `OSPlugin.bundleLibs()`,挂在 `beforeBuild` hook,**只在 `bun b` build 期、main 组件、非 android/web 时触发**。Linux 的 light 模式不收 fuse；FFmpeg 编解码依赖已进入二进制，不再收集对应 `.so`。

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

### macOS rpath + 弱链接

build.rs 在 macOS 注入 `-Wl,-rpath,@executable_path/../Frameworks`(对位于 `Contents/MacOS/` 的二进制有效)。libfuse 通过 `-Wl,-weak-lfuse` 弱链接,动态库不在捆绑范围内 —— 有 macFUSE 则可用虚拟盘,无则不崩,设置页检测 `/Library/Frameworks/macFUSE.framework` 或 `/Library/Filesystems/macfuse.fs` 并提示安装。x264 已静态嵌入 FFmpeg,二进制无 brew dylib 硬依赖。

无 brew dylib 捆绑 → 无 `install_name_tool` 改写 Mach-O → Apple Silicon linker 的 ad-hoc 签名天然有效 → 无需事后 `codesign` 重签。CEF 框架与 helper 在 `tauri build` 打 dmg 前经 Tauri 原生 `macOS.frameworks` / `macOS.files` 拷入,签名保原样,全程无签名重做。

## CEF runtime 随包打包(Linux/Windows standard|light)

CEF/Chromium 运行时(约 200MB)不走系统收集,来源是 `CEF_PATH` 指向的自编发行版目录
(回退:Linux `~/i/cef-prod`、Windows `H:\cef-prod`;dev/check 用对应 cef-dev):

| 平台 | 收集函数(os-plugin) | 暂存位置 | 安装位置 | 搬运机制 |
|---|---|---|---|---|
| Linux | `collectLinuxCefLibs()` | `bin/linux/`(含 `locales/`) | `/usr/lib/kabegame/` | deb `files` 注入(component-plugin 递归扫描 bin/linux) |
| Windows | `collectWindowsCefRuntime()` | `src-tauri/kabegame/resources/cef/`(含 `locales/`) | `$INSTDIR\` 与 `$INSTDIR\locales\` | 随 `resources/**/*` 进 NSIS 包,POSTINSTALL hook(`nsis/installer-hooks.nsh`)move 到位 |

- 清单常量:`CEF_RUNTIME_FILES`(Linux)/ `WINDOWS_CEF_RUNTIME_FILES`(Windows),locales 白名单共用 `CEF_LOCALES`(en-US 必留)。
- Windows 必须搬到 exe 同目录:`libcef.dll` 是 load-time 链接,CEF 要求 dll/pak/dat/locales 与 exe 同层;NSIS 现有 `resources\bin\*.dll` move loop 只搬 DLL,CEF 用独立的 `resources\cef` move 段(含非 DLL 文件与 locales 子目录),卸载时在 PREUNINSTALL 里显式删除非 DLL 残留(icudtl.dat、*.pak、locales/ 等)。
- Windows exe 还必须内嵌含 `<compatibility>` supportedOS 的 application manifest,否则 GPU 进程崩溃循环 —— 见 [tauri-runtime-cef README](../../src-tauri/tauri-runtime-cef/README.md) 的 Windows 注意事项。
- 运行时资源定位:dev 下 cef-dll-sys build.rs 已把 runtime 拷进 `target/{debug,release}/`;安装态 Linux 走 `<exe>/../lib/kabegame`,Windows 走 CEF 默认(exe 同目录)。

## 虚拟盘驱动/系统依赖安装策略

运行时库和内核级驱动/系统扩展分开处理:

- Windows 安装包仍随包携带并移动 `dokan2.dll` 到 `$INSTDIR`，供 `/DELAYLOAD:dokan2.dll` 在用户启用画册盘时解析；NSIS 安装阶段不再静默启动 `dokan-installer.exe`。设置页通过 `get_album_drive_driver_installed` 检测 `%WINDIR%\SysNative\drivers\dokan2.sys` / `%WINDIR%\System32\drivers\dokan2.sys`，缺失时由用户点击按钮触发 `install_album_drive_driver`，以 `runas /S` 启动随包的 `resources/bin/dokan-installer.exe`。
- macOS 随包复制的是 `libfuse.2.dylib`，只解决应用二进制加载；macFUSE 系统扩展仍需要用户自行安装/批准。设置页检测 `/Library/Frameworks/macFUSE.framework` 或 `/Library/Filesystems/macfuse.fs`，缺失时只展示手动安装说明。
- Linux 不捆 libfuse，`fuser` 静态链接 FUSE 用户态库；运行时需要系统提供 `fusermount3` 与 `/dev/fuse`。设置页检测两者可用性，缺失时只展示发行版包管理器安装说明。

## Tauri 配置如何感知动态库

[scripts/plugins/component-plugin.ts](../../scripts/plugins/component-plugin.ts) 在渲染 `tauri.conf.json.handlebars` 前,扫描 `bin/{linux,macos}/` 并向 `templateCtx` 注入:

- `linuxDebExtraFilesEntries`:形如 `"/usr/lib/kabegame/libx264.so.163": "../../bin/linux/libx264.so.163"` 的逗号分隔字符串。
- `linuxDebExtraFilesPresent`:布尔位,控制 deb files 段是否补逗号。
- `macosFrameworksEntries`:形如 `["<CEF_PATH>/Chromium Embedded Framework.framework"]` 的 JSON 数组字符串(build 期注入 CEF 框架绝对路径；dev/check 为 `[]`)。
- `macosFilesEntries` / `macosFilesPresent`:5 个 helper 变体 app 的 `"Frameworks/<name>.app": "<abs>"` 映射(build 期从 `target/cef-helpers-stage/` 注入)。

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
  "minimumSystemVersion": "11.0",
  "frameworks": ["/Volumes/KIOXIA/cef-prod/Chromium Embedded Framework.framework"],
  "files": {
    "Frameworks/Kabegame Helper.app": "/Volumes/KIOXIA/kabegame/target/cef-helpers-stage/Kabegame Helper.app",
    "Frameworks/Kabegame Helper (GPU).app": "/Volumes/KIOXIA/kabegame/target/cef-helpers-stage/Kabegame Helper (GPU).app",
    "Frameworks/Kabegame Helper (Renderer).app": "/Volumes/KIOXIA/kabegame/target/cef-helpers-stage/Kabegame Helper (Renderer).app",
    "Frameworks/Kabegame Helper (Plugin).app": "/Volumes/KIOXIA/kabegame/target/cef-helpers-stage/Kabegame Helper (Plugin).app",
    "Frameworks/Kabegame Helper (Alerts).app": "/Volumes/KIOXIA/kabegame/target/cef-helpers-stage/Kabegame Helper (Alerts).app"
  },
  "dmg": { "background": "dmg/background.jpg" }
}
```

`linux.deb.depends` 保留 `fuse3` 是因为 Linux 端 `fuser` 用 `default-features=false`(纯 Rust FUSE 实现),运行时仍调用 `fusermount3` 二进制(由 apt 包 `fuse3` 提供);**不**捆 libfuse,这点也由 [release-plugin.ts](../../scripts/plugins/release-plugin.ts) 的 `assertNoLinuxLibfuseLink` 强制校验。

## 升级与运维

- **升级 FFmpeg/x264 主版本**:重新运行 `bun run build:ffmpeg`；下次 Rust 构建会重新读取 `libav*.pc` 并静态链接更新后的库。
- **系统 x264 版本变化**:重新运行 `bun run build:ffmpeg` 后重建即可，不需要收集 SONAME 动态库。
- **覆盖额外库**:设 env `KABEGAME_BUNDLE_LIBS_EXTRA="/path/to/extra.so,/another.so"`,会被复制到 `bin/{linux,macos}/`(Windows 暂不支持此 env,有需要可扩展)。
- **macOS macFUSE 路径**:默认从 `/Library/Frameworks/macFUSE.framework/Versions/A/Frameworks/` 找;若 macFUSE 装在别处,设 `MACFUSE_LIB_DIR` env 指向 `libfuse.dylib` 所在目录。

## 维护清单(改动牵涉的文件)

| 文件 | 角色 |
|---|---|
| `scripts/plugins/os-plugin.ts` | 主入口 `bundleLibs` + 平台收集 + `verifyFFmpegBuildArtifacts` + macOS `stageMacOSCefHelpers` |
| `scripts/plugins/component-plugin.ts` | 渲染 tauri.conf 前注入 `linuxDebExtraFiles*` / `macosFrameworksEntries` / `macosFiles*` |
| `scripts/plugins/mode-plugin.ts` | dev/start 时 Windows PATH 注入(`OSPlugin.binDir`);copyBin 已并入 OSPlugin |
| `scripts/plugins/release-plugin.ts` | Linux assertNoLinuxLibfuseLink(强制 Linux 不链 libfuse) |
| `scripts/build-ffmpeg.sh` | 只编 FFmpeg + 生成 MSVC 导入库;**不再**复制 DLL 到 bin/ |
| `scripts/utils.ts` | 通用工具;Windows DLL 复制函数已迁到 os-plugin |
| `src-tauri/kabegame/build.rs` | Linux `$ORIGIN/../lib/kabegame` + macOS `@executable_path/../Frameworks` rpath |
| `src-tauri/kabegame-cli/build.rs` | 同上(CLI 也吃同一份 libx264) |
| `src-tauri/kabegame/tauri.conf.json.handlebars` | Linux deb files + macOS frameworks 动态注入点 |
| `src-tauri/kabegame/nsis/installer-hooks.nsh` | Windows 安装期把 resources/bin DLL 与 resources/cef CEF runtime 搬到 $INSTDIR;卸载期清理;不自动安装 Dokan 驱动 |
| `.gitignore` | `/bin/linux/`、`/bin/macos/`、`/bin/windows/av*-*.dll`、`src-tauri/kabegame/resources/cef/` 等 |
