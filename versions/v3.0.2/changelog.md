# v3.0.2 changelog

## Added

- F11全屏快捷键
- 新增 `bun check` 命令：按组件依次检查 `vue-tsc` 与 `cargo check`
  - `bun check` 必须指定 `-c, --component`
  - `--skip` 统一为 `vue|cargo` 且只能指定其中一个值
- plugin editor 支持全量的变量类型
- plugin editor 支持不手动输入json指定变量类型
- Rhai 脚本新增 HTTP Header 接口：`set_header` / `del_header`
- plugin-editor Rhai 编辑器补全/悬浮/签名提示新增 `set_header` / `del_header`
- plugin-editor 测试面板支持配置 HTTP Header
- ctrl + c 复制图片快捷键
- rar 解压缩导入支持

## Changed

- 将构建脚本从js升级到ts，类型更安全
- 将服务端ipc代码移到core
- 构建命令支持 `--skip vue|cargo`（只能一个值；main 支持 `--skip vue` 跳过前端构建）
- 将 release 放到了git中，原因：
  1. 方便用户从README直接下载
  2. 方便引用
  3. 不用调试github action
  4. 不用等待github action的缓慢运行
  5. 不用为了action ci而调整构建代码
  6. 不用维护action和script两处代码
  7. 克隆仓库的用户可以直接从 release 目录下运行安装脚本
     缺点是
  8. git 包增加约100mb，上传下载都变得耗时
  9. 每次发布都要更新 README.md，不过不复杂
     但是考虑到这是对C的终端应用，所以这些缺点可以接受。因为克隆仓库的人不多。
- 爬虫中的重定向会带上所有原始header

## Removed

- 经过考虑去掉 plasma 插件。原因：
  1. 几乎没有文档，只能借鉴社区里的若干项目
  2. 调试困难，每次都要重启 plasma shell
  3. 同步问题繁琐，插件和主应用之间的状态管理复杂
  4. 功能不强。插件提供的功能主应用几乎都能提供，而且插件还依赖主应用的运行
  5. 侵入性高。用户在运行plasma插件的同时不能用其他插件
  6. 用户不多。社区最火的插件全球安装量只有2w+，不值得投入太多精力开发
  7. 安装、卸载逻辑复杂，要在deb包里维护这些逻辑
  8. 无法发行在商店，或者发行复杂。因为商店不支持deb包发行，只支持tar.gz，导致不能安装.so。

## Fixed

- plugin editor 任务列表显示插件名称问题
- 画廊切换到其他tab导致画廊页面归一的问题
- kgpg拖拽导入将kgpg当作图片的bug
- 修复 light 和 local 关于内置插件的问题
- 修复 reqwest 30x 处理问题
- 当一次性导入过多压缩包导致死锁问题。解决方案是用一个专门的线程解压缩
