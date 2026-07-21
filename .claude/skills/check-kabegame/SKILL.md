---
name: check-kabegame
description: 校验 Kabegame 的改动是否编译/类型通过 —— 跑 vue-tsc + cargo check（deno task check -c kabegame）并汇总错误。改完 Rust 或 Vue/TS 代码后想 check / verify / typecheck / 验证改动 / 看有没有编译错误时使用。不要用 cargo build / tauri build / deno task b 来验证。
---

# check-kabegame

Kabegame 的**唯一正规校验入口**。`deno task check` 会先注入 `CEF_PATH`、FFmpeg
`pkgconfig`、V8、NDK 等一大堆环境变量（由 `scripts/plugins/*.ts` 完成），再跑
`vue-tsc` 和 `cargo check`。**直接手敲 `cargo check` 会因缺这些环境变量而失败。**

本 skill 的驱动是 `.claude/skills/check-kabegame/driver.sh`：包装上面那条命令，
把日志落盘并把错误摘出来，省得在几百行 warning 里翻。

规则来源：`.cursor/rules/verify-by-lint.mdc`。**不要用 `cargo build` /
`tauri build` / `deno task b` 来验证改动** —— 慢，而且不产生额外信息。

下面所有路径都相对仓库根 `/Volumes/KIOXIA/kabegame`（脚本自己会 cd 过去，从任意
子目录调用都行）。

## 前置

`deno`（2.9.x）在 PATH 里即可；其余（cargo/CEF/FFmpeg）由 `deno task check` 自行准备。
新 checkout 首次需要 `deno install && deno task prepare`。

## 用法（agent 路径）

```bash
# 全量：vue-tsc + cargo check（改动同时涉及前后端时用这个）
.claude/skills/check-kabegame/driver.sh

# 只查 Rust（改了 src-tauri/ 时用，省掉前端那一趟）
.claude/skills/check-kabegame/driver.sh --skip vue

# 只查前端类型（改了 apps/ 或 packages/ 时用，最快，秒级）
.claude/skills/check-kabegame/driver.sh --skip cargo

# Android 交叉检查（cargo check --target aarch64-linux-android）——需额外前置，见 Gotchas
.claude/skills/check-kabegame/driver.sh --mode android --skip vue

# 换组件
.claude/skills/check-kabegame/driver.sh -c kabegame-cli
```

不给 `-c` 时默认补 `-c kabegame`；其余参数原样透传给 `deno task check`。

**输出**：末尾固定一段汇总，只需要看它——

```
======== check 汇总 ========
耗时      : 29s
退出码    : 0
vue-tsc   : 0 个 error
cargo     : 0 个 error
结果      : 通过 ✅（warning 不影响退出码）
===========================
```

失败时汇总下面会附最多 40 条错误行（带日志行号），完整上下文在
`.kabegame/debug/check/check-<时间戳>.log`（该目录已 gitignore）。实测失败长这样：

```
退出码    : 101
cargo     : 1 个 error

-------- 错误摘要 --------
362:error[E0308]: mismatched types
428:error: could not compile `kabegame` (lib) due to 1 previous error; 34 warnings emitted
```

## 用法（人工路径）

等价的裸命令，没有汇总、没有日志：

```bash
deno task check -c kabegame
deno task check -c kabegame --skip cargo
```

## Gotchas

- **仓库里有一堆 warning 是常态**，实测干净树上 `kabegame` lib 报 46 个、
  `kabegame-core` 报 16 个 warning，退出码仍是 0。**只看汇总里的 error 数和退出码**，
  别把 warning 当成自己改坏了。
- **退出码不是 1**：vue-tsc 失败退 `2`，cargo 失败退 `101`。判断成败请用
  `!= 0`，别写死 `== 1`。
- **app 在跑的时候 cargo check 会炸**：`cef-dll-sys` 的 build script 要往 `target/`
  复制 CEF 运行时，被占用时报 `os error 32`（Windows）/ `Text file busy`。driver
  会先 `pgrep` 检测并在 stderr 告警，但不会替你杀进程——自己退出 app，或先用
  `--skip cargo`。
- **首次/大改后的 cargo check 很慢**（要编 `bindgen`、`cef-dll-sys`、`kabegame-core`）。
  增量情况下实测 ~30s；冷缓存要几分钟起，别当卡死。
- `cargo check` 会顺带打印一条 `failed to auto-clean cache data ... Permission denied
  (os error 13)`（`~/.cargo/registry` 权限）。是噪音，不影响结果。
- **`--skip` 只接受一个值**，写两次不报错而是**后者覆盖前者**：
  `--skip vue --skip cargo` 实测跑了 vue-tsc、跳了 cargo。别指望它俩都跳。
- **`--mode android` 在多数机器上直接失败**，实测报
  `error: Uncaught (in promise) Error: rusty_v8 Android 自建产物缺失: bin/android/`。
  它需要 `bin/android/` 的 rusty_v8 自建产物（只能在 x86_64 Linux 上产出）+
  `deno task build:ffmpeg --target android` + NDK。默认别跑它，除非改动确实只影响
  Android 且环境已备齐。见 `cocs/crawler/V8_RUNTIME.md`。
- 日志带 ANSI 颜色码，driver 内部已 `sed` 剥除后再 grep；如果自己写脚本解析该日志，
  记得同样处理。

## Troubleshooting

| 症状 | 处理 |
|---|---|
| `deno task check` 报缺 `-c` | driver 会自动补 `-c kabegame`；裸命令必须显式给 |
| cargo 报 `os error 32` / `Text file busy` | 有 kabegame 实例在跑，退出后重试 |
| `rusty_v8 Android 自建产物缺失: bin/android/` | `--mode android` 前置没备齐，见上面 Gotchas；桌面改动直接去掉 `--mode android` |
| `failed to auto-clean cache data ... os error 13` | 噪音，忽略 |
