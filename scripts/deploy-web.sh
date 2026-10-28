#!/usr/bin/env bash
set -euo pipefail

# 部署在线 Demo（--mode web 的 Rust 二进制 + 爬虫插件）。
# Demo 现在对外走 demo.kabegame.com（原 kabegame.com 已改为文档站，见 deploy-docs.sh）。
# 域名切换在 NPM(Nginx Proxy Manager)面板手动维护；本机 systemd 服务名与端口(127.0.0.1:7490)不变。
#
# 三段式上传（先静态资源、再插件、后二进制）：
#   0. 前端静态资源 → OSS 挂载目录 /mnt/oss/web/（即 https://cdn.kabegame.com/web/）。
#      生产 web 构建的 base 指向该 CDN（apps/kabegame/vite.config.ts），二进制只负责返回
#      index.html；新二进制上线前资源必须已在 OSS，否则页面引用的 chunk 会 404。
#      先 rsync 到服务器本地暂存目录，再在服务器上 cp 进挂载点：ossfs2 按写入时的文件名
#      决定 Content-Type，rsync 直写挂载点会先写无扩展名的临时文件再改名，JS 被标成
#      application/octet-stream、浏览器拒绝执行；--inplace 又因 ossfs2 不支持 ftruncate 失败。
#      只增不删：已打开旧页面的用户还会按需加载旧版本 chunk。
#   1. 插件 .kgpg → 服务器**用户数据目录** plugins-directory/（与插件商店无关；
#      web 二进制不像桌面安装包那样内嵌 resources/plugins，服务端插件完全由该目录提供）。
#      服务运行中上传是安全的：插件在进程启动时加载，此刻还没读；这样能把停机窗口
#      压缩到只覆盖二进制那几秒。仅覆盖同名文件，不删除服务器上已有的其它插件。
#   2. 停服务 → 上传二进制 → 启动服务。
#
# 前置：deno task build:web（产出 .kabegame/release/{kabegame,plugins/}）
#
# /rpc 接口埋点由服务器上的 systemd drop-in（kabegame.service.d/umami.conf）里的
# KABEGAME_UMAMI_* 环境变量开启，本脚本不改它；见 cocs/web/RPC_TRACKING.md。

REMOTE_HOST="cmtheit.com"
REMOTE_USER="cmtheit"
REMOTE_DIR="/home/${REMOTE_USER}/kabegame"
# 服务器 systemd 以 User=cmtheit 运行，AppPaths 的 data_dir = dirs::data_local_dir()/Kabegame
REMOTE_PLUGINS_DIR="/home/${REMOTE_USER}/.local/share/Kabegame/plugins-directory"
SERVICE_NAME="kabegame"

RELEASE_DIR=".kabegame/release"
LOCAL_BIN="${RELEASE_DIR}/kabegame"
LOCAL_PLUGINS="${RELEASE_DIR}/plugins"
LOCAL_WEB_DIST="dist-kabegame-web"
REMOTE_WEB_STAGING="${REMOTE_DIR}/web-dist"
REMOTE_OSS_WEB_DIR="/mnt/oss/web"
CDN_WEB_BASE="https://cdn.kabegame.com/web/"

cd "$(dirname "$0")/.."

if [[ ! -f "${LOCAL_BIN}" ]]; then
  echo "Error: ${LOCAL_BIN} not found. Build it first: deno task build:web" >&2
  exit 1
fi
if [[ ! -f "${LOCAL_WEB_DIST}/index.html" ]]; then
  echo "Error: ${LOCAL_WEB_DIST}/index.html not found. Build it first: deno task build:web" >&2
  exit 1
fi
# build:web 先出前端再编二进制；前端比二进制新说明之后单独重出过前端，
# 上传的资源会与二进制内嵌的 index.html 对不上
if [[ "${LOCAL_WEB_DIST}/index.html" -nt "${LOCAL_BIN}" ]]; then
  echo "Error: ${LOCAL_WEB_DIST}/ is newer than ${LOCAL_BIN}; rerun deno task build:web" >&2
  exit 1
fi
ENTRY_JS=$(grep -oE "${CDN_WEB_BASE}assets/index-[^\"]+\.js" "${LOCAL_WEB_DIST}/index.html" | head -n 1 || true)
if [[ -z "${ENTRY_JS}" ]]; then
  echo "Error: ${LOCAL_WEB_DIST}/index.html does not load scripts from ${CDN_WEB_BASE}" >&2
  exit 1
fi

SSH_TARGET="${REMOTE_USER}@${REMOTE_HOST}"

# 0) 前端静态资源 → OSS（服务仍在运行，无停机）
echo "==> Uploading web static assets to ${REMOTE_HOST}:${REMOTE_OSS_WEB_DIR}/"
rsync -rt --delete --exclude=/index.html "${LOCAL_WEB_DIST}/" "${SSH_TARGET}:${REMOTE_WEB_STAGING}/"
ssh "${SSH_TARGET}" "mkdir -p '${REMOTE_OSS_WEB_DIR}' && cp -r '${REMOTE_WEB_STAGING}/.' '${REMOTE_OSS_WEB_DIR}/'"
ENTRY_TYPE=$(curl -fsSI "${ENTRY_JS}" | tr -d '\r' | awk -F': ' 'tolower($1) == "content-type" { print $2 }' || true)
if [[ "${ENTRY_TYPE}" != *javascript* ]]; then
  echo "Error: ${ENTRY_JS} served as '${ENTRY_TYPE}', not JavaScript; aborting before touching the service" >&2
  exit 1
fi

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
