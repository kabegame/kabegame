/**
 * 一份 `SceneBundle` 在某个设备上的全部 GPU 资源与每帧编码。
 *
 * 每个可见图层先由 `graph.ts` 排成步骤：直接上屏（P1 路径）、合成链（基础 pass → 合成 RT → effect pass → 上屏）、
 * passthrough、`_rt_FullFrameBuffer` 快照、effect 的 `copy` / `swap`。这里照步骤建纹理、合成 RT、fbo、管线、
 * 每个绘制步骤的顶点 / uniform 缓冲与 bind group，每帧按顺序编码：画到场景目标的步骤合并进同一个 render pass，
 * 画进合成 RT / fbo、拷快照与 copy 时先结束场景 pass，之后再以 `load` 接着画。铺到画布由 `SceneRenderer` 负责。
 *
 * - 快照：`copyTextureToTexture` 把场景目标整张拷进独立纹理，绝不采样正在写的目标（LWE 的 GL 反馈环在 WebGPU 里是校验错误）。
 * - 合成 RT 按尺寸与采样方式跨图层共享（WPE `sc.<W>.<H>…`，p2-REPORT B5）：图层依次画，每层的基础 pass 先整张覆盖。
 *   非 unique 的 fbo 按名字、尺寸、格式、寻址共享，unique 的每层独占（B6）。
 * - `swap` 只改 fbo 名 → 实体的对应（`FboBindings`），跨帧保留；引用 fbo 的 bind group 按当前对应取（缓存）。
 * - 泛光（`bundle.bloom`，P2b）：全部图层之后拷一次快照、跑 `BloomChain`，combine 写回场景目标；没有泛光时不多任何拷贝或 pass。
 *   开关每帧读 `SceneState.bloomEnabled`（A1），关着时和没有链走同一段代码，画面逐字节相同。HDR 在加载时判定，读场景文件、和开关无关（K3），运行中关泛光，目标格式与 `brightness` 都保持 HDR。
 * - HDR：场景目标、快照、合成 RT 都是 `rgba16float`（`*_backbuffer` fbo 编译期已换算），图层颜色乘 `brightness`（B10）。
 * - effect 开关（3c，对齐 WPE，p3-script-REPORT J 节）：分两段。加载时 `prepareVariants` 把可变图层可能用到的程序与管线全部建好
 *   （关着的 effect 也一样）；切换时 `sync` 当场重排图层（`rebuildLayer`），不编译、不等待，返回时新结构已换上。脚本在 `sync` 之前运行，
 *   所以脚本写的开关同一帧就画。加载与切换共用 `buildLayer`，「就地 = 重编译」靠的就是这一点。
 *   每次切换清掉本图层全部带 `clear` 的 fbo，其余内容与 swap 状态保留（J6）。预建失败的图层切换时走整场重编译。
 * - 清屏（L4、L11）：`clearcolor` 与 `clearenabled` 每帧读，脚本写入同帧生效。`clearenabled: false` 是不清屏，不是清成黑色：
 *   WPE 画进两张交替的后备缓冲，第 N 帧的底图是第 N−2 帧的成品，两条链互不相交，所以这里同样用两张场景目标逐帧交替。
 *   泛光的 combine 写当前这张，底图含泛光（L20）。第二张只在清屏可能关掉时建（`SceneGeneral.clearVariable`），别的场景资源不变。
 *   HDR 下 WPE 的后备缓冲存 `lin(x)`，累加因此收敛（L21），我们的目标存 `x`，所以开画之前把底图过一次 `lin`（`linearizeBase`）。
 * - 层级（P4a 步骤 1）：模型矩阵是沿父链累乘的世界矩阵（`worldMatrixOf`），`visible` 沿父链继承（`visibleObjects`），
 *   绘制顺序仍是 `objects` 顺序。写死不可见的祖先下面的图层不建资源（`buildableLayers`）。图层画自己（含组的局部正交）另乘自身偏移
 *   （`drawMatrixOf`：文本排版、图像层对齐，P8 步骤 3），子层、粒子、控制点、模型的剔除不带它。
 * - 粒子（P4a 步骤 4）：粒子层是一个 `particle-tree` op，和图像步骤按 `objects` 顺序混排、画在同一个场景 pass 里。
 *   有子系统时一个粒子层是若干次绘制（P4e 步骤 1、2）：整棵树一个模拟器（根 `ParticleSystem`，子系统与事件实例挂在它下面），只步进根；
 *   编码时沿 `ParticleSystem.forEachDrawn` 的先序每帧现排（`arrangeParticles`）：每个被画的系统按模板路径找到计划里那个步骤预备好的管线，
 *   再按「这个模板本帧第几次出现」取模板 draw 池里的一个 draw（各有顶点缓冲与 uniform，模型矩阵由 `forEachDrawn` 给）。顶层与 static
 *   子孙每帧恰好一次，draw 建场景时就建好；事件实例（及其子孙）的 draw 第一次用到时建、之后复用、不回收，模型矩阵变了就重写 uniform；
 *   快照插在本帧先序里第一个需要帧缓冲的系统之前，每对象至多一次。没有事件条目的场景，绘制顺序、uniform 与 draw 和步骤 1 逐字节相同。
 *   每个粒子层一个 `ParticleSystem`（种子默认随机，探针可固定；建场景时预热），顶点缓冲按 `maxcount` 分配，索引缓冲全场一份、
 *   只建一次。调用方每帧先 `stepParticles`（脚本之前，P4c 步骤 4）再 `update`，`encode` 把列写成顶点、`writeBuffer` 后
 *   `drawIndexed`。MVP = 视图投影 × 模型矩阵：本地系统是对象世界矩阵，世界空间系统（`flags & 1`）是单位阵；`flags & 4` 换透视
 *   粒子的视图投影。混合、纹理、材质常量走和图像 pass 相同的路径。
 *   帧表（P4b 步骤 2）：槽 0 的纹理带帧表时 `g_RenderVar1` 取它的 `sheet`，顶点多写 `a_TexCoordVec4C1`，帧数学在着色器里。
 *   rope（P4d 步骤 1）：程序带 `geometry`（翻译器把几何着色器展开进顶点着色器）时，顶点按实例步进、每段一个实例，顶点缓冲按
 *   `maxcount` 段分配，`encode` 按 rope 表写段顶点（`particles/rope.ts` 的 `writeRopeSegments`），三角形带
 *   `draw(maxVertices, 段数)`，段数为 0 不画；不用索引缓冲。ropetrail（P4d 步骤 2）同一条路，按 renderer 换布局与写入函数：每个存活
 *   粒子按槽序恒写 n 段（`particles/ropetrail.ts` 的 `writeTrailSegments`），顶点缓冲按 `maxcount × n` 段分配，`g_RenderVar0` 每帧按
 *   系统的计时器写（`update`，`trailRenderVar0`）。
 * - 视差（P5a 步骤 2）：渲染器每帧交来视差点 P 与 amount（`setParallax`，关着时为 null）。每次绘制的视图投影换成 `VP · T(o)`，
 *   o 按 draw 所属对象的根对象算（`render/parallax.ts` 的 `parallaxOffset`）：图像层直接上屏、带 effect 图层的每个 pass（基础 pass
 *   用自己的整面矩阵，本来就不读 VP）、正交与透视粒子都一样（p5-REPORT `p5a-fx`：WPE 画整个对象之前把视图换成带视差的）。粒子模拟与
 *   控制点反投影仍用不带视差的 `viewProjection`（跟随指针的粒子出生在不含视差的反投影点）。矩阵属于静态 uniform：P、开关或 amount 变了
 *   全部 draw 重写一遍，对象原点、根的 `parallaxDepth` 变了照旧经 `dirty.layers`。
 * - 抖动（P5a 步骤 3）：渲染器每帧交来 eye 偏移 s（`setCamera`，`render/shake.ts`，关着时 (0, 0)）。正交相机的 eye 与 center 加
 *   同一个 s，视图就是 `T(−s)`：场景级的 `viewProjection`、透视粒子的 `perspectiveViewProjection` 都右乘它（透视粒子的覆盖改的是当前
 *   V 的平移分量，当前 V 已带抖动，rea-p5-camera.md 7.2），眼位（`g_EyePosition` 与拖尾的 `trailEye`）加 s。视差的 `T(o)` 也是纯平移，
 *   所以每次绘制是 `VP · T(−s) · T(o) = VP · T(o − s)`。粒子模拟与指针反投影用带抖动、不带视差的 `viewProjection`；渲染器在粒子步进
 *   之后才交本帧的 s，所以模拟用的是上一帧的（WPE 先更新对象、后更新相机，`p5a-shakepar` 实测，见 `SceneRenderer.render`）。
 *   `setCamera` 只改场景级的值，全部 draw 的重写和视差共用一次，在 `setParallax` 里（相机或视差变了才刷）。
 *   关着时 s 恒为 (0, 0)，矩阵与眼位逐字节同以前。
 * - 缩放（P5a 步骤 4）：`general.zoom` 随 s 一起交来（`setCamera`），时机同抖动（粒子模拟用上一帧的）。正交投影绕场景中心乘 zoom
 *   （`sceneViewProjection`），透视粒子的相机距离按缩放后的可见高算（`particleViewProjection`，rea-p5-camera.md 7.2）；zoom 变了只重算
 *   这两份基准矩阵，平移照旧右乘，所以每次绘制是 `VP(zoom) · T(o − s)`（视差、抖动是场景单位，在缩放之前加，步骤 4 补测）。眼位与视差点
 *   不随缩放变。建场景时取编译期的值，zoom 为 1 时逐字节同以前。
 * - 透视相机（P5d 步骤 2，`render/camera.ts`）：透视场景（`SceneGeneral.perspective`）的场景目标按 `build` 的 `size`（画布尺寸）建，
 *   场景级的视图投影换成 `P·V`（`setCamera` 的透视那一种，渲染器每帧交，时机同抖动），`g_EyePosition` 是相机的 eye，视图向量
 *   `g_ViewForward` / `Right` / `Up` 与粒子朝向用的视线、上方向换成相机的（正交场景是常量，字节不变）。视差不移动对象、zoom 不起作用；
 *   透视粒子那一份（`perspectiveViewProjection`）不算（照报）。建场景时先按加载时的相机（`initialPerspectiveFrame`）。
 * - 透视图层（P5b 步骤 1，p5-REPORT `p5b-persp`）：对象 `perspective: true` 的图像层只在画到场景目标的绘制（直接上屏、带 effect 的
 *   末 pass、passthrough 上屏）把视图投影换成透视粒子那一份（`perspectiveViewProjection`），所以和透视粒子同一份矩阵：相机距离随
 *   `perspectiveoverridefov` 与 `zoom` 变，带抖动的 `T(−s)`。视差平移照旧右乘，在投影之前，每次绘制是 `P_persp · T(o − s) · W`
 *   （`p5b-persp-par`：偏移落在 z = 0 平面上正好是屏幕上的 o 像素）。画进合成 RT 的基础 pass 不变；effect 中间 pass 的效果矩阵
 *   （`g_EffectModelViewProjectionMatrix` 等）仍按正交算：rea-p5-modelflags 1.3 读到的是只在上屏时压相机，rea-p5-camera 7.1 另提到
 *   正交 + bit7 时图层合成矩阵经 `FUN_140184f00` 换算，都没有实测（语料里透视图层的 effect 只读 MVP）。
 * - 组合层（P5b 步骤 2，p5-REPORT `p5b-cl`、`p5b-proj`）：组合层在 `graph.ts` 里排成普通的合成路径（带子层的见下「组」），这里只多认两样东西。
 *   `compose` 角色的绘制是基础 pass：管线同 `base`（关混合、四通道直写），uniform 取图层 MVP（`drawMatrices`，视差与抖动照常在
 *   视图投影里）；顶点是图层四边形，composelayer 着色器自己按 a_TexCoord 铺满合成 RT，按 MVP 算出的屏幕位置采快照。`clear` 步骤
 *   （`copybackground: false`）建成一个 op：先结束场景 pass，再对目标开一个 `loadOp: "clear"`、清成 (0, 0, 0, 0) 的 render pass，
 *   不画基础材质。不画的组合层（没有启用的 effect、colorBlendMode ∈ {0, 31}）是空计划，没有 op、不建 draw；运行时 effect 开关切到
 *   这种状态时图层重建成空计划（`variantPlans` 的「全关」那份就是它）。
 * - fullscreen（P5b 步骤 3，p5-REPORT `p5b-fs`、`p5b-fsnofx`、`p5b-fsmvp`）：`geometry: "fullscreen"` 的绘制画 2×2 的 NDC 四边形，
 *   UV 取步骤的 `uv` / `inset`（effect 中间 pass 本来就是 (1, 1)、不内缩，字节同以前）。fullscreen 图层直接上屏（`direct`）时矩阵照常
 *   （场景视图投影 · 视差 · W，透视图层换透视），着色器乘 MVP 就是被 W 变换的 2×2 方块；其余角色（effect、末 pass、passthrough
 *   上屏）的世界矩阵是单位阵、视图投影是 NDC 正交 `FULLSCREEN_VIEW_PROJECTION`，不经 `viewProjectionOf`，所以没有视差、抖动、
 *   透视，正好铺满全屏（`p5b-fs` 事件 76 的 MVP）。合成路径的基础 pass 是 `copy`（快照 → 合成 RT 0）：源是 `framebuffer`，
 *   `resolveTexture` 取快照，拷贝尺寸取两边较小值；合成 RT 是场景尺寸时就是整张。
 * - 组（P5b 步骤 4，带子层的组合层，p5-REPORT `p5b-grp-*`、`p5b-nest`、`p5b-grpptc`）：子孙（`SceneLayer.group` 非空）在顶层不画，
 *   由组的 `subtree` op 画：先结束当前 pass，按 `layer.subtree`（先序）依次跑可见子孙的 op，它们「画到场景」的绘制改画进组当前的
 *   合成 RT（连着的合进一个 pass），画进自己合成 RT / fbo 的照旧；嵌套组同样递归，它的上屏画进外层组的合成 RT。
 *   - 矩阵：组里图层的绘制（除了嵌套组自己的 `compose` 基础 pass）视图投影换成 `groupViewProjection`（`layout.ts`，
 *     `ortho(±w/2, ±h/2, ±1000) · inverse(W_组)`，w、h 是组的 `size`），不经 `viewProjectionOf`：没有视差、抖动、缩放、透视，这些只作用在
 *     组本身（`p5b-grp-par`）。世界矩阵照旧，粒子同样（世界空间系统的单位模型矩阵乘它正好回到本地）。嵌套组的 compose 照旧用场景视图
 *     投影采快照（`p5b-nest` 事件 94）。组的 `W` 变了时子孙随父链标脏（`SceneState.write`），uniform 跟着重写；组的 `size` 改值整场重编译。
 *   - 管线：组里画到「场景」的绘制写 RGBA（`p5b-grp-cb1` 事件 78–106 写掩码 15）；组 `copyBackground` 为 false 时 alpha 通道换成
 *     One / One / Max，颜色通道照绘制自己的混合、不混合的用 One / Zero（`p5b-grp-cb0` 事件 73–101，红蓝重叠处 alpha 0.5），管线键带
 *     `alphaMax`。例外是 `copyBackground` 为 true 的组里的上屏（`final` / `passthrough`：带 effect 的子层、嵌套组画回组里）只写 RGB：
 *     WPE 合成渲染结束时关掉 alpha 写入（rea-p5-modelflags §2.5 的 `vfunc_0xd8(1, 0)`），`p5b-grpptc` 事件 102、`p5b-nest` 事件 129 的
 *     写掩码都是 7。WPE 的这个开关是全局状态，之后同组里的普通绘制也不写 alpha（`p5b-grpptc` 的粒子事件 116 / 129），这一条我们没有
 *     复刻（取决于运行时可见性与 effect 开关），记为已知差异。
 *   - 快照：组里的 `snapshot` op 照常拷真正的场景目标（组里的绘制都不落在场景目标上，内容就是组开始时那份，同 WPE）。
 *   - 合成 RT 池按「父链上组的层数」分开（WPE B5 的池化 RT 名里的 k）：组画子树期间它的合成 RT 一直在用，子孙自己的合成 RT 不能和它
 *     共享同一张，否则子孙的基础 pass 会把组的内容覆盖掉，或者同一张纹理在一个 pass 里既是目标又被采样。顶层图层的池键不变。
 *   - 组隐藏时（含祖先）整棵子树不画：组的 op 整段跳过，子孙在顶层本来就不画。
 * - 视频纹理（P9a 步骤 2）：建成初值全 0 的 `rgba8unorm`（`uploadTexture`），绑定组建一次不再变。每个 draw 建时记下它绑定的视频纹理
 *   （`Draw.videos`，只看着色器真正绑定的槽，同 WPE 逐槽更新，rea-p9-video 第 2 节第 4 条），编码时画到它就问 `VideoSink`（`drawn`），
 *   有新帧就 `copyExternalImageToTexture`（`copyVideo`），对应 WPE 绑定纹理时的 `TransferVideoFrame`。拷贝是队列操作，排在本帧
 *   提交之前，所以先于这一帧的绘制（同粒子顶点的 `writeBuffer`）。图像、effect、粒子的 draw 一视同仁；不可见图层整段跳过，
 *   不问 → 播放器 30 帧后暂停（rea 第 4 节）。没有 sink（dev 探针自己建的场景）时纹理保持全 0。
 * - 粒子生命周期（P4a 步骤 5）：`instanceoverride` 就地写由 `sync` 交给模拟器（从基值重新乘，不重建缓冲；只写了 `rate` 时只改
 *   步进率，P4f 步骤 1）；不可见（含祖先）
 *   的粒子层不发射，有存活粒子就清空，重新可见不重新预热（C8）；暂停 / 补画帧时间为 0，不步进；粒子缓冲随场景 `destroy`
 *   释放，换场景或重编译时新场景重新预热。
 * - 文本（P6b 1d）：排版结果由宿主在加载前排好，经 `build` 的 `texts` 进 `SceneState.texts`（对齐偏移进图层的世界矩阵）。`text` 步骤
 *   的 draw 自带顶点（排版出的逐字四边形或背景四边形，按程序布局打包）与索引缓冲（uint16，三角形列表），uniform 走 `textUniformValues`
 *   （`textMatrices`）。字形图集是第一种运行时纹理（`render/text.ts`）：每个 `GlyphAtlas` 对象一张，同一「字体 + 字号」的层共用，建场景
 *   时整张上传，`sync` 按脏区增量上传；`atlas` 引用经图层资源解析。文本层的图层四边形、合成 RT 与 fbo 都按排版的尺寸；开了背景、走合成
 *   时 `clear` op 每帧按背景常量与图层 alpha 现算清屏色。
 *   运行中重排（P6b 1e）：`build` 的 `relayout`（宿主 `SceneTexts.relayouter()`）是重排器。`sync` 最先处理 `dirty.texts`：逐层按
 *   `SceneState.textFields` 重排、`setText` 换进状态（偏移变了本层与子孙的矩阵跟着刷，同一次 `sync`）；某张图集因到 4096 清空重排过
 *   （`GlyphAtlas.resets` 变了）时用它的别的层也重排（已定 5）；缺字体时重排器返回 null，旧排版照画，宿主读完字体再标脏。之后图集纹理
 *   增量上传，扩容了的重建纹理、用它的层一起重建；最后对这些层 `rebuildLayer(…, { force: true })`：整层重建 draw（新顶点、新索引），
 *   合成 RT 与 effect fbo 由本层独占、不进共享池（建场景时也一样，已定 6），尺寸和新排版不同就销毁旧的、按新尺寸建，图集按新排版重新取。
 *   `prepareVariants` 对文本层按「两种字形都有」的假想排版备好全部步骤的管线，运行中步骤增减不会缺管线。合成 RT 是排版的 `compositeSize`
 *   两维 `max(4, ·)`（`graph.ts` 的 `textCompositeSize`）。重排与重建的次数与用时由 `textStats()` 给 dev 探针。
 * - 模型（P5c 步骤 2，p5-REPORT「P5c 语义的实测核对」）：模型层是一个 `model` op，编码时先做视锥剔除（`render/mesh.ts` 的
 *   `frustumCulled`，平面取场景级的视图投影），没被剔就按 `model.order` 画各网格，和图像步骤、粒子在同一个场景 pass 里按 `objects` 顺序。
 *   网格的顶点与索引是 mdl 的字节原样上传，按文件缓冲上的视图去重（同一个 mdl 的几个对象共用一份，`meshBuffer`），随场景销毁；
 *   `drawIndexed`、三角形列表。顶点布局按网格格式（`meshVertexLayout`），网格没有的属性接全场一份的全零占位缓冲（槽 1，`arrayStride` 0）。
 *   管线比图像层多一项布局键（`pipelineKey` 只在出现时加后缀；背面剔除 P5c 时只有网格有，P5d 步骤 1 起所有步骤一样，见下「深度与
 *   剔除」）。uniform 同图像层直接上屏（视差、抖动、缩放，`perspective: true` 换透视那一份），颜色组固定为 1。
 * - 形状（P8 步骤 2，`SceneLayer.shape`）：渲染图只有一步 `final`（`planShapeLayer`），这里只在两处认它：建 draw 时 `geometry: "shape"`
 *   的顶点是 `shapeQuad`（effect 常量的四个点），矩阵走 `drawMatrices` 的形状分支（效果矩阵取 WPE 给形状的那组值）。`buildableLayers`
 *   收形状层（它的 `passes` 为空）。管线照 `final`：画到场景时写 RGB、三角形带。
 * - 深度与剔除（P5d 步骤 1，p5-REPORT「P5d 语义的实测核对」）：每个绘制步骤的 `raster`（`graph.ts` 的 `rasterState`）定管线的剔除与深度
 *   （`stepPipeline`）。剔除对所有步骤生效（`cullMode: "back"`、`frontFace: "ccw"`）。深度附件按需建（`wantsDepth`）：加载时的计划与
 *   预建的变体里有一个「画进场景目标、不在组里、而且测深度」的步骤，才给场景目标配一张同尺寸的 `depth32float`（两张交替的场景目标共用）；
 *   有它时画进场景目标、不在组里的管线都带 `depthStencil`（测 GREATER、不测 always），组里的与画进合成 RT / fbo 的不带，泛光链与
 *   `linearizeBase` 各开自己的 pass、也不带。每帧第一个场景 pass 清颜色时深度一起清 0（反向 Z），其余 load，`clearenabled: false` 时
 *   深度也不清。没有这种步骤的场景不建深度，管线与 render pass 和改前逐字相同。
 * - 被依赖（P8 步骤 4，`SceneLayer.dependedOn`，rea-p8-render 第 1、2 节，p8-REPORT 结论 7–9）：渲染图已排成合成路径（`graph.ts`），这里
 *   多认三样东西。
 *   - 独占 RT：`populate` 在建完全部 runtime 之后、任何 `buildLayer` 之前给每个被依赖的图层建一张（`layerTargets`，尺寸 `compositeSize`、
 *     场景格式、采样 `compositeSampling`，同它的合成 RT），随场景销毁；它就是本层的合成 RT 0（`ensureComposites`），其余从池里借。跨帧、
 *     跨 effect 开关的重建都保留、不清（WPE 帧之间不清；被依赖者排在引用方后面时引用方读到上一帧，结论 9）。引用方的
 *     `{ kind: "layer" }` 解析到它（`resolveTexture`），几个引用方共用同一张，采样器与 `g_Texture<n>Resolution` 随它。
 *   - 建资源：`buildableLayers` 不看被依赖图层自身与祖先的可见性（WPE `0x1000`）。
 *   - 编码：不可见（自身或祖先）时照跑它的 op，只跳过画到「场景」的那一步上屏（`layerOpsToRun`），顶层与组画子树两处同一个判断。
 *     语料里的被依赖者都不是组（是组的照报 `dependency:group`），组隐藏时整棵子树照旧不画。
 */
import { HDR_BLOOM_MATERIALS, LDR_BLOOM_MATERIALS } from "../compile/bloom";
import type { TargetKey } from "../compile/bindings";
import type { SceneBundle, SceneFbo, SceneLayer, SceneModel, ScenePass, SceneTexture } from "../compile/bundle";
import { layerCompositeName } from "../compile/dependencies";
import type { ParticleRenderer, SceneParticle } from "../compile/particles";
import { FBO_FORMATS } from "../compile/tex";
import { silentParticleAudio, type ParticleAudio } from "../particles/audio";
import { pointerScenePoint, type ControlPointInputs } from "../particles/controlpoints";
import { orientationBasis } from "../particles/orientation";
import {
  initialPerspectiveFrame,
  ORTHO_VIEW_VECTORS,
  type OrthographicCameraFrame,
  type PerspectiveCameraFrame,
  type ViewVectors,
} from "./camera";
import { SeededRandom, type ParticleROverride } from "../particles/random";
import { ropeVertexLayout, writeRopeSegments, type RopeVertexLayout } from "../particles/rope";
import { trailRenderVar0, trailVertexLayout, writeTrailSegments, type TrailVertexLayout } from "../particles/ropetrail";
import { ParticleSystem, particleNode } from "../particles/system";
import { summarizeParticles, type ParticleSummary } from "../particles/track";
import {
  particleVertexLayout,
  quadIndices,
  trailEye,
  writeVertices,
  type ParticleVertexLayout,
} from "../particles/vertices";
import type { ParticleScriptTarget } from "../script/api";
import type { GlyphAtlas } from "../text/atlas";
import type { TextRelayouter } from "../text/host";
import type { TextLayout } from "../text/layout";
import type { VideoSink } from "../video/sceneVideos";
import type { TextureBinding } from "../wpesl2wgsl";
import { BloomChain } from "./bloom";
import { oneLine, SceneRenderError } from "./errors";
import {
  compositeSampling,
  compositeSize,
  FboBindings,
  fboSize,
  particleTreeWantsFramebuffer,
  planLayer,
  planSignature,
  textCompositeSize,
  variantPlans,
  type DrawStep,
  type LayerPlan,
  type MeshStep,
  type ParticleStep,
  type TargetRef,
  type TextStep,
  type TextureRef,
} from "./graph";
import {
  drawMatrixOf,
  effectiveVisible,
  everyAncestor,
  eyePosition,
  groupViewProjection,
  layerQuad,
  particleViewProjection,
  rootObject,
  sceneTargetSize,
  sceneViewProjection,
  screenQuadSize,
  shapeQuad,
  worldMatrixOf,
} from "./layout";
import { identity, multiply, orthographic, translation, type Mat4 } from "./math";
import { alignedBytes, frustumCulled, MESH_PLACEHOLDER_BYTES, meshVertexLayout, type MeshVertexLayout } from "./mesh";
import { parallaxOffset, type SceneParallax } from "./parallax";
import {
  createPipeline,
  createProgram,
  depthFlags,
  programVertexPacking,
  SCENE_DEPTH_FORMAT,
  type GpuProgram,
} from "./programs";
import type { DirtyState, LayerState, SceneState } from "./state";
import { ATLAS_SAMPLER, backgroundQuadVertices, TextAtlasTextures, textIndexData, textQuadVertices } from "./text";
import { requiredFeatures, samplerDescriptor, uploadTexture } from "./textures";
import { traceUniforms } from "./trace";
import {
  drawUniformValues,
  frameBuiltins,
  layerRefreshNames,
  LIGHT_UNIFORMS,
  PARTICLE_REFRESH_UNIFORMS,
  particleUniformValues,
  textUniformValues,
  UniformBlock,
  type FrameInput,
  type UniformEntry,
} from "./uniforms";

export { drawMatrices } from "./uniforms";

/** 离屏目标格式：WPE 在 gamma 空间混合，用非 sRGB 格式。合成 RT 在 LDR 下也是它（B5）。 */
export const SCENE_TARGET_FORMAT: GPUTextureFormat = "rgba8unorm";
/** HDR 下的场景目标、快照与合成 RT（A4，J5 抓帧：后备缓冲与合成 RT 都是 RGBA16F）。 */
export const HDR_TARGET_FORMAT: GPUTextureFormat = "rgba16float";

/**
 * fullscreen 图层（P5b 步骤 3）除直接上屏以外的视图投影：WPE 的 `ortho(−1, 1, −1, 1, −1, 1)`（`p5b-fs` 事件 76 的 MVP
 * `[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1]`），x、y 不变、z ∈ [−1, 1] → 深度 [0, 1]，z = 0 落在 0.5（同场景正交）。
 * `orthographic` 按 glm 的「视空间 z ∈ [−far, −near] → [0, 1]」，所以 near、far 反着传（同 `sceneViewProjection`）。只读，不要改它。
 */
const FULLSCREEN_VIEW_PROJECTION: Mat4 = orthographic(-1, 1, -1, 1, 1, -1);

export function sceneTargetFormat(hdr: boolean): GPUTextureFormat {
  return hdr ? HDR_TARGET_FORMAT : SCENE_TARGET_FORMAT;
}

/** 底图逐像素过 `lin`（WPE `passthroughsrgb.frag`，公式不变）：见 `GpuScene.linearizeBase`。 */
const LINEAR_BASE_WGSL = /* wgsl */ `
@group(0) @binding(0) var base: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let value = textureLoad(base, vec2<i32>(position.xy), 0);
  let c = step(vec3<f32>(0.04045), value.rgb);
  let rgb = c * pow((value.rgb + 0.055) / 1.055, vec3<f32>(2.4)) + (1.0 - c) * (value.rgb / 12.92);
  return vec4<f32>(rgb, value.a);
}
`;

/** 每像素字节（显存估算用）。 */
function texelBytes(format: GPUTextureFormat): number {
  if (format === "rgba16float") return 8;
  if (format === "rg16float") return 4;
  if (format === "r16float" || format === "rg8unorm") return 2;
  if (format === "r8unorm") return 1;
  return 4;
}

/** 一张场景目标。 */
interface SceneTarget {
  texture: GPUTexture;
  view: GPUTextureView;
}

interface RenderTarget {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

/**
 * 一个图层用到的合成 RT（可能来自共享池）与 fbo 名 → `targets` 下标的对应。
 * 跨单图层重建保留：合成 RT 只增不减，fbo 的 swap 状态不丢。文本层（P6b 1e）的合成 RT 与 fbo 由本层独占，排版尺寸变了就换成新尺寸的
 * （fbo 在同一个下标上换，对应与 swap 状态不丢），图集随排版重新取。
 */
interface LayerResources {
  composites: RenderTarget[];
  fbos: FboBindings;
  /** 文本层（P6b 1d）本层排版所在的图集纹理（`atlas` 引用解析到这里）；其它图层没有。 */
  atlases?: { main: RenderTarget; color: RenderTarget | null };
}

/** 一个绘制步骤等齐的程序与管线（`prepareLayer`）。 */
interface PreparedDraw {
  program: GpuProgram;
  pipeline: GPURenderPipeline;
}

/** 图层的绘制步骤、粒子层的绘制、文本层的绘制，或模型的网格绘制（`graph.ts`）：都画一次，共用 draw 的 uniform / bind group / 管线路径。 */
type DrawLike = DrawStep | ParticleStep | TextStep | MeshStep;

/** 文本层一次绘制的索引（P6b 1d）：三角形列表，每四边形 6 个。 */
interface TextDraw {
  indexBuffer: GPUBuffer;
  indexFormat: GPUIndexFormat;
  count: number;
}

/**
 * 一次网格绘制（P5c 步骤 2）：索引缓冲（按 mdl 视图共用，`meshBuffer`）、索引格式（网格标志 bit0）与个数，以及占位缓冲（网格没有、着色器
 * 声明了的属性接到槽 1，`meshVertexLayout`；没有时为 null）。顶点缓冲在 `Draw.vertexBuffer`，同样共用，图层重建时不释放。
 */
interface MeshDraw {
  indexBuffer: GPUBuffer;
  indexFormat: GPUIndexFormat;
  count: number;
  placeholder: GPUBuffer | null;
}

/** 一次粒子绘制的系统与 CPU 侧顶点（P4a 步骤 4）。 */
interface ParticleDraw {
  /**
   * 这次绘制的系统：非实例化的模板（顶层与 static 子孙）固定是树里那个节点；实例化的模板（P4e 步骤 2）每帧由 `arrangeParticles` 按出现
   * 次序重新指派，换了就重写顶点与 uniform。
   */
  system: ParticleSystem;
  /**
   * 顶点布局：sprite / spritetrail 每粒子 4 个顶点（`particleVertexLayout`）；rope（`rope` 非空）每段一个实例（`ropeVertexLayout`），
   * ropetrail（`rope` 非空且系统有历史 `system.trail`）同样每段一个实例（`trailVertexLayout`）。
   */
  layout: ParticleVertexLayout | RopeVertexLayout | TrailVertexLayout;
  /**
   * rope 两类（P4d 步骤 1、2）：程序带 `geometry` 时非空，每个实例（段）画 `maxVertices` 个顶点（`4 + 2·subdivision`）、三角形带；
   * 其余为 null。
   */
  rope: { maxVertices: number } | null;
  /**
   * CPU 侧交错顶点，按 `units` 个粒子（每个 4 个顶点）分配；rope 按 `units` 段（每段一个实例），ropetrail 按 `units × n` 段。
   */
  vertices: Float32Array;
  /**
   * 顶点缓冲按多少个粒子分配（`particleUnits`）：非实例化的模板是系统的 `maxcount`（同以前）；实例化的模板（P4e 步骤 2）按当时的存活数
   * 分配、不够时翻倍增长到 `maxcount` 为止（`uploadParticles`）——事件子系统的 `maxcount` 语料最大 20000、条目上限最大 350，按容量
   * 给每个实例分配不可接受。
   */
  units: number;
  /** 上次写进缓冲的粒子数，`drawIndexed` 画 6 倍的索引；rope 两类是段数（实例数）。 */
  count: number;
  /** 步进过（或换了系统）、还没写成顶点：`encode` 里写 `vertices` 并 `writeBuffer`。 */
  stale: boolean;
  /**
   * 拖尾系统（renderer 是 `spritetrail`，P4c 步骤 5）写顶点时判断退化粒子用的眼位（`particles/vertices.ts` 的 `trailEye`）：
   * `(g_EyePosition, 1)` 乘这次绘制模型矩阵的逆，和 uniform 同时算（`refreshParticleGeometry`）。非拖尾系统为 null。
   */
  trailEye: [number, number, number] | null;
  /**
   * 朝向算出 NaN（`orientationBasis` 为 null，`upright` 的轴平行于视线，P4c 步骤 5）：这次绘制跳过，uniform 照常写。
   * 同样随模型矩阵更新（`refreshParticleGeometry`）。
   */
  hidden: boolean;
  /** 模板路径经过事件条目（`ParticleStep.instanced`，P4e 步骤 2）。 */
  instanced: boolean;
  /**
   * 上次写进 uniform 与几何（`hidden`、`trailEye`）的模型矩阵（`ParticleSystem.drawTransform`）。实例化的 draw 每帧和 `forEachDrawn`
   * 给的比，不同就重写随它变的那几项（P4e 步骤 2）。
   */
  model: Mat4;
}

/**
 * 粒子层的一个模板（P4e 步骤 2）：计划里的一个 `particles` 步骤（模板路径 `step.node`）、预备好的程序与管线，以及它的 draw 池——这个模板
 * 本帧第 k 次出现用第 k 个（k 从 0 起）。非实例化的模板建场景时建第 0 个；实例化的模板第一次用到时建、之后复用、不回收（同 WPE 的池只增
 * 不减，rea-p4e-children 4.1）。
 */
interface ParticleTemplate {
  step: ParticleStep;
  prepared: PreparedDraw;
  pool: Draw[];
}

/**
 * 一个粒子层的系统树（P4e 步骤 1、2）：根系统（static 子系统与事件实例挂在它下面）、加载时对象的世界矩阵，以及按模板路径
 * （`step.node.join("/")`）索引的模板。整个粒子层是一个 `particle-tree` op。
 */
interface ParticleTree {
  object: number;
  layer: SceneLayer;
  resources: LayerResources;
  system: ParticleSystem;
  /**
   * 加载时对象的世界矩阵（`worldMatrixOf`，控制点的输入，P4c 步骤 1）：`stepParticles` 没给 `state`（dev 探针按 dt 回放）时每帧用它。
   */
  world: Mat4;
  /**
   * 最近一次交给根系统的控制点输入（建树时是预热用的那份，之后每次 `stepParticles` 换成这一帧的，可见与不可见都换）：脚本
   * `emitParticles` 用它（P4f 步骤 3：和本帧模拟用的对象 `W` 一致，已定 7）。
   */
  inputs: ControlPointInputs;
  templates: Map<string, ParticleTemplate>;
  /** 模板树里有材质需要帧缓冲的系统（`particleTreeWantsFramebuffer`）：编码时在先序里第一个这样的系统之前拷快照。 */
  framebuffer: boolean;
}

/** 实例化 draw 的顶点缓冲第一次按多少个粒子分配（不超过系统的 `maxcount`，`particleUnits`）。 */
const INSTANCE_UNITS_MIN = 64;

/**
 * 一次粒子绘制的顶点缓冲按多少个粒子分配：非实例化的模板是系统的容量（同 P4e 步骤 1 以前）；实例化的模板按需要的个数，至少
 * `INSTANCE_UNITS_MIN`、至多容量。
 */
function particleUnits(system: ParticleSystem, instanced: boolean, needed = 0): number {
  const capacity = system.columns.capacity;
  return instanced ? Math.min(capacity, Math.max(INSTANCE_UNITS_MIN, needed)) : capacity;
}

/** `units` 个粒子的 CPU 侧顶点（float 个数）：sprite 每粒子 4 个顶点；rope 每段一个实例；ropetrail 每粒子 n 段。 */
function particleFloats(
  system: ParticleSystem,
  layout: ParticleDraw["layout"],
  rope: ParticleDraw["rope"],
  units: number,
): number {
  const per = rope ? (system.trail ? system.trail.segments : 1) : 4;
  return Math.max(1, units) * per * Math.max(1, layout.stride);
}

/** 两个矩阵逐位相同（`Object.is`：NaN 与 NaN 相同，0 与 −0 不同）。 */
function sameMatrix(a: Mat4, b: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** 一个粒子层最近若干帧的开销样本（dev 探针，`GpuScene.profileParticles`）。 */
interface ParticleTiming {
  /** `ParticleSystem.step` 的用时（毫秒）。 */
  simulate: number[];
  /** `writeVertices` 的用时（毫秒）。 */
  vertices: number[];
  /** `queue.writeBuffer` 的用时（毫秒，只是排队，不含 GPU 拷贝）。 */
  upload: number[];
  /** 步进后的存活数。 */
  alive: number[];
}

/** 粒子开销记录每层最多留的帧数。 */
const PARTICLE_TIMING_FRAMES = 600;

function recordSample(list: number[], value: number): void {
  list.push(value);
  if (list.length > PARTICLE_TIMING_FRAMES) list.splice(0, list.length - PARTICLE_TIMING_FRAMES);
}

/**
 * 文本层独占的一个 effect fbo（P6b 1e，已定 6）：在 `GpuScene.targets` 里的下标、所属 effect（`layer.effects` 下标）与定义。排版的合成 RT
 * 尺寸变了时按新尺寸在同一个下标上换一张（`FboBindings` 的对应与 swap 状态不变）。
 */
interface TextFbo {
  id: number;
  effect: number;
  fbo: SceneFbo;
}

/** fbo 的纹理格式：`FBO_FORMATS` 的 GPU 格式，不认识的按 rgba8unorm。 */
function fboFormatOf(fbo: SceneFbo): GPUTextureFormat {
  return (FBO_FORMATS[fbo.format]?.gpu ?? "rgba8unorm") as GPUTextureFormat;
}

/**
 * 一层在一次 `sync` 里最多重排几次（P6b 1e）：图集重置（已定 5）会让这次已经排过的层再排一次；再排还连环重置时停下，留到下一次脏。
 */
const TEXT_RELAYOUT_LIMIT = 2;

/** 几份排版用到的图集（主图集与彩色图集，去重）；空排版、null 不算。 */
function layoutAtlases(...layouts: (TextLayout | null | undefined)[]): GlyphAtlas[] {
  const out = new Set<GlyphAtlas>();
  for (const layout of layouts) {
    const mesh = layout?.mesh;
    if (!mesh) continue;
    out.add(mesh.atlas);
    if (mesh.colorAtlas) out.add(mesh.colorAtlas);
  }
  return [...out];
}

/**
 * 把同一次 `sync` 里第二次取走的脏项并进第一次的（P6b 1e：`setText` 标的脏图层要在这一次 `sync` 里刷）。`texts` 不并：文本已经处理过，
 * 调用方把它们重新标回状态（留给下一次 `sync`）。
 */
function mergeDirty(into: DirtyState, from: DirtyState): void {
  for (const item of from.layers) into.layers.add(item);
  for (const item of from.passes) into.passes.add(item);
  for (const item of from.structures) into.structures.add(item);
  for (const item of from.particles) into.particles.add(item);
  into.bloom ||= from.bloom;
  into.lights ||= from.lights;
}

/** 一组样本的均值、p95 与最大值（保留两位小数）；没有样本时都是 0。 */
export function timingStats(samples: readonly number[]): { mean: number; p95: number; max: number } {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (!samples.length) return { mean: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    mean: round(mean),
    p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
    max: round(sorted[sorted.length - 1]),
  };
}

/** 一个粒子层的开销统计（`GpuScene.particleProfile`）。 */
export interface ParticleProfile {
  object: number;
  name: string;
  capacity: number;
  /** 记录到的模拟帧数（最多 600）。 */
  frames: number;
  alive: ReturnType<typeof timingStats>;
  simulateMs: ReturnType<typeof timingStats>;
  verticesMs: ReturnType<typeof timingStats>;
  uploadMs: ReturnType<typeof timingStats>;
}

/** 粒子层的运行时选项（`GpuScene.build`）。 */
export interface ParticleOptions {
  /** operator 遍数（`particlePasses(maxFps)`）；缺省 1。 */
  passes?: 1 | 2;
  /**
   * 宿主的帧上限（`maxFps`，和 `passes` 同一个值算出来的）：rope 绳没满时把期望粒子数估成 `min(fps, R)·L`（rea-p4d-rope.md 1.2，
   * WPE 读设置的 `fps`，`particles/rope.ts` 的 `ropeTexCoords`）。缺省 60（同 `passes` 缺省的一遍）。
   */
  fps?: number;
  /** 随机种子：第 i 个粒子层（`bundle.layers` 里带 `particle` 的，按顺序）用 `seed + i`，同 `particles/track.ts`。缺省随机。 */
  seed?: number;
  /**
   * 按粒子层（`objects` 下标）给出生时 `R` 的替换（`ParticleROverride`），每建一个模拟器调一次。只给 dev 探针用（`renderFrame` 的
   * `particles.random`，替换的实现在探针侧），产品路径不传。
   */
  rOverride?: (object: number) => ParticleROverride | undefined;
  /**
   * 加载时刻光标下的场景纹理坐标（`render/layout.ts` 的 `sceneCursor`，P4c 步骤 2），加载时的控制点更新和预热按它算指针的
   * 跟随点（WPE 加载时也读当时的指针，rea-p4c-sim.md 1.3、1.7）。缺省场景中心 `(0.5, 0.5)`。
   */
  cursor?: readonly [number, number];
  /**
   * 粒子读的 16 段频谱（P4e 步骤 4，`particles/audio.ts`）：渲染器给场景频谱的 `L16` / `R16`（`SceneSpectrum`，它每帧在步进之前推进）。
   * 不给时建一份全 0 的（dev 探针回放时往 `GpuScene.particleAudio` 里直接写抓帧的值）。全部粒子层共用这一份。
   */
  audio?: ParticleAudio;
}

/** 两组数逐个相同（`Object.is`：区分 ±0 与 NaN）。 */
function same(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a.length === b.length && Array.prototype.every.call(a, (value: number, i: number) => Object.is(value, b[i]));
}

/** 正交场景一帧的相机（P5a 步骤 3、4）。`kind` 可省（P5d 步骤 2 之前的写法）。 */
export interface OrthographicSceneCamera {
  kind?: "orthographic";
  /** 抖动偏移 s（`render/shake.ts` 的 `shakeOffset`），场景单位；关着时 (0, 0)。 */
  shake: readonly [number, number];
  /**
   * 正交缩放（`general.zoom`，缺键为 1），绕场景中心乘进投影（`sceneViewProjection`）。有相机对象时是总缩放
   * `general.zoom × camera.zoom`（已算进 `cameraObject`，这里只记着）。
   */
  zoom: number;
  /**
   * 生效的相机对象的一帧（P5d 步骤 3，`render/camera.ts` 的 `orthographicCameraObjectFrame`，已含 s 与总缩放）：VP、透视覆盖、眼位与
   * 视图向量都取它。没有可见相机对象时不给，走原来的「基准矩阵 × T(−s)」（字节不变）。
   */
  cameraObject?: OrthographicCameraFrame;
}
/** 透视场景一帧的相机（P5d 步骤 2，`render/camera.ts` 的 `perspectiveCamera`）：V、P、eye 与视图向量。 */
export interface PerspectiveSceneCamera {
  kind: "perspective";
  frame: PerspectiveCameraFrame;
}
/** 一帧的相机（`GpuScene.setCamera`）：渲染器与探针在帧开头按脚本之前的 general 字段取，按场景的投影类型选一种。 */
export type SceneCamera = OrthographicSceneCamera | PerspectiveSceneCamera;

interface Draw {
  label: string;
  step: DrawLike;
  /** 粒子层的模拟器与顶点；图像层为 null。 */
  particles: ParticleDraw | null;
  /** 文本层的索引缓冲（P6b 1d）；其余为 null。 */
  text: TextDraw | null;
  /** 模型的网格绘制（P5c 步骤 2）；其余为 null。 */
  mesh: MeshDraw | null;
  /** 本 draw 的程序（dev 探针改写顶点着色器用）。 */
  program: GpuProgram;
  /** 所属图层（`objects` 下标与 bundle 里的图层，就地刷新用）。 */
  object: number;
  layer: SceneLayer;
  /** 本 pass 的稳定键（材质常量绑定按它找回 draw）。 */
  passKey: TargetKey;
  resources: LayerResources;
  pipeline: GPURenderPipeline;
  vertexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer | null;
  block: UniformBlock | null;
  /** 需要每帧刷新的内置 uniform 名（被材质值覆盖的不刷）。 */
  frameNames: string[];
  /**
   * ropetrail（P4d 步骤 2）的 `g_RenderVar0` 每帧按系统的计时器重写（`trailRenderVar0`）：粒子层是 ropetrail、块里有这个名字、
   * 材质没覆盖时为真。
   */
  trailRenderVar: boolean;
  /** 按槽位的纹理尺寸（就地刷新时复用，纹理不随属性变化）。 */
  textureSizes: readonly (TextureSize | undefined)[];
  /**
   * 着色器绑定的视频纹理（bundle 纹理下标，去重，P9a）：建 draw 时算一次，编码时逐个问 `VideoSink`（`encode` 的 `draw`）。
   * 没有视频时为空。
   */
  videos: number[];
  /** 静态 uniform 被就地改过：下一次 `update` 要整块重写。 */
  dirty: boolean;
  /** 不引用 fbo 时建一次；引用 fbo 时按当前 swap 状态取（`bindGroups` 缓存）。 */
  bindGroup: GPUBindGroup | null;
  bindGroups: Map<string, GPUBindGroup>;
  entries: (resolveFbo: (effect: number, name: string) => RenderTarget) => GPUBindGroupEntry[];
  layout: GPUBindGroupLayout;
}

/** 纹理尺寸（与 `render/uniforms.ts` 的 `TextureSize` 同形）。 */
type TextureSize = Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight">;

/** 一个图层的全部步骤与 draw：不可见时整段跳过（含它的快照），泛光的 op 单独放在最后（P3a）。 */
interface LayerRuntime {
  object: number;
  layer: SceneLayer;
  ops: Op[];
  draws: Draw[];
  resources: LayerResources;
  /** 当前 `ops` 的计划签名（`planSignature`）；重建时比较，相同就不动。 */
  signature: string;
  /** 粒子层的系统树（P4e 步骤 1、2）；图像层与没有可画模板的粒子层为 null。 */
  tree: ParticleTree | null;
}

type Op =
  | { kind: "draw"; draw: Draw }
  /** 一个粒子层：编码时沿系统树每帧现排绘制与快照（`arrangeParticles`，P4e 步骤 2）。 */
  | { kind: "particle-tree"; tree: ParticleTree }
  | { kind: "snapshot" }
  | { kind: "copy"; resources: LayerResources; effect: number | null; source: TextureRef; target: TargetRef }
  | { kind: "swap"; resources: LayerResources; effect: number; source: string; target: string }
  /**
   * 把合成 RT 清成 (0, 0, 0, 0)（组合层 `copybackground: false`，P5b 步骤 2）；`color: "text-background"` 时清成文本层的
   * (背景色, 图层 alpha)（P6b 1d，开了 `opaquebackground` 的文本层走合成）。
   */
  | { kind: "clear"; resources: LayerResources; target: TargetRef; layer: SceneLayer; color?: "text-background" }
  /** 组画子树（P5b 步骤 4）：`layer.subtree` 里可见的子孙依次画进 `target`（组当前的合成 RT）。 */
  | { kind: "subtree"; resources: LayerResources; target: TargetRef; layer: SceneLayer }
  /** 一个模型（P5c 步骤 2）：编码时先做视锥剔除，没被剔就按 `model.order` 画各网格（`draws` 就是这个顺序）。 */
  | { kind: "model"; layer: SceneLayer; draws: Draw[] };

/**
 * 决定一条管线的五项：WebGPU 的管线绑定了混合、目标格式、写掩码与图元拓扑（WPE 的 D3D11 着色器不绑），同一个程序要按它们
 * 各建一份。`topology`：sprite / spritetrail 粒子是带索引的三角形列表；图层四边形和 rope 两类（几何着色器展开，每段一个实例，
 * P4d 步骤 1、2）是三角形带。键只给三角形列表加后缀，其余和加这一项之前逐字相同（rope 两类的程序只给自己用，按实例步进的布局跟着
 * 程序走）。
 */
export interface PipelineSpec {
  program: number;
  blending: string | null;
  format: GPUTextureFormat;
  alpha: boolean;
  topology: "triangle-strip" | "triangle-list";
  /**
   * alpha 通道换成 One / One / Max（P5b 步骤 4：`copyBackground` 为 false 的组里画到「场景」的绘制，颜色通道照 `blending`，不混合的用
   * One / Zero，`programs.ts` 的 `groupBlendState`）。缺省 false；为 true 时管线键多一个后缀，其余键和加这一项之前逐字相同。
   */
  alphaMax?: boolean;
  /**
   * 模型网格的顶点布局键（P5c 步骤 2，`render/mesh.ts` 的 `MeshVertexLayout.key`）：布局按网格格式建，不由程序推出，同一个程序在不同格式的
   * 网格上要各建一份。只有网格步骤有；有时管线键多一个后缀，其余键和加这一项之前逐字相同。
   */
  mesh?: string;
  /**
   * 剔背面（屏幕上逆时针为正面）：步骤的 `raster.cull`（P5c 步骤 2 起模型，P5d 步骤 1 推广到所有步骤，`p5d-cull`）；不剔时不写，管线键
   * 不变。
   */
  cull?: "back";
  /**
   * 深度状态（P5d 步骤 1）：只在「这一步画进场景目标、不在组里、而且场景有深度附件」时出现（格式 `depth32float`，WebGPU 要求管线与 render
   * pass 的深度格式一致），`test` 为 GREATER（反向 Z，清 0）、否则 always，`write` 写深度。没有时管线键不变。
   */
  depth?: { test: boolean; write: boolean };
}

export function pipelineKey({
  program,
  blending,
  format,
  alpha,
  topology,
  alphaMax,
  mesh,
  cull,
  depth,
}: PipelineSpec): string {
  return `${program}|${blending}|${format}|${alpha}${topology === "triangle-list" ? "|list" : ""}${alphaMax ? "|max" : ""}${mesh !== undefined ? `|mesh:${mesh}` : ""}${cull ? `|cull:${cull}` : ""}${depth ? `|depth:${depthFlags(depth)}` : ""}`;
}

/**
 * 绘制步骤的管线：合成 RT 与场景目标同格式，只有 fbo 有自己的格式；画到场景目标时不写 alpha。粒子只画到场景目标。
 * `geometry`：程序的翻译结果带几何着色器展开（rope），粒子步骤用三角形带。
 * `group`：这一步所属图层在组里时是那个组（`SceneLayer.group`，P5b 步骤 4），否则为 null。组里「画到场景」的绘制实际落在组的合成 RT
 * 上（格式同场景目标）：写 RGBA（`p5b-grp-cb1` 事件 78–106）；组 `copyBackground` 为 false 时 alpha 取 MAX、写 RGBA（`p5b-grp-cb0`
 * 事件 73–101，rea-p5-modelflags §2.5 的状态 `0x10`）；组 `copyBackground` 为 true 时上屏角色（`final` / `passthrough`）只写 RGB，
 * WPE 在每个合成渲染结束时关掉 alpha 写入（`p5b-grpptc` 事件 102、`p5b-nest` 事件 129 的写掩码 7）。
 * `mesh`：网格步骤（P5c 步骤 2）的顶点布局键（`meshVertexLayout`），网格是三角形列表。
 * 剔除与深度（P5d 步骤 1）按步骤的 `raster`（`graph.ts` 的 `rasterState`）：`cull` 对所有步骤、所有目标都起作用；深度只在
 * `sceneDepth`（场景目标带深度附件）时、这一步画进场景目标且不在组里才给（组里「画到场景」的落在组的合成 RT 上，WPE 的合成 RT 不挂
 * 深度）。场景没有深度附件时，管线键与改前逐字相同（剔除照旧只看 `raster.cull`）。
 */
export function stepPipeline(
  step: DrawLike,
  format: GPUTextureFormat,
  fboFormat: (effect: number, name: string) => GPUTextureFormat,
  geometry = false,
  group: Pick<SceneLayer, "copyBackground"> | null = null,
  mesh?: string,
  sceneDepth = false,
): PipelineSpec {
  const { pass, blending, target, raster } = step;
  const inGroup = !!group && target.kind === "scene";
  const alphaMax = inGroup && !group.copyBackground;
  const upload = step.kind === "draw" && (step.role === "final" || step.role === "passthrough");
  return {
    program: pass.program!,
    blending,
    format: target.kind === "fbo" ? fboFormat(target.effect, target.name) : format,
    alpha: target.kind !== "scene" || alphaMax || (inGroup && !upload),
    topology:
      step.kind === "text" || step.kind === "mesh" || (step.kind === "particles" && !geometry)
        ? "triangle-list"
        : "triangle-strip",
    ...(alphaMax ? { alphaMax: true } : {}),
    ...(step.kind === "mesh" ? { mesh: mesh ?? "" } : {}),
    ...(raster.cull ? { cull: "back" as const } : {}),
    ...(sceneDepth && target.kind === "scene" && !group ? { depth: { test: raster.test, write: raster.write } } : {}),
  };
}

/**
 * 场景目标要不要深度附件（P5d 步骤 1）：有一个「画进场景目标、不在组里、而且测深度」的绘制步骤就要。`plans` 是一个图层可能用到的全部计划
 * （加载时的计划与 `variantPlans` 的预建计划取并集），`layer.group` 非空的图层（组的子孙）画进组的合成 RT，不算。不测深度的 pass 也不写
 * 深度（`depthtest: disabled` 连写入一起关），这时深度附件对画面没有任何作用，所以一个都没有的场景不建，管线与 render pass 和改前逐字
 * 相同，也不白占显存。
 */
export function wantsDepth(
  layers: readonly { layer: Pick<SceneLayer, "group">; plans: readonly LayerPlan[] }[],
): boolean {
  return layers.some(
    ({ layer, plans }) =>
      layer.group == null &&
      plans.some((plan) =>
        plan.steps.some(
          (step) =>
            (step.kind === "draw" || step.kind === "particles" || step.kind === "text" || step.kind === "mesh") &&
            step.target.kind === "scene" &&
            step.raster.test,
        ),
      ),
  );
}

/**
 * 粒子程序的顶点输入能不能由 CPU 写：带 `geometry` 的按 renderer 查，rope（P4d 步骤 1）按 `writeRopeSegments` 的 6 个输入
 * （`particles/rope.ts`），ropetrail（P4d 步骤 2）按 `writeTrailSegments` 的 5 个输入（`particles/ropetrail.ts`）；其余按
 * `writeVertices`（`particles/vertices.ts`）。
 */
function particleAttributeProblems(
  program: SceneBundle["programs"][number],
  renderer: ParticleRenderer["kind"] | undefined,
): string[] {
  try {
    const packing = programVertexPacking(program);
    if (!program.geometry) return particleVertexLayout(packing).problems;
    return (renderer === "ropetrail" ? trailVertexLayout(packing) : ropeVertexLayout(packing)).problems;
  } catch (error) {
    return error instanceof SceneRenderError ? error.reasons : [`render:particle-attribute:${String(error)}`];
  }
}

/**
 * 几何着色器分支（rope 两类）写段顶点：系统有 ropetrail 历史（`system.trail`，P4d 步骤 2）时每个存活粒子恒写 n 段
 * （`writeTrailSegments`），否则按 rope 表写（`writeRopeSegments`，P4d 步骤 1，`fps` 是宿主的帧上限）。返回段数。
 */
function writeSegments(system: ParticleSystem, layout: ParticleDraw["layout"], out: Float32Array, fps: number): number {
  return system.trail
    ? writeTrailSegments(system, layout as TrailVertexLayout, out)
    : writeRopeSegments(system, layout as RopeVertexLayout, out, fps);
}

/**
 * 一份计划里渲染器画不了的项（加载时的自查与 `prepareVariants` 共用）。`particle` 是图层的粒子系统树：每个粒子步骤按它自己那个系统的
 * renderer 种类查程序的输入（子系统的 renderer 可以和父不同，P4e 步骤 1）。`model` 是图层的模型（P5c 步骤 2）：每个网格步骤按网格格式查
 * 程序的输入（`meshVertexLayout`）。
 */
function planProblems(
  plan: LayerPlan,
  bundle: SceneBundle,
  particle?: SceneParticle | null,
  model?: SceneModel | null,
): string[] {
  const problems = [...plan.reasons];
  for (const step of plan.steps) {
    if (step.kind !== "draw" && step.kind !== "particles" && step.kind !== "text" && step.kind !== "mesh") continue;
    const program = step.pass.program === null ? undefined : bundle.programs[step.pass.program];
    if (!program) problems.push("render:no-program");
    else if (step.kind === "particles")
      problems.push(
        ...particleAttributeProblems(program, particle ? particleNode(particle, step.node).renderer.kind : undefined),
      );
    else if (step.kind === "mesh") {
      const mesh = model?.meshes[step.mesh];
      if (!mesh) problems.push(`render:mesh:${step.mesh}`);
      else problems.push(...meshVertexLayout(program.attributes ?? [], mesh.format).problems);
    }
    // 视频纹理（P9a）没有 mip：渲染器建空纹理、运行时拷帧，不算缺
    for (const ref of Object.values(step.inputs))
      if (ref.kind === "texture" && !bundle.textures[ref.index]?.mips.length && !bundle.textures[ref.index]?.video)
        problems.push(`render:texture-missing:${ref.index}`);
  }
  return problems;
}

/** 计划要不要 `_rt_FullFrameBuffer`。fullscreen 的基础拷贝（P5b 步骤 3）读快照，`planLayer` 在它之前总有 `snapshot`，这里另认一遍。 */
function wantsSnapshot(plan: LayerPlan): boolean {
  return plan.steps.some(
    (step) =>
      step.kind === "snapshot" ||
      (step.kind === "copy" && step.source.kind === "framebuffer") ||
      ((step.kind === "draw" || step.kind === "particles" || step.kind === "text" || step.kind === "mesh") &&
        Object.values(step.inputs).some((ref) => ref.kind === "framebuffer")),
  );
}

/** 渲染器能画的 bundle 结构；不能画的整理成原因键（编译期能力表之外的渲染器自查）。 */
export function checkRenderable(
  bundle: SceneBundle,
  features: ReadonlySet<string>,
  /** `texts`：文本层的排版结果（P6b 1d，`GpuScene.build` 的同名选项）；文本层没有排版结果时报 `render:text-layout`。 */
  options: { ignoreUnsupported?: boolean; texts?: ReadonlyMap<number, TextLayout> } = {},
): string[] {
  const reasons = new Set<string>(options.ignoreUnsupported ? [] : bundle.unsupported);
  for (const feature of requiredFeatures(bundle.textures))
    if (!features.has(feature))
      reasons.add(feature === "texture-compression-bc" ? "webgpu:no-bc" : `webgpu:${feature}`);
  if (bundle.bloom)
    for (const name of Object.keys(bundle.bloom.hdr ? HDR_BLOOM_MATERIALS : LDR_BLOOM_MATERIALS)) {
      const pass = bundle.bloom.passes[name as keyof typeof bundle.bloom.passes];
      if (!pass || pass.program === null || !bundle.programs[pass.program]) reasons.add(`render:bloom:${name}`);
    }
  for (const layer of buildableLayers(bundle))
    for (const reason of planProblems(
      planLayer(layer, bundle.textures, undefined, options.texts?.get(layer.object) ?? null),
      bundle,
      layer.particle,
      layer.model,
    ))
      reasons.add(reason);
  return [...reasons];
}

/**
 * 要建 GPU 资源的图层（有 pass 的，含粒子材质的 pass，P4a 步骤 4；文本层；模型有网格 pass 的，P5c 步骤 2；形状层，P8 步骤 2，`passes`
 * 为空、画的是 effect 的 pass）：自身和每个祖先都可能可见，即当前可见、`visible` 绑了用户属性，或场景带脚本。`visibleBound` 的图层当前
 * 可能不可见，但随时可能显示，同样要能画（P3a）。写死不可见的分组下面的子孙永远画不出来（`visible` 沿父链继承，P4a 步骤 1）：不建资源，
 * 它们的问题也不让整场退回（`p5c-ver` 的 HID 不画）。
 * 被依赖的图层（P8 步骤 4，`SceneLayer.dependedOn`）例外：不看自身与祖先的可见性（WPE `0x1000`，rea-p8-render 1.3、2.4），写死不可见也照画
 * 进它的独占 RT（`p8-dep` 的 1、3、8，`p8-misc` 的 A13）。
 */
export function buildableLayers(bundle: Pick<SceneBundle, "layers" | "scripts">): SceneLayer[] {
  const scripted = bundle.scripts.list.length > 0;
  const byObject = new Map(bundle.layers.map((layer) => [layer.object, layer]));
  return bundle.layers.filter(
    (layer) =>
      (layer.passes.length > 0 ||
        (layer.particle?.passes.length ?? 0) > 0 ||
        !!layer.text ||
        !!layer.model?.meshes.some((mesh) => mesh.passes.length > 0) ||
        !!layer.shape) &&
      (!!layer.dependedOn ||
        everyAncestor(layer.object, byObject, (item) => item.visible || item.visibleBound || scripted)),
  );
}

/**
 * 一个图层本帧要跑的 op（P8 步骤 4，rea-p8-render 2.4，p8-REPORT 结论 7）：可见时全部；不可见（自身或祖先）时一般整段跳过（含快照、copy 与
 * swap），被依赖的图层照跑，只去掉画到「场景」的绘制——它画到场景的只有 passthrough 上屏那一步（WPE `FUN_1401e8aa0` 的上屏块
 * `if (真可见)`，层首快照、基础 pass、effect 链都不看可见性）。组画子树时「场景」是组的合成 RT，规则相同。粒子树与模型 op 只画到场景，
 * 一并去掉（被依赖的只有图像层，碰不到）。纯函数，单测核对跳过规则。
 */
export function layerOpsToRun<O extends { kind: string }>(
  ops: readonly O[],
  layer: Pick<SceneLayer, "dependedOn">,
  visible: boolean,
): readonly O[] {
  if (visible) return ops;
  if (!layer.dependedOn) return [];
  return ops.filter((op) => !drawsToScene(op));
}

/** op 画到「场景」（顶层是场景目标，组里是组的合成 RT）：目标是 `scene` 的绘制、粒子树、模型。 */
function drawsToScene(op: { kind: string }): boolean {
  if (op.kind === "particle-tree" || op.kind === "model") return true;
  return op.kind === "draw" && (op as { draw?: { step: { target: TargetRef } } }).draw?.step.target.kind === "scene";
}

/**
 * 要上传的纹理：除了只被「关着且带不支持项」的 effect 用到的，其余全部上传。这种 effect 打开时整场重编译，用不到这份
 * GPU 纹理；它的纹理可能没有 mip 或格式不认识，上传会抛错，让本来能画的场景退回（3c）。关着的 effect 编译到一半出错时
 * 步骤不留，已解析的纹理同样不被引用。没有可变 effect 的场景，bundle 里的纹理都有 pass 引用，结果是全集。
 * 粒子材质的纹理同样上传（P4a 步骤 4），含系统树里全部子系统的（P4e 步骤 1）。
 */
export function uploadableTextures(bundle: Pick<SceneBundle, "layers">): Set<number> {
  const used = new Set<number>();
  const add = (pass: ScenePass) => {
    for (const index of Object.values(pass.textures)) used.add(index);
  };
  const addParticle = (particle: SceneParticle) => {
    particle.passes.forEach(add);
    for (const child of particle.children ?? []) addParticle(child.system);
  };
  for (const layer of bundle.layers) {
    layer.passes.forEach(add);
    if (layer.particle) addParticle(layer.particle);
    if (layer.passthrough) add(layer.passthrough);
    if (layer.groupUpload) add(layer.groupUpload);
    // 文本的宿主材质（P6b 1d）都没有静态纹理，照样过一遍
    const text = layer.text;
    if (text)
      for (const pass of [text.glyphPass, text.colorPass, text.backgroundPass, text.clearAlphaPass])
        if (pass) add(pass);
    // 模型网格的材质（P5c 步骤 2）
    for (const mesh of layer.model?.meshes ?? []) mesh.passes.forEach(add);
    for (const effect of layer.effects) {
      if (!effect.enabled && effect.unsupported.length) continue;
      for (const step of effect.steps) if (step.kind === "draw") add(step.pass);
    }
  }
  return used;
}

/**
 * 本帧要执行的图层（`objects` 下标）：不可见图层整段跳过（含它的快照、copy 与 swap）。可见性沿父链继承：
 * 自身和所有祖先都可见才画（P4a 步骤 1），祖先按 `state.layers` 查，不要求祖先有 GPU 资源。
 * 纯函数，单测核对可见性的跳过规则（P3a）。
 */
export function visibleObjects(layers: readonly { object: number }[], state: SceneState): number[] {
  return layers.filter((layer) => effectiveVisible(layer.object, state.layers)).map((layer) => layer.object);
}

export class GpuScene {
  private readonly owned = new Set<{ destroy(): void }>();
  /** 按图层分组的步骤：不可见图层整段跳过（含它的快照），泛光的 op 单独放在最后（P3a）。 */
  private readonly layers: LayerRuntime[] = [];
  private readonly draws = new Set<Draw>();
  private readonly drawsByLayer = new Map<number, Draw[]>();
  private readonly drawsByPass = new Map<TargetKey, Draw[]>();
  /** fbo 实体（`FboBindings` 的下标指向这里）。 */
  private readonly targets: RenderTarget[] = [];
  /** 场景目标：`current` 是这一帧画的那张，`alternate` 只在清屏可能关掉时有（L11）。 */
  private current: SceneTarget | null = null;
  private alternate: SceneTarget | null = null;
  /** `linearizeBase` 的管线，第一次用时才建。 */
  private linearBase: { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup } | null = null;
  private snapshot: RenderTarget | null = null;
  /**
   * 场景目标的深度附件（P5d 步骤 1，`depth32float`，`wantsDepth`）：有测深度的绘制画进场景目标才建，尺寸同场景目标；两张交替的场景目标
   * 共用这一张（同 WPE 后备缓冲的深度不随交换链翻转）。没有时为 null，管线与 render pass 都不带深度。
   */
  private depthTarget: { texture: GPUTexture; view: GPUTextureView } | null = null;
  width = 0;
  height = 0;
  /** 场景目标、快照与合成 RT 的格式（HDR 为 `rgba16float`）。 */
  format: GPUTextureFormat = SCENE_TARGET_FORMAT;
  /** 渲染目标类资源（场景目标、快照、合成 RT、fbo、泛光 RT）的显存估算，字节；不含场景纹理。 */
  targetBytes = 0;
  /** 真正重建图层的次数与用时（毫秒）：计划签名没变的切换不算。dev 探针读。 */
  readonly rebuildStats = { count: 0, totalMs: 0, maxMs: 0 };
  private bloom: BloomChain | null = null;
  /** 就地刷新 uniform 时复用的场景级视图投影：`baseViewProjection · T(−s)`，s 是本帧的抖动（`setCamera`）。 */
  private viewProjection: Float32Array = new Float32Array(16);
  /** 透视粒子（`flags & 4`）的视图投影：`basePerspectiveViewProjection · T(−s)`。 */
  private perspectiveViewProjection: Float32Array = new Float32Array(16);
  /** 不带抖动的场景视图投影（`sceneViewProjection(general, zoom)`，建场景时算，zoom 变了重算）。 */
  private baseViewProjection: Float32Array = new Float32Array(16);
  /** 不带抖动的透视粒子视图投影（`particleViewProjection(general, zoom)`，建场景时算，zoom 变了重算）。 */
  private basePerspectiveViewProjection: Float32Array = new Float32Array(16);
  /** 本帧的抖动偏移 s（P5a 步骤 3，`setCamera`）：不跨帧，只记本帧的值。 */
  private shake: [number, number] = [0, 0];
  /** 当前的正交缩放（P5a 步骤 4，`setCamera`）：建场景时取编译期的 `general.zoom`，两份基准矩阵按它算。 */
  private zoom = 1;
  /** `setCamera` 改了相机、draw 还没按新相机重写：下一次 `setParallax` 整体刷一遍（与视差的刷新合成一次）。 */
  private cameraDirty = false;
  /**
   * 正交场景当前的相机来自相机对象（P5d 步骤 3，`applyCameraObject`）：这时 VP、透视覆盖、眼位与视图向量都是相机对象的，`zoom` /
   * `shake` / 两份基准矩阵还是上一次没有相机对象时的。回到没有相机对象时要整套重算（不能按 zoom 与 s 没变提前返回）。
   */
  private objectCamera = false;
  /**
   * 场景当前的视图向量（P5d 步骤 2）：`g_ViewForward` / `g_ViewRight` / `g_ViewUp` 与粒子朝向的视线、上方向。正交场景恒为常量；
   * 透视场景随 `setCamera` 换。
   */
  private viewVectors: ViewVectors = ORTHO_VIEW_VECTORS;
  /** 本帧的视差（P5a 步骤 2，`setParallax`）：null 为关着，绘制不加平移。 */
  private parallax: SceneParallax | null = null;
  /** 粒子层全场共用的索引缓冲（`quadIndices`），按最大的 `maxcount` 建一次；没有粒子层时为 null。 */
  private particleIndices: { buffer: GPUBuffer; format: GPUIndexFormat; particles: number } | null = null;
  /** 粒子层（`objects` 下标）→ 第几个粒子层（`bundle.layers` 里带 `particle` 的顺序），定种子用。 */
  private readonly particleOrdinals = new Map<number, number>();
  private readonly particlePasses: 1 | 2;
  /** 宿主的帧上限（`ParticleOptions.fps`）：rope 的 `TL`、`TP0`（`writeRopeSegments`）。 */
  private readonly particleFps: number;
  private readonly particleSeed: number;
  private readonly particleROverride: ParticleOptions["rOverride"];
  /**
   * 全部粒子层共用的 16 段频谱（P4e 步骤 4，`ParticleOptions.audio`）：建树时交给每个根系统（`ParticleSystem.setAudio`，子系统与实例沿用），
   * 之后只读。渲染器给的是场景频谱的数组，dev 探针回放时直接往这里写抓帧读到的值（不经归一化）。
   */
  readonly particleAudio: ParticleAudio;
  /**
   * 最近的光标下场景纹理坐标（P4c 步骤 2）：建场景时取 `ParticleOptions.cursor`，之后每次 `stepParticles` 更新。新建粒子系统
   * 预热时用它。现在只有加载时会新建：粒子层编译期没有 effect、`planParticleLayer` 也不看 effect，计划签名不变，不会单独重建；
   * 以后能单独重建时，新系统按最近的指针预热（`render/particles.test.ts` 用内部字段强制重建守着这一点）。
   */
  private particleCursor: readonly [number, number];
  /** 粒子开销记录（dev 探针，`profileParticles` 打开时才有）。 */
  private particleTimings: Map<Draw, ParticleTiming> | null = null;
  /** 粒子层（`objects` 下标）→ 系统树（P4e 步骤 1、2），图层顺序；步进、实例改值、探针都从这里找根。 */
  private readonly trees = new Map<number, ParticleTree>();
  /**
   * 最近一次 `update` 写的每帧内置量（`frameBuiltins`）：编码时才建的实例化 draw（P4e 步骤 2）错过了这一帧的 `update`，建好后补上；还没
   * `update` 过时为 null。
   */
  private frameValues: Record<string, ArrayLike<number>> | null = null;
  /** HDR 下图层颜色乘 `brightness`（B10），就地刷新时按状态里的 brightness 现算。 */
  private hdr = false;
  private eye: readonly number[] = [];
  /** 上传后的场景纹理，下标同 `bundle.textures`；没上传的为 null（`uploadableTextures`）。 */
  private textures: (GPUTexture | null)[] = [];
  private dummies!: ReturnType<GpuScene["createDummies"]>;
  private readonly samplers = new Map<string, GPUSampler>();
  private readonly programs = new Map<number, Promise<GpuProgram>>();
  private readonly pipelines = new Map<string, Promise<GPURenderPipeline>>();
  /** 已建好的程序与管线：切换时同步取（`preparedOf`）。 */
  private readonly readyPrograms = new Map<number, GpuProgram>();
  private readonly readyPipelines = new Map<string, GPURenderPipeline>();
  /** 合成 RT 的共享池，键是尺寸与采样方式（组里的图层另加组的层数，P5b 步骤 4）；重建时不够也从这里补。 */
  private readonly compositePool = new Map<string, RenderTarget[]>();
  /**
   * 被依赖图层的独占 RT（P8 步骤 4，`createLayerTarget`）：`objects` 下标 → 那张 RT。是那一层的合成 RT 0，引用方的 `{ kind: "layer" }`
   * 解析到这里；跨帧、跨重建保留，随场景销毁。
   */
  private readonly layerTargets = new Map<number, RenderTarget>();
  /** bundle 的全部图层（含没有资源的分组节点），按 `objects` 下标：组的尺寸、`copyBackground` 与父链上组的层数从这里查。 */
  private readonly layerByObject = new Map<number, SceneLayer>();
  /** 建了资源的图层按 `objects` 下标：组的 `subtree` op 按它找子孙的 op（P5b 步骤 4）。 */
  private readonly runtimeByObject = new Map<number, LayerRuntime>();
  /** 文本层的字形图集纹理（P6b 1d，`render/text.ts`），按图集对象共享；`populate` 里建。 */
  private atlasTextures: TextAtlasTextures | null = null;
  /** 运行中重排的重排器（P6b 1e，`build` 的 `relayout`）；没有时文本字段变了也不重排（dev 探针、单测）。 */
  private relayouter: TextRelayouter | null = null;
  /** 文本层独占的 effect fbo（P6b 1e），按 `objects` 下标：排版尺寸变了按新尺寸原地换（`resizeTextFbos`）。 */
  private readonly textFbos = new Map<number, TextFbo[]>();
  /** 上次看到的图集重置次数（`GlyphAtlas.resets`，P6b 1e 已定 5）：建场景时记下，变了就把用这张图集的层全部重排。 */
  private readonly atlasResets = new Map<GlyphAtlas, number>();
  /** 运行中重排的累计数（P6b 1e，`textStats`）：有重排或重建的 `sync` 次数、重排调用次数、缺字体没排成的次数、重建的层数。 */
  private readonly textCounts = { syncs: 0, relayouts: 0, waiting: 0, rebuilds: 0 };
  /** 每次有重排或重建的 `sync` 的样本（最近 600 次）：重排的层数、重排与重建的用时（毫秒）。 */
  private readonly textTimings = { layers: [] as number[], relayoutMs: [] as number[], rebuildMs: [] as number[] };
  /** 视频纹理的帧来源（P9a，`setVideoSink`）；null 时视频纹理保持全 0。 */
  private videoSink: VideoSink | null = null;
  /** 已经记过 warning 的视频纹理（`size:<下标>` / `copy:<下标>`）：每张纹理每种只记一次。 */
  private readonly videoWarned = new Set<string>();
  /**
   * 模型网格的 GPU 缓冲（P5c 步骤 2，`meshBuffer`）：按 mdl 文件缓冲 → 「用途、视图偏移与长度」去重，同一个 mdl 被几个对象引用时共用一份
   * （编译期同一路径只解析一次，几个对象的网格是同一块缓冲上的同一个视图）。随场景销毁，图层重建不释放。
   */
  private readonly meshBuffers = new Map<ArrayBufferLike, Map<string, GPUBuffer>>();
  /** 网格的占位顶点缓冲（全零，`MESH_PLACEHOLDER_BYTES`）：第一个有占位属性的网格建，全场共用。 */
  private meshPlaceholder: GPUBuffer | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly bundle: SceneBundle,
    private readonly warnings: string[],
    particles: ParticleOptions,
  ) {
    this.particlePasses = particles.passes ?? 1;
    this.particleFps = particles.fps ?? 60;
    this.particleSeed = particles.seed ?? Math.floor(Math.random() * 2 ** 32);
    this.particleROverride = particles.rOverride;
    this.particleCursor = particles.cursor ?? [0.5, 0.5];
    this.particleAudio = particles.audio ?? silentParticleAudio();
    let ordinal = 0;
    for (const layer of bundle.layers) if (layer.particle) this.particleOrdinals.set(layer.object, ordinal++);
    for (const layer of bundle.layers) this.layerByObject.set(layer.object, layer);
  }

  /** 替这个图层作画的组（P5b 步骤 4）；顶层图层，或组不在 bundle 里时为 null。 */
  private groupOf(layer: SceneLayer): SceneLayer | null {
    return layer.group === null ? null : (this.layerByObject.get(layer.group) ?? null);
  }

  /** 父链上组的层数（P5b 步骤 4）：顶层 0，组的子孙 1，嵌套组的子孙 2……按 `group` 往上数，环按走过的节点兜底。 */
  private groupDepth(layer: SceneLayer): number {
    let depth = 0;
    const seen = new Set<number>();
    for (let group = layer.group; group !== null && !seen.has(group); depth++) {
      seen.add(group);
      group = this.layerByObject.get(group)?.group ?? null;
    }
    return depth;
  }

  /** 这一帧画的那张场景目标（dev 探针同步读回用）。有两张时 `encode` 开头才换，要在它之后取。 */
  get targetTexture(): GPUTexture | null {
    return this.current?.texture ?? null;
  }

  /** 这一帧画的那张场景目标的视图，取用时机同 `targetTexture`。 */
  get targetView(): GPUTextureView | null {
    return this.current?.view ?? null;
  }

  /**
   * dev 探针专用（`dev/fluidProbe.ts` 的流体单步隔离，P7d 步骤 3；生产路径不调用）：图层 `object`（`objects` 下标）的合成 RT，以及
   * 它第 `effect` 个 effect 的 fbo 按名字取**此刻**扮演它的实体（`swap` 之后的对应，`FboBindings.resolve`）。探针往里写输入、读回
   * 输出；纹理都带 `COPY_SRC | COPY_DST`（`createTarget`）。没有这个图层（没建资源）或 effect 时为 null。
   */
  devLayerTargets(
    object: number,
    effect: number,
  ): {
    composites: readonly { texture: GPUTexture; width: number; height: number; format: GPUTextureFormat }[];
    fbos: ReadonlyMap<string, { texture: GPUTexture; width: number; height: number; format: GPUTextureFormat }>;
  } | null {
    const runtime = this.runtimeByObject.get(object);
    const fx = runtime?.layer.effects[effect];
    if (!runtime || !fx) return null;
    const fbos = new Map(
      fx.fbos.map((fbo) => [fbo.name, this.targets[runtime.resources.fbos.resolve(effect, fbo.name)]] as const),
    );
    return { composites: [...runtime.resources.composites], fbos };
  }

  /**
   * 建全部资源。失败时已建的资源都会释放，抛 `SceneRenderError`；`warnings` 收集 Tint 的非错误消息。
   * `state` 是本次场景的 CPU 侧状态（`render/state.ts`），建 draw 时按它的初始值写 uniform；
   * `ignoreUnsupported`：dev 强制渲染（D4），不因 `bundle.unsupported` 拒绝，渲染器自查仍然生效。
   * `particles`：粒子的遍数与种子（`ParticleOptions`）；粒子系统建好就预热。
   */
  static async build(
    device: GPUDevice,
    bundle: SceneBundle,
    state: SceneState,
    features: ReadonlySet<string>,
    warnings: string[],
    options: {
      ignoreUnsupported?: boolean;
      particles?: ParticleOptions;
      /**
       * 文本层的排版结果（P6b 1d）：宿主在加载前排好（`text/host.ts`），按 `objects` 下标。写进 `state`（`SceneState.setTexts`），
       * 渲染图、对齐偏移与图集都从那里取。文本层没有排版结果时整场画不了（`render:text-layout`）。
       */
      texts?: ReadonlyMap<number, TextLayout>;
      /**
       * 运行中重排（P6b 1e）：宿主的 `SceneTexts.relayouter()`，排进 `texts` 那次加载的图集。`sync` 对排版字段变了的文本层调它；不给时
       * 字段变了也不重排。
       */
      relayout?: TextRelayouter;
      /**
       * 场景目标尺寸（P5d 步骤 2）：透视场景必给（按画布尺寸渲染，已定 6；渲染器传 `fullResolution`），经 `sceneTargetSize` 钳设备上限；
       * 正交场景不给，照旧按 `general.width/height`。透视场景没给时按 1920×1080。
       */
      size?: readonly [number, number];
    } = {},
  ): Promise<GpuScene> {
    if (options.texts) state.setTexts(options.texts);
    const reasons = checkRenderable(bundle, features, { ...options, texts: state.texts });
    if (reasons.length) throw new SceneRenderError(reasons);
    const scene = new GpuScene(device, bundle, warnings, options.particles ?? {});
    scene.relayouter = options.relayout ?? null;
    // 加载时（宿主排版期间）的图集重置不算：运行中重置了才连带重排
    for (const atlas of layoutAtlases(...state.texts.values())) scene.atlasResets.set(atlas, atlas.resets);
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let failure: unknown = null;
    try {
      await scene.populate(state, options.size);
    } catch (error) {
      failure = error;
    }
    const validation = await device.popErrorScope();
    const memory = await device.popErrorScope();
    if (!failure && validation) failure = new SceneRenderError([`webgpu:validation:${oneLine(validation.message)}`]);
    if (!failure && memory) failure = new SceneRenderError([`webgpu:out-of-memory:${oneLine(memory.message)}`]);
    if (failure) {
      scene.destroy();
      throw failure instanceof SceneRenderError
        ? failure
        : new SceneRenderError([`webgpu:build:${oneLine(String(failure))}`]);
    }
    // 必须在上面的错误作用域之外：`createShaderModule` 遇到坏 WGSL 会报校验错误，留在里面会让整场失败
    await scene.prepareVariants(state);
    return scene;
  }

  private own<T extends { destroy(): void }>(resource: T): T {
    this.owned.add(resource);
    return resource;
  }

  /** 提前释放一个资源（换下的 draw 的缓冲），开关多少次都不累积。 */
  private release(resource: { destroy(): void }): void {
    this.owned.delete(resource);
    resource.destroy();
  }

  private createSceneTarget(label: string, extraUsage = 0): SceneTarget {
    const { width, height, format } = this;
    const texture = this.own(
      this.device.createTexture({
        label,
        size: { width, height },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | extraUsage,
      }),
    );
    this.targetBytes += width * height * texelBytes(format);
    return { texture, view: texture.createView() };
  }

  /** 场景目标的深度附件（P5d 步骤 1）：场景目标尺寸、`depth32float`，只作附件；计进显存估算（每像素 4 字节）。 */
  private createDepthTarget(): { texture: GPUTexture; view: GPUTextureView } {
    const { width, height } = this;
    const texture = this.own(
      this.device.createTexture({
        label: "scene depth",
        size: { width, height },
        format: SCENE_DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
    );
    this.targetBytes += width * height * 4;
    return { texture, view: texture.createView() };
  }

  private createTarget(
    label: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampler: GPUSampler,
  ): RenderTarget {
    const texture = this.own(
      this.device.createTexture({
        label,
        size: { width, height },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      }),
    );
    this.targetBytes += width * height * texelBytes(format);
    return { texture, view: texture.createView(), width, height, format, sampler };
  }

  /** 提前释放一张 `createTarget` 建的目标（P6b 1e：文本层独占的合成 RT 与 fbo 换尺寸时），显存估算一并减掉。 */
  private releaseTarget(target: RenderTarget): void {
    this.targetBytes -= target.width * target.height * texelBytes(target.format);
    this.release(target.texture);
  }

  /**
   * 建一个 effect fbo 的渲染目标（`populate` 的共享池与文本层的独占 fbo 共用，P6b 1e 从 `populate` 抽出）：尺寸已按合成 RT 算好
   * （`fboSize`），寻址看 `repeat`、线性过滤，创建后清成 `clear` 色（没写时 WebGPU 纹理本来就是全 0）。
   */
  private createFbo(
    fbo: SceneFbo,
    [width, height]: readonly [number, number],
    format: GPUTextureFormat,
    key: string,
    encoder: GPUCommandEncoder,
  ): RenderTarget {
    const address: GPUAddressMode = fbo.repeat ? "repeat" : "clamp-to-edge";
    const target = this.createTarget(
      `fbo ${key}`,
      width,
      height,
      format,
      this.sampler({
        addressModeU: address,
        addressModeV: address,
        magFilter: "linear",
        minFilter: "linear",
      }),
    );
    if (fbo.clear) this.clearTarget(encoder, target, fbo.clear, `clear ${key}`);
    return target;
  }

  private sampler(descriptor: GPUSamplerDescriptor): GPUSampler {
    const key = JSON.stringify(descriptor);
    let found = this.samplers.get(key);
    if (!found) this.samplers.set(key, (found = this.device.createSampler(descriptor)));
    return found;
  }

  private samplerFor(texture: SceneTexture): GPUSampler {
    return this.sampler(samplerDescriptor(texture, texture.mips.length > 1));
  }

  /**
   * `mesh`：网格步骤（P5c 步骤 2）的顶点布局；`cull`、`depth`：步骤的剔除与深度状态（P5d 步骤 1），见 `createPipeline`；键里只在出现时
   * 加后缀（`pipelineKey`）。
   */
  private pipelineFor(
    program: GpuProgram,
    blending: string | null,
    format: GPUTextureFormat,
    alpha: boolean,
    topology: PipelineSpec["topology"] = "triangle-strip",
    alphaMax = false,
    mesh?: MeshVertexLayout,
    cull?: PipelineSpec["cull"],
    depth?: PipelineSpec["depth"],
  ): Promise<GPURenderPipeline> {
    const key = pipelineKey({
      program: program.index,
      blending,
      format,
      alpha,
      topology,
      alphaMax,
      mesh: mesh?.key,
      cull,
      depth,
    });
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = createPipeline(
        this.device,
        program,
        blending,
        format,
        alpha,
        topology,
        alphaMax,
        mesh?.buffers,
        cull,
        depth,
      ).then((ready) => {
        this.readyPipelines.set(key, ready);
        return ready;
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /**
   * 网格步骤的顶点布局（P5c 步骤 2）：程序的属性按网格格式配对（`meshVertexLayout`）。管线键、建管线与建 draw 都从这里取。
   * 网格不在图层上（手写的计划）时报 `render:mesh:<下标>`，自查（`planProblems`）已先挡下。
   */
  private meshLayoutOf(layer: SceneLayer, step: MeshStep): MeshVertexLayout {
    const mesh = layer.model?.meshes[step.mesh];
    if (!mesh) throw new SceneRenderError([`render:mesh:${step.mesh}`]);
    const program = step.pass.program === null ? undefined : this.bundle.programs[step.pass.program];
    return meshVertexLayout(program?.attributes ?? [], mesh.format);
  }

  /**
   * 网格的顶点 / 索引缓冲（P5c 步骤 2）：mdl 的字节原样上传（不在 CPU 上逐顶点重排），按文件缓冲上的视图去重（`meshBuffers`）。
   * `writeBuffer` 的长度要 4 字节对齐，u16 索引奇数个时补齐（`alignedBytes`）。
   */
  private meshBuffer(view: Uint8Array, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    let byView = this.meshBuffers.get(view.buffer);
    if (!byView) this.meshBuffers.set(view.buffer, (byView = new Map()));
    const key = `${usage}|${view.byteOffset}|${view.byteLength}`;
    let buffer = byView.get(key);
    if (!buffer) {
      const bytes = alignedBytes(view);
      buffer = this.own(
        this.device.createBuffer({ label, size: bytes.byteLength, usage: usage | GPUBufferUsage.COPY_DST }),
      );
      this.device.queue.writeBuffer(buffer, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
      byView.set(key, buffer);
    }
    return buffer;
  }

  /** 网格的占位顶点缓冲（P5c 步骤 2）：全零，WebGPU 的缓冲建出来就是 0，不用写。 */
  private meshPlaceholderBuffer(): GPUBuffer {
    this.meshPlaceholder ??= this.own(
      this.device.createBuffer({
        label: "mesh placeholder",
        size: MESH_PLACEHOLDER_BYTES,
        usage: GPUBufferUsage.VERTEX,
      }),
    );
    return this.meshPlaceholder;
  }

  /** 用到才建，只在加载时走到。失败抛错，由调用方决定退回还是冻结图层。 */
  private ensureProgram(index: number): Promise<GpuProgram> {
    let program = this.programs.get(index);
    if (!program) {
      program = createProgram(this.device, this.bundle.programs[index], index, this.warnings).then((ready) => {
        this.readyPrograms.set(index, ready);
        return ready;
      });
      this.programs.set(index, program);
    }
    return program;
  }

  /** `_rt_FullFrameBuffer`：有图层要读、或要跑泛光链才建（两者共用一张，泛光在全部图层之后再拷一次）。 */
  private ensureSnapshot(): void {
    if (this.snapshot) return;
    const { width, height, format } = this;
    const texture = this.own(
      this.device.createTexture({
        label: "_rt_FullFrameBuffer",
        size: { width, height },
        format,
        // COPY_SRC：fullscreen 的基础拷贝（P5b 步骤 3）把快照整张拷进合成 RT 0，没有它 WebGPU 校验失败、整个命令缓冲被丢掉（画面全黑）
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      }),
    );
    this.targetBytes += width * height * texelBytes(format);
    this.snapshot = {
      texture,
      view: texture.createView(),
      width,
      height,
      format,
      sampler: this.sampler({ magFilter: "linear", minFilter: "linear" }),
    };
  }

  /** 基础材质槽 0 的纹理：合成 RT 的尺寸跟随它，过滤看它的 NoInterpolation（`compositeSampling`）。粒子层没有基础材质，为 undefined。 */
  private baseTexture(layer: SceneLayer): SceneTexture | undefined {
    const base = layer.passes[0]?.textures[0];
    return base === undefined ? undefined : this.bundle.textures[base];
  }

  /**
   * 被依赖图层的独占 RT（P8 步骤 4，rea-p8-render 2.2）：尺寸同它的合成 RT（`compositeSize`），格式是场景格式（HDR 为 RGBA16F），采样同它
   * 自己采样合成 RT 的规则（`compositeSampling`），不进共享池。WPE 的名字 `_rt_imageLayerComposite_<id>_a` 作标签。计进显存估算、随场景销毁。
   */
  private createLayerTarget(layer: SceneLayer): void {
    const baseTexture = this.baseTexture(layer);
    const [width, height] = compositeSize(layer, baseTexture);
    const { clamp, nearest } = compositeSampling(layer, baseTexture);
    const address: GPUAddressMode = clamp ? "clamp-to-edge" : "repeat";
    const filter: GPUFilterMode = nearest ? "nearest" : "linear";
    this.layerTargets.set(
      layer.object,
      this.createTarget(
        layerCompositeName(layer.id),
        width,
        height,
        this.format,
        this.sampler({ addressModeU: address, addressModeV: address, magFilter: filter, minFilter: filter }),
      ),
    );
  }

  /**
   * 本图层的合成 RT 至少 `plan.composite.count` 张，不够就从共享池补。文本层的由本层独占（`ensureTextComposites`，P6b 1e）。
   * 被依赖的图层（P8 步骤 4）第 0 张是它的独占 RT（`layerTargets`），其余照旧从同键的池里借；之后的重建（effect 开关、`prepareVariants`）只往后补，
   * 第 0 张一直是它。
   */
  private ensureComposites(runtime: LayerRuntime, plan: LayerPlan): void {
    if (!plan.composite) return;
    if (runtime.layer.text) {
      this.ensureTextComposites(runtime, plan.composite);
      return;
    }
    const { width, height, count } = plan.composite;
    const own = this.layerTargets.get(runtime.object);
    /** 从池里借的张数：独占的那张占了第 0 张。 */
    const pooled = own ? count - 1 : count;
    // 合成 RT 的采样（P8 步骤 1，p8-REPORT、rea-p8-layer §3）：寻址只看对象 clampuvs（缺省钳制），过滤在对象 nointerpolation 或
    // 基础纹理 NoInterpolation 时最近邻
    const { clamp, nearest } = compositeSampling(runtime.layer, this.baseTexture(runtime.layer));
    // 组里的图层按父链上组的层数另开一个池（P5b 步骤 4，WPE B5 池化 RT 名里的 k）：组画子树期间它的合成 RT 一直在用，子孙的合成 RT
    // 不能和它是同一张。顶层（层数 0）的键不变
    const depth = this.groupDepth(runtime.layer);
    const key = `${width}x${height}|${clamp}|${nearest}${depth ? `|k${depth}` : ""}`;
    const pool = this.compositePool.get(key) ?? [];
    this.compositePool.set(key, pool);
    const address: GPUAddressMode = clamp ? "clamp-to-edge" : "repeat";
    const filter: GPUFilterMode = nearest ? "nearest" : "linear";
    while (pool.length < pooled)
      pool.push(
        this.createTarget(
          `composite ${key} #${pool.length}`,
          width,
          height,
          this.format,
          this.sampler({ addressModeU: address, addressModeV: address, magFilter: filter, minFilter: filter }),
        ),
      );
    const { composites } = runtime.resources;
    // 被依赖：独占的那张放在第 0 张。`populate` 先建它、后建 draw，正常走不到替换；万一先借过池化 RT，整组换成它再按下标重借
    if (own && composites[0] !== own) composites.splice(0, composites.length, own);
    const offset = own ? 1 : 0;
    composites.push(...pool.slice(composites.length - offset, pooled));
  }

  /**
   * 文本层的合成 RT（P6b 1e，已定 6）：本层独占、不进共享池。尺寸会随文字变，共享池只增不减，按尺寸共享的话时钟每换一个宽度就多攒
   * 一张；独占后尺寸变了就销毁旧的（已提交的帧不受影响）、按新尺寸建，内存有界（WPE 每次重排也重新分配，rea-p8-layer `+0xb8`）。
   * 采样与标签照共享池的写法（组里另加层数），只是每层一组。
   */
  private ensureTextComposites(
    runtime: LayerRuntime,
    { width, height, count }: NonNullable<LayerPlan["composite"]>,
  ): void {
    const { composites } = runtime.resources;
    if (composites.some((target) => target.width !== width || target.height !== height))
      for (const target of composites.splice(0)) this.releaseTarget(target);
    const { clamp, nearest } = compositeSampling(runtime.layer, this.baseTexture(runtime.layer));
    const depth = this.groupDepth(runtime.layer);
    const key = `${width}x${height}|${clamp}|${nearest}${depth ? `|k${depth}` : ""}`;
    const address: GPUAddressMode = clamp ? "clamp-to-edge" : "repeat";
    const filter: GPUFilterMode = nearest ? "nearest" : "linear";
    while (composites.length < count)
      composites.push(
        this.createTarget(
          `composite ${key} #${composites.length}`,
          width,
          height,
          this.format,
          this.sampler({ addressModeU: address, addressModeV: address, magFilter: filter, minFilter: filter }),
        ),
      );
  }

  /** 文本层的一个独占 fbo（P6b 1e）：按合成 RT 尺寸 `size` 算 fbo 尺寸（`fboSize`），标签带图层 id 与 effect 下标。 */
  private createTextFbo(
    layer: SceneLayer,
    effect: number,
    fbo: SceneFbo,
    size: readonly [number, number],
    encoder: GPUCommandEncoder,
  ): RenderTarget {
    const [fw, fh] = fboSize(fbo, size);
    const format = fboFormatOf(fbo);
    return this.createFbo(
      fbo,
      [fw, fh],
      format,
      `text ${layer.id}|${effect}|${fbo.name}|${fw}x${fh}|${format}|${fbo.repeat}`,
      encoder,
    );
  }

  /**
   * 建场景时给文本层建独占的 effect fbo（P6b 1e，已定 6）：全部 effect（关着的也建，同共享池的规则），每个 effect 的每个名字一张，不和别的
   * 图层、也不和本层别的 effect 共用；记进 `textFbos`，之后尺寸变了原地换。
   */
  private createTextFbos(
    layer: SceneLayer,
    size: readonly [number, number],
    encoder: GPUCommandEncoder,
  ): Map<string, number>[] {
    const records: TextFbo[] = [];
    const maps = layer.effects.map(
      (effect, e) =>
        new Map(
          effect.fbos.map((fbo) => {
            const id = this.targets.length;
            this.targets.push(this.createTextFbo(layer, e, fbo, size, encoder));
            records.push({ id, effect: e, fbo });
            return [fbo.name, id] as const;
          }),
        ),
    );
    this.textFbos.set(layer.object, records);
    return maps;
  }

  /**
   * 文本层的 fbo 按新的合成 RT 尺寸换（P6b 1e）：尺寸没变的不动（内容与 swap 状态保留）；变了的销毁旧的、在同一个下标上建新的并清成 `clear`
   * 色（`FboBindings` 的对应不变，新 draw 的 bind group 取到新纹理）。清屏提交在这一帧的绘制之前。
   */
  private resizeTextFbos(object: number, size: readonly [number, number]): void {
    const records = this.textFbos.get(object);
    const layer = this.layerByObject.get(object);
    if (!records?.length || !layer) return;
    let encoder: GPUCommandEncoder | null = null;
    for (const record of records) {
      const [fw, fh] = fboSize(record.fbo, size);
      const current = this.targets[record.id];
      if (current.width === fw && current.height === fh) continue;
      this.releaseTarget(current);
      encoder ??= this.device.createCommandEncoder({ label: "text fbo resize" });
      this.targets[record.id] = this.createTextFbo(layer, record.effect, record.fbo, size, encoder);
    }
    if (encoder) this.device.queue.submit([encoder.finish()]);
  }

  /**
   * 文本层按当前排版换资源（P6b 1e，`rebuildLayer` 在建 draw 之前调）：图集按新排版重新取（换字号是新图集、扩容后是新纹理，排版为空时没有）；
   * 计划没有合成路径（空文字）时不留合成 RT（有合成时 `buildLayer` → `ensureTextComposites` 按新尺寸换）；fbo 按新的合成 RT 尺寸换（全部
   * effect 关着时也按它，同 `populate`）。
   */
  private ensureTextResources(runtime: LayerRuntime, plan: LayerPlan, state: SceneState): void {
    const layout = state.texts.get(runtime.object);
    const { resources } = runtime;
    const { atlases } = this.textAtlasesOf(layout);
    if (atlases) resources.atlases = atlases;
    else delete resources.atlases;
    if (!plan.composite) for (const target of resources.composites.splice(0)) this.releaseTarget(target);
    if (layout) this.resizeTextFbos(runtime.object, textCompositeSize(layout));
  }

  /** 这个图层在当前开关下的计划：`planLayer` 的回调给 `layer.effects` 下标，状态按 scene.json 坐标（`source`）存。 */
  private planOf(layer: SceneLayer, state: SceneState): LayerPlan {
    return planLayer(
      layer,
      this.bundle.textures,
      (e) => state.effectEnabled(layer.object, layer.effects[e].source),
      state.texts.get(layer.object) ?? null,
      [this.width, this.height],
    );
  }

  private pipelineOf(step: DrawLike, { layer, resources }: Pick<LayerRuntime, "layer" | "resources">): PipelineSpec {
    return stepPipeline(
      step,
      this.format,
      (effect, name) => this.targets[resources.fbos.resolve(effect, name)].format,
      // rope 的程序带几何着色器展开：三角形带（P4d 步骤 1）
      !!(step.pass.program !== null && this.bundle.programs[step.pass.program]?.geometry),
      // 组里画到「场景」的绘制落在组的合成 RT 上（P5b 步骤 4）：写 alpha，`copyBackground` 为 false 时 alpha 取 MAX
      this.groupOf(layer),
      // 网格（P5c 步骤 2）的顶点布局按网格格式
      step.kind === "mesh" ? this.meshLayoutOf(layer, step).key : undefined,
      // 深度附件（P5d 步骤 1）：有时画进场景目标、不在组里的管线都带深度状态
      this.depthTarget !== null,
    );
  }

  /** 等齐一份计划要用的程序与管线，之后 `buildLayer` 就是同步的。 */
  private async prepareLayer(
    plan: LayerPlan,
    runtime: Pick<LayerRuntime, "layer" | "resources">,
  ): Promise<Map<DrawLike, PreparedDraw>> {
    const prepared = new Map<DrawLike, PreparedDraw>();
    await Promise.all(
      plan.steps.map(async (step) => {
        if (step.kind !== "draw" && step.kind !== "particles" && step.kind !== "text" && step.kind !== "mesh") return;
        const program = await this.ensureProgram(step.pass.program!);
        const { blending, format, alpha, topology, alphaMax, cull, depth } = this.pipelineOf(step, runtime);
        const mesh = step.kind === "mesh" ? this.meshLayoutOf(runtime.layer, step) : undefined;
        prepared.set(step, {
          program,
          pipeline: await this.pipelineFor(program, blending, format, alpha, topology, alphaMax, mesh, cull, depth),
        });
      }),
    );
    return prepared;
  }

  /** 从就绪表同步取一份计划的程序与管线。`prepareVariants` 都备好了，缺了说明枚举漏了。 */
  private preparedOf(plan: LayerPlan, runtime: Pick<LayerRuntime, "layer" | "resources">): Map<DrawLike, PreparedDraw> {
    const prepared = new Map<DrawLike, PreparedDraw>();
    for (const step of plan.steps) {
      if (step.kind !== "draw" && step.kind !== "particles" && step.kind !== "text" && step.kind !== "mesh") continue;
      const spec = this.pipelineOf(step, runtime);
      const program = this.readyPrograms.get(spec.program);
      const pipeline = this.readyPipelines.get(pipelineKey(spec));
      if (!program || !pipeline) throw new SceneRenderError(["render:variant-missing"]);
      prepared.set(step, { program, pipeline });
    }
    return prepared;
  }

  /**
   * 关着的 effect 也在加载时备好（WPE 同样）。逐图层进行，失败不影响当前画面，这一层之后走整场重编译。
   * 文本层（P6b 1e）备的是运行中重排可能出现的全部步骤（`variantPlans` 的假想排版）：只备程序与管线，合成 RT 由本层按当时的排版尺寸建
   * （`ensureTextComposites`），快照用到时 `buildLayer` 再建。备不好时运行中出现新步骤会报 `render:variant-missing`。
   */
  private async prepareVariants(state: SceneState): Promise<void> {
    for (const runtime of this.layers) {
      const text = runtime.layer.text ? (state.texts.get(runtime.object) ?? null) : null;
      const plans = variantPlans(runtime.layer, this.bundle.textures, text, [this.width, this.height]);
      if (!plans.length) continue;
      this.device.pushErrorScope("out-of-memory");
      this.device.pushErrorScope("validation");
      let failure: unknown = null;
      try {
        for (const plan of plans) {
          const problems = planProblems(plan, this.bundle, runtime.layer.particle, runtime.layer.model);
          if (problems.length) throw new SceneRenderError(problems);
          if (runtime.layer.text) {
            await this.prepareLayer(plan, runtime);
            continue;
          }
          this.ensureComposites(runtime, plan);
          if (wantsSnapshot(plan)) this.ensureSnapshot();
          this.checkPlanOps(plan, runtime);
          await this.prepareLayer(plan, runtime);
        }
      } catch (error) {
        failure = error;
      }
      const validation = await this.device.popErrorScope();
      const memory = await this.device.popErrorScope();
      const error = validation ?? memory;
      if (failure || error) {
        state.freezeLayer(runtime.object);
        this.warnings.push(
          runtime.layer.text
            ? `文本图层 ${runtime.object} 的步骤备不好，运行中重排出现新步骤时画不了：${String(failure ?? error!.message)}`
            : `图层 ${runtime.object} 的可变 effect 备不好，切换时整场重新加载：${String(failure ?? error!.message)}`,
        );
      }
    }
  }

  /** copy / swap / clear / subtree 的检查：切换时不能再失败，所以 `prepareVariants` 对每份计划先过一遍。 */
  private checkPlanOps(plan: LayerPlan, { layer, resources }: LayerRuntime): void {
    for (const step of plan.steps) {
      if (step.kind === "clear" || step.kind === "subtree") {
        // 组合层的 clear 只清合成 RT（P5b 步骤 2），组的子树画进合成 RT（步骤 4）：`ensureComposites` 之后应当解析得到
        if (!this.resolveTarget(step.target, resources))
          throw new SceneRenderError([`render:${step.kind}-target:${layer.name}`]);
      } else if (step.kind === "swap") {
        const a = this.targets[resources.fbos.resolve(step.effect, step.source)];
        const b = this.targets[resources.fbos.resolve(step.effect, step.target)];
        if (a.format !== b.format || a.width !== b.width || a.height !== b.height)
          throw new SceneRenderError([`render:swap-mismatch:${step.source}:${step.target}`]);
      } else if (step.kind === "copy") {
        const source = this.resolveTexture(step.source, resources);
        const target = this.resolveTarget(step.target, resources);
        if (!source || !target || source.format !== target.format)
          throw new SceneRenderError([`render:copy-format:${layer.name}`]);
      }
    }
  }

  /**
   * 照计划生成 op 与 draw。全程同步：新 draw 的 uniform 按这一刻的状态写。`worlds` 是这一刻状态下的世界矩阵缓存
   * （`worldMatrixOf`），由调用方按一次状态快照建一份。
   */
  private buildLayer(
    runtime: LayerRuntime,
    plan: LayerPlan,
    prepared: ReadonlyMap<DrawLike, PreparedDraw>,
    state: SceneState,
    worlds: Map<number, Mat4>,
  ): { ops: Op[]; draws: Draw[]; tree: ParticleTree | null } {
    const { layer, resources } = runtime;
    this.ensureComposites(runtime, plan);
    if (wantsSnapshot(plan)) this.ensureSnapshot();
    this.checkPlanOps(plan, runtime);
    const ops: Op[] = [];
    const draws: Draw[] = [];
    if (layer.particle) {
      // 粒子层（P4e 步骤 1、2）：整个层一个 `particle-tree` op；没有可画的模板时没有 op、不建树（同以前没有粒子步骤时）
      const steps = plan.steps.filter((step): step is ParticleStep => step.kind === "particles");
      if (!steps.length) return { ops, draws, tree: null };
      // 整棵树一起建、一起预热；`renderer: []` 的系统要帧缓冲时同样拷快照（它没有步骤，`wantsSnapshot` 看不到）
      const tree = this.createParticleTree(layer, resources, state);
      if (tree.framebuffer) this.ensureSnapshot();
      for (const step of steps) {
        const template: ParticleTemplate = { step, prepared: prepared.get(step)!, pool: [] };
        tree.templates.set(step.node.join("/"), template);
        // 顶层与 static 子孙每帧恰好一次：建场景时建好（顺序同 P4e 步骤 1 的先序）；事件实例下的模板第一次用到时建
        if (step.instanced) continue;
        const system = tree.system.node(step.node);
        if (!system) throw new SceneRenderError([`render:particle-node:${step.node.join("/")}`]);
        const draw = this.createDraw(layer, step, resources, template.prepared, state, worlds, system);
        template.pool.push(draw);
        draws.push(draw);
      }
      ops.push({ kind: "particle-tree", tree });
      return { ops, draws, tree };
    }
    if (layer.model) {
      // 模型层（P5c 步骤 2）：整个层一个 `model` op（编码时先做视锥剔除），网格按计划的顺序（`model.order`）；没有网格步骤时没有 op
      for (const step of plan.steps)
        if (step.kind === "mesh")
          draws.push(this.createDraw(layer, step, resources, prepared.get(step)!, state, worlds));
      if (draws.length) ops.push({ kind: "model", layer, draws: [...draws] });
      return { ops, draws, tree: null };
    }
    for (const step of plan.steps) {
      if (step.kind === "snapshot") ops.push({ kind: "snapshot" });
      else if (step.kind === "swap")
        ops.push({ kind: "swap", resources, effect: step.effect, source: step.source, target: step.target });
      else if (step.kind === "copy")
        ops.push({ kind: "copy", resources, effect: step.effect, source: step.source, target: step.target });
      else if (step.kind === "clear")
        ops.push({
          kind: "clear",
          resources,
          target: step.target,
          layer,
          ...(step.color ? { color: step.color } : {}),
        });
      else if (step.kind === "subtree") ops.push({ kind: "subtree", resources, target: step.target, layer });
      else {
        const draw = this.createDraw(layer, step, resources, prepared.get(step)!, state, worlds);
        ops.push({ kind: "draw", draw });
        draws.push(draw);
      }
    }
    return { ops, draws, tree: null };
  }

  /** 把建好的 op 与 draw 接进图层和索引。 */
  private install(runtime: LayerRuntime, built: { ops: Op[]; draws: Draw[]; tree: ParticleTree | null }): void {
    runtime.ops = built.ops;
    runtime.draws = built.draws;
    runtime.tree = built.tree;
    if (built.tree) this.trees.set(runtime.object, built.tree);
    else this.trees.delete(runtime.object);
    // 与 `runtime.draws` 同一个数组：之后按需建的实例化 draw（`addPooledDraw`）追加一次两边都有
    this.drawsByLayer.set(runtime.object, built.draws);
    for (const draw of built.draws) this.indexDraw(draw);
  }

  /** 一个 draw 进全场的索引（按 pass 键找回、每帧写 uniform）。 */
  private indexDraw(draw: Draw): void {
    this.draws.add(draw);
    const byPass = this.drawsByPass.get(draw.passKey);
    if (byPass) byPass.push(draw);
    else this.drawsByPass.set(draw.passKey, [draw]);
  }

  private async populate(state: SceneState, size?: readonly [number, number]): Promise<void> {
    const { device, bundle } = this;
    const { general } = bundle;
    // 透视场景按画布尺寸（P5d 步骤 2，已定 6）；正交场景按场景尺寸
    const [width, height] = general.perspective
      ? sceneTargetSize(size?.[0] ?? 1920, size?.[1] ?? 1080, device.limits.maxTextureDimension2D)
      : sceneTargetSize(general.width, general.height, device.limits.maxTextureDimension2D);
    const hdr = (this.hdr = general.postprocess.hdr);
    const format = (this.format = sceneTargetFormat(hdr));
    this.width = width;
    this.height = height;
    this.eye = eyePosition(general);
    this.current = this.createSceneTarget("scene target");
    // 两张都是空的：不清屏时初始底色就是黑，`clearcolor` 不出现（L11）
    if (general.clearVariable) this.alternate = this.createAlternateTarget();

    const uploadable = uploadableTextures(bundle);
    this.textures = bundle.textures.map((texture, index) =>
      uploadable.has(index) ? this.own(uploadTexture(device, texture)) : null,
    );
    this.dummies = this.createDummies();
    this.atlasTextures = new TextAtlasTextures(
      device,
      this.sampler(ATLAS_SAMPLER),
      (resource) => this.own(resource),
      (resource) => this.release(resource),
    );

    const built = buildableLayers(bundle);
    const plans = built.map((layer) => this.planOf(layer, state));
    // 深度附件（P5d 步骤 1）：按全部可能用到的计划判定（加载时的计划与预建的变体），要在建任何管线之前定下来，管线的深度状态跟着它
    if (
      wantsDepth(
        built.map((layer, index) => ({
          layer,
          plans: [plans[index], ...variantPlans(layer, bundle.textures, null, [width, height])],
        })),
      )
    )
      this.depthTarget = this.createDepthTarget();

    // 程序：全部建完再汇总失败，Tint 报告一次列全
    const used = new Set<number>();
    for (const plan of plans)
      for (const step of plan.steps)
        if (
          (step.kind === "draw" || step.kind === "particles" || step.kind === "text" || step.kind === "mesh") &&
          step.pass.program !== null
        )
          used.add(step.pass.program);
    for (const pass of Object.values(bundle.bloom?.passes ?? {}))
      if (pass?.program !== null && pass?.program !== undefined) used.add(pass.program);
    const settled = await Promise.allSettled([...used].map((index) => this.ensureProgram(index)));
    const failed = settled.flatMap((result) =>
      result.status === "rejected"
        ? result.reason instanceof SceneRenderError
          ? result.reason.reasons
          : [`webgpu:shader:${oneLine(String(result.reason))}`]
        : [],
    );
    if (failed.length) throw new SceneRenderError(failed);
    const programs = new Map<number, GpuProgram>();
    for (const result of settled) if (result.status === "fulfilled") programs.set(result.value.index, result.value);

    const fboPool = new Map<string, number>();
    const setup = device.createCommandEncoder({ label: "scene setup" });
    // 建场景时 s 是 (0, 0)：两份相同，`setCamera` 换成带抖动的。缩放取编译期的值（P5a 步骤 4），预热的指针反投影就带上它
    this.zoom = general.fields.zoom;
    this.viewProjection = this.baseViewProjection = sceneViewProjection(general, this.zoom);
    this.perspectiveViewProjection = this.basePerspectiveViewProjection = particleViewProjection(general, this.zoom);
    // 透视场景（P5d 步骤 2）：建场景时取加载时的相机（路径从头、g_Time 0），渲染器第一帧就用 `setCamera` 换成当帧的；预热的指针
    // 反投影用它。透视粒子那一份（`perspectiveViewProjection`）照旧（透视场景里的透视粒子照报 `camera:perspective:particle`）
    if (general.perspective)
      this.applyPerspective(initialPerspectiveFrame(general.camera, state.general, width, height));
    // 粒子的索引缓冲：全场一份，按最大的 maxcount 建（含子系统的，每个粒子步骤按它画的那个系统，P4e 步骤 1）
    const particleCapacity = plans.reduce((max, plan, index) => {
      const particle = built[index].particle;
      for (const step of plan.steps)
        if (step.kind === "particles" && particle) max = Math.max(max, particleNode(particle, step.node).maxcount);
      return max;
    }, -1);
    if (particleCapacity >= 0) this.createParticleIndices(particleCapacity);

    const runtimes = plans.map((plan, index) => {
      const layer = built[index];
      // fbo 一律按真实合成尺寸：全部 effect 关着时也是，打开时不用重建。文本层取排版的合成 RT 尺寸（P6b 1d），fbo 由本层独占（1e）
      const textLayout = layer.text ? state.texts.get(layer.object) : undefined;
      const size = textLayout
        ? textCompositeSize(textLayout)
        : compositeSize(layer, this.baseTexture(layer), [width, height]);
      const maps = layer.text
        ? this.createTextFbos(layer, size, setup)
        : layer.effects.map(
            (effect) =>
              new Map(
                effect.fbos.map((fbo) => {
                  const [fw, fh] = fboSize(fbo, size);
                  const fboFormat = fboFormatOf(fbo);
                  const key = fbo.unique
                    ? `unique|${layer.id}|${effect.id}|${fbo.name}`
                    : `${fbo.name}|${fw}x${fh}|${fboFormat}|${fbo.repeat}`;
                  let id = fboPool.get(key);
                  if (id === undefined) {
                    // 创建后清成 `clear` 色（`createFbo`）
                    const target = this.createFbo(fbo, [fw, fh], fboFormat, key, setup);
                    id = this.targets.length;
                    this.targets.push(target);
                    fboPool.set(key, id);
                  }
                  return [fbo.name, id] as const;
                }),
              ),
          );
      const runtime: LayerRuntime = {
        object: layer.object,
        layer,
        ops: [],
        draws: [],
        resources: { composites: [], fbos: new FboBindings(maps), ...this.textAtlasesOf(textLayout) },
        signature: planSignature(plan),
        tree: null,
      };
      this.layers.push(runtime);
      this.runtimeByObject.set(layer.object, runtime);
      return runtime;
    });
    // 被依赖图层的独占 RT（P8 步骤 4）：在任何 `buildLayer` 之前建好，引用方排在被依赖者前面时建 draw 也解析得到（`resolveTexture`）
    for (const runtime of runtimes) if (runtime.layer.dependedOn) this.createLayerTarget(runtime.layer);
    const prepared = await Promise.all(plans.map((plan, index) => this.prepareLayer(plan, runtimes[index])));
    // 泛光：全部图层之后（A1 / A3）
    if (bundle.bloom) {
      this.ensureSnapshot();
      const chain = await BloomChain.create({
        device,
        bloom: bundle.bloom,
        params: general.bloom,
        programs,
        format,
        width,
        height,
        source: this.snapshot!.view,
        pipelineFor: (program, blending, target) => this.pipelineFor(program, blending, target, false),
        own: (resource) => this.own(resource),
      });
      this.bloom = chain;
      this.targetBytes += chain.bytes;
    }
    // 世界矩阵按这一刻的状态算，全部图层共用一份缓存
    const worlds = new Map<number, Mat4>();
    runtimes.forEach((runtime, index) =>
      this.install(runtime, this.buildLayer(runtime, plans[index], prepared[index], state, worlds)),
    );
    device.queue.submit([setup.finish()]);
  }

  private clearTarget(encoder: GPUCommandEncoder, target: RenderTarget, color: readonly number[], label: string): void {
    const [r, g, b, a] = color;
    encoder
      .beginRenderPass({
        label,
        colorAttachments: [{ view: target.view, clearValue: { r, g, b, a }, loadOp: "clear", storeOp: "store" }],
      })
      .end();
  }

  /** 泛光链（dev 探针用）；没有泛光时为 null。 */
  get bloomChain(): BloomChain | null {
    return this.bloom;
  }

  /** 着色器声明了、材质没绑的槽位用的占位纹理（全 0，同 D3D 空 SRV 的读数）与默认采样器。 */
  private createDummies() {
    const device = this.device;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const flat = this.own(device.createTexture({ label: "dummy 2d", size: [1, 1], format: "rgba8unorm", usage }));
    const volume = this.own(
      device.createTexture({ label: "dummy 3d", size: [1, 1, 1], dimension: "3d", format: "rgba8unorm", usage }),
    );
    const cube = this.own(device.createTexture({ label: "dummy cube", size: [1, 1, 6], format: "rgba8unorm", usage }));
    const depth = this.own(
      device.createTexture({
        label: "dummy depth",
        size: [1, 1],
        format: "depth32float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    return {
      views: {
        "2d": flat.createView(),
        "3d": volume.createView({ dimension: "3d" }),
        cube: cube.createView({ dimension: "cube" }),
        "2d-comparison": depth.createView(),
      } as Record<TextureBinding["kind"], GPUTextureView>,
      sampler: device.createSampler({ addressModeU: "repeat", addressModeV: "repeat" }),
      comparison: device.createSampler({ compare: "less-equal" }),
    };
  }

  private resolveTexture(ref: TextureRef, resources: LayerResources): RenderTarget | null {
    if (ref.kind === "composite") return resources.composites[ref.index] ?? null;
    if (ref.kind === "fbo") return this.targets[resources.fbos.resolve(ref.effect, ref.name)] ?? null;
    if (ref.kind === "framebuffer") return this.snapshot;
    if (ref.kind === "atlas") return (ref.color ? resources.atlases?.color : resources.atlases?.main) ?? null;
    // 别的图层的独占 RT（P8 步骤 4）；那一层没建资源时为 null，建 draw 时报 `render:texture-rt:layer`
    if (ref.kind === "layer") return this.layerTargets.get(ref.object) ?? null;
    return null;
  }

  /** 文本层的图集纹理（P6b 1d）：本层排版的主图集与彩色图集（没有彩色图集时为 null）；不是文本层、或排版为空时不给。 */
  private textAtlasesOf(layout: TextLayout | undefined): Pick<LayerResources, "atlases"> {
    const mesh = layout?.mesh;
    const textures = this.atlasTextures;
    if (!mesh || !textures) return {};
    return {
      atlases: { main: textures.get(mesh.atlas), color: mesh.colorAtlas ? textures.get(mesh.colorAtlas) : null },
    };
  }

  /** 图层四边形与矩阵用的尺寸：文本层取排版的文字框（`TextLayout.size`，P6b 1d，WPE 不用 JSON 的 `size`），其余是 `layer.size`。 */
  private layerSize(layer: SceneLayer, state: SceneState): number[] {
    const layout = layer.text ? state.texts.get(layer.object) : undefined;
    return layout ? [...layout.size] : layer.size;
  }

  /** 文本层开了背景、走合成时 RT 的清屏色（P6b 1d，rea-p6b-layout 4）：背景常量（就地写过的值）与图层当前的 alpha。 */
  private textBackground(layer: SceneLayer, state: SceneState): number[] {
    const text = layer.text;
    const rgb = (text && state.constants.get(text.background.key)?.g_Color) ?? text?.background.color ?? [0, 0, 0];
    return [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, state.layers.get(layer.object)?.alpha ?? layer.alpha];
  }

  private resolveTarget(ref: TargetRef, resources: LayerResources): RenderTarget | null {
    if (ref.kind === "scene") return null;
    return this.resolveTexture(ref, resources);
  }

  /** 全场一份的粒子索引缓冲（`quadIndices`）：每粒子 `0 1 2 0 2 3`，建场景时写一次。 */
  private createParticleIndices(capacity: number): void {
    const particles = Math.max(1, capacity);
    const indices = quadIndices(particles);
    const buffer = this.own(
      this.device.createBuffer({
        label: "particle indices",
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      }),
    );
    this.device.queue.writeBuffer(buffer, 0, indices.buffer, indices.byteOffset, indices.byteLength);
    this.particleIndices = { buffer, format: indices instanceof Uint32Array ? "uint32" : "uint16", particles };
  }

  /**
   * 一个粒子层的模拟器（整棵系统树，P4e 步骤 1：子系统由根系统构造时一起建）：种子 = `particleSeed` + 第几个粒子层，建好就预热（C1；
   * 子系统先于父预热，`ParticleSystem.prewarm`）。
   * `instanceoverride` 取状态里的当前值（建场景时与编译期相同；万一单图层重建，用的也是就地写过的值），子系统从根上取。
   * 预热按状态里对象当前的世界矩阵更新控制点（P4c 步骤 1，rea-p4c-sim.md 1.3）；指针点的跟随点按最近的 cursor
   * （`particleCursor`，加载时是 `ParticleOptions.cursor`）反投影（P4c 步骤 2）。
   * 单图层重建（这一层已经有树）时新树沿用旧树的脚本暂停 / 停止（`adoptScriptControl`，P4f 步骤 3【推】）。
   */
  private createParticleTree(layer: SceneLayer, resources: LayerResources, state: SceneState): ParticleTree {
    const compiled = layer.particle!;
    const def = { ...compiled, instance: { ...compiled.instance, ...state.particleInstances.get(layer.object) } };
    const ordinal = this.particleOrdinals.get(layer.object) ?? 0;
    const system = new ParticleSystem(
      def,
      new SeededRandom((this.particleSeed + ordinal) >>> 0),
      this.particlePasses,
      this.particleROverride?.(layer.object),
    );
    // 建系统时钳过的 `rate`（加载，rea-p4f-script.md 6.1）写回状态：单图层重建时状态里可能是 `setRate` 单写的、没钳过的值（P4f 步骤 1）
    const values = state.particleInstances.get(layer.object);
    if (values) values.rate = system.instanceScalar("rate");
    // 频谱（P4e 步骤 4）：预热之前换上，预热读到的是当时的值（首次加载为 0，rea-p4e-audio.md 3.5【推】）
    system.setAudio(this.particleAudio);
    const world = worldMatrixOf(layer.object, state.layers, new Map());
    const inputs = { world, pointer: pointerScenePoint(this.viewProjection, this.particleCursor) };
    system.prewarm(inputs);
    // 单图层重建：旧树还在 `trees` 里（`install` 之后才换）
    const previous = this.trees.get(layer.object);
    if (previous) system.adoptScriptControl(previous.system);
    return {
      object: layer.object,
      layer,
      resources,
      system,
      world,
      inputs,
      templates: new Map(),
      framebuffer: particleTreeWantsFramebuffer(compiled),
    };
  }

  /**
   * 粒子层脚本方法的落点（P4f 步骤 3，`IParticleSystem`，`script/api.ts` 的 `installParticle`）：接到这一层的根系统（子系统与事件实例
   * 脚本拿不到，rea-p4f-script.md 1.5）。`stop` 与 `emitParticles` 改了粒子，标 `stale`（暂停中补画的帧也重写顶点）；`emitParticles` 带
   * 这一层最近一次交给根系统的控制点输入（`ParticleTree.inputs`）。没有这一层的树（不是粒子层、没有可画的模板）时为 null。
   */
  particleScript(object: number): ParticleScriptTarget | null {
    const tree = this.trees.get(object);
    if (!tree) return null;
    return {
      play: () => tree.system.scriptPlay(),
      pause: () => tree.system.scriptPause(),
      stop: () => {
        tree.system.scriptStop();
        this.markParticlesStale(object);
      },
      isPlaying: () => tree.system.scriptIsPlaying(),
      emitParticles: (count) => {
        tree.system.emitParticles(count, tree.inputs);
        this.markParticlesStale(object);
      },
    };
  }

  /**
   * 重编译换上新场景时，各粒子层沿用旧场景同一对象的脚本暂停 / 停止（P4f 步骤 3【推】，`ParticleSystem.adoptScriptControl`）：WPE 没有
   * 重编译，脚本 `stop()` / `pause()` 过的系统一直保持；我们的新树重新预热，不沿用就会自己又发起来。`SceneRenderer.load` 在换上新场景、
   * 画第一帧之前调。
   */
  adoptParticleScripts(previous: GpuScene): void {
    for (const [object, tree] of this.trees) {
      const old = previous.trees.get(object);
      if (old) tree.system.adoptScriptControl(old.system);
    }
  }

  /** 这一层的全部粒子绘制标 `stale`（下次编码重写顶点）：步进之后、脚本改了粒子之后。 */
  private markParticlesStale(object: number): void {
    for (const item of this.drawsByLayer.get(object) ?? []) if (item.particles) item.particles.stale = true;
  }

  /**
   * 一次粒子绘制的 CPU 侧顶点：系统是这个模板的一次出现（P4e 步骤 1、2），顶点按它自己的 renderer 与 `particleUnits` 分配，第一次
   * `encode` 时写（`stale`）。布局的问题 `checkRenderable` 已经查过。
   */
  private createParticles(step: ParticleStep, program: GpuProgram, system: ParticleSystem): ParticleDraw {
    const geometry = program.result.geometry;
    const units = particleUnits(system, step.instanced, system.alive);
    const base = { system, units, count: 0, stale: true, trailEye: null, hidden: false, instanced: step.instanced };
    // 模型矩阵由 `createDraw` 按当时的状态写
    const model = identity();
    if (geometry) {
      const rope = { maxVertices: geometry.maxVertices };
      // ropetrail（P4d 步骤 2）：每个存活粒子恒写 n 段，按 `maxcount × n` 段分配（WPE `segments·maxcount`，rea-p4d-rope.md 3.5）；
      // rope（P4d 步骤 1）：每段一个实例，最多 `maxcount − 1` 段，按 `maxcount` 段分配
      const { layout } = system.trail
        ? trailVertexLayout(program.vertexPacking)
        : ropeVertexLayout(program.vertexPacking);
      const vertices = new Float32Array(particleFloats(system, layout, rope, units));
      return { ...base, layout, rope, vertices, model };
    }
    const { layout } = particleVertexLayout(program.vertexPacking);
    const vertices = new Float32Array(particleFloats(system, layout, null, units));
    return { ...base, layout, rope: null, vertices, model };
  }

  /**
   * 粒子绘制的模型矩阵（`g_ModelMatrix`）：本地系统是对象的世界矩阵（父链），世界空间系统（系统 flags bit0，P4c 步骤 4）是单位阵。
   * WPE 绘制时把模型矩阵栈顶整个换成 `ctx+0xaf0`（`FUN_1402366f0`，`0x14023670c`–`0x140236748`，rea-p4c-sim.md 5.3），普通场景里
   * 是单位阵，所以只乘视图投影。uniform、朝向与拖尾的眼位都用它（rea-p4c-render.md 7.2：`g_Orientation*` 和 `g_ModelMatrix` 都取
   * `*(ctx+0x30)`）。
   * 子系统与事件实例的绘制（P4e 步骤 1、2，rea-p4e-children 第 6 节）：本地 static 子系统是 `父绘制栈顶 · L`、本地实例是 `父绘制栈顶 · X`，
   * 世界的都是单位阵（`ParticleSystem.drawTransform`，和 `forEachDrawn` 同一串运算）。
   */
  private particleModel(particles: ParticleDraw, object: number, state: SceneState, worlds: Map<number, Mat4>): Mat4 {
    return particles.system.drawTransform(worldMatrixOf(object, state.layers, worlds)).model;
  }

  /**
   * 按模型矩阵重算粒子层的绘制几何（P4c 步骤 5）：朝向是不是 NaN（`hidden`）、拖尾的眼位（`trailEye`）。建 draw 与就地刷新时调，
   * 和 uniform 同一个模型矩阵（记进 `model`）。拖尾的眼位变了，下一次画之前重写顶点（退化粒子的判断跟着变）。
   * rope 两类（P4d 步骤 1、2，同一个几何着色器）的几何只在 `ORIENTATION ≠ 0` 时读 `g_OrientationForward`（rea-p4d-rope.md 1.5），
   * screen 朝向不受它影响，不因它跳过；`ORIENTATION ≠ 0` 时朝向是 NaN 则整条带子的右向量都是 NaN，WPE 的图元全被丢弃，同样整次跳过。
   */
  private refreshParticleGeometry(particles: ParticleDraw, model: Mat4): void {
    particles.model = model;
    // 子系统按它自己的 renderer 与模型矩阵（P4e 步骤 1）
    const renderer = particles.system.def.renderer;
    if (!renderer) return;
    particles.hidden =
      particles.rope && renderer.orientation.mode === 0
        ? false
        : orientationBasis(renderer.orientation, model, this.viewVectors.forward, this.viewVectors.up) === null;
    const eye = renderer.kind === "spritetrail" ? trailEye(this.eye, model) : null;
    const previous = particles.trailEye;
    if (eye && (!previous || eye.some((value, i) => !Object.is(value, previous[i])))) particles.stale = true;
    particles.trailEye = eye;
  }

  private createDraw(
    layer: SceneLayer,
    step: DrawLike,
    resources: LayerResources,
    { program, pipeline }: PreparedDraw,
    state: SceneState,
    worlds: Map<number, Mat4>,
    /**
     * 粒子绘制的系统（P4e 步骤 1、2）：非实例化的模板是树里那个节点，实例化的模板是它这一次出现的实例；图像层不用。
     */
    system?: ParticleSystem,
    /** 实例化 draw 在池里的序号（第几次出现，从 0 起）：第 2 个起标签带 `#k`（k 从 1 起数）。 */
    occurrence = 0,
  ): Draw {
    const { device, bundle } = this;
    const { pass } = step;
    // 子系统的绘制在标签后面带上树里的路径（P4e 步骤 1），顶层的标签不变；同一模板的第 k 个 draw（P4e 步骤 2）再带 `#k`
    const label =
      step.kind === "particles"
        ? `layer ${layer.id} ${layer.name} particles${step.node.length ? ` ${step.node.join("/")}` : ""}${occurrence ? `#${occurrence + 1}` : ""}`
        : step.kind === "text"
          ? `layer ${layer.id} ${layer.name} text ${step.part}`
          : step.kind === "mesh"
            ? `layer ${layer.id} ${layer.name} mesh ${step.mesh}`
            : `layer ${layer.id} ${layer.name} ${step.role}`;

    let vertexBuffer: GPUBuffer;
    let particles: ParticleDraw | null = null;
    let text: TextDraw | null = null;
    let meshDraw: MeshDraw | null = null;
    let model: Mat4 | null = null;
    if (step.kind === "mesh") {
      // 模型网格（P5c 步骤 2）：mdl 的顶点与索引原样上传、按视图共用；网格没有的属性接占位缓冲（`meshVertexLayout`）
      const mesh = layer.model?.meshes[step.mesh];
      if (!mesh) throw new SceneRenderError([`render:mesh:${step.mesh}`]);
      const name = `${layer.model!.path}#${step.mesh}`;
      vertexBuffer = this.meshBuffer(mesh.vertices, GPUBufferUsage.VERTEX, `${name} vertices`);
      meshDraw = {
        indexBuffer: this.meshBuffer(mesh.indices, GPUBufferUsage.INDEX, `${name} indices`),
        indexFormat: mesh.indexFormat,
        count: mesh.indexCount,
        placeholder: this.meshLayoutOf(layer, step).placeholders ? this.meshPlaceholderBuffer() : null,
      };
    } else if (step.kind === "text") {
      // 文本（P6b 1d）：排版出的逐字四边形或背景四边形，按程序布局打包；索引照 WPE 的顺序，三角形列表
      const layout = state.texts.get(layer.object);
      const mesh = layout?.mesh;
      if (!layout || !mesh) throw new SceneRenderError([`render:text-layout:${layer.object}`]);
      const quads = step.part === "background" ? null : step.part === "color" ? mesh.colorGlyphs : mesh.glyphs;
      const vertices = quads ? textQuadVertices(quads) : backgroundQuadVertices(textCompositeSize(layout));
      const count = quads ? quads.length : 1;
      const vertexData = program.vertexPacking.pack(vertices);
      vertexBuffer = this.own(
        device.createBuffer({
          label,
          size: vertexData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(vertexBuffer, 0, vertexData);
      const indices = textIndexData(count);
      const indexBuffer = this.own(
        device.createBuffer({
          label: `${label} indices`,
          size: indices.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(indexBuffer, 0, indices.buffer, indices.byteOffset, indices.byteLength);
      text = { indexBuffer, indexFormat: indices instanceof Uint32Array ? "uint32" : "uint16", count: count * 6 };
    } else if (step.kind === "particles") {
      // 粒子：每帧由 `encode` 写，按 `particleUnits` 分配
      if (!system) throw new SceneRenderError([`render:particle-node:${step.node.join("/")}`]);
      particles = this.createParticles(step, program, system);
      model = this.particleModel(particles, layer.object, state, worlds);
      this.refreshParticleGeometry(particles, model);
      vertexBuffer = this.own(
        device.createBuffer({
          label,
          size: particles.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
    } else {
      // 几何：图层四边形（模型空间、未缩放的 size），或 2×2 的 NDC 四边形。后者的 UV 取步骤的：effect 中间 pass 是 (1, 1)、不内缩
      // （字节同以前），fullscreen 图层直接上屏取纹理上界（P5b 步骤 3）。形状层（P8 步骤 2）是 effect 常量的四个点围成的四边形
      // （`shapeQuad`，uv 就是点本身），点在编译期定好、不随常量就地写变（同 WPE）。几何 `layer` 的边长图像层按 `trunc(size)`
      // （P8 步骤 3，`screenQuadSize`，`p8-align2` 的 F1、F3），文本层按排版；`fill` 仍按浮点 size，和它的整面正交一致
      const vertices =
        step.geometry === "fullscreen"
          ? layerQuad([2, 2], step.uv, step.inset)
          : step.geometry === "shape"
            ? shapeQuad(this.layerSize(layer, state), layer.shape?.points ?? null)
            : step.geometry === "layer"
              ? layerQuad(screenQuadSize(layer, this.layerSize(layer, state)), step.uv, step.inset)
              : layerQuad(this.layerSize(layer, state), step.uv, step.inset);
      const vertexData = program.vertexPacking.pack(vertices);
      vertexBuffer = this.own(
        device.createBuffer({
          label,
          size: vertexData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    }

    const sizeOf = (ref: TextureRef | undefined) => {
      if (!ref) return undefined;
      if (ref.kind === "texture") return bundle.textures[ref.index];
      const target = this.resolveTexture(ref, resources);
      return target
        ? { width: target.width, height: target.height, textureWidth: target.width, textureHeight: target.height }
        : undefined;
    };

    // uniform：内置值打底，材质常量 / 用户属性覆盖（与就地刷新共用 `drawUniformValues`）
    let block: UniformBlock | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    let frameNames: string[] = [];
    let trailRenderVar = false;
    const slots = Math.max(10, ...program.textures.map((t) => t.slot + 1));
    const textureSizes = Array.from({ length: slots }, (_, slot) => sizeOf(step.inputs[slot]));
    if (program.uniformSize) {
      block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
      const layerState = state.layers.get(layer.object);
      if (layerState)
        for (const [name, values] of Object.entries(
          this.uniformValues(step, layer, layerState, textureSizes, state, worlds, model),
        ))
          block.set(name, values);
      frameNames = Object.keys(
        frameBuiltins({ time: 0, frametime: 0, daytime: 0, pointer: [0, 0], pointerLast: [0, 0], cursor: [0, 0] }),
      ).filter((name) => block!.has(name) && !(name in pass.uniforms));
      // ropetrail（P4d 步骤 2）的 g_RenderVar0 随计时器每帧变（建 draw 时的值是计时器初值 0 的，`particleBuiltins`）
      trailRenderVar = !!particles?.system.trail && block.has("g_RenderVar0") && !("g_RenderVar0" in pass.uniforms);
      uniformBuffer = this.own(
        device.createBuffer({
          label,
          size: block.data.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      traceUniforms(uniformBuffer, (program.result.uniforms ?? []) as UniformEntry[]);
      device.queue.writeBuffer(uniformBuffer, 0, block.data);
    }

    // 视频纹理（P9a）：只看着色器真正绑定的槽（WPE 绑定时遍历程序用到的槽表，只更新这些，rea-p9-video 第 2 节第 4 条）
    const videos = [
      ...new Set(
        program.textures.flatMap((binding) => {
          const ref = step.inputs[binding.slot];
          return ref?.kind === "texture" && bundle.textures[ref.index]?.video ? [ref.index] : [];
        }),
      ),
    ];

    const entries = (resolveFbo: (effect: number, name: string) => RenderTarget): GPUBindGroupEntry[] => {
      const list: GPUBindGroupEntry[] = [];
      if (uniformBuffer) list.push({ binding: 0, resource: { buffer: uniformBuffer } });
      for (const binding of program.textures) {
        const ref = step.inputs[binding.slot];
        let view: GPUTextureView;
        let sampler: GPUSampler;
        if (!ref) {
          view = this.dummies.views[binding.kind];
          sampler = binding.kind === "2d-comparison" ? this.dummies.comparison : this.dummies.sampler;
        } else {
          if (binding.kind !== "2d")
            throw new SceneRenderError([`render:texture-kind:${binding.slot}:${binding.kind}`]);
          if (ref.kind === "texture") {
            view = this.textures[ref.index]!.createView();
            sampler = this.samplerFor(bundle.textures[ref.index]);
          } else {
            const target = ref.kind === "fbo" ? resolveFbo(ref.effect, ref.name) : this.resolveTexture(ref, resources);
            if (!target) throw new SceneRenderError([`render:texture-rt:${ref.kind}`]);
            view = target.view;
            sampler = target.sampler;
          }
        }
        list.push({ binding: binding.binding, resource: view });
        list.push({ binding: binding.samplerBinding, resource: sampler });
      }
      return list;
    };
    const dynamic = Object.values(step.inputs).some((ref) => ref.kind === "fbo");
    const resolveNow = (effect: number, name: string) => this.targets[resources.fbos.resolve(effect, name)];
    const bindGroup = dynamic
      ? null
      : device.createBindGroup({ label, layout: program.bindGroupLayout, entries: entries(resolveNow) });

    return {
      label,
      step,
      particles,
      text,
      mesh: meshDraw,
      program,
      object: layer.object,
      layer,
      passKey: pass.key,
      resources,
      pipeline,
      vertexBuffer,
      uniformBuffer,
      block,
      frameNames,
      trailRenderVar,
      textureSizes,
      videos,
      dirty: false,
      bindGroup,
      bindGroups: new Map(),
      entries,
      layout: program.bindGroupLayout,
    };
  }

  /** 引用 fbo 的 bind group 按当前 swap 状态取（各状态各建一次）。 */
  private bindGroupOf(draw: Draw): GPUBindGroup {
    if (draw.bindGroup) return draw.bindGroup;
    const ids: number[] = [];
    const resolve = (effect: number, name: string) => {
      const id = draw.resources.fbos.resolve(effect, name);
      ids.push(id);
      return this.targets[id];
    };
    const entries = draw.entries(resolve);
    const key = ids.join(",");
    let group = draw.bindGroups.get(key);
    if (!group) {
      group = this.device.createBindGroup({ label: draw.label, layout: draw.layout, entries });
      draw.bindGroups.set(key, group);
    }
    return group;
  }

  /**
   * 一个 draw 的全部静态 uniform（建 draw 与就地刷新共用）：图层状态、按父链算的世界矩阵 + 场景级常量（建场景时算一次）。
   * 图层走 `drawUniformValues`，粒子走 `particleUniformValues`（透视粒子换视图投影）。视图投影是取矩阵的唯一入口，开着视差时
   * 两条路径都换成带视差的（`viewProjectionOf`，P5a 步骤 2）。场景级的视图投影与眼位带本帧的抖动与缩放（`setCamera`，步骤 3、4）。
   */
  private uniformValues(
    step: DrawLike,
    layer: SceneLayer,
    layerState: LayerState,
    textures: readonly (TextureSize | undefined)[],
    state: SceneState,
    worlds: Map<number, Mat4>,
    /** 粒子绘制的模型矩阵（`particleModel`，调用方算好、同时记进 `ParticleDraw.model`）；图像层不用。 */
    model: Mat4 | null = null,
  ): Record<string, number[]> {
    const common = {
      // 图层画自己的矩阵（P8 步骤 3）：世界矩阵再乘自身偏移（文本排版、图像层对齐），直接上屏、合成链各角色、效果矩阵、
      // `g_LayerModelMatrix` 与文本都用它；粒子下面换成 `model`，模型网格没有偏移（字节同 `worldMatrixOf`）
      world: drawMatrixOf(layer.object, state.layers, worlds),
      constants: state.constants.get(step.pass.key) ?? {},
      // HDR 下颜色乘 brightness（B10）；passthrough 的 g_Color4 由材质值覆盖成 (1, 1, 1, 1)
      colorScale: this.hdr ? layerState.brightness : 1,
      screenSize: [this.width, this.height] as [number, number],
      textures,
      eye: this.eye,
      // 视图向量（P5d 步骤 2）：全部 pass 都写，正交场景是常量
      view: this.viewVectors,
      // 读状态，不读编译结果：单图层重建新建的 draw 要拿到当前值
      ambient: state.general.ambientcolor,
      skylight: state.general.skylightcolor,
    };
    // 组里的图层（P5b 步骤 4，p5-REPORT `p5b-grp-*`、`p5b-grpptc`）：视图投影换成组的局部正交 `ortho(±w/2, ±h/2, ±1000) · inverse(W_组)`，
    // 不经 `viewProjectionOf`（组里没有视差、抖动、缩放、透视，它们只作用在组本身，`p5b-grp-par`）。嵌套组自己的 compose 基础 pass
    // 例外，照旧用场景视图投影按屏幕位置采快照（`p5b-nest` 事件 94）；effect 中间 pass 的效果矩阵也按组的局部正交算（WPE 画子树时
    // 投影栈就是它，没有实测）。组的矩阵取它画自己的那个（P8 步骤 3，带组的对齐偏移：`p8-align2` 的 Gc 落在组 RT 的左上角）
    const group = this.groupOf(layer);
    const groupVp =
      group && !(step.kind === "draw" && step.role === "compose")
        ? groupViewProjection(group.size, drawMatrixOf(group.object, state.layers, worlds))
        : null;
    if (step.kind === "text") {
      // 文本（P6b 1d）：直接上屏用这次画到场景的视图投影（带视差、抖动；组里是组的局部正交），画进合成 RT 用 RT 像素的正交
      // （`textMatrices`）。排版结果在建 draw 前已核对过
      return textUniformValues({
        ...common,
        step,
        layer: layerState,
        layout: state.texts.get(layer.object)!,
        viewProjection: groupVp ?? this.viewProjectionOf(layer, state, this.viewProjection),
      });
    }
    if (step.kind === "particles") {
      // 帧表（P4b 步骤 2）：槽 0 的纹理带帧表时写 `g_RenderVar1`
      const base = step.inputs[0];
      return particleUniformValues({
        ...common,
        // 世界空间系统（P4c 步骤 4）是单位阵，对象变换改了照样走这里重写，仍是单位阵（`particleModel`）；子系统与事件实例按树算
        // （P4e 步骤 1、2）
        world: model ?? identity(),
        layer: layerState,
        // 透视粒子同样带视差：平移加在世界坐标里，z = 0 平面上和正交一致（p5-REPORT `p5a-fx`）；组里的透视粒子照报
        // （`model:passthrough:children:perspective`），强制渲染时按组的局部正交画
        viewProjection:
          groupVp ??
          this.viewProjectionOf(layer, state, step.perspective ? this.perspectiveViewProjection : this.viewProjection),
        sheet: base?.kind === "texture" ? this.bundle.textures[base.index]?.sheet : undefined,
        // 朝向与拖尾的 g_RenderVar0（P4c 步骤 5）：这次绘制的系统自己的 renderer（P4e 步骤 1）
        renderer: layer.particle ? particleNode(layer.particle, step.node).renderer : undefined,
      });
    }
    if (step.kind === "mesh")
      // 模型网格（P5c 步骤 2）：同图像层直接上屏（`direct` 角色：`g_ModelMatrix` 是世界矩阵、MVP = VP · W，不乘 `size`），只换颜色组：
      // WPE 画网格之前把 `g_Color` / `g_Alpha` 写成 1（rea-p5-mesh 2.5，p5-REPORT `p5c-color`：对象写 `color 1 0 0`、`alpha 0.5`、
      // `brightness 3` 时 `g_Color4` 仍是 (1, 1, 1, 1)，HDR 同样）。视图投影带视差、抖动、缩放，`perspective: true` 换透视那一份
      // （`p5c-matrix` 的视差、缩放、透视三份，和图像层相同）；组里的模型照报，强制渲染时用组的局部正交
      return drawUniformValues({
        ...common,
        colorScale: 1,
        step: { role: "direct", inputs: step.inputs },
        layer: { ...layerState, color: [1, 1, 1], alpha: 1, size: layer.size },
        viewProjection:
          groupVp ??
          this.viewProjectionOf(layer, state, layer.perspective ? this.perspectiveViewProjection : this.viewProjection),
      });
    // fullscreen（P5b 步骤 3，p5-REPORT `p5b-fs` 事件 76）：直接上屏以外的角色（effect、末 pass、passthrough 上屏）模型与视图都是
    // 单位阵、投影是 NDC 正交，不经 `viewProjectionOf`：`origin` / `scale` / `angles`、视差、抖动、透视都不起作用，2×2 的四边形
    // 正好铺满全屏。效果矩阵跟着是单位阵（`size` 是 (2, 2)，`scale(w/2, h/2)` 也是单位阵）。直接上屏照常（下面）
    if (layer.fullscreen && step.role !== "direct")
      return drawUniformValues({
        ...common,
        world: identity(),
        step,
        layer: { ...layerState, size: this.layerSize(layer, state) },
        viewProjection: FULLSCREEN_VIEW_PROJECTION,
      });
    return drawUniformValues({
      ...common,
      step,
      layer: { ...layerState, size: this.layerSize(layer, state) },
      // 图像层 perspective（P5b 步骤 1，p5-REPORT `p5b-persp`）：画到场景目标的绘制（直接上屏、末 pass、passthrough 上屏）换成透视粒子
      // 那一份视图投影（相机距离随 perspectiveoverridefov 与 zoom 变，已带抖动），视差平移照旧右乘；画进合成 RT / fbo 的 pass 不变。
      // 组里的图层用组的局部正交（组里的透视图层照报，强制渲染时不换透视）
      viewProjection:
        groupVp ??
        this.viewProjectionOf(
          layer,
          state,
          layer.perspective && step.target.kind === "scene" ? this.perspectiveViewProjection : this.viewProjection,
        ),
    });
  }

  /**
   * 一次绘制的视图投影（P5a 步骤 2）：开着视差时是 `base · T(o)`（列向量约定：先把世界坐标平移 o，再投影；WPE 行向量下的
   * `V′ = T(o)·V`，rea-p5-camera.md 6.3），o 由 draw 所属对象的根对象的当前 `origin` 字段与 `parallaxDepth` 算；关着、根不在表里或
   * o 为 0 时原样返回 `base`，字节不变。`base` 是 `viewProjection` / `perspectiveViewProjection`，已带抖动的 `T(−s)`（步骤 3），
   * 两个平移相乘就是 `VP · T(o − s)`。
   */
  private viewProjectionOf(layer: SceneLayer, state: SceneState, base: Mat4): Mat4 {
    const parallax = this.parallax;
    if (!parallax) return base;
    const root = state.layers.get(rootObject(layer.object, state.layers));
    if (!root) return base;
    const [x, y] = parallaxOffset(parallax.amount, root.parallaxDepth, root.origin, parallax.point);
    return x === 0 && y === 0 ? base : multiply(base, translation(x, y, 0));
  }

  /**
   * 本帧的相机：抖动偏移 s（P5a 步骤 3，`render/shake.ts`，关着时 (0, 0)）与正交缩放 zoom（步骤 4，`general.zoom`）。渲染器每帧在
   * 粒子步进之后、脚本之前交来，两者都按脚本之前的字段取。zoom 变了先按它重算两份基准矩阵（`sceneViewProjection` /
   * `particleViewProjection`，透视粒子的相机距离跟着变）；任何一项变了就换掉场景级的视图投影（`base · T(−s)`，正交与透视粒子各一份）
   * 与眼位（`eyePosition(general, s)`，不随缩放变，步骤 4 补测），并标记相机变了。s 为 (0, 0) 时直接用基准矩阵，字节同没有抖动。
   * 只改场景级的值：下一次 `stepParticles`（即下一帧的模拟，同 WPE 用上一帧的相机）的指针反投影用它，draw 的 uniform 留给随后的
   * `setParallax` 一起重写（一帧至多一次）。
   * 正交场景带 `cameraObject`（P5d 步骤 3，有可见的相机对象）时整套取它（`applyCameraObject`）；没有时逐字同以前，只是刚离开相机对象
   * 的那一帧不提前返回、视图向量回到常量。
   */
  setCamera(camera: SceneCamera): void {
    if (camera.kind === "perspective") {
      this.applyPerspective(camera.frame);
      return;
    }
    if (camera.cameraObject) {
      this.applyCameraObject(camera.cameraObject);
      return;
    }
    const [x, y] = camera.shake;
    const { zoom } = camera;
    const zoomed = zoom !== this.zoom;
    if (!zoomed && x === this.shake[0] && y === this.shake[1] && !this.objectCamera) return;
    // 刚离开相机对象（P5d 步骤 3，相机对象被隐藏）：视图向量回到正交常量，下面按 zoom 与 s 整套重算
    if (this.objectCamera) {
      this.objectCamera = false;
      this.viewVectors = ORTHO_VIEW_VECTORS;
    }
    if (zoomed) {
      this.zoom = zoom;
      this.baseViewProjection = sceneViewProjection(this.bundle.general, zoom);
      this.basePerspectiveViewProjection = particleViewProjection(this.bundle.general, zoom);
    }
    this.shake = [x, y];
    const still = x === 0 && y === 0;
    this.viewProjection = still ? this.baseViewProjection : multiply(this.baseViewProjection, translation(-x, -y, 0));
    this.perspectiveViewProjection = still
      ? this.basePerspectiveViewProjection
      : multiply(this.basePerspectiveViewProjection, translation(-x, -y, 0));
    this.eye = eyePosition(this.bundle.general, [x, y]);
    this.cameraDirty = true;
  }

  /**
   * 透视场景的相机（P5d 步骤 2）：场景级的视图投影换成 `P·V`（普通图像层、粒子、模型、合成链末 pass、视锥剔除、指针反投影都从这里
   * 取，`p5d-persp` / `p5d-2d` / `p5d-ptc` 实测），`g_EyePosition` 是 eye（含路径与抖动），视图向量换成相机的。有变化才标记
   * 相机变了（draw 的重写同正交，留给随后的 `setParallax`）。透视粒子那一份不动（照报）。
   */
  private applyPerspective(frame: PerspectiveCameraFrame): void {
    const vectors = this.viewVectors;
    if (
      same(frame.viewProjection, this.viewProjection) &&
      same(frame.eye, this.eye) &&
      same(frame.vectors.forward, vectors.forward) &&
      same(frame.vectors.right, vectors.right) &&
      same(frame.vectors.up, vectors.up)
    )
      return;
    this.viewProjection = this.baseViewProjection = frame.viewProjection;
    this.eye = [...frame.eye];
    this.viewVectors = frame.vectors;
    this.cameraDirty = true;
  }

  /**
   * 正交场景的相机对象（P5d 步骤 3）：场景级的视图投影换成 `sceneViewProjection(general, 总缩放) · V`，透视覆盖（透视粒子、
   * `perspective: true` 的图像层 / 模型）换成在相机 V 上做的那一份，`g_EyePosition` 加相机的 eye.xy，视图向量取 V（都在
   * `orthographicCameraObjectFrame` 里算好）。有变化才标记相机变了（draw 的重写同正交，留给随后的 `setParallax`）。
   */
  private applyCameraObject(frame: OrthographicCameraFrame): void {
    const vectors = this.viewVectors;
    if (
      this.objectCamera &&
      same(frame.viewProjection, this.viewProjection) &&
      same(frame.perspectiveViewProjection, this.perspectiveViewProjection) &&
      same(frame.eye, this.eye) &&
      same(frame.vectors.forward, vectors.forward) &&
      same(frame.vectors.right, vectors.right) &&
      same(frame.vectors.up, vectors.up)
    )
      return;
    this.objectCamera = true;
    this.viewProjection = frame.viewProjection;
    this.perspectiveViewProjection = frame.perspectiveViewProjection;
    this.eye = [...frame.eye];
    this.viewVectors = frame.vectors;
    this.cameraDirty = true;
  }

  /**
   * 本帧的视差（P5a 步骤 2）：渲染器每帧在脚本之后、第二次 `sync` 之前交来（开关关着时为 null）。和上一次不同（开与关互换、P 或
   * amount 变），或者 `setCamera` 改了相机（步骤 3、4）时记下，并按 `state` 把全部 draw 由图层与相机算出的那组 uniform 重写一遍
   * （`refreshLayer`，共用一份世界矩阵缓存），清掉相机的标记；都没变时什么都不做。之后单图层重建新建的 draw 按记下的值写。
   */
  setParallax(next: SceneParallax | null, state: SceneState): void {
    const current = this.parallax;
    const same =
      (!current && !next) ||
      (!!current &&
        !!next &&
        current.amount === next.amount &&
        current.point[0] === next.point[0] &&
        current.point[1] === next.point[1]);
    if (same && !this.cameraDirty) return;
    this.parallax = next ? { point: [next.point[0], next.point[1]], amount: next.amount } : null;
    this.cameraDirty = false;
    const worlds = new Map<number, Mat4>();
    for (const draw of this.draws) this.refreshLayer(draw, state, worlds);
  }

  /**
   * 把 `SceneState` 的脏项刷进 uniform 块 / 泛光链（在 `update` 之前调用）。
   * 脏 draw 由 `update` 整块重写。结构脏当场处理，返回时新结构已换上。
   */
  sync(state: SceneState): void {
    const dirty = state.takeDirty();
    // 本次的状态快照下的世界矩阵：重建与刷新共用，一条父链只算一次。父的变换写过时子孙已在 `dirty.layers` 里（`SceneState.write`）
    const worlds = new Map<number, Mat4>();
    // 文本最先（P6b 1e）：重排、换进状态、图集纹理、强制重建本层；偏移变了的本层与子孙并进这次的 `dirty.layers`，下面照常刷
    this.syncTexts(dirty, state, worlds);
    // 结构先处理：新 draw 按当前状态写 uniform，后面的刷新也落在新 draw 上
    this.rebuildStructures(dirty.structures, state, worlds);
    for (const object of dirty.layers)
      for (const draw of this.drawsByLayer.get(object) ?? []) this.refreshLayer(draw, state, worlds);
    for (const key of dirty.passes) for (const draw of this.drawsByPass.get(key) ?? []) this.refreshPass(draw, state);
    if (dirty.lights) for (const draw of this.draws) this.refreshLights(draw, state);
    // `instanceoverride` 改值：模拟器从基值重新乘，不重建缓冲、不清粒子（P4a 步骤 5，C5）。只交给根系统，由它递归到 static 子系统与
    // 事件实例（P4e 步骤 1、2，rea-p4e-children 3.4）。
    // 单写的 `rate` 先走（P4f 步骤 1，rea-p4f-script.md 5.4：没有改值回调，只改步进率，不钳制、不重算），再做置脏的重算：同一帧两边都
    // 写了时，WPE 下一帧开头先钳 `io.rate` 再重算（5.2），结果是钳过的值，`setInstance` 开头的钳制覆盖 `setRate`。重算里钳过的
    // `rate` 写回状态（WPE 写回 `io.rate`，之后脚本与属性面板读到的是钳过的值）
    for (const object of dirty.rates) {
      const values = state.particleInstances.get(object);
      const tree = this.trees.get(object);
      if (values && tree) tree.system.setRate(values.rate);
    }
    for (const object of dirty.particles) {
      const values = state.particleInstances.get(object);
      const tree = this.trees.get(object);
      if (!values || !tree) continue;
      tree.system.setInstance(values);
      values.rate = tree.system.instanceScalar("rate");
    }
    if (dirty.bloom) this.bloom?.setParams(state.bloom);
    if (!state.general.clearenabled && !this.alternate) this.addAlternateTarget();
  }

  /**
   * 文本层运行中重排与重建（P6b 1e，`sync` 最先调）：
   * 1. `dirty.texts` 里的层按 `textFields` 重排（`relayoutTexts`），排成的经 `setText` 换进状态。偏移变了时 `setText` 把本层与子孙标进
   *    状态的脏图层，这次 `sync` 已经取走过一次，再取一次并进 `dirty`（同一帧生效）；
   * 2. 图集纹理：增量上传，扩容了的重建纹理（`TextAtlasTextures.sync`），用它们的层要重建（UV 从字形对象现读，不用重排）；
   * 3. 对重排成的与用了重建纹理的层 `rebuildLayer(…, { force: true })`。
   * 没有文本层时只有一次图集纹理的空遍历，非文本场景的行为不变。
   */
  private syncTexts(dirty: DirtyState, state: SceneState, worlds: Map<number, Mat4>): void {
    const atlasTextures = this.atlasTextures;
    if (!atlasTextures) return;
    const rebuild = new Set<number>();
    const started = performance.now();
    const relayouts = dirty.texts.size ? this.relayoutTexts(dirty.texts, state, rebuild) : 0;
    const relayoutMs = performance.now() - started;
    if (relayouts) {
      const again = state.takeDirty();
      mergeDirty(dirty, again);
      // 重排期间不会有文本标脏（读完字体的回调在帧外）；万一有，放回去留给下一次
      for (const object of again.texts) state.touchText(object);
    }
    for (const atlas of atlasTextures.sync())
      for (const object of this.textLayersUsing(atlas, state)) rebuild.add(object);
    const rebuildStarted = performance.now();
    for (const object of rebuild) {
      const runtime = this.runtimeByObject.get(object);
      if (runtime) this.rebuildLayer(runtime, state, worlds, { force: true });
    }
    if (!relayouts && !rebuild.size) return;
    const counts = this.textCounts;
    counts.syncs++;
    counts.relayouts += relayouts;
    counts.rebuilds += rebuild.size;
    recordSample(this.textTimings.layers, relayouts);
    recordSample(this.textTimings.relayoutMs, relayoutMs);
    recordSample(this.textTimings.rebuildMs, performance.now() - rebuildStarted);
  }

  /**
   * 按当前字段重排脏文本层（P6b 1e），返回调了几次重排器；排成的换进状态（`setText`）、记进 `rebuild`。没有重排器时什么都不做（字段照存，
   * 画面不变）。重排器返回 null（缺字体、过期）时旧排版照画。某张图集在这次重排里清空重排过（`GlyphAtlas.resets` 变了，已定 5）：别的层
   * 正在用的字形被标成回收、像素可能被覆盖，用这张图集的别的层（这次已经排过的也算）排进队列再排一次；每层一次 `sync` 最多排
   * `TEXT_RELAYOUT_LIMIT` 次，连环重置时停下。
   */
  private relayoutTexts(objects: ReadonlySet<number>, state: SceneState, rebuild: Set<number>): number {
    const relayouter = this.relayouter;
    if (!relayouter) return 0;
    const queue = [...objects];
    const queued = new Set(queue);
    const times = new Map<number, number>();
    let calls = 0;
    while (queue.length) {
      const object = queue.shift()!;
      queued.delete(object);
      const previous = state.texts.get(object);
      const fields = state.textFields.get(object);
      // 没建资源的文本层（写死不可见的分组下面）不排
      if (!this.runtimeByObject.get(object)?.layer.text || !previous || !fields) continue;
      const count = times.get(object) ?? 0;
      if (count >= TEXT_RELAYOUT_LIMIT) continue;
      times.set(object, count + 1);
      calls++;
      const layout = relayouter.relayout(object, fields, previous);
      for (const atlas of layoutAtlases(previous, layout)) {
        if (atlas.resets === (this.atlasResets.get(atlas) ?? 0)) continue;
        this.atlasResets.set(atlas, atlas.resets);
        for (const other of this.textLayersUsing(atlas, state))
          if (other !== object && !queued.has(other)) {
            queue.push(other);
            queued.add(other);
          }
      }
      if (!layout) {
        this.textCounts.waiting++;
        continue;
      }
      state.setText(object, layout);
      rebuild.add(object);
    }
    return calls;
  }

  /** 当前排版用到 `atlas`（主图集或彩色图集）的文本层（建了资源的，`objects` 下标）。 */
  private textLayersUsing(atlas: GlyphAtlas, state: SceneState): number[] {
    const out: number[] = [];
    for (const [object, runtime] of this.runtimeByObject)
      if (runtime.layer.text && layoutAtlases(state.texts.get(object)).includes(atlas)) out.push(object);
    return out;
  }

  /**
   * dev 探针（`host.texts()`）：运行中重排的统计（P6b 1e）。`syncs` 是有重排或重建的 `sync` 次数，`relayouts` 是重排器调用次数（含没排成的），
   * `waiting` 是缺字体或过期没排成的次数，`rebuilds` 是强制重建的层数；`layers` / `relayoutMs` / `rebuildMs` 是这些 `sync` 每次的重排层数与
   * 用时（最近 600 次的均值、p95、最大值，毫秒）。
   */
  textStats(): {
    syncs: number;
    relayouts: number;
    waiting: number;
    rebuilds: number;
    layers: ReturnType<typeof timingStats>;
    relayoutMs: ReturnType<typeof timingStats>;
    rebuildMs: ReturnType<typeof timingStats>;
  } {
    return {
      ...this.textCounts,
      layers: timingStats(this.textTimings.layers),
      relayoutMs: timingStats(this.textTimings.relayoutMs),
      rebuildMs: timingStats(this.textTimings.rebuildMs),
    };
  }

  private createAlternateTarget(): SceneTarget {
    return this.createSceneTarget("scene target 2", GPUTextureUsage.COPY_DST);
  }

  /** 没有声明的脚本第一次关掉清屏：当场建第二张，把当前画面拷过去。这一帧的底图是 N−1，静止内容相同。 */
  private addAlternateTarget(): void {
    if (!this.current) return;
    const alternate = this.createAlternateTarget();
    const encoder = this.device.createCommandEncoder({ label: "scene target copy" });
    encoder.copyTextureToTexture(
      { texture: this.current.texture },
      { texture: alternate.texture },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([encoder.finish()]);
    this.alternate = alternate;
  }

  /**
   * HDR 不清屏时把底图换回 WPE 的空间。WPE 收尾写 `lin(x)`（`combine_hdr`、`passthroughsrgb`），下一轮底图是线性值，累加因此收敛；
   * 我们的目标存 `x`（画布是 8 位 sRGB 编码，单帧逐值相等，P2b），不补这一步就一直涨（L21）。
   * 快照当中转：这一帧要读它之前总有 `snapshot` 操作重新拷。
   */
  private linearizeBase(encoder: GPUCommandEncoder, { texture, view }: SceneTarget): void {
    this.ensureSnapshot();
    const snapshot = this.snapshot!;
    if (!this.linearBase) {
      const module = this.device.createShaderModule({ label: "scene base linear", code: LINEAR_BASE_WGSL });
      const pipeline = this.device.createRenderPipeline({
        label: "scene base linear",
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: this.format }] },
        primitive: { topology: "triangle-list" },
      });
      const bindGroup = this.device.createBindGroup({
        label: "scene base linear",
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: snapshot.view }],
      });
      this.linearBase = { pipeline, bindGroup };
    }
    encoder.copyTextureToTexture(
      { texture },
      { texture: snapshot.texture },
      { width: this.width, height: this.height },
    );
    const pass = encoder.beginRenderPass({
      label: "scene base linear",
      colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(this.linearBase.pipeline);
    pass.setBindGroup(0, this.linearBase.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** effect 开关真的变了的图层：重排，再清 fbo。清屏提交在这一帧的绘制之前。 */
  private rebuildStructures(objects: ReadonlySet<number>, state: SceneState, worlds: Map<number, Mat4>): void {
    if (!objects.size) return;
    const encoder = this.device.createCommandEncoder({ label: "effect clear" });
    let cleared = false;
    for (const object of objects) {
      const runtime = this.layers.find((layer) => layer.object === object);
      if (!runtime) continue;
      this.rebuildLayer(runtime, state, worlds);
      // 签名没变也要清：同一帧内关了又开，WPE 仍然重建
      cleared = this.clearLayerFbos(encoder, runtime) || cleared;
    }
    if (cleared) this.device.queue.submit([encoder.finish()]);
  }

  /**
   * 切换当场做完：程序与管线都是加载时备好的，这里不编译、不等待。copy / swap 与程序的检查已提前到 `prepareVariants`，n + 2 份之外的组合由 `planProblems` 当场查，
   * 万一还有校验错误，走 `onuncapturederror`。旧 draw 的缓冲换下时销毁：已提交的帧不受影响，之后的帧只用新 draw。
   */
  private rebuildLayer(
    runtime: LayerRuntime,
    state: SceneState,
    worlds: Map<number, Mat4>,
    /**
     * `force`（P6b 1e）：签名相同也重建。文本层换了排版时用：直接上屏的文本换了字签名不变，顶点、索引、合成 RT 尺寸与图集却都变了。
     * 强制重建不计入 `rebuildStats`（那是 effect 开关的），记在 `textStats`。
     */
    options: { force?: boolean } = {},
  ): void {
    const plan = this.planOf(runtime.layer, state);
    const signature = planSignature(plan);
    if (!options.force && signature === runtime.signature) return;
    const started = performance.now();
    // 开关组合太多，`prepareVariants` 只查 n + 2 份；全部开着的 effect 都没有绘制 pass 这类组合在这里才查得到
    const problems = planProblems(plan, this.bundle, runtime.layer.particle, runtime.layer.model);
    if (problems.length) throw new SceneRenderError(problems);
    // 先取管线（缺了就抛，这时什么都还没换）；文本层再按新排版换独占的合成 RT、fbo 与图集，新 draw 才绑得到
    const prepared = this.preparedOf(plan, runtime);
    if (runtime.layer.text) this.ensureTextResources(runtime, plan, state);
    const built = this.buildLayer(runtime, plan, prepared, state, worlds);
    for (const draw of runtime.draws) {
      this.draws.delete(draw);
      this.drawsByPass.delete(draw.passKey);
      // 网格的顶点 / 索引缓冲按视图共用（`meshBuffer`），随场景销毁，这里不释放
      if (!draw.mesh) this.release(draw.vertexBuffer);
      if (draw.uniformBuffer) this.release(draw.uniformBuffer);
      if (draw.text) this.release(draw.text.indexBuffer);
    }
    this.install(runtime, built);
    runtime.signature = signature;
    if (options.force) return;
    const elapsed = performance.now() - started;
    this.rebuildStats.count++;
    this.rebuildStats.totalMs += elapsed;
    this.rebuildStats.maxMs = Math.max(this.rebuildStats.maxMs, elapsed);
  }

  /**
   * 清本图层全部 effect 带 `clear` 的 fbo，含没切的和关着的（J6），返回有没有清。
   * 实体按初始对应取：swap 只改 pass 下标，清的是 fbo 本身。
   */
  private clearLayerFbos(encoder: GPUCommandEncoder, { layer, resources }: LayerRuntime): boolean {
    let cleared = false;
    layer.effects.forEach((effect, e) => {
      for (const fbo of effect.fbos) {
        if (!fbo.clear) continue;
        this.clearTarget(encoder, this.targets[resources.fbos.initial(e, fbo.name)], fbo.clear, `clear ${fbo.name}`);
        cleared = true;
      }
    });
    return cleared;
  }

  /**
   * 图层（或它某个祖先）状态变化：只重写由图层算出的那组内置 uniform（材质值优先，不覆盖）。粒子 draw 的模型矩阵按它当前的系统现算
   * （`particleModel`）；实例化的 draw（P4e 步骤 2）换了实例或实例的 `X` 变了，编码时同样走这里（`assignParticles`）。
   */
  private refreshLayer(draw: Draw, state: SceneState, worlds: Map<number, Mat4>): void {
    // 粒子层的朝向是否 NaN、拖尾的眼位随模型矩阵变（P4c 步骤 5），没有 uniform 块也要跟上
    let model: Mat4 | null = null;
    if (draw.particles) {
      model = this.particleModel(draw.particles, draw.object, state, worlds);
      this.refreshParticleGeometry(draw.particles, model);
    }
    const layerState = state.layers.get(draw.object);
    if (!draw.block || !layerState) return;
    const values = this.uniformValues(draw.step, draw.layer, layerState, draw.textureSizes, state, worlds, model);
    const names = layerRefreshNames(draw.step.pass.uniforms);
    // 朝向由模型矩阵算（P4c 步骤 5），对象变换变了一起重写；材质值同样优先
    if (draw.particles) names.push(...PARTICLE_REFRESH_UNIFORMS.filter((name) => !(name in draw.step.pass.uniforms)));
    for (const name of names) {
      const value = values[name];
      if (value) draw.block.set(name, value);
    }
    draw.dirty = true;
  }

  /** 材质常量变化：重写本 pass 的全部材质常量（含用户属性写进 `constantshadervalues` 的那些）。 */
  private refreshPass(draw: Draw, state: SceneState): void {
    const constants = state.constants.get(draw.passKey);
    if (!draw.block || !constants) return;
    for (const [name, values] of Object.entries(constants)) draw.block.set(name, values);
    draw.dirty = true;
  }

  /** 环境光变化：只写块里有、材质没覆盖的名字；都没有时不标脏，脚本逐帧写时不重传无关的缓冲。 */
  private refreshLights(draw: Draw, state: SceneState): void {
    const { block, step } = draw;
    if (!block) return;
    for (const [name, key] of Object.entries(LIGHT_UNIFORMS)) {
      if (!block.has(name) || name in step.pass.uniforms) continue;
      block.set(name, state.general[key]);
      draw.dirty = true;
    }
  }

  /**
   * 写每帧变化的 uniform（`g_Time` 等）；被就地改过的 draw 整块重写一次。不步进粒子：粒子由调用方在脚本之前先
   * `stepParticles`（P4c 步骤 4，见那里），这里只写 uniform。`state` 不读，留着和调用方的写法对称。
   * ropetrail（P4d 步骤 2）的 `g_RenderVar0` 每帧按系统当时的计时器写（`trailRenderVar0`，WPE 每次绘制前写，rea-p4d-rope.md
   * 第 4 节）：步进在前，所以是本帧采样之后的计时器。
   */
  update(frame: FrameInput, _state?: SceneState): void {
    const values = (this.frameValues = frameBuiltins(frame));
    for (const draw of this.draws) {
      if (!draw.block || !draw.uniformBuffer) continue;
      if (!draw.frameNames.length && !draw.dirty && !draw.trailRenderVar) continue;
      this.applyFrame(draw, values);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
      draw.dirty = false;
    }
  }

  /**
   * 把每帧量写进 draw 的 uniform 块（不上传）：`update` 每帧调；编码时才建、或换了实例的实例化 draw（P4e 步骤 2）也调，补上这一帧的值与
   * 新系统的 ropetrail 计时器。`values` 为 null（还没 `update` 过）时只写 ropetrail 的 `g_RenderVar0`。
   */
  private applyFrame(draw: Draw, values: Record<string, ArrayLike<number>> | null): void {
    if (!draw.block) return;
    if (values) for (const name of draw.frameNames) draw.block.set(name, values[name]);
    const system = draw.trailRenderVar ? draw.particles?.system : undefined;
    if (system?.trail && system.def.renderer.ropetrail)
      draw.block.set("g_RenderVar0", trailRenderVar0(system.def.renderer.ropetrail, system.trail.timer));
  }

  /**
   * 全部粒子层按帧时间步进一帧（`ParticleSystem.step` 乘 `instanceoverride.rate`）；帧时间不是正数（补画帧、暂停）时不动。
   * `state` 给出时，不可见（含祖先，`effectiveVisible`）的粒子层不发射、不步进，还有存活粒子就清空并复位 emitter 计时
   * （`ParticleSystem.suspend`，C8 读码）；重新可见时照常步进，不重新预热。清空后标 `stale`：之后哪一帧再画，都先写成 0 个。
   * 不可见的帧照样把这一帧的世界矩阵与跟随点交给 `suspend`，控制点照常更新、拷 `previous`（P4d 步骤 5）；帧时间也交给它，系统时间照常
   * 累加（P4d 收尾 A）。
   * `time` 是这一帧的 `g_Time`（和 uniform 同一个值，已回绕），作噪声类模块的场景时间 `T`（P4b 步骤 4）。
   * 控制点的输入是对象的世界矩阵（P4c 步骤 1）：给了 `state` 时每帧按它沿父链算（脚本改变换、父链变化下一帧就跟上，一次调用
   * 共用一份缓存），没给时用加载时的（`ParticleTree.world`）。
   * 指针点的跟随点（P4c 步骤 2）：`cursor` 是这一帧光标下的场景纹理坐标（`FrameInput.cursor`，缺省场景中心），按场景的正交
   * `P·V` 反投影到 z = 0（`pointerScenePoint`），每次调用只算一次、交给每个系统（没有粒子层时不算）；透视粒子不另算（WPE 模拟时
   * 栈上是正交投影，透视投影只在绘制时压栈，rea-p4c-sim.md 1.6）。V 带最近一次 `setCamera` 的抖动、不带视差（P5a 步骤 3：渲染器在
   * 步进之后才交本帧的 s，所以是上一帧的，同 WPE；视差只在绘制时乘），跟随指针的控制点随抖动整体平移 s；P 带同一次的缩放（步骤 4，
   * `p5a-zoomx*` 实测：按带缩放的投影反投影误差 ≤ 3e-4，不带缩放差几百像素）。
   *
   * 调用时机（P4c 步骤 4）：每帧在脚本之前，`update` 之前。WPE 一帧里先模拟粒子、后跑脚本，粒子拿到的是本帧脚本运行之前的对象
   * 变换（即上一帧脚本写完的）：预研回放 `ignore/p4/c4/prestudy.test.ts` 里脚本每帧移动、旋转的世界空间系统 `w-stay-w`，按「本帧
   * 变换」回放差 2.54 像素（正好是对象一帧的位移），按「上一帧变换」差 0.016；同时日志里脚本读到的 `engine.runtime` 与同帧
   * `g_Time` 完全相等，P3b 也测过脚本写的变换当帧作用到图层，所以不是脚本时钟慢一帧。可见性同样按脚本之前的状态判断（没有实测）。
   * 渲染器在步进之前先 `sync` 一次，两帧之间写进 `SceneState` 的属性改值（`instanceoverride` 等）这一帧就进模拟器。
   * dev 探针按 dt 序列回放时直接调它（探针没有脚本，顺序同渲染器）。
   */
  stepParticles(
    frametime: number,
    time: number,
    state?: SceneState,
    cursor: readonly [number, number] = [0.5, 0.5],
  ): void {
    this.particleCursor = cursor;
    if (!(frametime > 0)) return;
    const worlds = new Map<number, Mat4>();
    let pointer: [number, number] | null = null;
    // 一个粒子层若干次绘制共用一棵系统树（P4e 步骤 1、2）：只步进根（子系统与事件实例由它递归），每棵树一次，图层顺序；步进后这一层的
    // 全部粒子绘制都标 `stale`（实例化的 draw 每帧都可能换实例，一起标）。交给根的控制点输入记进 `tree.inputs`，本帧脚本
    // `emitParticles` 用同一份（P4f 步骤 3）
    for (const tree of this.trees.values()) {
      const root = tree.system;
      const object = tree.object;
      if (state && !effectiveVisible(object, state.layers)) {
        // 不可见时控制点照常更新（P4d 步骤 5，rea-p4d-modules.md 5.3）：`W` 与跟随点照可见时的算法算
        const world = worldMatrixOf(object, state.layers, worlds);
        pointer ??= pointerScenePoint(this.viewProjection, cursor);
        tree.inputs = { world, pointer };
        // 系统时间在不可见的帧上照常累加（P4d 收尾 A），所以把帧时间也交给它；子系统与事件实例这时以 `emit = false` 照常步进
        // （rea-p4e-children 3.6），所以有子系统时每帧都要重写
        if (root.suspend(tree.inputs, frametime, time) || root.hasChildren) this.markParticlesStale(object);
        continue;
      }
      // 开销记在这一层的第一个 draw 上（同 P4e 步骤 1 按 draw 找根时的那一个）
      const first = this.drawsByLayer.get(object)?.[0];
      const timing = first ? this.particleTimings?.get(first) : undefined;
      const started = timing ? performance.now() : 0;
      const world = state ? worldMatrixOf(object, state.layers, worlds) : tree.world;
      pointer ??= pointerScenePoint(this.viewProjection, cursor);
      tree.inputs = { world, pointer };
      root.step(frametime, time, tree.inputs);
      if (timing) {
        recordSample(timing.simulate, performance.now() - started);
        recordSample(timing.alive, root.alive);
      }
      this.markParticlesStale(object);
    }
  }

  /**
   * 视频纹理的帧来源（P9a）：渲染器换上场景时交来（`SceneRenderer.load`，宿主的 `SceneVideos`）；dev 探针的确定性回放可以换上自己的。
   * null 时视频纹理保持全 0。
   */
  setVideoSink(sink: VideoSink | null): void {
    this.videoSink = sink;
  }

  /**
   * 把视频元素当前的帧拷进第 `index` 张纹理（P9a）。拷的尺寸取视频与纹理的较小者：WPE 是缩放到纹理尺寸（rea-p9-video 第 2 节第 3 条），
   * 语料 60 段两者都相同，不同时只拷重叠部分并记一条 warning（决定 3）。还没有尺寸（`videoWidth` 为 0）时跳过；拷贝抛错（元素状态
   * 不对等）时记一条 warning，不让这一帧失败。两种 warning 每张纹理各记一次。
   */
  private copyVideo(index: number, source: HTMLVideoElement): void {
    const texture = this.textures[index];
    const info = this.bundle.textures[index];
    const { videoWidth, videoHeight } = source;
    if (!texture || !info || !videoWidth || !videoHeight) return;
    if (videoWidth !== info.textureWidth || videoHeight !== info.textureHeight)
      this.warnVideo(
        `size:${index}`,
        `场景视频 ${info.path} 的尺寸 ${videoWidth}×${videoHeight} 和纹理 ${info.textureWidth}×${info.textureHeight} 不同，只拷重叠部分`,
      );
    try {
      this.device.queue.copyExternalImageToTexture(
        { source },
        { texture },
        { width: Math.min(videoWidth, info.textureWidth), height: Math.min(videoHeight, info.textureHeight) },
      );
    } catch (error) {
      this.warnVideo(`copy:${index}`, `场景视频 ${info.path} 拷进纹理失败：${oneLine(String(error))}`);
    }
  }

  private warnVideo(key: string, message: string): void {
    if (this.videoWarned.has(key)) return;
    this.videoWarned.add(key);
    this.warnings.push(message);
  }

  /**
   * 步进过的粒子层：把列写成顶点，再整段传上去（只传存活的那部分）。rope（P4d 步骤 1）按 rope 表写段顶点，`count` 是段数
   * （每段一个实例，`writeRopeSegments`，`fps` 是宿主的帧上限）；ropetrail（P4d 步骤 2）每个存活粒子 n 段（`writeTrailSegments`）。
   */
  private uploadParticles(draw: Draw, particles: ParticleDraw): void {
    if (!particles.stale) return;
    particles.stale = false;
    // 实例化的 draw（P4e 步骤 2）：顶点缓冲按存活数分配，不够时翻倍增长到容量为止（`particleUnits`）；sprite、rope 的段、ropetrail 的
    // 粒子都不超过存活数
    if (particles.instanced && particles.system.alive > particles.units) this.growParticles(draw, particles);
    const timing = this.particleTimings?.get(draw);
    const started = timing ? performance.now() : 0;
    particles.count = particles.rope
      ? writeSegments(particles.system, particles.layout, particles.vertices, this.particleFps)
      : writeVertices(
          particles.system,
          particles.layout as ParticleVertexLayout,
          particles.vertices,
          particles.trailEye,
        );
    const written = timing ? performance.now() : 0;
    if (particles.count) {
      const bytes = particles.count * (particles.rope ? 1 : 4) * particles.layout.stride * 4;
      this.device.queue.writeBuffer(
        draw.vertexBuffer,
        0,
        particles.vertices.buffer,
        particles.vertices.byteOffset,
        bytes,
      );
    }
    if (timing) {
      recordSample(timing.vertices, written - started);
      recordSample(timing.upload, performance.now() - written);
    }
  }

  /**
   * 实例化 draw（P4e 步骤 2）的顶点缓冲装不下这次的存活粒子：按 `max(存活数, 原来的 2 倍)` 重新分配，至多系统容量（`particleUnits`）；
   * 旧缓冲随即释放（已提交的帧不受影响，这一帧之后只用新的）。
   */
  private growParticles(draw: Draw, particles: ParticleDraw): void {
    const { system } = particles;
    const units = Math.min(system.columns.capacity, Math.max(system.alive, particles.units * 2));
    particles.units = units;
    particles.vertices = new Float32Array(particleFloats(system, particles.layout, particles.rope, units));
    this.release(draw.vertexBuffer);
    draw.vertexBuffer = this.own(
      this.device.createBuffer({
        label: draw.label,
        size: particles.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
    );
  }

  /**
   * 沿系统树的绘制先序（`ParticleSystem.forEachDrawn`，rea-p4e-children 第 6 节）走一棵树这一帧要画的系统（P4e 步骤 2），规则同
   * `planParticleLayer`：基础材质为空的系统整棵子树不画；`renderer: []` 的系统自己不画、照常递归。`visit` 收到系统、模板、第几次出现
   * （从 0 起）与模型矩阵：
   * - 非实例化的模板（顶层与 static 子孙）每帧恰好一次，存活数为 0 也给（draw 自己判断不画，同 P4e 步骤 1）；
   * - 实例化的模板只数有存活粒子的出现：WPE 存活数为 0 的系统不画、只照常递归（第 6 节），所以它不占绘制，第 k 次出现和抓帧里同一模板的
   *   第 k 次绘制对得上（同 `particles/track.ts` 的 `drawnSystems`）。
   * `framebuffer` 在先序里第一个需要帧缓冲的系统之前调一次（快照，每对象至多一次，折射位 `obj+0x93d` 父子共用；`renderer: []` 与存活数为
   * 0 的系统也算，同 P4e 步骤 1 的「我们照拷」，见 `particleTreeWantsFramebuffer`）。
   */
  private walkParticles(
    tree: ParticleTree,
    object: Mat4,
    visit: (system: ParticleSystem, template: ParticleTemplate, occurrence: number, model: Mat4) => void,
    framebuffer?: () => void,
  ): void {
    let snapped = false;
    const counts = new Map<ParticleTemplate, number>();
    tree.system.forEachDrawn((system, path, model) => {
      const pass = system.def.passes[0];
      if (!pass) return false;
      if (pass.framebuffer && !snapped) {
        snapped = true;
        framebuffer?.();
      }
      const template = tree.templates.get(path.join("/"));
      if (!template || (template.step.instanced && !system.alive)) return;
      const occurrence = counts.get(template) ?? 0;
      counts.set(template, occurrence + 1);
      visit(system, template, occurrence, model);
    }, object);
  }

  /**
   * 编码一个粒子层（`particle-tree` op，P4e 步骤 2）：沿 `walkParticles` 的先序逐个系统取 draw、画。非实例化的模板用建场景时建好的那个
   * draw（顺序、uniform、顶点与 P4e 步骤 1 逐字节相同）；实例化的模板第 k 次出现用池里第 k 个，没有就现建（`addPooledDraw`），已有的
   * 换了实例或模型矩阵变了就重写随它变的 uniform（`assignParticles`）。uniform 与顶点都在本帧提交之前经队列写入，每个 draw 每帧至多用
   * 一次，所以互不覆盖。`snapshot` 在先序里第一个需要帧缓冲的系统之前调。
   */
  private arrangeParticles(
    tree: ParticleTree,
    state: SceneState,
    worlds: Map<number, Mat4>,
    snapshot: () => void,
    draw: (item: Draw) => void,
  ): void {
    const object = worldMatrixOf(tree.object, state.layers, worlds);
    this.walkParticles(
      tree,
      object,
      (system, template, occurrence, model) => {
        if (!template.step.instanced) {
          draw(template.pool[0]);
          return;
        }
        const item = template.pool[occurrence];
        if (item) this.assignParticles(item, system, model, state, worlds);
        draw(item ?? this.addPooledDraw(tree, template, system, state, worlds));
      },
      snapshot,
    );
  }

  /**
   * 实例化 draw 这一帧画 `system`（P4e 步骤 2）：系统换了就标 `stale`（重写顶点）；系统或模型矩阵（`forEachDrawn` 给的，和上次写进 uniform
   * 的 `ParticleDraw.model` 逐位比）变了，就按 `refreshLayer` 重写随模型矩阵变的那几项（`g_ModelMatrix`、MVP、`g_Orientation*`、拖尾
   * 眼位与 `hidden`），补上新系统的 ropetrail 计时器，当场上传（这一帧的 `update` 已经过去）。都没变时什么都不做。
   */
  private assignParticles(
    item: Draw,
    system: ParticleSystem,
    model: Mat4,
    state: SceneState,
    worlds: Map<number, Mat4>,
  ): void {
    const particles = item.particles!;
    const changed = particles.system !== system;
    if (!changed && sameMatrix(particles.model, model)) return;
    if (changed) {
      particles.system = system;
      particles.stale = true;
    }
    this.refreshLayer(item, state, worlds);
    this.applyFrame(item, null);
    if (item.block && item.uniformBuffer) {
      this.device.queue.writeBuffer(item.uniformBuffer, 0, item.block.data);
      item.dirty = false;
    }
  }

  /**
   * 实例化模板的池里再建一个 draw（P4e 步骤 2，第一次用到时）：同 `createDraw`（顶点缓冲按 `particleUnits`），进全场与本层的索引（就地
   * 刷新、材质常量、每帧 uniform 都照常覆盖它），之后常驻到场景销毁。这一帧的 `update` 已经过去，建好后补上这一帧的每帧量再传一次。
   */
  private addPooledDraw(
    tree: ParticleTree,
    template: ParticleTemplate,
    system: ParticleSystem,
    state: SceneState,
    worlds: Map<number, Mat4>,
  ): Draw {
    const draw = this.createDraw(
      tree.layer,
      template.step,
      tree.resources,
      template.prepared,
      state,
      worlds,
      system,
      template.pool.length,
    );
    template.pool.push(draw);
    // 与 `LayerRuntime.draws` 同一个数组（`install`）：图层重建时一起释放
    this.drawsByLayer.get(tree.object)?.push(draw);
    this.indexDraw(draw);
    if (this.particleTimings) this.particleTimings.set(draw, { simulate: [], vertices: [], upload: [], alive: [] });
    if (draw.block && draw.uniformBuffer && this.frameValues) {
      this.applyFrame(draw, this.frameValues);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
    }
    return draw;
  }

  /**
   * 各粒子层当前的数量（dev 探针用）：存活数、高水位与容量。`detail` 时加上存活粒子的分布（位置范围、尺寸、alpha），
   * 供和 WPE 比统计量（`summarizeParticles`）。按绘制先序（`walkParticles`），每次出现一项（P4e 步骤 2：实例化的模板只列有存活粒子的
   * 实例，同一模板第 k 次出现（k ≥ 2）带 `occurrence: k`）。
   */
  particleStats(detail = false): {
    object: number;
    name: string;
    /** 子系统的绘制才有（P4e 步骤 1）：在系统树里的模板路径（`ParticleStep.node`），顶层的条目不带这一项、和以前逐字相同。 */
    node?: number[];
    /** 同一模板的第几次出现（P4e 步骤 2，从 1 起数），只在第 2 次起带。 */
    occurrence?: number;
    alive: number;
    highWater: number;
    capacity: number;
    summary?: ParticleSummary;
  }[] {
    const out: ReturnType<GpuScene["particleStats"]> = [];
    for (const tree of this.trees.values())
      this.walkParticles(tree, tree.world, (system, { step }, occurrence) =>
        out.push({
          object: tree.object,
          name: tree.layer.name,
          ...(step.node.length ? { node: [...step.node] } : {}),
          ...(occurrence ? { occurrence: occurrence + 1 } : {}),
          alive: system.alive,
          highWater: system.highWater,
          capacity: system.columns.capacity,
          ...(detail ? { summary: summarizeParticles(system) } : {}),
        }),
      );
    return out;
  }

  /**
   * dev 探针：开始（`true`）或停止（`false`，同时清空）记录粒子开销。打开后每个粒子层记最近 600 帧的模拟、写顶点与上传
   * 用时（`stepParticles` / `uploadParticles`），由 `particleProfile` 汇总。关着时只多一次 null 判断。
   */
  profileParticles(enabled: boolean): void {
    if (!enabled) {
      this.particleTimings = null;
      return;
    }
    this.particleTimings ??= new Map();
    for (const draw of this.draws)
      if (draw.particles && !this.particleTimings.has(draw))
        this.particleTimings.set(draw, { simulate: [], vertices: [], upload: [], alive: [] });
  }

  /** dev 探针：各粒子层的开销统计（毫秒）；没打开记录时为空。 */
  particleProfile(): ParticleProfile[] {
    if (!this.particleTimings) return [];
    return [...this.particleTimings].map(([draw, timing]) => ({
      object: draw.object,
      name: draw.layer.name,
      capacity: draw.particles!.system.columns.capacity,
      frames: timing.simulate.length,
      alive: timingStats(timing.alive),
      simulateMs: timingStats(timing.simulate),
      verticesMs: timingStats(timing.vertices),
      uploadMs: timingStats(timing.upload),
    }));
  }

  /**
   * dev 探针（`particleCorners`）：一个粒子层的程序、uniform 缓冲、bind group 条目，以及按当前状态写好的顶点
   * （存活粒子按槽序，`count` 个，每个 4 个顶点；拖尾系统跳过退化的粒子，同 `encode`）。`hidden`：朝向是 NaN，`encode` 不画这一层
   * （P4c 步骤 5）；`trailEye`：拖尾系统写顶点用的眼位（`trailDrawable` 按它挑出写了的粒子）。不是粒子层时为 null。
   * `node`：系统树里的哪个模板（P4e 步骤 1，`ParticleStep.node`），缺省顶层；`occurrence`：这个模板池里的第几个 draw（P4e 步骤 2，从 0 起，
   * 即最近一次编码时第几次出现的实例），缺省第一个。
   */
  particleProbe(
    object: number,
    node: readonly number[] = [],
    occurrence = 0,
  ): {
    program: GpuProgram;
    uniformBuffer: GPUBuffer | null;
    entries: GPUBindGroupEntry[];
    /** 写好的顶点：sprite 每粒子 4 个顶点；rope 两类每段一个实例（`rope` 非空）。 */
    vertices: Float32Array;
    /** 粒子数；rope 两类是段数（ropetrail 是存活数 · n，按槽序每粒子 n 段）。 */
    count: number;
    layout: ParticleDraw["layout"];
    /** rope 两类（P4d 步骤 1、2）：每段输出的顶点数；其余为 null。ropetrail 的系统带历史（`system.trail`）。 */
    rope: { maxVertices: number } | null;
    perspective: boolean;
    system: ParticleSystem;
    hidden: boolean;
    trailEye: [number, number, number] | null;
  } | null {
    const draw = this.trees.get(object)?.templates.get(node.join("/"))?.pool[occurrence];
    if (!draw?.particles || draw.step.kind !== "particles") return null;
    const { system, layout, rope, trailEye: eye, hidden } = draw.particles;
    const vertices = new Float32Array(draw.particles.vertices.length);
    const count = rope
      ? writeSegments(system, layout, vertices, this.particleFps)
      : writeVertices(system, layout as ParticleVertexLayout, vertices, eye);
    const resources = draw.resources;
    return {
      program: draw.program,
      uniformBuffer: draw.uniformBuffer,
      entries: draw.entries((effect, name) => this.targets[resources.fbos.resolve(effect, name)]),
      vertices: vertices.subarray(0, count * (rope ? 1 : 4) * layout.stride),
      count,
      layout,
      rope,
      perspective: draw.step.perspective,
      system,
      hidden,
      trailEye: eye,
    };
  }

  /**
   * 按图层顺序执行全部步骤，结果在离屏场景目标里。不可见图层整段跳过（含它的快照），泛光关着时不拷快照、不跑链。
   * `afterBloomStep`：泛光链每步之后调用（dev 探针读回中间结果用）。
   */
  encode(encoder: GPUCommandEncoder, state: SceneState, afterBloomStep?: Parameters<BloomChain["encode"]>[2]): void {
    // 两张时每帧都换，清屏开着也换：运行中关掉时手上正好是 N−2（L11）
    if (this.alternate) [this.current, this.alternate] = [this.alternate, this.current];
    if (!this.current) return;
    const { view: sceneView, texture: sceneTexture } = this.current;
    const { clearcolor, clearenabled } = state.general;
    const depthView = this.depthTarget?.view ?? null;
    // 粒子层现排时的世界矩阵（P4e 步骤 2）：这一刻的状态下，一条父链只算一次
    const worlds = new Map<number, Mat4>();
    const [r, g, b] = clearcolor;
    if (this.hdr && !clearenabled) this.linearizeBase(encoder, this.current);
    const snapshot = () => {
      if (this.snapshot)
        encoder.copyTextureToTexture(
          { texture: sceneTexture },
          { texture: this.snapshot.texture },
          { width: this.width, height: this.height },
        );
    };
    /** 当前开着的「画到场景」的 pass 与它的目标：同一目标上连着的绘制合进一个 pass。 */
    let open: { pass: GPURenderPassEncoder; view: GPUTextureView } | null = null;
    let started = false;
    /**
     * 「画到场景」的 pass。`view` 缺省是真正的场景目标；组画子树时（P5b 步骤 4）是组的合成 RT，以 `load` 接着画、不碰 `started`。
     * 目标换了先结束旧的。
     */
    const begin = (view: GPUTextureView = sceneView): GPURenderPassEncoder => {
      if (open && open.view === view) return open.pass;
      end();
      const scene = view === sceneView;
      // 第一个 pass：开着清成 clearcolor，关着接着这张目标上次的成品画
      const loadOp: GPULoadOp = started || !clearenabled ? "load" : "clear";
      const pass = encoder.beginRenderPass({
        label: scene ? "scene" : "group",
        colorAttachments: [
          scene
            ? { view, clearValue: { r, g, b, a: 1 }, loadOp, storeOp: "store" }
            : { view, loadOp: "load", storeOp: "store" },
        ],
        // 深度附件（P5d 步骤 1）只挂在真正的场景目标上（组的合成 RT 不挂）：和颜色一起清成 0（反向 Z），其余 load；`clearenabled` 为
        // false 时颜色、深度都不清（`p5d-noclear`：静止的写深度物体从第二帧起被自己上一帧的深度挡掉）
        ...(scene && depthView
          ? {
              depthStencilAttachment: {
                view: depthView,
                depthClearValue: 0,
                depthLoadOp: loadOp,
                depthStoreOp: "store",
              },
            }
          : {}),
      });
      if (scene) started = true;
      open = { pass, view };
      return pass;
    };
    const end = () => {
      open?.pass.end();
      open = null;
    };
    const draw = (pass: GPURenderPassEncoder, item: Draw) => {
      // 视频纹理（P9a）：画到它就记下帧号；有新帧就拷进来，排在本帧提交之前（同 WPE 绑定时 TransferVideoFrame，rea-p9-video
      // 第 2 节第 4 条）。视频尺寸和纹理不同时只拷重叠部分并记一条 warn（决定 3，语料 0 段）
      for (const index of item.videos) {
        const source = this.videoSink?.drawn(index);
        if (source) this.copyVideo(index, source);
      }
      // 网格没有索引（空网格）就不画
      if (item.mesh && !item.mesh.count) return;
      const particles = item.particles;
      if (particles) {
        // 朝向是 NaN（P4c 步骤 5）：WPE 的四角全是 NaN、图元被丢弃，这里整次绘制跳过（WGSL 判不了 NaN）
        if (particles.hidden) return;
        // 粒子：先把这一帧的顶点传上去（队列写入排在本帧提交之前），没有存活粒子就不画（rope：没有段就不画，存活数 ≤ 1 时
        // WPE 不绑也不画，rea-p4d-rope.md 第 4 节）
        this.uploadParticles(item, particles);
        if (!particles.count || (!particles.rope && !this.particleIndices)) return;
      }
      pass.setPipeline(item.pipeline);
      pass.setBindGroup(0, this.bindGroupOf(item));
      pass.setVertexBuffer(0, item.vertexBuffer);
      if (item.mesh) {
        // 模型网格（P5c 步骤 2）：mdl 的索引，三角形列表；网格没有的属性从槽 1 的全零占位缓冲读
        if (item.mesh.placeholder) pass.setVertexBuffer(1, item.mesh.placeholder);
        pass.setIndexBuffer(item.mesh.indexBuffer, item.mesh.indexFormat);
        pass.drawIndexed(item.mesh.count);
      } else if (item.text) {
        // 文本（P6b 1d）：逐字四边形，带索引的三角形列表
        pass.setIndexBuffer(item.text.indexBuffer, item.text.indexFormat);
        pass.drawIndexed(item.text.count);
      } else if (particles?.rope) {
        // rope 两类（P4d 步骤 1、2）：每段一个实例、`maxVertices` 个顶点的三角形带（几何着色器展开），不用索引；ropetrail 的
        // 段数是存活数 · n
        pass.draw(particles.rope.maxVertices, particles.count);
      } else if (particles) {
        pass.setIndexBuffer(this.particleIndices!.buffer, this.particleIndices!.format);
        pass.drawIndexed(particles.count * 6);
      } else pass.draw(4);
    };
    // 不可见图层整段跳过（含它的快照与 copy / swap）；运行时可见性由 `SceneState` 决定（P3a），沿父链继承（组隐藏时子孙也不可见）
    const visible = new Set(visibleObjects(this.layers, state));
    /** `sceneTarget`：「画到场景」的绘制落在哪；缺省是真正的场景目标，组画子树时是组的合成 RT（P5b 步骤 4）。 */
    const runOps = (ops: readonly Op[], sceneTarget: GPUTextureView = sceneView) => {
      for (const op of ops) {
        if (op.kind === "draw") {
          const { draw: item } = op;
          if (item.step.target.kind === "scene") {
            draw(begin(sceneTarget), item);
            continue;
          }
          end();
          const target = this.resolveTarget(item.step.target, item.resources);
          if (!target) continue;
          const pass = encoder.beginRenderPass({
            label: item.label,
            colorAttachments: [{ view: target.view, loadOp: "load", storeOp: "store" }],
          });
          draw(pass, item);
          pass.end();
        } else if (op.kind === "snapshot") {
          // 快照要包含清屏色：本帧还没画过场景就先清一次。组里（P5b 步骤 4）也拷真正的场景目标：组里的绘制都不落在它上面，
          // 拍到的就是组开始时那份（WPE 在组里读的正是那份）
          if (!started) begin();
          end();
          snapshot();
        } else if (op.kind === "particle-tree") {
          // 粒子层（P4e 步骤 2）：沿系统树每帧现排，快照插在先序里第一个需要帧缓冲的系统之前（同上面的快照操作）
          this.arrangeParticles(
            op.tree,
            state,
            worlds,
            () => {
              if (!started) begin();
              end();
              snapshot();
            },
            (item) => draw(begin(sceneTarget), item),
          );
        } else if (op.kind === "model") {
          // 模型（P5c 步骤 2）：先做视锥剔除（p5-REPORT `p5c-frustum`，rea-p5-mesh 4.4），被剔就整个模型不画。平面取场景级的视图投影
          // （带抖动与缩放、不带每个对象的视差：WPE 在场景绘制开头从相机算一次平面），世界矩阵不含视差；`perspective: true` 的模型也按它
          // 判（WPE 先剔除、后换透视投影，rea 2.6）。组里的模型照报（`model:passthrough:children:model`），强制渲染时不剔：组的局部
          // 正交下 WPE 用哪组平面没有实测
          const model = op.layer.model;
          if (
            model &&
            op.layer.group == null &&
            frustumCulled(model.bounds, worldMatrixOf(op.layer.object, state.layers, worlds), this.viewProjection)
          )
            continue;
          for (const item of op.draws) draw(begin(sceneTarget), item);
        } else if (op.kind === "subtree") {
          // 组画子树（P5b 步骤 4）：子孙按先序画，「画到场景」的绘制改画进组当前的合成 RT（嵌套组递归，它的上屏画进这一张）。
          // 不可见的子孙（含祖先）整段跳过；没有资源的（分组节点、声音）没有 op
          end();
          const target = this.resolveTarget(op.target, op.resources);
          if (!target) continue;
          // 不可见的子孙跳过，被依赖的照画进自己的 RT、不上屏（P8 步骤 4，同顶层）
          for (const object of op.layer.subtree) {
            const child = this.runtimeByObject.get(object);
            if (child) runLayer(child, target.view);
          }
          end();
        } else if (op.kind === "copy") {
          end();
          const source = this.resolveTexture(op.source, op.resources);
          const target = this.resolveTarget(op.target, op.resources);
          if (source && target && source !== target)
            encoder.copyTextureToTexture(
              { texture: source.texture },
              { texture: target.texture },
              { width: Math.min(source.width, target.width), height: Math.min(source.height, target.height) },
            );
        } else if (op.kind === "clear") {
          // 组合层 `copybackground: false`（P5b 步骤 2）：合成 RT 清成 (0, 0, 0, 0)，代替基础 pass。不碰场景目标，不算开过场景 pass
          end();
          const target = this.resolveTarget(op.target, op.resources);
          // 文本层开了背景（P6b 1d）：清成 (背景色, 图层 alpha)，每帧现算（背景色与 alpha 都可能就地改）
          const color = op.color === "text-background" ? this.textBackground(op.layer, state) : [0, 0, 0, 0];
          if (target) this.clearTarget(encoder, target, color, "clear composite");
        } else op.resources.fbos.swap(op.effect, op.source, op.target);
      }
    };
    /**
     * 一个图层（P8 步骤 4，`layerOpsToRun`）：可见时全部 op；不可见时一般整段跳过，被依赖的照跑、只去掉画到「场景」（`sceneTarget`）的上屏。
     * 顶层与组画子树共用。
     */
    function runLayer(runtime: LayerRuntime, sceneTarget?: GPUTextureView): void {
      const ops = layerOpsToRun(runtime.ops, runtime.layer, visible.has(runtime.object));
      if (ops.length) runOps(ops, sceneTarget);
    }
    // 组的子孙（`group` 非空）在顶层不画，由组的 `subtree` op 画（P5b 步骤 4）
    // `group == null`：缺这个字段（手写的图层）也当顶层
    for (const layer of this.layers) if (layer.layer.group == null) runLayer(layer);
    if (this.bloom && state.bloomEnabled) {
      // 全部图层画完：整帧快照（只拷这一次）→ 泛光链 → combine 写回场景目标
      if (!started) begin();
      end();
      snapshot();
      this.bloom.encode(encoder, sceneView, afterBloomStep);
    }
    if (!started) begin();
    end();
  }

  destroy(): void {
    for (const resource of this.owned) resource.destroy();
    this.owned.clear();
    this.draws.clear();
    this.layers.length = 0;
    this.runtimeByObject.clear();
    this.drawsByLayer.clear();
    this.drawsByPass.clear();
    this.targets.length = 0;
    this.current = null;
    this.alternate = null;
    this.linearBase = null;
    this.snapshot = null;
    this.depthTarget = null;
    this.bloom = null;
    this.particleIndices = null;
    this.particleTimings = null;
    this.atlasTextures = null;
    this.relayouter = null;
    this.textFbos.clear();
    this.layerTargets.clear();
    this.atlasResets.clear();
    this.meshBuffers.clear();
    this.meshPlaceholder = null;
  }
}
