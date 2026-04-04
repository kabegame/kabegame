# Linux 发布构建环境，与 .github/workflows/release.yml 中 `ubuntu-24.04` job 对齐：
#   Bun 1.3.6、Rust 1.92.0、tauri-cli 2.10.0、同一套 apt 依赖。
#
# 用途：在较新桌面系统（例如 Ubuntu 25.10 + libfuse3 SONAME .4）上本机构建时，可在此镜像内构建，
# 使产物链接的 libfuse3 与 CI 及更多仍带 libfuse3.so.3 的发行版一致。
#
# 构建时将仓库上下文复制到 /src（需已 git clone；子模块请在宿主机 checkout 后再 docker build）。
# 默认 CMD：在镜像内 /src 上跑完整 Linux 发布构建（见文末 CMD）；运行时不挂载宿主机。
#
# 构建镜像并执行默认 CMD（或覆盖命令）：
#   ./docker/build-linux-release.sh
#   ./docker/build-linux-release.sh bash -l
#   docker build -f docker/linux-release.Dockerfile -t kabegame-linux-release:latest .
#   LINUX_RELEASE_DOCKER_IT=0 ./docker/build-linux-release.sh

FROM ubuntu:24.04

ARG BUN_VERSION=1.3.6
ARG RUST_TOOLCHAIN=1.92.0
ARG TAURI_CLI_VERSION=2.10.0

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/root/.cargo/bin:/root/.bun/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    unzip \
    libwebkit2gtk-4.1-dev \
    build-essential \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    webkit2gtk-driver \
    xvfb \
    libgtk-3-dev \
    libsoup-3.0-dev \
    patchelf \
    libfuse3-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Bun 在子进程里可能 posix_spawn("/bash", …)；系统只有 /bin/bash，缺 /bash 会报 EBADF。
RUN ln -sf /bin/bash /bash

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    -y \
    --default-toolchain "${RUST_TOOLCHAIN}" \
    --profile minimal

RUN cargo install tauri-cli --version "${TAURI_CLI_VERSION}"

RUN git config --global --add safe.directory '*'

WORKDIR /src

COPY . /src

CMD ["bash", "-l"]