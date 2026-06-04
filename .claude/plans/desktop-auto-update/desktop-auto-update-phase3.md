# Phase 3 — 前端：侧栏 NEW / 重启按钮 + 更新弹窗（tabs + marked changelog）

> 根计划：[desktop-auto-update.md](./desktop-auto-update.md) ｜ 前置：[Phase 1](./desktop-auto-update-phase1.md)（后端查询）、[Phase 2](./desktop-auto-update-phase2.md)（store + service + 调度）
> 本 Phase 让更新**可见可交互**：侧栏「Kabegame」下方的 NEW / 重启按钮，点击打开横向 tabs 更新弹窗，用项目 `marked` + `DOMPurify` 渲染各版本 changelog（**不兼容 GFM 也行、绝不跑脚本**），每个版本带「在 GitHub 查看」链接。

## ⚠️ 对根计划的修正（用户 2026-06-02）

**Linux 也弹更新弹窗、也显示 changelog**，只是**不能下载**——其主操作按钮为「打开发布页」（`openUrl(htmlUrl)`）。
> 即根计划「Linux 点 NEW 直接跳转 GitHub」作废，改为：**所有桌面平台点 NEW 都打开同一个弹窗**；平台差异只体现在弹窗内的"主操作按钮"：
> - **Linux**：永远是「打开发布页」（无下载、无 restartable）。
> - **macOS / Windows**：`release.assetUrl` 命中 → 「下载」；未命中（决策 D1）→ 「打开发布页」。

## 1. 本 Phase 范围

- ✅ 侧栏按钮（NEW / 重启更新）+ 折叠态小圆点。
- ✅ 更新弹窗（tabs + marked changelog + GitHub 链接 + 主操作按钮）。
- ✅ **「打开发布页」全链路可用**（Linux 与无 asset 场景，Phase 3 即完整工作）。
- ⏳ **「下载」按钮**：渲染出来，但点击走**占位** `onDownload`（toast 提示，真正下载在 Phase 5）。
- ⏳ **「重启更新」按钮**：渲染 + 确认框，但确认后的安装 `invoke` 留 Phase 6（Phase 3 先占位）。

## 2. 新建组件

```
apps/kabegame/src/components/updater/
  UpdateButton.vue   // 侧栏按钮：NEW（updateDetected）/ 重启更新（restartable）/ 折叠小圆点
  UpdateDialog.vue   // 横向 tabs + marked changelog + GitHub 链接 + 主操作
```

### 2.1 `UpdateButton.vue`
- props：`collapsed: boolean`（来自 App.vue 的 `isCollapsed`）。
- 依赖 `useUpdaterStore()`：`state` / `hasUpdate` / `isRestartable`。
- 渲染：
  - `state === 'latest'` → 不渲染。
  - **展开态**（`!collapsed`）：
    - `updateDetected` → 一个高亮 pill 按钮，文案 `t('updater.new')`（带轻微 pulse 动画吸引注意）。
    - `restartable` → pill 按钮，文案 `t('updater.restartUpdate')`。
  - **折叠态**（`collapsed`）：只渲染一个小红点（绝对定位的 badge），不显示文字。
- 点击：
  - `updateDetected` → `dialogVisible = true`（打开 `UpdateDialog`，**所有平台一致**，含 Linux）。
  - `restartable` → `ElMessageBox.confirm(t('updater.restartConfirmMessage'), t('updater.restartConfirmTitle'))`；确认后：
    ```ts
    // TODO(Phase 6): await invoke('apply_update_and_restart')
    ```
    （Phase 3 先占位，可 `ElMessage.info` 或空实现）。
- `UpdateDialog` 实例就挂在本组件内（`<UpdateDialog v-model:visible="dialogVisible" />`），避免 App.vue 再加挂载点。

### 2.2 `UpdateDialog.vue`
- props/emits：`visible`（`v-model:visible`）。`useModalBack(visible)`（桌面 no-op，遵守 CLAUDE.md）。
- 数据：`useUpdaterStore().releases`（最新在前，≤5）。`activeTab` 默认第一个（最新）的 `tag`。
- 结构：
  ```vue
  <el-dialog v-model="visible" :title="t('updater.dialogTitle')" width="640px" append-to-body>
    <el-tabs v-model="activeTab" type="card">
      <el-tab-pane v-for="r in releases" :key="r.tag" :name="r.tag" :label="r.tag">
        <div class="changelog" v-html="renderedBody(r)" @click="onBodyClick"></div>
      </el-tab-pane>
    </el-tabs>
    <template #footer>
      <a class="github-link" @click="openRelease(active)">{{ t('updater.viewOnGithub') }}</a>
      <el-button v-if="canDownload(active)" type="primary" @click="onDownload(active)">
        {{ t('updater.download') }}
      </el-button>
      <el-button v-else type="primary" @click="openRelease(active)">
        {{ t('updater.openReleasePage') }}
      </el-button>
    </template>
  </el-dialog>
  ```
  - `active` = `releases.find(r => r.tag === activeTab)`。
  - **`canDownload(r)`** = `!IS_LINUX && !!r.assetUrl`（Linux 恒 false；mac/win 看 asset 是否命中）。
  - **`openRelease(r)`** = `openUrl(r.htmlUrl)`（`@tauri-apps/plugin-opener`）。
  - **`onDownload(r)`** = Phase 3 占位：`ElMessage.info(t('updater.downloadComingSoon'))`；**Phase 5 替换**为 `updaterService.downloadAndStage(r)`。
  - 当 `!canDownload(active)` 时，footer 额外显示一行小字提示 `t('updater.noAssetHint')`（mac/win 无包时）或留空（Linux 正常如此）。

### 2.3 changelog 渲染（marked + DOMPurify，轻量版）
- **不复用** `PluginDocRenderer.vue`（它带图片预览/base64 等重逻辑），在 `UpdateDialog` 内写轻量 helper：
  ```ts
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  function renderChangelog(md: string): string {
    if (!md) return "";
    const raw = marked.parse(md, { gfm: false, breaks: true }) as string; // 不兼容 GFM 即可
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });      // 净化即"不跑脚本"
  }
  ```
  - `renderedBody(r)` 缓存：用 `computed`/`Map` 避免每次渲染（changelog 不变）。
- **链接外开**：`onBodyClick` 拦截 `<a href>` 点击 → `e.preventDefault()` → `openUrl(href)`（Tauri webview 内 `target=_blank` 不可靠，统一走 opener，呼应项目既有模式）。

## 3. App.vue 接线（侧栏「Kabegame」下方）

`.sidebar-title-section`（`v-if="!isCollapsed"`，h1 下方）插入完整按钮；折叠态在 logo 上叠小圆点：
```html
<div v-if="!isCollapsed" class="sidebar-title-section">
  <h1>Kabegame</h1>
  <UpdateButton :collapsed="false" />
</div>
```
折叠态（logo 始终可见）旁加圆点（二选一实现，保持简单）：
```html
<div class="app-logo-wrap">
  <img :src="appLogoUrl" class="app-logo logo-clickable" @click="toggleCollapse" />
  <UpdateButton v-if="isCollapsed" :collapsed="true" />  <!-- 仅渲染小圆点 -->
</div>
```
> 仅桌面侧栏存在该区域；Android 紧凑布局无侧栏，`UpdateButton` 不出现（且 service 在 Android noop，store 恒 latest）。Web 同理（store 恒 latest）。无需额外平台判断——`state==='latest'` 时组件本就不渲染。

## 4. i18n（新增 `updater` 命名空间）

新增 `packages/i18n/src/locales/<locale>/updater.json` 并在各 `index.ts` 注册（5 个 locale：en/zh/ja/ko/zhtw，避免缺 key 告警；ja/ko/zhtw 至少补齐，可暂用 en 文案占位）。

键（zh / en 示例）：
| key | zh | en |
|---|---|---|
| `updater.new` | NEW | NEW |
| `updater.restartUpdate` | 重启更新 | Restart to update |
| `updater.dialogTitle` | 发现新版本 | Update available |
| `updater.viewOnGithub` | 在 GitHub 查看 | View on GitHub |
| `updater.download` | 下载 | Download |
| `updater.openReleasePage` | 打开发布页 | Open release page |
| `updater.noAssetHint` | 当前平台暂无安装包，请前往发布页手动下载 | No installer for this platform; download from the release page |
| `updater.downloadComingSoon` | 下载功能即将上线 | Download coming soon |
| `updater.restartConfirmTitle` | 重启更新 | Restart to update |
| `updater.restartConfirmMessage` | 新版本已就绪，是否立即重启以完成更新？ | A new version is ready. Restart now to finish updating? |

> `index.ts` 同步加 `import updater from "./updater.json";` 与 `export default { ..., updater }`。

## 5. 验收

1. **macOS/Windows（dev 旧版本）**：侧栏「Kabegame」下方出现 NEW；点开弹窗见多 tab、changelog 正确渲染、`type:card` 横向 tabs、「在 GitHub 查看」可跳转；footer 显示「下载」（点击当前为占位 toast）。
2. **Linux**：同样出现 NEW、同样弹窗显示 changelog；footer 显示「打开发布页」（点击 `openUrl` 跳转），**无下载按钮**。
3. **无 asset 的 mac/win**（构造 release 无匹配包）：footer 退化为「打开发布页」+ `noAssetHint` 小字。
4. **折叠侧栏**：logo 上出现小红点；展开后是完整 NEW 按钮。
5. **restartable**（DevTools `setRestartable('v4.1.1')`）：按钮变「重启更新」；点击弹确认框（确认后暂无动作，Phase 6 接）。
6. **链接外开**：changelog 正文里的 `<a>` 点击走 `openUrl`，不在 webview 内导航。

## 6. 文件改动清单

- **新增**：
  - `apps/kabegame/src/components/updater/UpdateButton.vue`
  - `apps/kabegame/src/components/updater/UpdateDialog.vue`
  - `packages/i18n/src/locales/{en,zh,ja,ko,zhtw}/updater.json`
- **修改**：
  - `apps/kabegame/src/App.vue`（sidebar-header 挂 `UpdateButton`：展开态 title-section、折叠态 logo 小圆点）
  - `packages/i18n/src/locales/{en,zh,ja,ko,zhtw}/index.ts`（注册 `updater` 命名空间）

## 7. 验证命令

- `bun check -c kabegame --skip cargo`（vue-tsc 通过）。
- 运行期目测见 §5。

## 8. 注意 / 风险

- **marked v17 API**：`marked.parse` 同步返回 string（无 async highlight 时）；类型上用 `as string`，与 PluginDocRenderer 一致。
- **DOMPurify 即"不跑脚本"**：`<script>`/`onclick` 等会被剥离，满足"不跑脚本"要求；无需额外 CSP。
- **tabs 过多**：后端已 cap 5，`type="card"` 横向排布 5 个 tag 不会溢出；超长 release name 不用于 tab label（用 `tag`）。
- **占位项清单**（供 Phase 5/6 收尾时检索）：`onDownload` 占位、restartable 确认后的 `apply_update_and_restart` TODO。
</content>
