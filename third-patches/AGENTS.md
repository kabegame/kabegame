# AGENTS.md

本文件适用于 `third-patches/**`。

## 第三方补丁序列

Kabegame 对 vendored `third/` 仓库的改动应放在对应的
`third-patches/<dir>/NNNN-*.patch` 文件中。对于由补丁管理器管理的仓库，
`deno task patch <dir>` 会将子模块重置到干净的锁定基线，然后按文件名排序应用完整补丁序列；
`deno task patch <dir> -r` 会执行重置，但不应用补丁。因为每次操作都从基线开始，所以可以修改、
删除或重新编号补丁文件。`--check` 会在一次性 worktree 中预检按顺序排列的补丁序列

`rusty_v8` 是唯一的手动例外：它是原地复用的大型构建树，补丁由 `scripts/build-v8.ts` 应用。
`cef` 也由 patch-manager 管理，正式补丁位于 `third-patches/cef/*.patch`，通过
`deno task patch cef` 应用到 `third/cef`。`automate-git.py` 只认可提交，因此
`scripts/build-chromium.ts` 会在构建前把已经应用补丁的 worktree 临时固化为 `kabegame-build` 分支上的提交；
这个临时提交只是构建桥接，不是补丁来源，`third/cef` 的 gitlink 仍指向官方上游锁定点。

## 工作流（reset 模型）

- **patch 文件可以自由修改、删除、重新编号。** 曾经的“追加式原则”已废除——它存在的唯一理由是旧的
  `--from N` 重同步要靠“磁盘上的前缀 patch 与已应用内容逐字节一致”才能逆向回滚。
- `deno task patch <dir>` = `git reset --hard`（回到子模块当前 HEAD 的纯净基线，并清掉系列会新建的文件）
  + 依次 `git apply` 整个系列。重复执行结果一致；中途失败会 reset 回纯净基线，不留半套状态。
- `deno task patch <dir> -r` = 仅 reset。不需要逆序 `apply -R`，因此也不要求 patch 与已应用内容一致。
- `deno task patch <dir> --check` = 在一次性 worktree 里链式预检，不动真实工作区。改完 patch 后跑它验证，
  并同步 `third-patches/<dir>/README.md` 与相关 cocs 文档。
- **代价**：reset 会丢弃子模块工作区里的一切未提交改动。要在 `third/` 下做本地开发，先 commit 到
  子模块分支上（reset 目标是子模块 HEAD，提交不会丢）。
- 生成新 patch 的工法：在已套用全系列的工作树上 `git -C third/<dir> add -A` 把当前状态存入 index，
  改完源码后 `git diff` 即为新 patch 内容，最后 `git reset` 恢复。
- **`rusty_v8` 不由 patch-manager 接管**（见 `scripts/patch-manager.ts` 的 `MANUAL_REPOS`）：它是就地复用的
  胖构建树（嵌套子模块 + 几十 GB 编译产物），reset 代价过大；patch 由 `scripts/build-v8.ts` 在构建流程里
  幂等应用。
- **`cef` 有正式补丁序列，并由 patch-manager 接管。** `third-patches/cef/*.patch` 通过
  `deno task patch cef` 应用到 `third/cef`；`automate-git.py` 只认提交、不看工作区，因此
  `scripts/build-chromium.ts` 的 `stageCefPatchesAsCommit()` 会在构建前把已应用补丁的状态临时固化成
  `kabegame-build` 分支上的提交。这个提交只是交给构建流程消费的桥接产物，**不需要**人工维护 fork 分支；
  补丁的唯一来源仍是 `third-patches/cef/`，`third/cef` 的 gitlink 始终指向官方上游 pin。
