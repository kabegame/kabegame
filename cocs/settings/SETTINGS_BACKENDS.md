# 前端设置后端抽象

## 主题

`packages/kabegame-core/src/stores/settings.ts` 统一管理前端设置状态。每个设置 key 的后端由
`settingsDescriptors.ts` 描述，调用方只通过 `useSettingKeyState(key)` 读写。

## 后端类型

- `tauri`：通过 `get_settings` 批量读取，通过 descriptor 中的 setter IPC 写入。getter-only key 允许没有 setter；调用方用 `settingsStore.refresh(key)` 走 descriptor 的 getter 做单键刷新（例如 `albumDriveDriverInstalled` 这类运行时状态）。
- `localStorage`：前端本地偏好，使用 `kabegame-setting-${key}` 持久化。
- `query`：URL query 镜像。settings 层只同步参数值，不判断 routeName 或激活态。
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

- `packages/kabegame-core/src/stores/settings.ts`
- `packages/kabegame-core/src/stores/settingsDescriptors.ts`
- `packages/kabegame-core/src/stores/localSettingsMigrations.ts`
- `packages/kabegame-core/src/composables/useSettingKeyState.ts`
- `apps/kabegame/src/stores/pathRoute.ts`
