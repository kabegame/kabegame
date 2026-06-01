## bug
- [x] `4.2.0` 下载过程中，task页面的图片选择老是被打断

## issue
- [ ] 扩展cli功能，修复cli bug

## optimize
- [ ] 删除图片改成将图片移入系统回收站
- [ ] 添加设置窗口模态是否弹出的设置选项
- [ ] 插件安装失败显示失败原因

## feat
- [ ] 添加托盘操作
    - [ ] 壁纸过渡方式切换
    - [ ] 壁纸填充方式切换
- [ ] 安卓 photoswipe 管理错误状态（图片丢失占位）和加载中状态
- [ ] ! 局域网数据共享（复用爬虫插件，通过http访问peer，并提供可扩展的发现协议）
- [ ] ! Provider 支持远程 URL（Provider 可以返回远程图片 URL，支持预览模式和按需下载）
桌面右键菜单下一张图片（windows用nsis脚本，plasma用desktop文件），并且做好错误处理
- [ ] 文件资源管理器快速预览插件（macos quiklook, windows preview handler，gnome sushi, KDE KIOpreview）
- [ ] 安卓用桌面小组件代替桌面上系统托盘功能。
- [x] `4.2.0` 自动同步文件夹画册
- [ ] 图片标签
- [ ] 图片评分
- [ ] 组合式搜索排序，在header下用一整行io组件来实现
    - [ ] 插件provider所有自动加上filter_comb目标
    - [ ] 插件provider的resolve最好为了避免歧义，用tag_之类的前缀
- [ ] 自动github更新，浏览小漫画查看更新日志
- [ ] 图片裁剪功能，裁剪后的图片的缩略图也被裁剪，设置壁纸也是裁剪部分，支持各平台，包括应用背景图片也应用裁剪，但复制和打开原图还是原图

## refactor


## stash
