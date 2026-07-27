#!/usr/bin/env bash
set -euo pipefail

# Web 发布构建统一入口：宿主出前端，容器只跑 Rust。
#
# 拆分原因：Apple Silicon 上 docker 的 linux/amd64 模拟层（Rosetta for Linux）
# 存在 V8 浮点缺陷——所有 double 的小数部分被截断为整数（0.96→0、Math.PI→3、
# parseFloat("0.96")→0），sass/rollup/UnoCSS 等跑在 deno/V8 上的 JS 构建全部
# 被静默数值污染（rgba alpha 归零 → 背景全透明、transition 全变 0s、bundle 里
# 97% 的小数字面量丢失），且全程零报错。Rust/C/Go 工具链不受影响（rustc、
# esbuild 的 Go 二进制、rspack 的 SWC 浮点均实测正常）。
# 因此：一切 JS 构建（vite 前端 + 爬虫插件打包）在宿主原生执行；容器只负责
# 以服务器 glibc 基线（almalinux 8）链接 x86_64 Rust 二进制。dist-kabegame/
# 是纯文本静态资源，与构建宿主的架构无关（web 模式下平台 define 全为 false，
# 由 KABEGAME_MODE 驱动而非宿主 OS）。
#
# 用法：
#   bash scripts/build-web.sh            # 日常构建
#   bash scripts/build-web.sh --rebuild  # 先重建镜像（deno.lock/子模块/Dockerfile 变更后）
#
# 产物（均在 .kabegame/release/，见 scripts/utils.ts 的 RELEASE_DIR）：
#   kabegame        x86_64 Linux 单二进制，前端静态资源已编译期嵌入
#   plugins/*.kgpg  爬虫插件（web 不嵌入二进制，部署时单独传到服务器用户数据目录）
# 部署：bash scripts/deploy-web.sh

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker/docker-compose.web-release.yml)

if [[ "${1:-}" == "--rebuild" ]]; then
  echo "==> 重建构建镜像"
  "${COMPOSE[@]}" build
fi

# 1) 宿主原生构建前端（vite → dist-kabegame/）+ 打包爬虫插件。
#    插件打包经 kabegame-cli sidecar（宿主 target/release/），缺失则先构建。
if [[ ! -x target/release/kabegame-cli ]]; then
  echo "==> 宿主 kabegame-cli 缺失，先构建（插件 .kgpg 打包所需）"
  deno task b -c kabegame-cli --release
fi

echo "==> [宿主] 构建 web 前端 dist-kabegame/ + 插件 .kabegame/release/plugins/"
deno task b -c kabegame --mode web --skip cargo

if [[ ! -f dist-kabegame/index.html ]]; then
  echo "Error: dist-kabegame/index.html 不存在，前端构建未产出" >&2
  exit 1
fi
if ! compgen -G ".kabegame/release/plugins/*.kgpg" >/dev/null; then
  echo "Error: .kabegame/release/plugins/ 无 .kgpg，插件打包未产出" >&2
  exit 1
fi

# 2) 容器内只跑 Rust（--skip vue + KABEGAME_SKIP_PLUGIN_PACKAGE=1，见 compose 注释）。
echo "==> [容器] 构建 x86_64 web 二进制"
"${COMPOSE[@]}" run --rm build

echo "==> 完成：.kabegame/release/{kabegame,plugins/}（部署：bash scripts/deploy-web.sh）"
