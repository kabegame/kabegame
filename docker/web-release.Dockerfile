# syntax=docker/dockerfile:1
# Web 模式发布构建环境（多阶段）
# 仅构建 kabegame web 二进制（axum HTTP 服务器，无 GUI/Tauri 依赖）。
#
# 分工（与 docker-compose.web-release.yml 配套）：
#   镜像构建（本文件）承担全部准备步骤——自编 deno（含 0004 node_modules 后缀补丁）、
#   x264+FFmpeg 静态库、`deno install` 出 node_modules-web 种子；源码/依赖不变时全部命中层缓存。
#   compose 运行时只剩最后一步 `deno task b -c kabegame --mode web`。
#
# 路径契约：ffmpeg-builder 在 /src（=运行时 bind-mount 挂载点）就地构建，使 .pc 烧入的
#   prefix=/src/third/*-build-web/install 在运行时容器里原样有效；产物经 /opt/kabegame/seed
#   由 entrypoint（web-release-entrypoint.sh）rsync 种回挂载的源码树——mode-plugin 会把
#   FFMPEG_PKG_CONFIG_PATH 无条件指向 <repo>/third/FFmpeg-build-web/install/lib/pkgconfig，
#   所以产物必须真实存在于 /src 树内，不能只留在镜像路径。
#
# 前置（宿主）：git submodule update --init third/deno third/FFmpeg third/x264
#   且 third/deno 已应用补丁（deno task patch deno）——COPY 的是宿主工作树。
#
# 编译隔离：CARGO_TARGET_DIR=/src/target-web（宿主增量）、DENO_NODE_MODULES_SUFFIX=-web、
#   KB_BUILD_SUFFIX=-web。almalinux8 与服务器（Alibaba Cloud Linux 3）同 glibc 2.28 基线；
#   官方 deno 2.9.0 二进制 glibc 基线更新、在此段错误，故必须自编。

ARG RUST_TOOLCHAIN=1.97.0

########## base：系统依赖 + rustup（final 与各 builder 共用） ##########
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

########## deno-builder：自编 deno CLI（third/deno pin v2.9.0 + kabegame 补丁） ##########
FROM base AS deno-builder

COPY scripts/utils.sh scripts/build-deno.sh /src/scripts/
COPY third/deno /src/third/deno

# build-deno.sh 会 cd 进 third/deno 再跑 cargo，故 deno 用自带的 rust-toolchain.toml
# （1.95.0，支持 deno_crypto 的 if_let_guard）构建，rustup 本阶段自动装，不进 final。
# 注：final 运行时编译主 app 用的是 base 默认工具链（RUST_TOOLCHAIN）——它链 crates.io
# deno_crypto 0.266（即 deno 2.9.0 的 ext/crypto，同样用了 if_let_guard），故 RUST_TOOLCHAIN 必须 ≥1.95。
# deno 的 cargo target（>10GB）用完即弃，只留二进制。
RUN CARGO_TARGET_DIR=/tmp/deno-target bash scripts/build-deno.sh \
 && install -m 755 /tmp/deno-target/release/deno /usr/local/bin/deno \
 && rm -rf /tmp/deno-target

########## ffmpeg-builder：x264 + FFmpeg 静态库（-web 后缀，就地 /src 构建） ##########
FROM base AS ffmpeg-builder
ENV KB_BUILD_SUFFIX=-web

COPY scripts/utils.sh scripts/build-ffmpeg.sh /src/scripts/
COPY third/x264 /src/third/x264
COPY third/FFmpeg /src/third/FFmpeg

RUN bash scripts/build-ffmpeg.sh

########## nm-builder：deno install 出 node_modules-web 种子（只 COPY 清单，依赖不变则缓存） ##########
FROM base AS nm-builder
COPY --from=deno-builder /usr/local/bin/deno /usr/local/bin/deno
ENV DENO_DIR=/opt/kabegame/deno-dir \
    DENO_NODE_MODULES_SUFFIX=-web

# 与根 package.json 的 workspaces 一一对应；新增 workspace 时需在此补一行。
COPY package.json deno.json deno.lock /src/
COPY apps/kabegame/package.json /src/apps/kabegame/
COPY apps/docs/package.json /src/apps/docs/
COPY packages/kabegame-core/package.json /src/packages/kabegame-core/
COPY packages/kabegame-i18n/package.json /src/packages/kabegame-i18n/
COPY packages/kabegame-plugin-sdk/package.json /src/packages/kabegame-plugin-sdk/
COPY packages/kabegame-types/package.json /src/packages/kabegame-types/
COPY packages/photoswipe-vue/package.json /src/packages/photoswipe-vue/
COPY src-tauri-plugins/tauri-plugin-picker/package.json /src/src-tauri-plugins/tauri-plugin-picker/
COPY src-tauri-plugins/tauri-plugin-share/package.json /src/src-tauri-plugins/tauri-plugin-share/

# 0004 补丁：node_modules 路径在真实 IO 边界重定向到 node_modules-web，
# 嵌套目录物理带后缀——必须由带该变量的 deno install 生成，不能从宿主树复制。
# 装完把所有 node_modules-web 树收进 /opt/kabegame/seed（含清单），供 final/entrypoint 消费。
RUN deno install --frozen \
 && mkdir -p /opt/kabegame/seed \
 && find . -maxdepth 4 -type d -name 'node_modules-web' -not -path '*/node_modules-web/*' \
      | sed 's|^\./||' > /opt/kabegame/seed/nm-list.txt \
 && while IFS= read -r rel; do \
      mkdir -p "/opt/kabegame/seed/$(dirname "$rel")"; \
      cp -a "/src/$rel" "/opt/kabegame/seed/$rel"; \
    done < /opt/kabegame/seed/nm-list.txt \
 && cp deno.lock /opt/kabegame/seed/deno.lock

########## final：工具链 + 预制产物 + seed entrypoint ##########
FROM base

COPY --from=deno-builder /usr/local/bin/deno /usr/local/bin/deno
# 只带 install 前缀（.pc/头文件/静态库），FFmpeg 编译中间产物不进 final。
COPY --from=ffmpeg-builder /src/third/FFmpeg-build-web/install /opt/kabegame/seed/third/FFmpeg-build-web/install
COPY --from=ffmpeg-builder /src/third/x264-build-web/install /opt/kabegame/seed/third/x264-build-web/install
COPY --from=nm-builder /opt/kabegame/seed /opt/kabegame/seed
COPY --from=nm-builder /opt/kabegame/deno-dir /opt/kabegame/deno-dir
COPY docker/web-release-entrypoint.sh /usr/local/bin/web-release-entrypoint.sh
RUN chmod +x /usr/local/bin/web-release-entrypoint.sh

# 注意 PATH 不再前置 /src/target-web/release：deno 权威来源是镜像 /usr/local/bin/deno
# （带补丁、与种子一致），避免宿主残留的旧自编 deno 遮蔽它。
# KABEGAME_SKIP_DENO_CLI=1：deno 已预编进镜像，DenoCliPlugin 不再重编。
ENV CARGO_TARGET_DIR="/src/target-web" \
    KB_BUILD_SUFFIX=-web \
    DENO_NODE_MODULES_SUFFIX=-web \
    DENO_DIR=/opt/kabegame/deno-dir \
    KABEGAME_SKIP_DENO_CLI=1

ENTRYPOINT ["/usr/local/bin/web-release-entrypoint.sh"]
CMD ["bash", "-l"]
