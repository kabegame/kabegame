# v4.7.0 changelog

## 用户侧

### Changed
- 壁纸轮播改为按一条视图路径依次切换：在画廊、画册、任务或畅游详情的过滤栏 ⋯ 菜单点「用当前视图轮播」，当前的过滤与排序就是轮播来源；设置页只显示当前轮播路径，原来的「选择画册 / 包含子画册 / 随机或顺序」三项去掉（随机即随机排序视图）。轮播位置会保存，停止再开启、重启应用都接着上次的下一张，换了视图才从第一张开始；原生壁纸模式只轮播图片，切换壁纸模式后从当前壁纸的下一张继续。旧设置升级时自动换算成对应路径。
- 图片详情的「基本信息」改为卡片式排版：名称作标题，源与收藏时间并在一行，类型、大小、尺寸做成可点筛选的芯片，宽高比画成与图片同比例的矩形框；URL 与本地路径各占一行，省略显示并带复制按钮，整体高度明显降低。

### Fixed
- Android 平板 / 横屏宽屏布局的侧栏、主内容区与弹窗不再被状态栏、底部导航栏遮挡；平板上的弹窗与桌面一样限高、只在内容区滚动，底部按钮始终可见。
- Android 平板（宽度超过紧凑断点）打开图片预览后左右滑动不再停在原图，能正常切换上一张 / 下一张；滑动过后按一次返回即可关闭预览，不再先被背后的多选状态吃掉。
- Android 吉祥物亀ちゃん不再被底部导航栏挡住脚部，拖动范围也限制在系统栏之内。

## 插件开发侧

### Added
- `kabegame-cli plugin run` 新增 `--freeze-template`：把本次运行插件的 `description.ejs` 冻结进每行 metadata（新列 `metadata.template`），详情面板优先用它渲染。`--id` 测试 id 没有安装，过去它下载的图片只能看原始键值，现在也能直接在应用里调试模板。插件模板与冻结模板并行获取，冻结模板非空时覆盖插件模板。

## 开发侧

### Changed
- 壁纸轮播只认 `wallpaperRotationPath` + `wallpaperRotationPosition` 两个设置，命令 / IPC 改为 `set_wallpaper_rotation_path` / `get_wallpaper_rotation_path`（`SettingsGet/SetWallpaperRotationPath`），删除画册 id、子画册、模式三组命令与画册 `bigger_order` 路由；Android Worker 不再读数据库，改为消费 Rust 预取的 `rotation_queue.json`。详见 `cocs/wallpaper/ROTATION_PATHQL.md`。
- 设置迁移框架与数据库迁移对齐：模块文档写明新增步骤与约束，迁移失败不写回、照常启动，迁移写回前备份 `settings.json.bak-v<旧版本>`，每个迁移带单测；新增 v003 把旧轮播三键换算成路径。
- metadata 表新增可空列 `template`（v047 迁移）；`images://id_<id>/metadata_full` 与 `get_image_metadata_full` 返回该字段。metadata 迁移把冻结模板原样带到新行，整轮去重按模板分区；开启「去重时更新元数据」时，后一次运行改挂到新行，data 与模板一起被覆盖，未冻结时清空。
- app IPC 协议升到 v4（`PluginRunParams.freezeTemplate`），新 CLI 连接旧主程序时自动回退本地执行。
