# Kabegame 构建文档

这篇文档介绍 Kabegame 如何从拉取仓库到开始 dev 运行，以及最后 build 打包。走的过程有问题随时提issue,或者加作者微信号：cmtheit。

## 一、拉取源码

```sh
git clone https://github.com/kabegame/kabegame --resurce-submodule
```

这会拉取主仓库源码、`src-crawler-plugins` 从仓库、`thirds` 下的第三方包、`packages` 下的一些deno包（包括插件sdk、photoswipe-vue）。

## 二、安装依赖
Kabegame 通过 deno 管理包，目前 lock 文件版本为 4, deno >= 2.9.0。 
```sh
deno install
```

Kabegame 的插件仓库 src-crawler-plugins 在 [源码安装](#一拉取源码)应该拉取了。
但它不是一个子 deno 包, 而是一个单独的workspace根。
所以要进去再单独安装一下依赖。

```sh
cd src-crawler-plugins
deno install
```

接下来是系统依赖。Kabegame 不用传统tauri需要的 webkitgtk，那被 [tauri补丁21](./third-patches/tauri/21-tauri-default-without-wry.patch) 裁掉了, linux上安装依赖：

```sh
sudo apt install build-essential pkg-config cmake ninja-build git curl file nasm clang libclang-dev \
  zlib1g-dev libssl-dev libgtk-3-dev libglib2.0-dev libayatana-appindicator3-dev \
  libpipewire-0.3-dev libspa-0.2-dev
```

包名按 Ubuntu 22.04。PipeWire 是插件模式推流和音频频谱要用的，会真的链接进程序（deb 也声明了 `libpipewire-0.3-0` 依赖）。
22.04 自带的 PipeWire 开发包是 0.3.48，Rust 绑定 pipewire-rs 原本对着它编不过，靠 [pipewire-rs 补丁](./third-patches/pipewire-rs/README.md)
补上，所以要先做完 [三方补丁](#三三方补丁) 再编译 Kabegame，不需要另找新版的 PipeWire 开发包。
要开发 Plasma 壁纸插件的话，再装 Qt ≥ 6.6 的开发包（`qt6-base-dev qt6-declarative-dev`，Ubuntu 24.10 起 apt 才有 6.6），
见下面 [Plasma 壁纸插件](#plasma-壁纸插件linux)。

## 三、三方补丁

Kabegame对tauri、cef等三方库打了补丁，以适应Kabegame的需求。但Kabegame只维护补丁文件，在上游更新的时候跟上更新补丁文件。所以在第一步拉取源码之后还需要手动打一次补丁：

```sh
deno task patch --all
```

## 四、编译二进制

Kabegame 会链入自编译的 `ffmpeg`、`v8`(仅安卓自编)、`cef`(包括chromium)，这一节介绍最重的编译。

### ffmpeg

ffmpeg 仅保留了常用视频的解码以及mp4的编码。

```sh
deno task build:ffmpeg
```

### v8
rusty_v8 官方没有继续支持安卓二进制，kabegame自己编译了aarch64版本的

```sh
deno task build:v8
```

注意还需要安装NDK工具链。

### cef

cef 是最重的（official build + PGO，第一次要编好几个小时）。官方预编译版不带 H.264 / AAC，而且 Kabegame 要给 CEF 打补丁，所以自己编。要准备两样东西：

- **CEF 源码**：就是仓库里的子模块 [third/cef](./third/cef/)（钉在官方上游的版本），[拉取源码](#一拉取源码)时已经下好了，补丁在 [三方补丁](#三三方补丁) 那一步打上（`deno task patch cef`）。不用另外下载。
- **构建根 `CEFBUILD`**：一个需要在之后指定的目录。脚本会自己把 depot_tools、CEF 的 automate-git.py 和整棵 Chromium 源码下载到这里，编译的中间产物也在这里。要求：
  - 放在**仓库外面**，而且上层目录里不能有 `node_modules`（Chromium 的 TS 构建会一路往上找 `node_modules`，找到仓库的就会编挂；默认的 `third/chromium` 会被脚本拦下），比如 `~/kabegame-cefbuild`；
  - 空间留足，本机实测约 90 GB；
  - 文件系统要支持符号链接、权限和大小写敏感：Linux 用 ext4 / btrfs 这类，macOS 用 APFS，不能是 exFAT；
  - 能访问 chromium.googlesource.com 和 GitHub。

```sh
CEFBUILD=~/kabegame-cefbuild deno task build:chromium
```

编好的 CEF 运行时导出到 `bin/<平台>/<架构>/cef-build/`，之后 dev、check、打包都自动从这里找，不用设环境变量。

以后改了 CEF 补丁，再跑同一条命令就是增量编译。网络不好时加 `DEPOT_TOOLS_UPDATE=0`，跳过 depot_tools 的自更新（增量编译不需要联网，不加的话可能一直卡在更新上）。加 `--clean` 是从头编。

平台前提：macOS 要完整的 Xcode（Xcode 27 起自带的 SDK 比 Chromium 支持的新，脚本会自动退到机器上的 26.x SDK，也可以用 `MAC_SDK_PATH` 指定）；Windows 要在 MSYS2 里跑，从 VS x64 Native Tools 环境启动，构建根放在 NTFS 盘。更多见 [tauri-runtime-kbcef 的 README](./src-tauri/tauri-runtime-kbcef/README.md)。

### wasm

Kabegame 的 WPE 场景壁纸依赖一些预编译的 wasm 包，运行以下命令：
```sh
deno task build:wpefont
deno task build:wpesl2wgsl
```
这会输出两个wasm文件到 [bin/wasm](./bin/wasm/)。

### Plasma 壁纸插件（Linux）

KDE Plasma 桌面的插件模式要一个 Plasma 6 壁纸插件（C++ QML 模块，源码在 [src-plasma-wallpaper-plugin](./src-plasma-wallpaper-plugin/)）。开发时用系统的 Qt 就行：

```sh
deno task build:plasma-plugin
```

出货要对着 **Qt 6.6** 编：插件被 plasmashell 加载，用的是用户系统里的 Qt，而 Qt 只往前兼容（对着 6.6 编的能在 6.6 以后的 Qt 里加载，反过来不行），
Plasma 6 要求 Qt ≥ 6.6，所以对着 6.6 编就能覆盖所有 Plasma 6 用户。发行版的 apt 一般没有 6.6（22.04 是 6.2，24.04 是 6.4），用 Qt 官方二进制：

```sh
sudo apt install python3-pip                     # 22.04 默认没有 pip
python3 -m pip install --user aqtinstall
python3 -m aqt install-qt linux desktop 6.6.3 gcc_64 -O ~/Qt
deno task build:plasma-plugin --qt ~/Qt/6.6.3/gcc_64
```

用 `python3 -m aqt` 是因为 `--user` 装出来的 `aqt` 在 `~/.local/bin`，不一定在 PATH 里。Ubuntu 23.04 起系统 Python 不让 pip 直接装包，
那就用 `pipx run --spec aqtinstall aqt install-qt …` 或者开一个 venv。

脚本最后会打印用到的 Qt 版本，不是 6.6 时会提醒只适合开发。没有插件产物时 dev 和打包只告警，照常进行，只是没有插件模式。
细节见 [插件 README](./src-plasma-wallpaper-plugin/README.md)「构建与分发」。

## 五、开发运行

开始dev之前，要先打包release版本的cli，cli会用来打包插件目录下的插件，用来在dev下使用。

```sh
deno task b -c kabegame-cli --release
```

之后运行
```sh
deno task dev -c kabegame 
```

如果你以上都没有问题的话，应该就能启动窗口了。

## 六、dev harness（可选）

[wpe-renderdoc](./.claude/mcps/wpe-renderdoc/) 下的 python mcp要启动需要安装 `RenderDoc` 以及相关的python依赖。

[kbp skills](./.claude/skills/kbp-tools/) 需要安装 Frida。

## 七、打包

运行以下命令打包当前版本

```sh
deno task b -c kabegame --release
```

这会构建 dmp（macos）、installer exe（windows）、deb（ubuntu 22）。

Linux 的 deb 要在 Ubuntu 22.04 里构建：程序对 glibc 的要求取决于构建机，22.04 的 glibc 2.35 能覆盖 22.04、Debian 12 以后的系统。
打包前先按上面用 Qt 6.6 编好 Plasma 壁纸插件，再紧接着打包。虚拟机怎么搭、完整步骤与验证见 [Linux 构建工作流](./cocs/build/LINUX_BUILD_WORKFLOW.md)。

构建安卓用 `deno task b -c kabegame --android --release`
构建web用 `deno task build:web`，这会启动一个docker容器构建，固定的 aliyun centos 分发系统。

当前版本通过以下命令设置，例如 4.7.0

```sh
deno task set-version v4.7.0 
```

这会替换几个文件里的字符串达到目的，目前没有试过alpha等实验标签。
