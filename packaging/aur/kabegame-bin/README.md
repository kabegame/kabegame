# kabegame-bin (AUR)

Arch User Repository packaging files for [`kabegame-bin`](https://aur.archlinux.org/packages/kabegame-bin), repackaged from the official Linux `.deb` GitHub Release.

## 自动发布（GitHub Actions）

仓库提供了 [.github/workflows/aur-publish.yml](../../../.github/workflows/aur-publish.yml)：
- 当发布**非预发布、非草稿**的正式 GitHub Release（`release: [published]`）时自动触发；
- 也支持在 GitHub Actions 页面手动触发（`Actions -> Publish to AUR (kabegame-bin) -> Run workflow`），可指定 `tag`、`pkgrel` 与 `dry_run`（仅校验并输出 diff，不推送）。

### 一次性密钥配置

1. 为 CI 单独生成一对 Ed25519 SSH 密钥（不要设置口令）：
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/aur-kabegame-ci -N "" -C "kabegame-aur-ci"
   ```
2. 登录 [AUR 账号设置](https://aur.archlinux.org/)，把 `~/.ssh/aur-kabegame-ci.pub` 的内容**另起一行追加**到 `SSH 公钥`（保留现有公钥）并保存。
3. 在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions -> Secrets` 新增仓库 Secret：
   - `AUR_SSH_PRIVATE_KEY`：填入 `~/.ssh/aur-kabegame-ci` 私钥全文。
4. （可选）如需修改推送 commit 作者信息，可在 `Actions -> Variables` 中设置 `AUR_GIT_NAME` 和 `AUR_GIT_EMAIL`（默认分别为 `yang208115` 与 `a3305587173@outlook.com`）。

> 注意：请确保 Release 页面下存在名为 `Linux-Kabegame-standard_<版本>_amd64.deb` 的资产；如果仅调整 `depends` 等打包内容（未发新版本），先将修改提交到主仓库的 `packaging/aur/kabegame-bin/`，再手动触发 workflow 并传入对应 `tag` 与递增后的 `pkgrel`。

## 本地手动更新流程

1. 修改 `PKGBUILD` 中的 `pkgver`（如有调整，重置 `pkgrel=1`）。
2. 更新 `sha256sums_x86_64`：
   - 可直接从 GitHub Release 获取 `Linux-Kabegame-standard_<pkgver>_amd64.deb` 的 SHA-256 摘要；或
   - 运行 `updpkgsums`（来自 `pacman-contrib`）自动下载并更新校验和。
3. 在打包目录执行本地构建与检查：
   ```bash
   makepkg -f
   namcap PKGBUILD
   namcap kabegame-bin-*.pkg.tar.zst
   ```
4. 重新生成 `.SRCINFO`：
   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```
5. 同步更新并推送至 AUR 仓库（`master` 分支）：
   ```bash
   git clone ssh://aur@aur.archlinux.org/kabegame-bin.git /tmp/aur-kabegame-bin
   cp PKGBUILD .SRCINFO kabegame-bin.install /tmp/aur-kabegame-bin/
   cd /tmp/aur-kabegame-bin
   git add PKGBUILD .SRCINFO kabegame-bin.install
   git commit -m "Update to <pkgver>"
   git push -u origin master
   ```
