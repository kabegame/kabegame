# v3.0.1 changelog

## Changed

- 经过各种考虑，去掉daemon，改成kabegame内嵌服务，原因如下：
  1. daemon状态管理太复杂
  2. 与kabegame的交互存在显著性能开销
  3. 未来做self-hosted不好迁移
  4. 用户无法轻易关闭的后台服务很令人反感。
