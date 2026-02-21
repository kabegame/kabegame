# Android 启动闪退调试

应用启动后立即闪退且终端无报错时，需要从 **logcat** 查看崩溃原因。

## 1. 抓取崩溃日志

连接设备或模拟器后，在项目根目录执行：

```bash
# 清空旧日志后再启动应用，便于只看本次启动
adb logcat -c && adb logcat | tee android_crash.log
```

然后在设备上打开 Kabegame，复现闪退。终端会同时输出到屏幕并写入 `android_crash.log`。

**只看本应用相关：**

```bash
adb logcat -c && adb logcat | grep -E "Kabegame|FATAL|AndroidRuntime|DEBUG|tauri|kabegame"
```

**只看崩溃栈：**

```bash
adb logcat -c && adb logcat *:E | tee android_errors.log
```

## 2. 日志里重点看什么

- **Java/Kotlin 崩溃**：搜 `FATAL EXCEPTION` 或 `AndroidRuntime`，下面会有 `Caused by:` 和堆栈。
- **Native (Rust) 崩溃**：搜 `Fatal signal`、`SIGABRT`、`backtrace` 或 `libkabegame.so`。
- **本应用日志**：搜 `Kabegame`。若在 `MainActivity.onCreate` 加了日志：
  - 能看到 `MainActivity.onCreate start` 说明已进 Activity；
  - 看不到说明崩溃在 Tauri/WebView 或 native 更早阶段。

## 3. 常见原因

| 现象 | 可能原因 |
|------|----------|
| `LifecycleOwner ... is attempting to register while current state is RESUMED` | PickerPlugin 在构造时调用了 `registerForActivityResult`，但插件在 Activity 已启动后才被创建。已通过 `PickerLauncherHost` 改为由 MainActivity 在 onCreate 前注册 launcher 并提供给插件使用。 |
| 完全无 Kabegame 日志 | Native 在加载或 setup 时崩溃，或 TauriActivity 未到 MainActivity |
| 有 "onCreate start" 无 "onCreate done" | 崩溃在 `super.onCreate()` 或 WebView 初始化 |
| Rust 编译报 `run_mobile_plugin_async` 不存在 | 需用 `cargo tauri android build` 并确保 Tauri 开启 mobile 相关 feature |

把 `android_crash.log` 或相关片段（含 FATAL / Fatal signal 及下面几行）发给开发者即可进一步定位。
