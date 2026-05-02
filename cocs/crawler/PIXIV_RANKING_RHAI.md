# Pixiv 插件排行榜（Rhai）

## 主题

`src-crawler-plugins/plugins/pixiv` 的 **排行榜**模式：`config.json` 三维度（榜序 `ranking_mode`、内容 `content_mode`、年龄向 `age_mode`）、单日期 `ranking_date`，以及 `crawl.rhai` 中列表分页与 `warn` 行为。选 **R18** 时脚本会校验 **`user_id` 非空**并设置 **`x-user-id`**（与表单「用户 UID」同一字段，全爬取类型可见；全年龄榜不发送该头）。

**表单顺序与条件**：`content_mode` 仅由 `source === ranking` 控制显示（一级目录）；各 **榜序** 选项带 `when: { content_mode: [...] }`，使插画/漫画仅见日/周/月/新生榜，动图仅见日/周榜，综合可见全部榜序。详见 `docs/RHAI_API.md` 中「options 各项的 when」。

## 涉及文件

| 文件 | 作用 |
|------|------|
| `src-crawler-plugins/plugins/pixiv/config.json` | 表单变量与 `when` 条件 |
| `src-crawler-plugins/plugins/pixiv/crawl.rhai` | 拼接 `mode`/`content`/`date`、按 JSON `next` 翻页、`warn` 数量不足 |
| `src-tauri/kabegame-core/src/plugin/rhai.rs` | 注册 Rhai `warn(msg)` → 任务日志 warn 级别 |

## 分页

排行榜列表接口返回 `next`：下一页页码（数字），最后一页为 `false`。脚本据此推进 `p`，不再用固定最大页数或「本页不足 50 条」推断末页。

## 适用场景

扩展排行榜选项、排查 R18 / `x-user-id` / Cookie、理解「留空 `ranking_date`」与 Pixiv 最新一期行为。
