# 前端设置后端抽象

## 主题

`packages/core/src/stores/settings.ts` 统一管理前端设置状态。每个设置 key 的后端由
`settingsDescriptors.ts` 描述，调用方只通过 `useSettingKeyState(key)` 读写。

## 后端类型

- `tauri`：通过 `get_settings` 批量读取，通过 descriptor 中的 setter IPC 写入。
- `localStorage`：前端本地偏好，使用 `kabegame-setting-${key}` 持久化。
- `query`：URL query 镜像。settings 层只同步参数值，不判断 routeName 或激活态。
- `readonly`：web 下桌面能力占位，写入由 `useSettingKeyState` 拦截并提示桌面版。

## 状态机

`save(key, value, opts?)` 不乐观写 `values[key]`，也不做手动回滚。保存态退出由真实观察源确认：

- tauri：后端 `setting-change` 事件进入 `applyChanges`。
- localStorage：`useLocalStorage` ref watcher。
- query：app 层注入的 `setSettingsQueryAdapter` watcher。

## 使用示例

```ts
const { settingValue, set } = useSettingKeyState("autoConfigTab");
await set("recommended", { history: "replace", source: "auto_config_tabs" });
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

- `packages/core/src/stores/settings.ts`
- `packages/core/src/stores/settingsDescriptors.ts`
- `packages/core/src/stores/localSettingsMigrations.ts`
- `packages/core/src/composables/useSettingKeyState.ts`
- `apps/kabegame/src/stores/pathRoute.ts`
