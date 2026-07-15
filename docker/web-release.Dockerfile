# Web 模式发布构建环境
# 仅构建 kabegame web 二进制（axum HTTP 服务器，无 GUI/Tauri 依赖）。
# 比 linux-release.Dockerfile 轻量：不安装 webkit2gtk / GTK / libfuse3 等桌面依赖。
#
# 本镜像**只装工具链**，不烘焙源码：源码树在运行时由 compose bind-mount 到 /src，
# 构建产物落隔离的 CARGO_TARGET_DIR=/src/target-web（在挂载卷上=宿主磁盘，跨 run 增量复用）。
# deno 因 glibc 基线问题必须自编，且镜像内无源码，故自编移到 compose 运行时命令
# （build-deno.sh 是纯 bash+cargo、不依赖 deno，先跑它产出 target-web/release/deno）。

# alinux/alinux3 与服务器（Alibaba Cloud Linux 3）完全一致，glibc 2.28
FROM almalinux:8

ARG RUST_TOOLCHAIN=1.92.0

# 自编 deno 落 /src/target-web/release（compose 运行时 build-deno.sh 产出）；官方 deno 2.9.0
# 二进制的 glibc 基线比 almalinux8(glibc 2.28)新，直接段错误，故必须自编（与 22.04 VM 同理）。
ENV CARGO_TARGET_DIR="/src/target-web"
# 按 glibc 环境隔离 FFmpeg/x264 原生构建目录，避免共享源码树上的产物互相覆盖。
ENV KB_BUILD_SUFFIX=-web
# node_modules 隔离(自编 deno 的 0004 补丁):node_modules 路径在真实 IO 边界重定向到
# node_modules-web。须由容器内 `deno install` 生成,不能从宿主复制。
ENV DENO_NODE_MODULES_SUFFIX=-web
ENV PATH="/root/.cargo/bin:/src/target-web/release:${PATH}"
# deno 由运行时 build-deno.sh 预编，`deno task b` 不再触发 DenoCliPlugin 重编。
ENV KABEGAME_SKIP_DENO_CLI=1

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
    pkgconfig \
    openssl-devel \
    x264-devel \
    nasm \
    clang-devel \
 && dnf clean all

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    -y \
    --default-toolchain "${RUST_TOOLCHAIN}" \
    --profile minimal

RUN git config --global --add safe.directory '*'

WORKDIR /src

CMD ["bash", "-l"]
