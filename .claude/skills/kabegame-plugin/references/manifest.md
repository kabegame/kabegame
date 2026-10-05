# package.json 清单：kbLabels 与 kbConfig

V8 与 WebView 通用。权威来源：插件标签 `apps/kabegame/src/stores/pluginLabels.ts`（REG）+
`docs/PLUGIN_FORMAT.md`；配置项 `src-crawler-plugins/config.schema.json`，后端取值转换在
`kabegame-core/src/crawler/task_scheduler/mod.rs` 的 `normalize_var_value`，表单显隐语义见
`cocs/crawler/TASK_CONFIG.md`。两处若与本文不一致，以源码为准并更新本文。

## kbLabels：插件标签（商店/插件列表上的徽标）

只写 `id`，文案、图标、颜色由应用提供；展示顺序固定为下表顺序。

| id | 显示名 | 什么时候加 |
|---|---|---|
| `auth.needCookie` | 需要 Cookie | 要先在畅游里登录才能抓（插件里会 `requireCookie()`） |
| `auth.needProxy` | 需要代理 | 中国大陆直连访问不全 |
| `content.res.mobile` | 移动端 | 提供竖屏 / 手机分辨率的图 |
| `content.res.desktop` | 桌面端 | 提供横屏 / 桌面分辨率的图 |
| `content.nsfw` | NSFW | 可能包含 NSFW / R-18 内容（R18 就用这个，没有单独的 r18 标签） |
| `content.type.video` | 视频 | 会下载视频 / 动态壁纸 |

```json
"kbLabels": [{ "id": "content.res.desktop" }, { "id": "content.nsfw" }]
```

- 只用上面这 6 个。`app.versionIncompatible` 由应用按 `engines.kabegame` 自动合成，插件不要声明。
- 不认识的 id 会显示成灰色标签，并且要自带 `name` / `desc` 作回落文案；没有充分理由别自造。
- 标签要如实反映站点：站点混有 R-18 内容就加 `content.nsfw`，即使插件默认配置不抓。

## kbConfig：配置变量

`kbConfig` 是数组，顺序就是表单顺序。每项必填 `key`、`type`、`name`；值在 V8 里是
`crawl(common, custom)` 的 `custom[key]`，在 WebView 里是 `Kabegame.vars[key]`。
CLI 的 `--var key=value` 也按下表类型转换。

| type | 额外字段 | 脚本里拿到的值 |
|---|---|---|
| `int` | `default`、`min`、`max` | 整数 |
| `float` | `default`、`min`、`max` | 数字 |
| `string` | `default` | 字符串 |
| `boolean` | `default` | `true` / `false` |
| `date` | `default`（与 format 一致，常用 `""`）、`format`（dayjs，缺省 `YYYY-MM-DD`）、`dateMin` / `dateMax`（`YYYY-MM-DD` 或 `today` / `yesterday`） | 按 `format` 格式化的日期字符串 |
| `options` | `options: [{ name, variable }]`（兼容纯字符串）、`default`（某个 variable） | 选中项的 `variable` 字符串（单选） |
| `list` | `options: string[]`（建议项，不要用 name/variable）、`default: string[]` | 字符串数组（可自由输入的多值） |
| `checkbox` | `options: [{ name, variable }]`、`default`（`string[]` 勾选项，或 `{ variable: bool }`） | 对象：`custom.foo.a`、`custom.foo.b` 各是 bool（多选） |

所有类型通用的可选字段：

- `descripts`：说明文字。
- 多语言：`name.zh` / `name.en` / `name.ja` / `name.ko` / `name.zhtw`，`descripts.*` 同理；
  `options` 里的 `name` 也可以带这些后缀。
- `when: { "<options 类型变量的 key>": ["variable1", "variable2"] }`：条件显示，多个 key 之间是 AND。
  选项级 `when`（写在 `options` 的某一项上）控制该选项是否可选。被隐藏的字段**提交时会被裁掉**，
  脚本拿不到，所以脚本里要为它们准备默认值。
- `width`：1–4，四列栅格中的宽度，缺省 4（独占一行），纯布局。

示例（模式切换 + 条件字段）：

```json
"kbConfig": [
  { "key": "mode", "type": "options", "name": "Mode", "name.zh": "模式", "default": "latest",
    "options": [{ "name": "Latest", "name.zh": "最新", "variable": "latest" },
                { "name": "Tag", "name.zh": "标签", "variable": "tag" }] },
  { "key": "tag", "type": "string", "name": "Tag", "name.zh": "标签", "default": "", "when": { "mode": ["tag"] } },
  { "key": "start_page", "type": "int", "name": "Start page", "name.zh": "起始页", "default": 1, "min": 1, "width": 2 },
  { "key": "end_page", "type": "int", "name": "End page", "name.zh": "结束页", "default": 1, "min": 1, "width": 2 }
]
```
