# 场景壁纸支持壁纸样式，预览按自身比例显示

## 总体设计思路

场景原来固定 cover，壁纸样式对它不生效；预览用主屏比例的「桌面画布」，场景比例不同时被裁。这次让场景按 Kabegame 的五种样式铺放，
预览则不看样式，和单独的图片一样完整显示。WPE 的 Free 不做（2026-11-07 用户）。

铺放只发生在上屏：宿主画布始终铺满 iframe，场景仍画进自己分辨率的离屏目标，最后一步按样式算视口和纹理坐标。这样样式放在一处，
fit 的留白、center 的裁切、tile 的重复都是同一个函数的不同参数，改样式不重编译，指针换算也在这里。没有选「父页面按样式改 iframe 大小」：
tile 做不到，cover 又得留在宿主里，逻辑分两处。

样式走 postMessage，不走地址参数：样式要能在运行时改，留一条路就够了；宿主启动时先请求一次，覆盖了 iframe 还没加载完时样式变化的情况。
留白颜色不用传：宿主本来就持有属性全集，`schemecolor` 的用户值已并入，改色也是现成的增量路径。

预览复用原来的画布，只把尺寸来源从「桌面」换成「内容」。尺寸在出首帧时才知道，这之前没有画面，翻转看不见；封面截取量的是这块画布，
所以不用改，还顺带修掉了封面被裁的问题。没有在导入时把分辨率写进 `images.width/height`：工坊场景几乎都在 `scene.pkg` 里，
Rust 这边没有读取器，还要回填，而这些字段也影响网格和宽高比筛选。

## WPE 的留白颜色（逆向 + 实测）

- 留白用 `schemecolor`，不是 `clearcolor`：`(alignment & ~2) != 0` 时换色（`0x14017fc4c`），alignment 枚举 cover 0、fill 1、stretch 2、center 3、free 4。
  实测（`p3-script-REPORT.md` 4g）：`alignment=1` + `schemecolor="1 0 0"` 背景整片变红。
- 优先级：用户值 > `config.json` 的 `general.defaultproperties.schemecolor` > 工程值 > 灰色 `0.5 0.5 0.5`。
- 场景整屏 D3D clear，alignment 只改正交投影（`FUN_140183a70`），没有单独的 quad 或视口。值原样、不做 sRGB 转换，alpha 1。
- 没有 `orthogonalprojection` 的场景，WPE 会删掉 alignment 属性；这类场景我们报 `camera:perspective` 退回，不受影响。
- 图片、视频各有路径（视频 mf 用 `SetBackgroundColor`，center / free 用 `FillRect`），颜色来源相同。网页原生端不画留白。
- 来源：编辑器建工程时 `getDominantColorFromFile` 按素材主色写入，作者可改。本机 128 个工程全部声明，33 个纯黑。
- 2.8.42 静态分析，地址都在这个版本上。

## 已定（2026-11-07 用户）

- 不做 Free，按 Kabegame 的 fill / fit / stretch / center / tile 实现。
- 留白学 WPE 用 `schemecolor`。
- 预览不做缩放拖动：页面要收指针事件，滚轮和拖动都进了 iframe，要做得先定交互。
- 网页壁纸不跟样式：页面没有固有尺寸，铺满窗口就是它的排版，WPE 原生端也不画网页的留白。预览里仍按主屏尺寸排版。

## 后续

- 退回预览图时的留白不是 `schemecolor`，要做得把颜色传给 Stage。
- 指针在 fit / center 下的换算是我们的选择，WPE 在这些对齐下怎么算没有查过。
