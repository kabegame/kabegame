# Web 模式发布构建环境
# 仅构建 kabegame web 二进制（axum HTTP 服务器，无 GUI/Tauri 依赖）。
# 比 linux-release.Dockerfile 轻量：不安装 webkit2gtk / GTK / libfuse3 等桌面依赖。

# alinux/alinux3 与服务器（Alibaba Cloud Linux 3）完全一致，glibc 2.28
FROM almalinux:8

ARG BUN_VERSION=1.3.6
ARG RUST_TOOLCHAIN=1.92.0

ENV PATH="/root/.cargo/bin:/root/.bun/bin:${PATH}"

RUN dnf install -y \
    ca-certificates \
    curl \
    git \
    unzip \
    gcc \
    gcc-c++ \
    make \
    pkgconfig \
    openssl-devel \
    && dnf clean all

RUN ln -sf /bin/bash /bash

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    -y \
    --default-toolchain "${RUST_TOOLCHAIN}" \
    --profile minimal

RUN git config --global --add safe.directory '*'

WORKDIR /src

COPY . /src

CMD ["bash", "-l"]
