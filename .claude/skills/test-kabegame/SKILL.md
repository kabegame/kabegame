---
name: test-kabegame
description: 跑 Kabegame 后端 Rust 测试（cargo test，经 deno task test 自动注入 FFmpeg/CEF 环境）并汇总结果。想 test / 跑测试 / 验证某个 crate 的单测或集成测试（kabegame | kabegame-core | kabegame-cli）时使用。前端没有测试；不要手敲裸 cargo test。
---

# test-kabegame

Kabegame 后端测试的统一入口。`deno task test` 会先注入 `FFMPEG_PKG_CONFIG_PATH`、
`BINDGEN_EXTRA_CLANG_ARGS`、`CEF_PATH`（仅 `-c kabegame`）等环境变量再跑
`cargo test -p <crate>`。**直接手敲 `cargo test` 会因缺这些环境变量而编译失败**
（rsmpeg/bindgen 找不到 FFmpeg 头文件）。前端没有测试，本 skill 只管 Rust。

驱动是 `.claude/skills/test-kabegame/driver.sh`：选 crate、把剩余参数
**自动加上 `--`** 传给 cargo test（不用自己写 `--`）、日志落盘、
从几百行 warning 里摘出 passed/failed 汇总。

下面所有路径都相对仓库根 `/Volumes/KIOXIA/kabegame`（脚本自己会 cd 过去，从任意
子目录调用都行）。

## 前置

`deno`（2.9.x）在 PATH 里即可；其余由 `deno task test` 自行准备。
新 checkout 首次需要 `deno install && deno task prepare`。

## 用法（agent 路径）

```bash
# kabegame-core 的 lib 单测，按名过滤（最常用；第一参数是 crate，可省略默认 kabegame-core）
.claude/skills/test-kabegame/driver.sh kabegame-core --lib kgpg

# kabegame-core 的集成测试 target（tests/ 下目前只有 dsl_e2e）
.claude/skills/test-kabegame/driver.sh kabegame-core --test dsl_e2e

# kabegame-cli 全部测试
.claude/skills/test-kabegame/driver.sh kabegame-cli

# 主 app crate（链 CEF，编译最重）：按名过滤
.claude/skills/test-kabegame/driver.sh kabegame rotator

# 需要看 println 输出时，再带一个 -- 透传给测试二进制
.claude/skills/test-kabegame/driver.sh kabegame-core --lib kgpg -- --nocapture
```

第一个参数若是 `kabegame | kabegame-cli | kabegame-core` 则选中该 crate，否则默认
`kabegame-core`；其余参数原样交给 cargo test（测试名过滤、`--lib`、`--test <target>`
都行），driver 负责补 `--`。

**输出**：末尾固定一段汇总，只需要看它——

```
======== test 汇总 ========
crate     : kabegame-core
耗时      : 198s
退出码    : 0
编译 error: 0 个
测试      : 2 passed / 0 failed / 0 ignored
结果      : 通过 ✅
===========================
```

失败时汇总下面附失败测试名/编译错误行（带日志行号），完整上下文在
`.kabegame/debug/test/test-<时间戳>.log`（该目录已 gitignore）。实测失败长这样：

```
退出码    : 101
编译 error: 1 个

-------- 失败摘要 --------
17:error: no test target named `nonexistent` in `kabegame-core` package
```

## 用法（人工路径）

等价的裸命令，没有汇总、没有日志（注意这里要自己写 `--`）：

```bash
deno task test -c kabegame-core -- --lib kgpg
deno task test -c kabegame-cli
```

## Gotchas

- **不要裸跑全量 `driver.sh`（不带过滤）当回归门槛**：全量套件有约 20 个既有失败
  （依赖本机媒体文件/环境），别把它们误判为自己改坏了。验证自己的改动请按名过滤，
  或对比改动前后同一过滤集的结果。
- **首次编译很慢**：test profile 的产物和 dev 不完全共享，实测冷缓存下
  `kabegame-core --lib` 约 3 分钟、`kabegame-cli` 约 4.5 分钟（要编 deno_core/V8）。
  增量情况下秒级到几十秒。别当卡死。
- **同一时间只跑一个 driver**：三个 crate 共用根 target/，并行的第二个 cargo 会
  `Blocking waiting for file lock on build directory` 干等（实测白等了 100s+ 才轮到）。
  串行跑。
- **`-c kabegame` 会做 CEF 检查**：注入 `CEF_PATH`（dev/check/test 均取 cef-dev），
  机器上没有导出的 CEF runtime 会直接报 `CEF runtime not found`。core/cli 不链
  CEF，无此要求。
- **app 在跑的时候 `-c kabegame` 会炸**：cef-dll-sys build script 复制 CEF 运行时
  时 target/ 被占用（os error 32 / Text file busy）。driver 会 pgrep 告警但不杀进程。
- **退出码不是 1**：cargo 编译失败/测试失败都退 `101`。判断成败用 `!= 0`。
- 过滤名匹配不到任何测试**不算失败**（`0 passed / 0 failed`、退出码 0）——看到
  全 0 先怀疑过滤词拼错，再下结论"测试通过"。
- 旧的 `deno task test:media`（`--test probe_media`）已删除：该集成测试 target
  已不存在于 `kabegame-core/tests/`。

## Troubleshooting

| 症状 | 处理 |
|---|---|
| `error: no test target named ...` | `--test <name>` 的 target 不存在；`kabegame-core/tests/` 下目前只有 `dsl_e2e` |
| bindgen/rsmpeg 报找不到 FFmpeg 头文件 | 手敲了裸 `cargo test`；走本 driver 或 `deno task test` |
| `CEF runtime not found in: .../cef-dev` | `-c kabegame` 需要本机 CEF runtime（`scripts/build-chromium.sh dev`），或者改测 kabegame-core/cli |
| `不存在的组件名称 ...` | crate 名拼错；只接受 kabegame / kabegame-cli / kabegame-core |
| `failed to auto-clean cache data ... os error 13` | cargo 缓存权限噪音，忽略 |
