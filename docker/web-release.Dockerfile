# syntax=docker/dockerfile:1
# Web 模式发布构建环境（多阶段）
# 仅构建 kabegame web 二进制（axum HTTP 服务器，无 GUI/Tauri 依赖）。
#
# 分工（与 docker-compose.web-release.yml 配套；统一入口 scripts/build-web.sh）：
#   镜像构建（本文件）：官方 deno 二进制（仅跑构建编排）+ x264/FFmpeg 静态库
#   （-web 后缀）；源码/依赖不变时全部命中层缓存。
#   compose 运行时只剩 Rust：`deno task b -c kabegame --mode web --release --skip vue`。
#   前端 dist-kabegame/ 与插件打包在宿主完成（build-web.sh）——Apple Silicon 的
#   linux/amd64 模拟层下 V8 浮点损坏（小数截断为整数），容器内不得跑任何 JS 构建；
#   rustc/esbuild(Go)/SWC(Rust) 不受影响。
#
# deno 用官方二进制而非自编（2026-07 起）：
#   容器内 deno 只执行 scripts/run.ts 构建编排——纯 JS 控制流，零小数运算，
#   依赖（commander/tapable/chalk/glob/handlebars）均为纯 JS。因此：
#   - 不再需要 0004 node_modules 后缀补丁（那是给容器内 vite/rollup 等 JS 产物
#     构建做 per-glibc 原生依赖隔离用的；现已无此类构建），官方 deno 在
#     nodeModulesDir=manual 下直接读挂载树的宿主 node_modules；
#   - 旧注释称官方二进制在此基线段错误——实测 deno 2.9.0 于 almalinux 8
#     （glibc 2.28，Rosetta linux/amd64）运行正常，不再成立。
#   注意 V8 浮点缺陷对官方/自编 deno 同等生效（与构建方式无关），编排层经
#   多次完整构建验证不受影响。
#
# 路径契约：ffmpeg-builder 在 /src（=运行时 bind-mount 挂载点）就地构建，使 .pc 烧入的
#   prefix=/src/third/*-build-web/install 在运行时容器里原样有效；产物经 /opt/kabegame/seed
#   由 entrypoint（web-release-entrypoint.sh）rsync 种回挂载的源码树——mode-plugin 会把
#   FFMPEG_PKG_CONFIG_PATH 无条件指向 <repo>/third/FFmpeg-build-web/install/lib/pkgconfig，
#   所以产物必须真实存在于 /src 树内，不能只留在镜像路径。
#
# 前置（宿主）：git submodule update --init third/FFmpeg third/x264
#
# 编译隔离：CARGO_TARGET_DIR=/src/target-web（宿主增量）、KB_BUILD_SUFFIX=-web。
#   almalinux8 与服务器（Alibaba Cloud Linux 3）同 glibc 2.28 基线。

# RUST_TOOLCHAIN 必须 ≥1.95：主 app 链 crates.io deno_crypto 0.266（deno 2.9.0 的
# ext/crypto，用了 if_let_guard）。
ARG RUST_TOOLCHAIN=1.97.0

########## base：系统依赖 + rustup（final 与 ffmpeg-builder 共用） ##########
FROM almalinux:8 AS base
ARG RUST_TOOLCHAIN

RUN dnf install -y \
    epel-release \
    dnf-plugins-core \
 && dnf config-manager --set-enabled powertools \
 && dnf install -y \
    https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm \
 && dnf install -y \
    ca-certificates \
    curl \
    git \
    unzip \
    gcc \
    gcc-c++ \
    make \
    cmake \
    pkgconfig \
    openssl-devel \
    x264-devel \
    nasm \
    clang-devel \
    rsync \
 && dnf clean all

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    -y \
    --default-toolchain "${RUST_TOOLCHAIN}" \
    --profile minimal

# 无 root rust-toolchain.toml：运行时 kabegame 构建直接用上面 default 工具链，零下载。
ENV PATH="/root/.cargo/bin:${PATH}"

RUN git config --global --add safe.directory '*'

WORKDIR /src

########## ffmpeg-builder：x264 + FFmpeg 静态库（-web 后缀，就地 /src 构建） ##########
FROM base AS ffmpeg-builder
ENV KB_BUILD_SUFFIX=-web

COPY scripts/utils.sh scripts/build-ffmpeg.sh /src/scripts/
COPY third/x264 /src/third/x264
COPY third/FFmpeg /src/third/FFmpeg

RUN bash scripts/build-ffmpeg.sh

########## final：工具链 + 官方 deno + 预制产物 + seed entrypoint ##########
FROM base

# 官方 deno（pin 与仓库 third/deno 同版）。理由见文件头"deno 用官方二进制"。
ARG DENO_VERSION=2.9.0
RUN curl -fsSL -o /tmp/deno.zip \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
 && unzip -q /tmp/deno.zip -d /usr/local/bin \
 && rm /tmp/deno.zip \
 && deno --version

# 只带 install 前缀（.pc/头文件/静态库），FFmpeg 编译中间产物不进 final。
COPY --from=ffmpeg-builder /src/third/FFmpeg-build-web/install /opt/kabegame/seed/third/FFmpeg-build-web/install
COPY --from=ffmpeg-builder /src/third/x264-build-web/install /opt/kabegame/seed/third/x264-build-web/install
COPY docker/web-release-entrypoint.sh /usr/local/bin/web-release-entrypoint.sh
RUN chmod +x /usr/local/bin/web-release-entrypoint.sh

# KABEGAME_SKIP_DENO_CLI=1：容器用镜像里的官方 deno，DenoCliPlugin 不做自编刷新。
ENV CARGO_TARGET_DIR="/src/target-web" \
    KB_BUILD_SUFFIX=-web \
    KABEGAME_SKIP_DENO_CLI=1

ENTRYPOINT ["/usr/local/bin/web-release-entrypoint.sh"]
CMD ["bash", "-l"]
