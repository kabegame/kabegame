---
title: 安装与首次启动
description: 按平台下载 Kabegame 发行包，并了解首次启动后数据目录的位置。
---

Kabegame 面向 Windows、macOS、Linux 桌面与 Android 发布。桌面端是单一的标准（standard）构建；`kabegame-cli` 命令行工具是**独立下载**，不随主程序打包。本页说明在各平台下载哪个包、以及首次启动后数据落在哪里。

## 选择发行包

从 [GitHub Releases](https://github.com/kabegame/kabegame/releases/latest) 下载对应平台的文件：

| 平台 | 主程序包名 | 命令行工具（可选，单独下载） |
|---|---|---|
| Windows | `Kabegame-standard_<版本>_x64-setup.exe` | `Kabegame-cli-standard_<版本>_x64-setup.exe` |
| macOS | `Kabegame-standard_<版本>_aarch64.dmg` | `Kabegame-cli-standard_<版本>_aarch64` |
| Linux | `Kabegame-standard_<版本>_amd64.deb` | `Kabegame-cli-standard_<版本>_amd64` |
| Android | `Kabegame_<版本>_android-preview.apk` | 不适用 |

:::note
`kabegame-cli` 需要用时到发布页单独下载，见 [kabegame-cli 用法](/reference/cli/)。Android 版不含 CLI。
:::

## Windows

下载 `Kabegame-standard_<版本>_x64-setup.exe`，双击运行 NSIS 安装向导。

安装完成后安装目录默认位于 `C:\Program Files\Kabegame\`，开始菜单会出现 Kabegame 图标。

## macOS

下载 `Kabegame-standard_<版本>_aarch64.dmg`，双击挂载后把 `Kabegame.app` 拖入「应用程序」。

由于安装包未签名，首次打开时 macOS Gatekeeper 会提示「已损坏」或无法验证开发者。在终端执行：

```bash
xattr -d com.apple.quarantine /Applications/Kabegame.app
```

命令完成后即可正常启动。最低系统要求为 macOS 11（Big Sur）。

## Linux

下载 `Kabegame-standard_<版本>_amd64.deb`，在终端执行：

```bash
sudo dpkg -i Kabegame-*.deb
```

如果提示依赖缺失，再执行以下命令补齐：

```bash
sudo apt-get install -f
```

最低支持 Ubuntu 24.04。

:::note
在 Wayland 下 Kabegame 会自动设置 `GDK_BACKEND=x11`，以 X11 渲染方式运行。这是为规避兼容性问题采取的默认行为，不是异常。
:::

## Android

从 [Releases](https://github.com/kabegame/kabegame/releases/latest) 页面下载最新的 `Kabegame_<版本>_android-preview.apk`，按照以下步骤安装：

1. 在系统设置中允许浏览器或文件管理器「安装未知来源的应用」。
2. 在文件管理器中点击下载的 APK，按提示完成安装。
3. 首次启动会自动创建数据目录，无需额外配置。

最低 Android 8.0（API 26+）。

:::note
Android 版不包含 `kabegame-cli`。
:::

## `.kgpg` 文件关联

桌面平台安装完成后会自动注册 `.kgpg` 文件关联：

- Windows、macOS：安装器自动写入注册表与 UTI。
- Linux：deb 的 postinst 脚本刷新 mime 数据库。

双击 `.kgpg` 插件包会通过 `kabegame-cli` 导入。Android 没有 `.kgpg` 关联。

## 首次启动后的数据目录

应用不会弹出安装引导窗口，启动后会直接创建数据与缓存目录。各平台路径如下：

| 平台 | 应用数据 | 缓存 |
|---|---|---|
| Windows | `%LOCALAPPDATA%\Kabegame` | `%LOCALAPPDATA%` 下的 `Kabegame` 子目录 |
| macOS | `~/Library/Application Support/Kabegame` | `~/Library/Caches/Kabegame` |
| Linux | `~/.local/share/Kabegame`（或 `$XDG_DATA_HOME/Kabegame`） | `~/.cache/Kabegame` |
| Android | `/data/data/app.kabegame/files` | `/data/data/app.kabegame/cache` |

Android 的大文件目录位于 `/storage/emulated/0/Android/data/app.kabegame/files`。所有平台的临时目录都是系统 `temp` 下的 `Kabegame` 子目录。

:::note
图片默认收藏在用户目录下的 `Pictures/Kabegame`，与应用数据目录分离。卸载应用不会删除 `Pictures/Kabegame` 中的图片。
:::

## 卸载

桌面端可通过系统的「应用与功能」或「应用程序」卸载 Kabegame。需要注意：

- `Pictures/Kabegame` 中的图片不会被删除，若要清理需手动操作。
- 应用数据目录和缓存目录（见上一节）同样不会随卸载移除，请按需手动删除。

## 排障

- **macOS 启动提示「已损坏」或无法打开** → 安装包未签名被 Gatekeeper 隔离 → 执行 `xattr -d com.apple.quarantine /Applications/Kabegame.app`。
- **Linux 在 Wayland 下看起来仍然走 X11** → 应用主动设置了 `GDK_BACKEND=x11` 作为兼容方案 → 这是正常行为，无需处理。

## 延伸阅读

- [快速上手](/guide/quickstart/) — 装好之后的第一步。
- [kabegame-cli 用法](/reference/cli/) — 从发布页单独下载的命令行工具。
- [Android 专版说明](/guide/android/) — Android 限制、返回键、分享体验。
- [故障排查](/guide/troubleshooting/) — 更完整的 FAQ 与常见错误。
