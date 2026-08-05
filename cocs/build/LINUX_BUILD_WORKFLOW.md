# 本机 Linux 构建工作流（Ubuntu 22.04 guest）

> **guest 是一台路径完全相同的开发机。** host 只做 debug 迭代，一切**产物构建**
> （release 二进制、FFmpeg/x264）都在 guest 里跑，由构建系统的守卫强制。

## 模型：profile 隔离 + 构建属地

**最终二进制的 glibc 版本地板 = 执行"最终链接"那台机器的 glibc。**

本机 host 是 bleeding-edge 发行版（glibc **2.43**）。直接在 host 出的 `.deb`，其
`usr/bin/kabegame` 会要求 `GLIBC_2.43`（如 `atan2f@GLIBC_2.43`、`pidfd_*@2.39`、
`__isoc23_*@2.38`），在**当前所有主流稳定发行版上都无法启动**（Ubuntu 24.04=2.39、
Debian 13=2.41、Fedora 41…），报 `version 'GLIBC_2.43' not found`。

过去靠"独立目录"隔离（`target-22`、`node_modules-22`、`.vm/cef-prod` 侧拷贝）。现在改成
**两条更简单的规则**：

| 谁 | 在哪跑 | 落点 |
|---|---|---|
| 开发迭代（`dev` / `check` / `test`，一律 debug） | host | `target/debug/` |
| release 构建（`deno task b --release`） | **只在 guest** | `target/release/` |
| FFmpeg/x264 产物构建（`deno task build:ffmpeg`） | **只在 guest** | `bin/linux/x86_64/{FFmpeg,x264}-build/` |
| chromium/CEF（`deno task build:chromium`） | host 或 guest 均可 | `third/chromium/` → `bin/linux/x86_64/cef-build-{dev,prod}/` |
| rusty_v8 android（`deno task build:v8`） | host 或 guest 均可 | `bin/android/arm64/rusty_v8-build/` |

- **同一个 `target/`**：debug 与 release 是 cargo 的两个 profile 子目录，`.o` 与 build-script
  产物天然不共享，不需要独立 `CARGO_TARGET_DIR`。`target-22` 已退役。
- **同一份 FFmpeg 产物**：只保留 guest 产的那份（glibc 2.35 地板）。host 上 debug 开发直接
  链接它——低地板向上兼容，链接无碍；host 因此不再产生任何 glibc 2.43 的污染源。
- **chromium/v8 豁免**：chromium 自带 Debian sysroot 控制 glibc 地板；v8 产物是
  android/Bionic 目标，与宿主 glibc 无关。两者都可以在 host 上跑（更快），产物经挂载共享。

### 守卫（强制，不是约定）

`scripts/paths.ts` 的 `requireUbuntu2204(what)` 读 `/etc/os-release`，非 Ubuntu 22.04 直接报错：

- `deno task b --release`（Linux、非 android/web）→ 守卫
- `deno task build:ffmpeg`（Linux native 目标）→ 守卫

逃生阀：`KB_ALLOW_HOST_BUILD=1`（明知在做什么时才用，例如临时验证一个不发布的构建）。

> 首次切到本模型时，如果 host 上留有旧的 `target/release/`（glibc 2.43 的存量产物），
> 在 guest 首次 release 构建前清掉：`rm -rf target/release`。

## 环境总览（一次性搭好，长期复用）

- **VM**：libvirt system session，域名 `ubuntu22.04`，用户 `ubuntu-test`，固定 IP
  `192.168.122.74`（按 MAC 的静态 DHCP 绑定），host 侧 `~/.ssh/config` 别名 `ubuntu22`
  免密登录。规格 8G/6core；`<memoryBacking>` 用 `memfd`+`shared`（virtiofs 前提）。
- **源码共享**：virtiofs（host 装 `virtiofsd`），filesystem 设备 tag `kbg` → source
  `/home/cm/i/kabegame`。**guest 必须挂到与 host 完全相同的路径 `/home/cm/i/kabegame`**
  （见踩坑 3）。**整棵树完整挂载**——CEF distrib、FFmpeg 产物、node_modules 全在树内，
  guest 不需要任何侧拷贝。
- **工具链/缓存放共享区**（guest 系统盘仅 ~12G，装不下）：统一在
  `/home/cm/i/kabegame/.vm/`（git 本地忽略，见 `.git/info/exclude`）：
  - `.vm/env.sh`：导出 `CARGO_HOME`/`RUSTUP_HOME`/`BUN_INSTALL` + `LANG=C.UTF-8`。
    **不再需要** `CARGO_TARGET_DIR`（共用 `target/`）与 `CEF_PATH`（构建系统按
    `bin/linux/x86_64/cef-build-prod` 自动解析）。
  - `.vm/{cargo,rustup,bun}`：rustup stable + bun（guest 独立的 CARGO_HOME，与 host 不共享）。
  - `.vm/run-build.sh`：一键构建脚本（见下）。
  - `.vm/cef-prod` **已废除**：CEF distrib 现在就在树内 `bin/linux/x86_64/cef-build-prod/`。
- **guest 依赖**（apt）：`build-essential pkg-config cmake git curl file zlib1g-dev
  libssl-dev libgtk-3-dev libglib2.0-dev clang libclang-dev libayatana-appindicator3-dev
  nasm`；`ubuntu-test` 开了免密 sudo；加了 6G swapfile 防链接期 OOM。

## virtiofs 挂载配置

**host 侧**（一次性）：装 `virtiofsd`（本机路径 `/usr/libexec/virtiofsd`），然后
`virsh -c qemu:///system edit ubuntu22.04` 加两段：

```xml
<!-- virtiofs 前提:共享内存后端,否则 filesystem 设备无法启动 -->
<memoryBacking>
  <source type='memfd'/>
  <access mode='shared'/>
</memoryBacking>

<!-- devices 内:把 host 源码目录透传给 guest,tag=kbg -->
<filesystem type='mount' accessmode='passthrough'>
  <driver type='virtiofs'/>
  <binary path='/usr/libexec/virtiofsd'/>
  <source dir='/home/cm/i/kabegame'/>
  <target dir='kbg'/>
</filesystem>
```

改完需 VM 完整关机再启动（`shutdown` + `start`，reboot 不重读 XML）。

**guest 侧**：挂载点必须与 host 路径完全一致（踩坑 3）：

```bash
sudo mkdir -p /home/cm/i/kabegame
# /etc/fstab 追加(nofail:host 侧设备缺席时不阻塞开机)
kbg /home/cm/i/kabegame virtiofs defaults,nofail 0 0
sudo mount -a
```

passthrough 模式按**数字 uid** 映射：host `cm`=1000 = guest `ubuntu-test`=1000，
guest 内读写即以属主身份进行，无需额外权限配置（踩坑 7）。

## 构建步骤（`.vm/run-build.sh`）

```
ssh ubuntu22 'setsid bash /home/cm/i/kabegame/.vm/run-build.sh > \
  /home/cm/i/kabegame/.vm/build.log 2>&1 < /dev/null &'
```

脚本三段（每段失败写不同 rc 到 `.vm/build.done`）：

1. **重编 x264+FFmpeg**：`deno task build:ffmpeg`（踩坑 1），校验 `libx264.a` 无 `__isoc23`。
   产物落 `bin/linux/x86_64/{FFmpeg,x264}-build/`，host 的 debug 开发也用这一份。
2. **构建 kabegame-cli（release）**：`deno task b -c kabegame-cli --release`，并 `--version`
   自检**能在 guest glibc 2.35 上运行**。cli 是打包 `.kgpg` 的工具，主构建的插件打包步骤
   会调用它（踩坑 4）。
3. **构建主程序 + deb**：`deno task b -c kabegame --release` → `target/release/bundle/deb/*.deb`
   （Linux 打包目标仅 `deb`，无 appimage/rpm）。`--release` 触发 **ReleasePlugin**：
   `-C codegen-units=1`、deb 的 libfuse 链接校验、构建后自动把 deb 以规范名
   `Kabegame-<mode>_<ver>_amd64.deb` 复制到共享盘的 `release/`（host 直接可见），无需手拷。

## 验证（务必做）

```bash
dpkg-deb -x <deb> root
# 地板：最高不得 > 2.35
objdump -T root/usr/bin/kabegame | grep -oE 'GLIBC_[0-9.]+' | sort -V | tail
# 新名符号：必须为 0
objdump -T root/usr/bin/kabegame | grep -c __isoc23
```

## 踩坑清单（核心价值）

**1. `__isoc23_*` 陷阱 —— 预编译 `.a` 复用的隐形杀手。**
host 上 glibc 2.38+ 的头文件会把 `sscanf`/`strtol` 重定向为 C23 版
`__isoc23_sscanf`/`__isoc23_strtol` 并**烧进 .o**。这是**新符号名**、**不带 `@GLIBC_2.xx`
版本标签**，所以"只扫 `@GLIBC_2.36+` 版本化符号"会漏判！历史上
`x264-build/libx264.a` 就带 6 处（`base.c`/`ratecontrol.c` 的 `x264_param_parse` 等），
guest（2.35 无此符号名）链接直接 `undefined symbol: __isoc23_sscanf`。
→ **判断预编译 `.a` 能否复用，必须同时扫两类**：版本化 `@GLIBC_2.36+` **和** 新名
`__isoc23_*`（`nm libxxx.a | grep -E '__isoc23|GLIBC_2\.(3[6-9]|4)'`）。
→ FFmpeg 的 `libav*.a` 是干净的（0 处），只有 **x264** 中招。**这正是现在
`deno task build:ffmpeg` 在 Linux 上被守卫钉死在 guest 的原因**——产物只有一份，
必须是 2.35 地板那份。`atan2f` 反而是**无版本**的 `*UND*`（最终链接期绑定），
本身不阻塞复用。

**2. debug/release 共用 `target/` 是安全的，但别跨 profile 复用。** cargo 不会因 glibc
变化而失效，会重用已编的 rlib / build-script / `-sys` crate `.o`（其中 C 代码带
`__isoc23_*@2.38`）。debug 与 release 是**不同的 profile 子目录**，`.o` 不共享，所以
host 的 debug 迭代不会污染 guest 的 release 产物。真正要防的是「在 host 上跑 release」——
由守卫拦下。切换到本模型时清一次存量 `target/release/`。

**3. 预编译产物里烧死的 host 绝对路径。** FFmpeg/x264 的 `.pc` 里
`prefix=/home/cm/i/kabegame/...` 是绝对路径。若 guest 把源码挂在别的路径（如
`/mnt/kbg`），`.pc` 在 guest 解析不到 → 链接找不到 `.a`。**对策：guest 把 virtiofs 挂到
与 host 完全相同的路径**，一次性消除所有此类问题（不止 `.pc`）。这也是"guest = 等同开发机"
这条设计的硬性前提。

**4. 构建脚本里写死的 `target/release`。** 多处曾用绝对 `ROOT/target` 而非
`CARGO_TARGET_DIR`，导致隔离 target 构建时误用旧产物。已改为统一从 `TARGET_DIR` 取
（见"涉及文件"）。其中 `src-crawler-plugins/package-plugin.ts` 最隐蔽：它 `spawn`
`target/release/kabegame-cli` 来打包 `.kgpg`——在 guest 上会去跑 **host 那份 cli**。
修复 = 该脚本按 `CARGO_TARGET_DIR` 定位 cli + **先把 cli 构建出来**。
同类第二例：`tauri.conf.json.handlebars` 的 bundle files 源路径曾写死
`../../target/release/kabegame-cef-helper`——修复 = component-plugin 往模板注入
`targetDir`（= `TARGET_DIR`），模板改用 `{{targetDir}}/release/kabegame-cef-helper`。
这份 files-map copy 是 Linux release 唯一被使用的 helper（`helper_path()` 硬编码
`/usr/lib/kabegame/`）；tauri 自动塞进 `/usr/bin` 的辅助 bin 已由 fork patch 0008
收敛为只打包 default-run（见 `third-patches/tauri/README.md`）。
> 注：本条在共用 `target/` 之后仍然成立且更重要——路径必须来自 `TARGET_DIR` 而不是硬编码。

**5. tauri-cli 的 target 归一。** fork 的 `cargo-tauri` 从 `third/tauri` 工作区构建，
其默认 target 是 `third/tauri/target`；但一旦设了全局 `CARGO_TARGET_DIR` 又会被重定向。
统一做法：`TauriCliPlugin` 显式 `--target-dir TARGET_DIR`（优先级高于 env），`BIN_DIR`
随 `TARGET_DIR`，默认 `ROOT/target`。

**6. 无需重编的部分。** CEF `libcef.so`（glibc 2.25）与 `rusty_v8` 预编译静态库都不带
`__isoc23_*`/高版本符号，**不用在 guest 重编**——这正是 chromium/v8 构建能豁免守卫、
留在 host 跑的原因。它们的产物在树内（`bin/linux/x86_64/cef-build-prod/`、
`bin/android/arm64/rusty_v8-build/`），guest 挂载即得。

**7. guest 资源。** 系统盘仅 12G：把 `CARGO_HOME`/`RUSTUP_HOME` 放共享区（sdb4）；
`target/` 与 CEF distrib 本来就在共享的仓库树内。8G 内存 + 并行 codegen 易 OOM，加 swap 兜底。
virtiofs passthrough 按数字 uid 映射（host `cm`=1000=guest `ubuntu-test`=1000），
读写以属主身份无缝。

**8. web 发布构建会覆盖 Linux FFmpeg 产物。** `deno task build:web` 的 docker 容器
（almalinux8，glibc 2.28）会把自己那份 FFmpeg/x264 种进 `bin/linux/x86_64/`，覆盖 guest 产的
那份，且容器里 `.pc` 烧的是 `/src` 前缀（宿主无效）。在 Linux 开发机上跑过 web 构建后，
需要回 guest 重跑 `deno task build:ffmpeg`。macOS 宿主无此问题（树内本无 linux 产物）。

## 路径与 target 的单一来源

`scripts/paths.ts` 是唯一来源：

- `TARGET_DIR` —— 读 `CARGO_TARGET_DIR`（相对值按 `ROOT` 归一化成绝对路径）并**回写
  `process.env.CARGO_TARGET_DIR`**，保证不同 cwd（主构建 cwd=src-tauri、tauri-cli cwd=ROOT）
  派生的 cargo/tauri 落点一致；缺省 `ROOT/target`。构建系统一切"找/搬产物"的路径都从这里取。
- `repoBuildDir(repo, { platform?, arch? })` —— 第三方编译产物目录
  `bin/{platform}/{arch}/{repo}-build`。
- `cefExportDir(variant)` —— `bin/{platform}/{arch}/cef-build-{dev,prod}`。
- `CHROMIUM_DIR` —— `third/chromium`（chromium checkout 工作区）。
- `requireUbuntu2204(what)` —— 构建属地守卫。

## 涉及文件

- `scripts/paths.ts` —— 路径命名公式、目标架构解析、`TARGET_DIR`、构建属地守卫（零 npm 依赖）。
- `scripts/utils.ts` —— re-export paths.ts + `FFMPEG_INSTALL_DIR` 等派生常量、`stageResourceBinary`。
- `scripts/build-system.ts` —— macOS run 的 exe 路径。
- `scripts/plugins/mode-plugin.ts` —— `CEF_PATH`/`FFMPEG_PKG_CONFIG_PATH` 注入、release 守卫调用。
- `scripts/plugins/os-plugin.ts` —— CEF helper、dokan2.dll 路径、`bin/{platform}/` 暂存清理
  （跳过 `{arch}/` 子目录）。
- `scripts/plugins/release-plugin.ts` —— bundle（deb/dmg/nsis）目录。
- `scripts/plugins/tauri-cli-plugin.ts` —— fork cargo-tauri 显式 `--target-dir`、`BIN_DIR`。
- `scripts/plugins/component-plugin.ts` —— 模板变量 `targetDir`（helper 等 bundle files 源路径）。
- `src-tauri/kabegame/tauri.conf.json.handlebars` —— helper 源路径 `{{targetDir}}/release/...`。
- `src-crawler-plugins/package-plugin.ts` —— 打包 `.kgpg` 的 `CLI_EXE` 按 `CARGO_TARGET_DIR` 定位。
- `scripts/build-ffmpeg.ts` —— x264+FFmpeg 源码构建（Linux 目标带属地守卫）。
- `src-tauri/tauri-runtime-cef/README.md`、`../../third-patches/cef/README.md` —— CEF 构建/直链。
- `.vm/env.sh`、`.vm/run-build.sh` —— guest 内环境与一键构建（git 本地忽略）。
