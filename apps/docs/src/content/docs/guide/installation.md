---
title: 安装与首次启动
description: 按平台下载 Kabegame 发行包、安装虚拟盘依赖，并了解首次启动后数据目录的位置。
---

Kabegame 面向 Windows、macOS、Linux 桌面与 Android 发布。桌面端提供 **Standard** 与 **Light** 两种模式：Standard 带有虚拟盘和 `kabegame-cli`，Light 只安装主程序。Android 只有单一的预览 APK。本页说明在各平台下载哪个包、如何处理虚拟盘依赖，以及首次启动后数据落在哪里。

## 选择发行包

每次发布都会同时上传 Standard 与 Light 两套桌面安装器。两者差异如下：

| 模式 | 包含内容 | 适合谁 |
|---|---|---|
| Standard | 主程序 + 虚拟盘 + `kabegame-cli` | 需要把图库挂载为磁盘、或用命令行批量处理的用户 |
| Light | 仅主程序 | 不需要虚拟盘，想要最小安装体积 |

从 [GitHub Releases](https://github.com/kabegame/kabegame/releases/latest) 下载对应平台与模式的文件。桌面端包名形如 `Kabegame-standard_<版本>_<架构>.<后缀>` 或 `Kabegame-light_<版本>_<架构>.<后缀>`。

:::note
Standard 与 Light 没有运行时切换开关，只能通过重新下载不同安装包来切换。
:::

## Windows

下载 `Kabegame-<mode>_<版本>_x64-setup.exe`，双击运行 NSIS 安装向导。

首次安装时，如果系统缺少 Dokan 2.x 驱动，安装器会通过 UAC 提权自动调起捆绑的 Dokan 安装程序。完成后安装目录默认位于 `C:\Program Files\Kabegame\`，开始菜单会出现 Kabegame 图标。

:::caution
Dokan 驱动的关键文件是 `dokan2.sys`，只有 `dokan2.dll` 不足以正常挂载。如果之前装过 Dokan 但虚拟盘仍然无法使用，建议重新安装 Dokan 2.x 运行时。
:::

虚拟盘的进一步配置请见 [虚拟盘](/guide/virtual-drive/)。

## macOS

下载 `Kabegame-<mode>_<版本>_aarch64.dmg`，双击挂载后把 `Kabegame.app` 拖入「应用程序」。

由于安装包未签名，首次打开时 macOS Gatekeeper 会提示「已损坏」或无法验证开发者。在终端执行：

```bash
xattr -d com.apple.quarantine /Applications/Kabegame.app
```

命令完成后即可正常启动。最低系统要求为 macOS 10.13 High Sierra。

:::caution
如果你使用 Standard 模式并希望启用虚拟盘，需要先安装 macFUSE：

```bash
brew install macfuse
```

具体挂载说明见 [虚拟盘](/guide/virtual-drive/)。
:::

## Linux

下载 `Kabegame-<mode>_<版本>_amd64.deb`，在终端执行：

```bash
sudo dpkg -i Kabegame-*.deb
```

如果提示依赖缺失，再执行以下命令补齐：

```bash
sudo apt-get install -f
```

Standard 模式的 deb 会声明对 `fuse3` 的依赖，apt 会自动拉取。若你的系统未预装 fuse3，也可以先手动安装：

```bash
sudo apt install fuse3
```

最低支持 Ubuntu 24.04。Light 模式不依赖 fuse3。

:::note
在 Wayland 下 Kabegame 会自动设置 `GDK_BACKEND=x11`，以 X11 渲染方式运行。这是为规避兼容性问题采取的默认行为，不是异常。
:::

## Android

从 [Releases](https://github.com/kabegame/kabegame/releases/latest) 页面下载 `Kabegame_<版本>_android-preview.apk`，按照以下步骤安装：

1. 在系统设置中允许浏览器或文件管理器「安装未知来源的应用」。
2. 在文件管理器中点击下载的 APK，按提示完成安装。
3. 首次启动会自动创建数据目录，无需额外配置。

最低 Android 8.0（API 26+）。

:::note
Android 版本不包含虚拟盘与 `kabegame-cli`，属于预览形态。
:::

## 虚拟盘依赖一览

虚拟盘只存在于桌面 Standard 模式下。各平台所需依赖：

| 平台 | 依赖 | 为什么需要 |
|---|---|---|
| Windows | Dokan 2.x 驱动（含 `dokan2.sys`） | 将图库挂载为本地磁盘 |
| macOS | macFUSE | 通过 FUSE 在 `~` 下暴露挂载点 |
| Linux | `fuse3` | 通过 FUSE 在本地目录挂载，`fusermount3` 用于卸载 |

各平台的挂载点配置、常见错误处理均在 [虚拟盘](/guide/virtual-drive/) 中展开。

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

- **Windows 挂载虚拟盘提示「Dokan 驱动不可用」** → Dokan 2.x 运行时未正确安装或缺少 `dokan2.sys` → 重新安装 Dokan 2.x 驱动。
- **Windows 挂载提示「Dokan 版本不兼容」** → `dokan2.dll` 与系统驱动版本不匹配 → 升级或重装 Dokan 2.x 驱动到与应用匹配的版本。
- **macOS 启动提示「已损坏」或无法打开** → 安装包未签名被 Gatekeeper 隔离 → 执行 `xattr -d com.apple.quarantine /Applications/Kabegame.app`。
- **Linux `dpkg -i` 报依赖错误** → `fuse3` 等依赖缺失 → 执行 `sudo apt-get install -f` 自动补齐。
- **Linux 在 Wayland 下看起来仍然走 X11** → 应用主动设置了 `GDK_BACKEND=x11` 作为兼容方案 → 这是正常行为，无需处理。

## 延伸阅读

- [快速上手](/guide/quickstart/) — 装好之后的第一步。
- [虚拟盘](/guide/virtual-drive/) — 挂载点配置与深入说明。
- [kabegame-cli 用法](/reference/cli/) — Standard 模式附带的命令行工具。
- [Android 专版说明](/guide/android/) — Android 限制、返回键、分享体验。
- [故障排查](/guide/troubleshooting/) — 更完整的 FAQ 与常见错误。
