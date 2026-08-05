#!/usr/bin/env bash
set -euo pipefail

# 部署在线 Demo（--mode web 的 Rust 二进制 + 爬虫插件）。
# Demo 现在对外走 demo.kabegame.com（原 kabegame.com 已改为文档站，见 deploy-docs.sh）。
# 域名切换在 NPM(Nginx Proxy Manager)面板手动维护；本机 systemd 服务名与端口(127.0.0.1:7490)不变。
#
# 两段式上传（先插件、后二进制）：
#   1. 插件 .kgpg → 服务器**用户数据目录** plugins-directory/（与插件商店无关；
#      web 二进制不像桌面安装包那样内嵌 resources/plugins，服务端插件完全由该目录提供）。
#      服务运行中上传是安全的：插件在进程启动时加载，此刻还没读；这样能把停机窗口
#      压缩到只覆盖二进制那几秒。仅覆盖同名文件，不删除服务器上已有的其它插件。
#   2. 停服务 → 上传二进制 → 启动服务。
#
# 前置：deno task build:web（产出 .kabegame/release/{kabegame,plugins/}）

REMOTE_HOST="cmtheit.com"
REMOTE_USER="cmtheit"
REMOTE_DIR="/home/${REMOTE_USER}/kabegame"
# 服务器 systemd 以 User=cmtheit 运行，AppPaths 的 data_dir = dirs::data_local_dir()/Kabegame
REMOTE_PLUGINS_DIR="/home/${REMOTE_USER}/.local/share/Kabegame/plugins-directory"
SERVICE_NAME="kabegame"

RELEASE_DIR=".kabegame/release"
LOCAL_BIN="${RELEASE_DIR}/kabegame"
LOCAL_PLUGINS="${RELEASE_DIR}/plugins"

cd "$(dirname "$0")/.."

if [[ ! -f "${LOCAL_BIN}" ]]; then
  echo "Error: ${LOCAL_BIN} not found. Build it first: deno task build:web" >&2
  exit 1
fi

SSH_TARGET="${REMOTE_USER}@${REMOTE_HOST}"

# 1) 插件（服务仍在运行，无停机）
if compgen -G "${LOCAL_PLUGINS}/*.kgpg" >/dev/null; then
  count=$(ls -1 "${LOCAL_PLUGINS}"/*.kgpg | wc -l | tr -d ' ')
  echo "==> Uploading ${count} plugin(s) to ${REMOTE_HOST}:${REMOTE_PLUGINS_DIR}/"
  ssh "${SSH_TARGET}" "mkdir -p '${REMOTE_PLUGINS_DIR}'"
  scp "${LOCAL_PLUGINS}"/*.kgpg "${SSH_TARGET}:${REMOTE_PLUGINS_DIR}/"
else
  echo "==> No plugins in ${LOCAL_PLUGINS}/, skipping plugin upload"
fi

# 2) 二进制（停机窗口仅覆盖此段）
echo "==> Stopping ${SERVICE_NAME} on ${REMOTE_HOST}"
ssh "${SSH_TARGET}" "sudo systemctl stop ${SERVICE_NAME}"

echo "==> Uploading ${LOCAL_BIN} to ${REMOTE_HOST}:${REMOTE_DIR}/"
scp "${LOCAL_BIN}" "${SSH_TARGET}:${REMOTE_DIR}/"

echo "==> Setting executable permission"
ssh "${SSH_TARGET}" "chmod +x ${REMOTE_DIR}/kabegame"

echo "==> Starting ${SERVICE_NAME} on ${REMOTE_HOST}"
ssh "${SSH_TARGET}" "sudo systemctl start ${SERVICE_NAME}"

echo "==> Done"
