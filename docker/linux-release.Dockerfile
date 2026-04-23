# Linux 发布构建环境，与 .github/workflows/release.yml 中 `ubuntu-24.04` job 对齐：
#   Bun 1.3.6、Rust 1.92.0、tauri-cli 2.10.0、同一套 apt 依赖。
#
# 用途：在较新桌面系统（例如 Ubuntu 25.10 + libfuse3 SONAME .4）上本机构建时，可在此镜像内构建，
# 使产物链接的 libfuse3 与 CI 及更多仍带 libfuse3.so.3 的发行版一致。
#
# 本镜像仅包含构建工具链（Bun、Rust、tauri-cli、apt 依赖），不打包源码。
# 源码通过 docker-compose 以 bind mount 方式挂到 /src，这样修改源文件不会使镜像缓存失效，
# 可跨多次构建复用同一镜像；`target/` 与 `node_modules/` 走具名卷，保留 cargo / bun 缓存，
# 避免每次冷启动都重新下载依赖和全量编译。
#
# 使用：
#   ./docker/build-linux-release.sh
#   ./docker/build-linux-release.sh bash -l
#   docker build -f docker/linux-release.Dockerfile -t kabegame-linux-release:latest .
#   LINUX_RELEASE_DOCKER_IT=0 ./docker/build-linux-release.sh

FROM ubuntu:24.04

ARG BUN_VERSION=1.3.6
ARG RUST_TOOLCHAIN=1.92.0
ARG TAURI_CLI_VERSION=2.10.0
# 默认走清华镜像；如需改成阿里/中科大/官方源，build 时传：
#   --build-arg APT_MIRROR=https://mirrors.aliyun.com/ubuntu
#   --build-arg APT_MIRROR=http://archive.ubuntu.com/ubuntu
ARG APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/ubuntu

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/root/.cargo/bin:/root/.bun/bin:${PATH}"

# 换源（Ubuntu 24.04 使用 deb822 格式 /etc/apt/sources.list.d/ubuntu.sources）
# 直接重写整个文件，避免 sed 转义坑
RUN printf '%s\n' \
        'Types: deb' \
        "URIs: ${APT_MIRROR}" \
        'Suites: noble noble-updates noble-backports' \
        'Components: main restricted universe multiverse' \
        'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
        '' \
        'Types: deb' \
        "URIs: ${APT_MIRROR}" \
        'Suites: noble-security' \
        'Components: main restricted universe multiverse' \
        'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
    > /etc/apt/sources.list.d/ubuntu.sources \
 && cat /etc/apt/sources.list.d/ubuntu.sources

# 全局重试/超时配置，对后续所有 apt-get 生效
RUN printf '%s\n' \
    'Acquire::Retries "5";' \
    'Acquire::http::Timeout "60";' \
    'Acquire::https::Timeout "60";' \
    'Acquire::http::Pipeline-Depth "0";' \
    > /etc/apt/apt.conf.d/80-retries

# 第 1 组：update 必须与 install 在同一层，防止 Docker 缓存 stale 的索引
# （Docker 官方规范：apt-get update && apt-get install 永远写在同一个 RUN）
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        unzip \
        file \
        build-essential \
        pkg-config \
        patchelf \
        libssl-dev

# 第 2 组：GTK / WebKit 栈（Tauri 主体依赖，体量最大，单独成层最有价值）
RUN apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libsoup-3.0-dev \
        librsvg2-dev \
        webkit2gtk-driver \
        libayatana-appindicator3-dev

# 第 3 组：其他运行/测试依赖
RUN apt-get install -y --no-install-recommends \
        xvfb \
        libxdo-dev \
        libfuse3-dev

# 最后清理 apt 列表，缩小最终镜像
RUN rm -rf /var/lib/apt/lists/*

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

# /src 由运行时 bind mount 提供，镜像本身不携带源码
CMD ["bash", "-l"]