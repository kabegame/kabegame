# 插件私有数据 `plugin_data`

`plugin_data` 是爬虫插件的 per-plugin JSON KV 空间：每个插件拥有一行、一个 JSON object。它适合保存可重建的缓存数据，例如 token、上次成功抓取时间、去重状态、米游社 emoji 集合，或 PixAI tag taxonomy / tag 显示名缓存。

## 数据表

```sql
CREATE TABLE plugin_data (
    plugin_id  TEXT    PRIMARY KEY,
    data       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
```

`data` 的顶层必须是 JSON object。内部 key 由插件自己管理，宿主不解释它的 schema。

## Rhai API

爬虫脚本可以读写当前插件自己的数据：

```rhai
let d = plugin_data();
d.run_count = (d.run_count ?? 0) + 1;
d.last_run = unix_time_ms();
set_plugin_data(d);
```

- `plugin_data() -> Map`：读取当前插件的 blob；不存在时返回空 `Map`。
- `set_plugin_data(value)`：覆盖当前插件的 blob；`value` 必须是 `Map`，否则脚本报错。

插件 id 不作为参数传入，而是由运行时闭包捕获当前任务的 `plugin_id`，所以脚本无法指定其它插件 id。

## EJS Bridge

`description.ejs` 只能读取，不能写入：

```html
<script>
  __bridge.getPluginData().then((data) => {
    document.body.textContent = JSON.stringify(data);
  });
</script>
```

- `__bridge.getPluginData() -> Promise<object>`：返回当前图片所属插件的 `plugin_data`；不存在时返回 `{}`。
- 没有 `setPluginData` bridge。写入只允许在 Rhai 爬虫侧发生。

安全边界在父窗口：`plugin_id` 来自 `ImageDetailContent.vue` 当前图片的 `image.pluginId`，不会信任 iframe 消息里的任何 plugin id 字段。

## 生命周期

卸载插件时，宿主会删除对应 `plugin_data` 行。清理失败是非致命错误：插件文件已删除时，宿主不会因为 DB 锁等问题回滚卸载；后续重装插件后，Rhai 写入会通过 UPSERT 覆盖旧数据。

## 并发语义

`plugin_data()` + `set_plugin_data()` 是普通读改写，不是原子事务。如果同一插件并发跑多个任务，后写入者可能覆盖先写入者。它的定位是 cache / scratch space，不适合保存不可丢失的计数或业务账本。

需要 TTL 时，把时间戳放在 blob 内部：

```rhai
let d = plugin_data();
if d.tags == () || d.tags_updated_at == () || unix_time_ms() - d.tags_updated_at > 86400000 {
    d.tags = #{};
    d.tags_updated_at = unix_time_ms();
    set_plugin_data(d);
}
```
