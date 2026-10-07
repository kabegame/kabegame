#!/usr/bin/env bash
# 构建并打包插件到 dev 插件目录。
#   deploy.sh <plugin-id> [--release]
#   CLI 默认 dev 版 target/debug/kabegame-cli；--release 或 KB_CLI_PROFILE=release 切到 target/release。
# 产物：.kabegame/debug/data/plugins-directory/<id>.kgpg
#   - dev app 直接读这个目录（app-run.sh 会 refresh_plugins）
#   - run-cli.sh 从这里取 .kgpg，import 到生产目录后再 plugin run
#
# 走 src-crawler-plugins/package-plugin.ts：它先构建 plugin-sdk（dist 过期时）与插件的
# scripts.build，再经 KABEGAME_CLI 调所选 profile 的 kabegame-cli plugin pack。
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ID="${1:?用法: deploy.sh <plugin-id> [--release]}"
[ "${2:-}" = --release ] && KB_CLI_PROFILE=release
PROFILE="${KB_CLI_PROFILE:-debug}"
DEST_DIR="$ROOT/.kabegame/debug/data/plugins-directory"

[ -d "$ROOT/src-crawler-plugins/plugins/$ID" ] || { echo "✗ 插件目录不存在: src-crawler-plugins/plugins/$ID" >&2; exit 1; }
export KABEGAME_CLI="$ROOT/target/$PROFILE/kabegame-cli"
if [ ! -x "$KABEGAME_CLI" ]; then
  [ "$PROFILE" = release ] && hint="deno task b -c kabegame-cli --release" || hint="deno task b -c kabegame-cli"
  echo "✗ 缺少 $PROFILE CLI —— 请用户在仓库根执行 $hint" >&2; exit 1
fi

before=$(stat -f %m "$DEST_DIR/$ID.kgpg" 2>/dev/null || echo 0)
deno task --cwd "$ROOT/src-crawler-plugins" package "$ID" --out-dir "$DEST_DIR" 2>&1 | grep -E "✅|❌|rror" || true
after=$(stat -f %m "$DEST_DIR/$ID.kgpg" 2>/dev/null || echo 0)
[ "$after" != "$before" ] || { echo "✗ 打包失败（.kgpg 未更新），去掉 grep 重跑看完整输出" >&2; exit 1; }
echo "✓ 已打包 → $DEST_DIR/$ID.kgpg"
