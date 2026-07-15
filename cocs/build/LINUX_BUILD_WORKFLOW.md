# 本机 Linux 构建工作流（Ubuntu 22.04 VM）

> **本机构建面向发布的 Linux desktop `.deb`，标准流程就是在 22.04 VM 里做最终链接。**
> 不是可选的"低 glibc 变体"——在本机，这**就是** Linux 的构建工作流。

## 为什么本机 Linux 构建要走 VM

**最终二进制的 glibc 版本地板 = 执行"最终链接"那台机器的 glibc。**

本机是 bleeding-edge 发行版（glibc **2.43**）。直接在本机 `deno task b -c kabegame` 出来的
`.deb`，其 `usr/bin/kabegame` 会要求 `GLIBC_2.43`（如 `atan2f@GLIBC_2.43`、`pidfd_*@2.39`、
`__isoc23_*@2.38`），于是在**当前所有主流稳定发行版上都无法启动**（Ubuntu 24.04=2.39、
Debian 13=2.41、Fedora 41…），报 `version 'GLIBC_2.43' not found`。

所以本机**发布用**的 Linux 构建放到老发行版（Ubuntu 22.04，glibc 2.35）里做。CEF/Chromium
是构建期直链的**预编译**产物（glibc 2.25，见 `src-tauri/tauri-runtime-cef/README.md`），
V8（`rusty_v8`）与 CEF 都**不重编**；只需把源码挂进 VM、复用 CEF distrib、在隔离的
`CARGO_TARGET_DIR` 里做一次 clean build，产物 glibc 地板即降到 **2.35**，可在
Ubuntu 22.04+/Debian 12+ 上运行。

> 直接在本机快速迭代（`deno task dev` / 只跑 `deno task check`）仍在本机进行；**只有出货用的 `.deb`
> 走 VM**。

> 实测：`release/Kabegame-standard_4.3.0_amd64-glibc2.35.deb`，主程序地板 GLIBC_2.35、
> 零 `__isoc23_*`、无 >2.35 符号。

## 环境总览（一次性搭好，长期复用）

- **VM**：libvirt system session，域名 `ubuntu22.04`，用户 `ubuntu-test`，固定 IP
  `192.168.122.74`（按 MAC 的静态 DHCP 绑定），host 侧 `~/.ssh/config` 别名 `ubuntu22`
  免密登录。规格 8G/6core；`<memoryBacking>` 用 `memfd`+`shared`（virtiofs 前提）。
- **源码共享**：virtiofs（host 装 `virtiofsd`），filesystem 设备 tag `kbg` → source
  `/home/cm/i/kabegame`。**guest 必须挂到与 host 完全相同的路径 `/home/cm/i/kabegame`**
  （见踩坑 3）。源码不复制、留在 sdb4（~120G 空闲）。具体配置见「virtiofs 挂载配置」节。
- **工具链/缓存/target 放共享区**（guest 系统盘仅 ~12G，装不下）：统一在
  `/home/cm/i/kabegame/.vm/`（git 本地忽略，见 `.git/info/exclude`）：
  - `.vm/env.sh`：导出 `CARGO_HOME`/`RUSTUP_HOME`/`BUN_INSTALL`/`CEF_PATH` +
    `CARGO_TARGET_DIR=/home/cm/i/kabegame/target-22` + `LANG=C.UTF-8`。
  - `.vm/cef-prod`：从 host `/home/cm/i/cef-prod` 拷入的**构建用** CEF distrib（含
    `include/`、`libcef_dll/`、`cmake/`、`libcef.so`；仓库内 `bin/linux/` 只是**运行时**
    文件，不能当 `CEF_PATH`）。
  - `.vm/{cargo,rustup,bun}`：rustup stable + bun。
  - `.vm/run-build.sh`：一键构建脚本（见下）。
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
2. **构建 kabegame-cli（release）到 target-22**：`deno task b -c kabegame-cli --release`，
   并 `--version` 自检**能在 guest glibc 2.35 上运行**。cli 是打包 `.kgpg` 的工具，
   主构建的插件打包步骤会调用它（踩坑 4）。
3. **构建主程序 + deb**：`deno task b -c kabegame --release` → `target-22/release/bundle/deb/*.deb`
   （Linux 打包目标仅 `deb`，无 appimage/rpm）。`--release` 触发 **ReleasePlugin**：
   `-C codegen-units=1`、deb 的 libfuse 链接校验、构建后自动把 deb 以规范名
   `Kabegame-<mode>_<ver>_amd64.deb` 复制到共享盘的 `release/`（host 直接可见），
   无需手拷。

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
版本标签**，所以"只扫 `@GLIBC_2.36+` 版本化符号"会漏判！本次
`third/x264-build/libx264.a` 就带 6 处（`base.c`/`ratecontrol.c` 的 `x264_param_parse` 等），
guest（2.35 无此符号名）链接直接 `undefined symbol: __isoc23_sscanf`。
→ **判断预编译 `.a` 能否复用，必须同时扫两类**：版本化 `@GLIBC_2.36+` **和** 新名
`__isoc23_*`（`nm libxxx.a | grep -E '__isoc23|GLIBC_2\.(3[6-9]|4)'`）。
→ 本次 FFmpeg 的 `libav*.a` 是干净的（0 处），只有 **x264** 中招；但因二者一起构建，
直接 `deno task build:ffmpeg` 全量在 guest 重编最省心。`atan2f` 反而是**无版本**的
`*UND*`（最终链接期绑定），本身不阻塞复用——真正阻塞的是 `__isoc23_*`。

**2. 不要复用 host 的 `target/`。** cargo 不会因 glibc 变化而失效，会重用 host 编的
rlib / build-script / `-sys` crate `.o`（其中 C 代码带 `__isoc23_*@2.38`）。必须用**独立
的 `CARGO_TARGET_DIR`**（本项目约定 `target-22`）做 clean build，让所有 `-sys` crate
用 22.04 的头重编。

**3. 预编译产物里烧死的 host 绝对路径。** FFmpeg/x264 的 `.pc` 里
`prefix=/home/cm/i/kabegame/...` 是 host 绝对路径。若 guest 把源码挂在别的路径（如
`/mnt/kbg`），`.pc` 在 guest 解析不到 → 链接找不到 `.a`。**对策：guest 把 virtiofs 挂到
与 host 完全相同的路径 `/home/cm/i/kabegame`**，一次性消除所有此类问题（不止 `.pc`）。

**4. 构建脚本里写死的 `target/release`。** 多处曾用绝对 `ROOT/target` 而非
`CARGO_TARGET_DIR`，导致 target-22 构建时误用旧的 `target/release` 产物。已改为统一从
`CARGO_TARGET_DIR` 取（见"涉及文件"）。其中 `src-crawler-plugins/package-plugin.ts`
最隐蔽：它 `spawn` `target/release/kabegame-cli` 来打包 `.kgpg`——在 guest 上会去跑
**host 那份 glibc 2.43 的 cli**，报 `GLIBC_2.43 not found`。修复 = 该脚本按
`CARGO_TARGET_DIR` 定位 cli + **先把 cli 构建进 target-22**。
同类第二例：`tauri.conf.json.handlebars` 的 bundle files 源路径曾写死
`../../target/release/kabegame-cef-helper`（deb 的 `/usr/lib/kabegame/` 与 macOS 的
`MacOS/`）——VM 构建时把 **host 旧 helper** 打进了包（本次侥幸该 helper 地板只有 2.34
才没炸）。修复 = component-plugin 往模板注入 `targetDir`（= `TARGET_DIR`），模板改用
`{{targetDir}}/release/kabegame-cef-helper`。这份 files-map copy 是 Linux release 唯一
被使用的 helper（`helper_path()` 硬编码 `/usr/lib/kabegame/`）；tauri 自动塞进
`/usr/bin` 的辅助 bin（helper 副本、cef-example）已由 fork patch 0008 收敛为只打包
default-run（见 `third-patches/tauri/README.md`）。

**5. tauri-cli 的 target 归一。** fork 的 `cargo-tauri` 从 `third/tauri` 工作区构建，
其默认 target 是 `third/tauri/target`；但一旦设了全局 `CARGO_TARGET_DIR` 又会被重定向。
统一做法：`TauriCliPlugin` 显式 `--target-dir TARGET_DIR`（优先级高于 env），`BIN_DIR`
随 `TARGET_DIR`，默认 `ROOT/target`。

**6. 无需重编的部分。** CEF `libcef.so`（glibc 2.25）与 `rusty_v8` 预编译静态库
（denoland manylinux 构建）都不带 `__isoc23_*`/高版本符号，**不用重编**——这正是本工作流
"不重编 Chromium/V8"成立的原因。

**7. guest 资源。** 系统盘仅 12G：把 `CARGO_HOME`/`RUSTUP_HOME`/`target-22`/CEF distrib
全放共享区（sdb4）；8G 内存 + 并行 codegen 易 OOM，加 swap 兜底。virtiofs passthrough
按数字 uid 映射（host `cm`=1000=guest `ubuntu-test`=1000），读写以属主身份无缝。

## CARGO_TARGET_DIR 单一来源

`scripts/utils.ts` 的 `TARGET_DIR` 是唯一来源：读 `CARGO_TARGET_DIR`（相对值按 `ROOT`
归一化成绝对路径）并**回写 `process.env.CARGO_TARGET_DIR`**，保证不同 cwd（主构建
cwd=src-tauri、tauri-cli cwd=ROOT）派生的 cargo/tauri 落点一致；缺省 `ROOT/target`。
构建系统一切"找/搬产物"的路径都从这里取。本机在 VM 内构建时设
`CARGO_TARGET_DIR=/home/cm/i/kabegame/target-22`。

## 涉及文件

- `scripts/utils.ts` —— `TARGET_DIR`（单一来源 + env 归一化回写）、`stageResourceBinary`。
- `scripts/build-system.ts` —— macOS run 的 exe 路径。
- `scripts/plugins/os-plugin.ts` —— CEF helper、dokan2.dll 路径。
- `scripts/plugins/release-plugin.ts` —— bundle（deb/dmg/nsis）目录。
- `scripts/plugins/tauri-cli-plugin.ts` —— fork cargo-tauri 显式 `--target-dir`、`BIN_DIR`。
- `scripts/plugins/component-plugin.ts` —— 模板变量 `targetDir`（helper 等 bundle files 源路径）。
- `src-tauri/kabegame/tauri.conf.json.handlebars` —— helper 源路径 `{{targetDir}}/release/...`。
- `src-crawler-plugins/package-plugin.ts` —— 打包 `.kgpg` 的 `CLI_EXE` 按 `CARGO_TARGET_DIR` 定位。
- `scripts/build-ffmpeg.sh` —— x264+FFmpeg 源码构建（Linux `nasm` 可选、asm 保留）。
- `src-tauri/tauri-runtime-cef/README.md`、`../../third-patches/cef/README.md` —— CEF 预编译/直链。
- `.vm/env.sh`、`.vm/run-build.sh` —— VM 内环境与一键构建（git 本地忽略）。
