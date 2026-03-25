# Linux 发布构建环境，与 .github/workflows/release.yml 中 `ubuntu-24.04` job 对齐：
#   Bun 1.3.6、Rust 1.92.0、tauri-cli 2.10.0、同一套 apt 依赖。
#
# 用途：在较新桌面系统（例如 Ubuntu 25.10 + libfuse3 SONAME .4）上本机构建时，可在此镜像内构建，
# 使产物链接的 libfuse3 与 CI 及更多仍带 libfuse3.so.3 的发行版一致。
#
# 构建镜像：
#   docker build -f docker/linux-release.Dockerfile -t kabegame-linux-release:latest .
#
# 在仓库根目录产出 release/（挂载当前源码，需已 git clone --recursive）：
#   docker run --rm -it -v "$PWD:/src:rw" -w /src kabegame-linux-release:latest
#
# 仅进入 shell 自行执行 bun/cargo：
#   docker run --rm -it -v "$PWD:/src:rw" -w /src kabegame-linux-release:latest bash -l

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

# 与 release workflow：`bun b -c cli` → standard → light
CMD ["bash", "-lc", "bun install --frozen-lockfile && bun b -c cli && bun b -c main --mode standard --release && bun b -c main --mode light --release"]
