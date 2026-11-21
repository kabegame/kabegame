# mediaremote-adapter（嵌入副本）

- 上游：<https://github.com/ungive/mediaremote-adapter>
- 提交：`6571499`（2026-11-20，「Define the bundle ID in a single place」）
- 许可证：BSD 3-Clause（同目录 `LICENSE`）

只拷了动态库与脚本用到的部分，文件内容一字未改：`include/`、`src/adapter/`、`src/private/`、`src/utility/`、
`src/test/NowPlayingTest.h`（`src/adapter/` 里引用它的常量）、`bin/mediaremote-adapter.pl`。没拷测试客户端的源码
（`src/test/` 的 `.m`）与 CMake / 脚本：插件不调 `test` 命令，动态库由插件的
`build.rs` 直接调 clang 编（参数照上游 `CMakeLists.txt`：`-fobjc-arc`、`-fvisibility=default`，链接 Foundation、AppKit、
UniformTypeIdentifiers）。

跟上游：整目录按上面的清单重新拷一遍、更新本文件的提交号，再在 macOS 上按插件 README 的走查过一遍。
