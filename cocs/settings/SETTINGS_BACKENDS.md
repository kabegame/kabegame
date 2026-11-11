# 前端设置后端抽象

## 主题

`apps/kabegame/src/stores/settings.ts` 统一管理前端设置状态。每个设置 key 的后端由
`settingsDescriptors.ts` 描述，调用方只通过 `useSettingKeyState(key)` 读写。

## 后端类型

- `tauri`：通过 `get_settings` 批量读取，通过 descriptor 中的 setter IPC 写入。getter-only key 允许没有 setter；调用方用 `settingsStore.refresh(key)` 走 descriptor 的 getter 做单键刷新（例如 `albumDriveDriverInstalled` 这类运行时状态）。`wallpaperTargets` 也是 getter-only：它由带 `target` 的专用命令写入（经 `useWallpaperTarget`，不走 `save`），值随后端的 `setting-change` 落地，保存中状态由各设置项自己持有，见 [多显示器壁纸](../wallpaper/MULTI_SCREEN.md)。
- `localStorage`：前端本地偏好，使用 `kabegame-setting-${key}` 持久化。
- `query`：URL query 镜像。settings 层只同步参数值，不判断 routeName 或激活态。四个 path-route 的路径里，`gallery-path`、`task-detail-path`、`surf-images-path` 全平台都走 query，参数名同为 `path`，所以只能在自己的页面上写，跨页要显式 `router.push` 到目标页。`album-detail-path` 只在 web 走 query，桌面 / Android 用 localStorage。画廊因此不再在重启后恢复上次浏览路径，见 [收藏视图](../gallery/SAVED_VIEWS.md)。
- `readonly`：web 下桌面能力占位，写入由 `useSettingKeyState` 拦截并提示桌面版。

## 状态机

`save(key, value, opts?)` 不乐观写 tauri/localStorage 的 `values[key]`，也不做手动回滚。保存态退出由真实观察源确认：

- tauri：后端 `setting-change` 事件进入 `applyChanges`。
- localStorage：`useLocalStorage` ref watcher。
- query：`setSettingsQueryAdapter.write` 完成后按当前 query 解码同步并清掉保存态；adapter 的 query watcher 仍负责浏览器前进/后退、手输 URL 等外部变化。

## 使用示例

```ts
const { settingValue, set } = useSettingKeyState("autoConfigTab");
await set("recommended", { history: "replace", source: "auto_config_tabs" });
```

```ts
const settings = useSettingsStore();
await settings.refresh("albumDriveDriverInstalled");
```

```ts
setSettingsQueryAdapter({
  query: computed(() => route.query as Record<string, unknown>),
  async write(param, value, history) {
    const query = { ...route.query };
    if (value === "") delete query[param];
    else query[param] = value;
    await router[history]({ path: route.path, query });
  },
});
```

## 涉及文件

- `apps/kabegame/src/stores/settings.ts`
- `apps/kabegame/src/stores/settingsDescriptors.ts`
- `apps/kabegame/src/stores/localSettingsMigrations.ts`
- `apps/kabegame/src/composables/useSettingKeyState.ts`
- `apps/kabegame/src/stores/pathRoute.ts`
