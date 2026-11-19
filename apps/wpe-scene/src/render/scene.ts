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
 *   绘制顺序仍是 `objects` 顺序（透视场景开了透明排序时顶层另排，见下「透明排序」）。写死不可见的祖先下面的图层不建资源
 *   （`buildableLayers`）。图层画自己（含组的局部正交）另乘自身偏移（`drawMatrixOf`：文本排版、图像层对齐，P8 步骤 3），子层、粒子、
 *   控制点、模型的剔除不带它。
 * - 粒子（P4a 步骤 4）：粒子层是一个 `particle-tree` op，和图像步骤按 `objects` 顺序混排、画在同一个场景 pass 里。
 *   有子系统时一个粒子层是若干次绘制（P4e 步骤 1、2）：整棵树一个模拟器（根 `ParticleSystem`，子系统与事件实例挂在它下面），只步进根；
 *   编码时沿 `ParticleSystem.forEachDrawn` 的先序每帧现排（`arrangeParticles`）：每个被画的系统按模板路径找到计划里那个步骤预备好的管线，
 *   再按「这个模板本帧第几次出现」取模板 draw 池里的一个 draw（各有顶点缓冲与 uniform，模型矩阵由 `forEachDrawn` 给）。顶层与 static
 *   子孙每帧恰好一次，draw 建场景时就建好；事件实例（及其子孙）的 draw 第一次用到时建、之后复用、不回收，模型矩阵变了就重写 uniform；
 *   快照插在本帧先序里第一个需要帧缓冲的系统之前，每对象至多一次。没有事件条目的场景，绘制顺序、uniform 与 draw 和步骤 1 逐字节相同。
 *   一个系统多条 renderer（P4f 步骤 4，rea-p4f-script.md 8.3）：模板仍按模板路径，带这个系统每条 renderer 的步骤，池里每项是一次出现的
 *   一组 draw（每条 renderer 一个，各有变体管线、顶点与 uniform），整组按 renderer 顺序连着画完才轮到子系统。各写各的顶点、不共用
 *   缓冲（WPE 共用一份只是省一次写入，两次绘制读的是同一批粒子、同一个槽序）：sprite 那次照写速度为 0 的粒子，拖尾那次照旧跳过退化的。
 *   单 renderer 的系统和以前逐字节相同。
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
 *   - 快照（P5f）：拷当前目标，组里是组的合成 RT，只拷左上角重叠部分到快照的 (0, 0)（`p5f-a`、`p5f-e` 实测）。
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
 *   - 独占 RT：备对象时给每个被依赖的图层建一张（L4，`stageObject`），`populate` 在任何 `buildLayer` 之前把它们全部放进 `layerTargets`（尺寸 `compositeSize`、
 *     场景格式、采样 `compositeSampling`，同它的合成 RT），随场景销毁；它就是本层的合成 RT 0（`ensureComposites`），其余从池里借。跨帧、
 *     跨 effect 开关的重建都保留、不清（WPE 帧之间不清；被依赖者排在引用方后面时引用方读到上一帧，结论 9）。引用方的
 *     `{ kind: "layer" }` 解析到它（`resolveTexture`），几个引用方共用同一张，采样器与 `g_Texture<n>Resolution` 随它。
 * - **用户纹理**（P11b 步骤 2，`{ kind: "user" }`，`resolveUser`）：槽上登记了用户纹理、来源（宿主的 `UserTextureProvider`）当前有图时，用那张图
 *   （按 WPE 的纹理名 `值 x round(比例·10)` 缓存的 `rgba8unorm`、直通 alpha、1 级 mip，裁切写在 `copyExternalImageToTexture` 的源矩形上，
 *   采样按槽的 `nearest` / `clamp`、线性或点、无各向异性）；否则用缺省纹理（`fallback`）。换图都在 `sync` 里做（帧开头，同 WPE 在帧函数开头消费
 *   待刷新集合；写入当场与解码完成各标一次脏）：
 *   - 其它槽：只给用到这个来源的 draw 重建 bind group、重写 `g_Texture<n>Resolution` 与 `g_Color4` / `g_Alpha`，不重建图层；
 *   - 图像层基础 pass 的槽 0：整层强制重建（`rebuildLayer(…, { force: true })`），UV 上界与内缩按新纹理（`planLayer` 的 `userBase`），合成 RT 与
 *     effect fbo 由本层独占、按新尺寸换（同文本层，`ensureUserSizing`），被依赖图层的独占 RT 也按新尺寸重建，引用它的 draw 重绑；
 *   - 组合层 / instanced 的 pass 有任一槽用户纹理生效时 `g_Color4` = (1, 1, 1, 1)、`g_Alpha` = 1，回到缺省时恢复对象的值（rea-p11b 4.3）；
 *   - RT 参考尺寸的槽（`reference.kind === "layer"`）加载时属性就有值的不生效，第一次写入之后才生效（M8）；
 *   - 没有槽引用的用户纹理在 `sync` 末尾销毁。
 *   - 建资源：`buildableLayers` 不看被依赖图层自身与祖先的可见性（WPE `0x1000`）。
 *   - 编码：不可见（自身或祖先）时照跑它的 op，只跳过画到「场景」的那一步上屏（`layerOpsToRun`），顶层与组画子树两处同一个判断。
 *     语料里的被依赖者都不是组（是组的照报 `dependency:group`），组隐藏时整棵子树照旧不画。
 * - 按对象装卸（L4，`.claude/plans/wpe-import/3-scene/live/phase-l4-gpu-objects.md`）：`populate` = 场景级准备（场景目标、纹理、占位纹理、反射 RT、
 *   阴影图集、深度附件、全部程序、视图、粒子索引、泛光、体积光）→ 全部对象并行 `prepareMain`（`prepareObject` 的主段：变形纹理、fbo、被依赖层的独占 RT、
 *   程序与管线）→ 被依赖层的独占 RT 进表 → 按图层顺序 `installCore`（`installObject` 的主体：运行时、粒子序号、挂点、合成 RT、draw、粒子树预热）。
 *   变体段（`prepareVariantsOf`）与投射者（`prepareShadowCasters` / `installShadowCasters`）整场加载时在 `build` 的错误作用域之外逐对象跑（顺序同以前），
 *   单个对象时并进 `prepareObject` / `installObject`。场景级资源可增长：纹理按增量上传（`ensureTextures`）、fbo 池带引用计数（`fboPool`）、粒子索引
 *   不够时重建（`ensureParticleIndices`）、裁切遮罩与挂点戳第一次用到才建、投射管线按键缓存；深度附件仍按加载时定一次。卸对象（`removeObject`，
 *   `releaseRemoved` 的循环体）放掉它独有的资源与 fbo 引用、粒子序号、挂点、投射者。粒子序号由 `build` 的 `particleOrdinal` 给（宿主传登记表的），
 *   反射名单按结构代数从活的 bundle 刷新（`syncReflectionList`）。
 * - 透明排序（P5d 步骤 4，`render/sortOrder.ts`，p5-REPORT「步骤 4 步骤 0：透明排序」）：透视场景且 `SceneGeneral.transparentSorting` 时，
 *   `encode` 顶层那一轮改按 `transparentDrawOrder`：先按原顺序跑不在半透明名单里的图层，再把半透明的（`SceneLayer.sortClass`）按「当帧
 *   `SceneState` 里的局部 origin · 当帧透视相机的视线方向（`viewVectors.forward`）」从大到小稳定排序后跑，`last` 排在最后。只换图层的先后，
 *   每个图层自己的 op 不变；组画子树、模型网格、粒子树内部的顺序不动。正交场景、开关关着时走原来那一行，调用序列逐项同以前。
 */
import { HDR_BLOOM_MATERIALS, LDR_BLOOM_MATERIALS } from "../compile/bloom";
import type { TargetKey } from "../compile/bindings";
import type {
  SceneBundle,
  SceneFbo,
  SceneLayer,
  SceneAttachment,
  SceneModel,
  ScenePass,
  ScenePuppetLayer,
  SceneTexture,
  SortClass,
} from "../compile/bundle";
import type { PuppetClipping } from "../compile/puppet";
import { layerCompositeName } from "../compile/dependencies";
import { particleDraws, type ParticleRenderer, type SceneParticle } from "../compile/particles";
import { FBO_FORMATS } from "../compile/tex";
import { silentParticleAudio, type ParticleAudio } from "../particles/audio";
import { pointerScenePoint, type ControlPointInputs } from "../particles/controlpoints";
import { orientationBasis } from "../particles/orientation";
import {
  initialPerspectiveFrame,
  ORTHO_VIEW_VECTORS,
  type OrthographicCameraFrame,
  type PerspectiveCameraFrame,
} from "./camera";
import { SeededRandom, type ParticleROverride } from "../particles/random";
import { ropeVertexLayout, writeRopeSegments, type RopeVertexLayout } from "../particles/rope";
import { trailRenderVar0, trailVertexLayout, writeTrailSegments, type TrailVertexLayout } from "../particles/ropetrail";
import { ParticleSystem, particleNode, particlePasses } from "../particles/system";
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
import type { TextDecor } from "../text/fields";
import type { TextLayout } from "../text/layout";
import { isDynamicSource, type UserTextureSlot } from "../compile/usertextures";
import type { CropRect } from "../usertex/crop";
import type { UserTextureAnimation, UserTextureCrop, UserTextureFrame, UserTextureProvider } from "../usertex/sources";
import type { VideoSink } from "../video/sceneVideos";
import type { TextureBinding } from "../wpesl2wgsl";
import { BloomChain } from "./bloom";
import { applyPassStates } from "./passState";
import type { CursorCamera } from "./cursor";
import { oneLine, reasonsOf, SceneRenderError } from "./errors";
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
  type ClipSlot,
  type DrawStep,
  type LayerPlan,
  type MeshStep,
  rasterState,
  shadowCasterInputs,
  type ParticleStep,
  type TargetRef,
  type TextStep,
  type TextureRef,
  type UserBase,
} from "./graph";
import {
  type Edges,
  drawMatrixOf,
  withAnchor,
  resolveAnchorEdges,
  withSelfOffset,
  effectiveVisible,
  everyAncestor,
  eyePosition,
  croppedCursorViewProjection,
  groupViewProjection,
  layerQuad,
  particleViewProjection,
  type ProjectionCrop,
  rootObject,
  sceneTargetSize,
  sceneViewProjection,
  screenQuadSize,
  shapeQuad,
  worldMatrixOf,
} from "./layout";
import { identity, mulAffine, multiply, orthographic, translateGlm, translation, type Mat4 } from "./math";
import { alignedBytes, frustumCulled, MESH_PLACEHOLDER_BYTES, meshVertexLayout, type MeshVertexLayout } from "./mesh";
import {
  clipDrawSequence,
  clipMaskSize,
  clipTemplateSegments,
  indexUpload,
  morphTexelData,
  needsScaledVertices,
  morphKey,
  puppetIndexCapacity,
  scaledPuppetVertices,
  type PuppetSource,
} from "./puppet";
import { fileIndices } from "../puppet/drawOrder";
import { parallaxOffset, type SceneParallax } from "./parallax";
import {
  createPipeline,
  createProgram,
  createShadowPipeline,
  depthFlags,
  programInstances,
  programVertexPacking,
  SCENE_DEPTH_FORMAT,
  type GpuProgram,
} from "./programs";
import { ReflectionTargets } from "./reflection";
import { SHADOW_ATLAS_FORMAT, ShadowAtlas, type ShadowCasterDraw } from "./shadows";
import { VolumetricsRenderer } from "./volumetrics";
import type { ShadowView } from "./shadowMath";
import {
  LEGACY_LIGHT_UNIFORMS,
  LIGHT_FRAME_UNIFORMS,
  legacyLightFrame,
  lightFrame,
  lightFrameUniforms,
  type LightFrame,
} from "../compile/lights";
import { legacyLightInputs, lightRecords } from "./lights";
import { volumetricGeometry } from "../compile/volumetrics";
import { FOG_UNIFORMS, fogUniforms } from "../compile/fog";
import { SHADOW_CASTER_UNIFORM } from "../compile/features";
import { mirroredView, type SceneView } from "./views";
import { SPRITE_COUNT_TARGET_FORMAT, SpriteCounter, spriteOverrides, spriteViewProjection } from "./sprite";
import { transparentDrawOrder } from "./sortOrder";
import { advanceTextureAnimations, layerSheet, newSheetClock, sheetFrameFor, type SheetClock } from "./sheets";
import { byPosition, layerStructure } from "./structure";
import type { DirtyState, LayerState, SceneState } from "./state";
import { WorldStamps } from "./worldStamps";
import { createGammaPass, encodeGamma, type GammaPass } from "./userGamma";
import { ATLAS_SAMPLER, backgroundQuadVertices, TextAtlasTextures, textIndexData, textQuadVertices } from "./text";
import { requiredFeatures, samplerDescriptor, uploadTexture } from "./textures";
import { traceUniforms } from "./trace";
import {
  drawUniformValues,
  frameBuiltins,
  layerRefreshNames,
  LIGHT_UNIFORMS,
  MSDF_RENDER_VAR_NAMES,
  PARTICLE_REFRESH_UNIFORMS,
  particleUniformValues,
  textUniformValues,
  UniformBlock,
  type FrameInput,
  type UniformEntry,
} from "./uniforms";
import { alphaToCoverage, writesAlpha } from "./writeState";

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
 * 两张渲染目标的形状相同（L6b）：尺寸、格式与采样器（`sampler()` 按描述缓存，同参数是同一个对象）。替换被依赖的图层时据此沿用旧的独占 RT，
 * 引用方的 bind group 不用重绑。
 */
function sameTargetShape(a: RenderTarget, b: RenderTarget): boolean {
  return a.width === b.width && a.height === b.height && a.format === b.format && a.sampler === b.sampler;
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

/** puppet 的上屏绘制（P12a 步骤 4）：几何是 puppet 的网格 0，走和模型网格同一条路径（顶点布局、索引、三角形列表）。 */
type PuppetDrawStep = DrawStep & { geometry: "puppet" };
function isPuppetDraw(step: DrawLike): step is PuppetDrawStep {
  return step.kind === "draw" && step.geometry === "puppet";
}
/** puppet 的纹理通道绘制（P12b2-2）：几何是通道网格（`ScenePuppet.textureChannels`），画进合成 RT，同样按网格格式配顶点布局。 */
type TexchanDrawStep = DrawStep & { geometry: "texchan" };
function isTexchanDraw(step: DrawLike): step is TexchanDrawStep {
  return step.kind === "draw" && step.geometry === "texchan";
}
/** 预光照的基础 pass（P13j，`DrawStep.prelit`）：四边形与正交按合成 RT 尺寸，多写三个 Alt 矩阵。 */
function isPrelitDraw(step: DrawLike): boolean {
  return step.kind === "draw" && !!step.prelit;
}
/**
 * 预光照的 `g_AltModelMatrix`（P13j，`FUN_140207b50` 的 `0x140207da7`–`0x140207e8a`）：图层世界矩阵（虚函数 `+0x80`，不含对齐偏移）；
 * instanced（模型标志 `0x800`）时行 0、行 1（列主序的前两列）各乘 `size / 图像尺寸`（`mulps`，float32）。纹理降级系数恒为 1，「乘降级
 * 系数」那一支不走。
 */
function prelitModel(world: Mat4, layer: SceneLayer, rtSize: readonly [number, number]): Mat4 {
  if (!layer.instanced) return world;
  const out = new Float32Array(world);
  const sx = Math.fround(Math.fround(layer.size[0] ?? 0) / rtSize[0]);
  const sy = Math.fround(Math.fround(layer.size[1] ?? 0) / rtSize[1]);
  for (let k = 0; k < 4; k++) {
    out[k] = Math.fround(out[k] * sx);
    out[4 + k] = Math.fround(out[4 + k] * sy);
  }
  return out;
}
/** 画网格的步骤：模型的网格步骤、puppet 的上屏绘制与纹理通道绘制。 */
function drawsMesh(step: DrawLike): step is MeshStep | PuppetDrawStep | TexchanDrawStep {
  return step.kind === "mesh" || isPuppetDraw(step) || isTexchanDraw(step);
}

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
  /** 实例数（P13d 点 8，`programInstances`）：程序的 `INSTANCECOUNT`，`fur4` 的毛发层数；其余 1。只在模型网格上。 */
  instances?: number;
  /**
   * 顶点缓冲是本 draw 私有的（P12a：直接上屏的 puppet 把 `a_TexCoord` 乘了 `step.uv`，不能和 mdl 视图共用），图层重建时要释放；
   * 共用的（模型网格、UV 为 (1, 1) 的 puppet）为假。
   */
  privateVertices?: boolean;
  /**
   * 索引缓冲是本 draw 私有、内容随 puppet 的绘制顺序变（P12f，`syncPuppetIndices`）：`slot` 是裁切模板的槽位（没有裁切为 null，整张网格），
   * `version` 是已上传的 `ScenePuppets.drawOrder` 版本（建时 −1，编译期数据记 0），`capacity` 是缓冲字节数，`source` 是已上传时 `drawOrder(object)` 返回的那个对象（没有来源为 null）：运行时被换掉（换来源、清空脚本存储不接回顺序）时版本号可能恰好相同、内容却不同，所以「来源对象相同且版本相同」才算已上传。图层重建 / 释放时要释放这块缓冲。
   */
  ordered?: { slot: ClipSlot | null; version: number; capacity: number; source: object | null };
}

/** 一次粒子绘制的系统与 CPU 侧顶点（P4a 步骤 4）。 */
interface ParticleDraw {
  /**
   * 这次绘制的系统：非实例化的模板（顶层与 static 子孙）固定是树里那个节点；实例化的模板（P4e 步骤 2）每帧由 `arrangeParticles` 按出现
   * 次序重新指派，换了就重写顶点与 uniform。
   */
  system: ParticleSystem;
  /**
   * 这次绘制的 renderer（`SceneParticle.draws[step.renderer].renderer`，P4f 步骤 4）：朝向是不是 NaN、拖尾的眼位、`g_Orientation*` 与
   * `g_RenderVar0` 都按它（rea-p4f-script.md 8.3：每条 renderer 用自己的 `rec+4` 算朝向）。同一系统的几次绘制各不相同；实例化的 draw
   * 换实例时不变（同一模板的实例共用定义）。没写 renderer 的手写定义（单测）为 undefined，按缺省的 sprite。
   */
  renderer: ParticleRenderer | undefined;
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
   * 拖尾绘制（这次的 renderer 是 `spritetrail`，P4c 步骤 5）写顶点时判断退化粒子用的眼位（`particles/vertices.ts` 的 `trailEye`）：
   * `(g_EyePosition, 1)` 乘这次绘制模型矩阵的逆，和 uniform 同时算（`refreshParticleGeometry`）。别的 renderer 为 null（同系统的 sprite
   * 那次也是，速度为 0 的粒子照写，P4f 步骤 4）。
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
 * 粒子层的一个模板（P4e 步骤 2）：一个模板路径（`node`）上的系统，它在计划里的 `particles` 步骤与预备好的程序、管线，以及它的 draw 池——
 * 这个模板本帧第 k 次出现用第 k 组（k 从 0 起）。非实例化的模板建场景时建第 0 组；实例化的模板第一次用到时建、之后复用、不回收（同 WPE
 * 的池只增不减，rea-p4e-children 4.1）。
 * 一个系统多条 renderer（P4f 步骤 4）：`renderers` 是这个系统每条 renderer 的步骤（`draws` 顺序，强制渲染 rope 混挂时跳过的那条不在里面），
 * 池里每组按同样的顺序每条一个 draw，一起建、一起换实例、连着画。单 renderer 的系统每组一个 draw。
 */
interface ParticleTemplate {
  /** 模板路径（各步骤的 `ParticleStep.node`）。 */
  node: number[];
  /** 模板路径经过事件条目（各步骤的 `ParticleStep.instanced`）。 */
  instanced: boolean;
  /** 这个系统的各 renderer 步骤与预备好的管线，`draws` 顺序（P4f 步骤 4）。 */
  renderers: { step: ParticleStep; prepared: PreparedDraw }[];
  /** 第 k 次出现用第 k 组（每组按 `renderers` 的顺序各一个 draw）；非实例化的模板建场景时建第 0 组。 */
  pool: Draw[][];
}

/**
 * 一个粒子层的系统树（P4e 步骤 1、2）：根系统（static 子系统与事件实例挂在它下面）、加载时对象的世界矩阵，以及按模板路径
 * （`step.node.join("/")`）索引的模板。整个粒子层是一个 `particle-tree` op。
 */
/** 粒子层一帧的绘制顺序（`arrangeParticles`）：draw，或「先序里第一个需要帧缓冲的系统之前拍一次快照」。 */
type ParticleArrangement = (Draw | "snapshot")[];

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

/**
 * 两份粒子定义（`SceneLayer.particle`，编译产物，纯数据）相同（L6）：单对象重编译替换粒子层时，相同就沿用旧的粒子树。按键排序的 JSON 比（新编的片段与
 * 旧的键的插入顺序一般相同，排序只为不依赖它）。
 */
export function sameParticleDefinition(a: SceneLayer["particle"], b: SceneLayer["particle"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const sorted = (_key: string, value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value;
  return JSON.stringify(a, sorted) === JSON.stringify(b, sorted);
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
   * 光标的裁切边距（`fillCropEdges`，P6c 修复 2）：给了时 `cursor` 是窗口归一化指针、反投影用裁过的 `P·V`（`GpuScene.setCursorCrop`）。
   * 产品由渲染器按样式与画布给，dev 探针在旧的「按场景分辨率画」模式下照同一规则给。
   */
  cursorCrop?: Edges | null;
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

/** puppet 绘制每帧要写的 uniform 名（`writePuppetUniforms`）：块里有任何一个，这个 draw 每帧都写。 */
const PUPPET_BLOCK_NAMES = ["g_Bones", "g_BonesAlpha", "g_MorphOffsets", "g_MorphWeights", "g_BlendMap"];

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
  /**
   * skinned puppet 的上屏绘制（P12a 步骤 4）：图层的 `objects` 下标，每帧 `update` 把 `ScenePuppets.skin` 写进块里的 `g_Bones`；
   * 静态 puppet、没有 `g_Bones` 的程序与别的绘制为 null。
   */
  puppet: number | null;
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
  /** 按槽位的纹理尺寸（就地刷新时复用；用户纹理换图时 `rebindDrawInputs` 重算）。 */
  textureSizes: readonly (TextureSize | undefined)[];
  /** 这个 draw 的输入里用到的用户纹理属性来源（P11b 步骤 2，去重）：来源标脏时 `sync` 按它找 draw。 */
  userNames: string[];
  /**
   * 着色器绑定的视频纹理（bundle 纹理下标，去重，P9a）：建 draw 时算一次，编码时逐个问 `VideoSink`（`encode` 的 `draw`）。
   * 没有视频时为空。
   */
  videos: number[];
  /**
   * 着色器绑定的 GIF / 视频用户纹理（P11b 步骤 4，同 `videos` 只看真正绑定的槽，按纹理名去重）：建 draw 与 `rebindDrawInputs` 时算，
   * 编码时在视频之后逐个 `drawn()`，有内容就上传（`uploadUserFrame`）。没有时为空。
   */
  userAnimations: UserAnim[];
  /** 静态 uniform 被就地改过：下一次 `update` 要整块重写。 */
  dirty: boolean;
  /**
   * 绑多图像帧表纹理（P6e 点 4）的槽号（建 draw 时定，没有时为空）。这类 draw 的 bind group 不是静态的：`bindSheets` 每次选格后把各槽当前的图像号
   * 记进 `sheetImages`，`bindGroupOf` 把它并进缓存键，`entries` 据此绑那张图像的纹理。
   */
  multiImage: number[];
  /** 多图像槽当前的图像号（槽号 → `frames[k].image`），没写过的槽按 0。 */
  sheetImages: Map<number, number>;
  /** 不引用 fbo 时建一次；引用 fbo 时按当前 swap 状态取（`bindGroups` 缓存）。 */
  bindGroup: GPUBindGroup | null;
  bindGroups: Map<string, GPUBindGroup>;
  entries: (resolveFbo: (effect: number, name: string) => RenderTarget) => GPUBindGroupEntry[];
  layout: GPUBindGroupLayout;
}

/**
 * 一个 draw 在平面反射 pass 里的副本（P13b2，`GpuScene.reflectionCopyOf`）：自己的 uniform 缓冲与 bind group。每帧编码时块 = 主块的拷贝
 * 再盖上 `overlay`（反射视图下的相机项），所以每帧量、材质常量、光照都和主块一致，只有相机不同。
 */
interface ReflectionCopy {
  block: UniformBlock;
  buffer: GPUBuffer;
  /** 反射视图下的相机项（`REFLECTION_CAMERA_UNIFORMS` 里块有、材质没覆盖的），`refreshReflection` 随主 draw 的刷新重算。 */
  overlay: Record<string, number[]>;
  /** 建 bind group 时主 draw 用的那一个：主 draw 换了（用户纹理换图）就重建。 */
  source: GPUBindGroup | null;
  bindGroup: GPUBindGroup | null;
  /** 多图像帧表（P6e 点 4）：按各槽图像号缓存的 bind group（键同 `bindGroupOf` 的图像部分）；`source` 变了就清空。 */
  groups?: Map<string, GPUBindGroup>;
}

/**
 * 反射视图要改的 uniform（P13b2，p13-REPORT C2、C3、C9）：矩阵、眼位与视图向量。粒子的 `g_Orientation*` 不在里面：WPE 在对象更新时按主视图
 * 写，反射 pass 不重算（C9）；拖尾的宽度方向在着色器里按 `g_EyePosition` 算，换了眼位就跟着变（C10）。
 */
const REFLECTION_CAMERA_UNIFORMS = [
  "g_ModelViewProjectionMatrix",
  "g_ModelViewProjectionMatrixInverse",
  "g_ViewProjectionMatrix",
  "g_EffectModelViewProjectionMatrix",
  "g_EffectModelViewProjectionMatrixInverse",
  "g_EffectTextureProjectionMatrix",
  "g_EffectTextureProjectionMatrixInverse",
  "g_EyePosition",
  "g_ViewForward",
  "g_ViewRight",
  "g_ViewUp",
] as const;

/** 平面反射 RT 的格式（P13b1，HDR 下也是 RGBA8）：HDR 场景的反射副本另建这个格式的管线。 */
const REFLECTION_TARGET_FORMAT: GPUTextureFormat = "rgba8unorm";

/** 纹理尺寸（与 `render/uniforms.ts` 的 `TextureSize` 同形）。 */
type TextureSize = Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight"> & {
  /** `_rt_MipMappedFrameBuffer` 的 mip 数（P13b1）：只有绑它的槽有，写 `g_Texture<n>MipMapInfo`。 */
  mipCount?: number;
};

/** 一张用户纹理的 GPU 资源（P11b 步骤 2，`GpuScene.userGpu`）：裁后宽高就是纹理尺寸。 */
interface UserGpu {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  /** 建它时的帧来源（P11b 步骤 4，GIF / 视频）：来源换了对象（值换过、WPE 从头开始）就释放重建。静态图没有。 */
  animation?: UserTextureAnimation;
}

/** 一个 draw 绑定的 GIF / 视频用户纹理（`Draw.userAnimations`）。 */
interface UserAnim {
  /** WPE 的纹理名（`userGpu` 的键）。 */
  key: string;
  animation: UserTextureAnimation;
  gpu: UserGpu;
  /** 在源（GIF 的画布、视频的画面）上的裁切矩形。 */
  rect: CropRect;
}

type UserRef = Extract<TextureRef, { kind: "user" }>;

/** 一个用户引用此刻用的图：GPU 纹理与采样器。 */
interface UserResolved {
  gpu: UserGpu;
  sampler: GPUSampler;
}

/** 图层基础 pass 槽 0 的用户纹理槽（图像层）：它换图要整层重建；没有时 null。 */
function baseUserSlot(layer: SceneLayer): UserTextureSlot | null {
  if (layer.text || layer.particle || layer.model || layer.shape) return null;
  const pass = layer.passes[0];
  const slot = pass?.userTextures?.find((item) => item.slot === 0 && isDynamicSource(item.source.kind));
  // 要有缺省（静态纹理或被依赖图层的 RT）才会包成用户引用（`graph.ts` 的 `passInputs`）
  return slot && (pass.textures[0] !== undefined || pass.layerComposites?.[0] !== undefined) ? slot : null;
}

/** 一个图层的全部步骤与 draw：不可见时整段跳过（含它的快照），泛光的 op 单独放在最后（P3a）。 */
interface LayerRuntime {
  object: number;
  layer: SceneLayer;
  ops: Op[];
  draws: Draw[];
  resources: LayerResources;
  /** 当前 `ops` 的计划签名（`planSignature`）；重建时比较，相同就不动。 */
  signature: string;
  /**
   * 建 `ops` 时的组归属（L7，`GpuScene.placementOf`）：替它作画的组与组的层数。管线（组里写 alpha、不带深度）、uniform（组的局部正交）与池化合成 RT
   * （按层数分池）都随它变，计划签名却不变（子层的计划和在不在组里无关），所以重建时和签名一起比。
   */
  placement: LayerPlacement;
  /** 粒子层的系统树（P4e 步骤 1、2）；图像层与没有可画模板的粒子层为 null。 */
  tree: ParticleTree | null;
  /**
   * 本层从 fbo 共享池取过引用的键（L4，`GpuScene.fboPool`）：卸对象时逐个减引用，归零才释放。同一个键取了几次就记几次；
   * 文本层与槽 0 有用户纹理的图层的 fbo 是独占的（`textFbos`），不在这里。
   */
  fboKeys: string[];
}

/** 图层建 draw、备管线要的两样（`LayerRuntime` 的一部分；备好还没装的对象也有，L4）。 */
type LayerHandle = Pick<LayerRuntime, "layer" | "resources">;

/** 图层的组归属（L7）：替它作画的组（`objects` 下标，顶层为 null）与父链上组的层数（`GpuScene.groupDepth`）。 */
interface LayerPlacement {
  group: number | null;
  depth: number;
}

function samePlacement(a: LayerPlacement, b: LayerPlacement): boolean {
  return a.group === b.group && a.depth === b.depth;
}

/**
 * 组合层运行中挂上子层变成组时要用的程序（L7）：基础 pass（compose / 拷贝）、`groupUpload`、passthrough 上屏。没有子层的组合层加载时计划是空的，
 * 这些程序不在任何计划里、不会建；建场景与备对象时另外备好（备不好不报错，真变成组时重排失败、整场重载），重排时管线才能同步建。
 */
function groupPrograms(
  layer: Pick<SceneLayer, "passthroughModel" | "passes" | "groupUpload" | "passthrough">,
): number[] {
  if (!layer.passthroughModel) return [];
  return [...layer.passes, layer.groupUpload, layer.passthrough].flatMap((pass) =>
    pass && pass.program !== null ? [pass.program] : [],
  );
}

/** 绘制类步骤（建 draw、要程序与管线的那四种）。 */
function isDrawLike(step: LayerPlan["steps"][number]): step is DrawLike {
  return step.kind === "draw" || step.kind === "particles" || step.kind === "text" || step.kind === "mesh";
}

/** 一个模型网格的阴影投射者备好的程序与管线（L4，`prepareShadowCasters`）：装对象时照它建 draw（`installShadowCasters`）。 */
interface ShadowCasterPrep {
  step: MeshStep;
  program: GpuProgram;
  pipeline: GPURenderPipeline;
}

/** 投射者的归属与它独有的资源（L4：卸对象时 draw 的 uniform 缓冲与逐条目副本一起放掉）。 */
interface ShadowCasterRecord {
  object: number;
  draw: Draw;
  copies: Map<number, { block: UniformBlock; buffer: GPUBuffer; bindGroup: GPUBindGroup }>;
}

/**
 * 备好的对象（L4，`GpuScene.prepareObject`）：装之前不进任何帧内结构（`layers`、`runtimeByObject`、draw 索引、`layerTargets`、
 * `textFbos`、`morphTargets`），所以备的时候不改正在画的东西。不装时 `discardPrepared` 收回它建的（池化 fbo 的引用、独占的 fbo、
 * 被依赖层的独占 RT、变形纹理）。只能装进备它的那个场景、只能装一次（`settled`）。
 */
export interface PreparedObject {
  readonly layer: SceneLayer;
  /** 备的那一刻的计划（`planOf`）；`prepared` 的键是它的步骤。 */
  readonly plan: LayerPlan;
  /** `prepareLayer` 的结果：计划里每个绘制步骤的程序与管线（含 HDR 反射副本的管线）。 */
  readonly prepared: ReadonlyMap<DrawLike, PreparedDraw>;
  /** 本层的资源：fbo 名 → `targets` 下标（池化的已取引用、独占的已建）、文本层的图集；合成 RT 装的时候借（变体段借过的已在里面）。 */
  readonly resources: LayerResources;
  /** 取过引用的 fbo 池键（装上后归运行时，`LayerRuntime.fboKeys`）。 */
  readonly fboKeys: readonly string[];
  /** 文本层与槽 0 有用户纹理的图层独占的 fbo（装的时候进 `textFbos`）；其余为 null。 */
  readonly textFbos: TextFbo[] | null;
  /** 被依赖图层的独占 RT（装的时候进 `layerTargets`）；不是被依赖的为 null。 */
  readonly layerTarget: RenderTarget | null;
  /** 本层的变形纹理（键同 `morphTargets`，装的时候进表）。 */
  readonly morphs: ReadonlyMap<string, RenderTarget>;
  /**
   * 变体段（运行中 effect 开关、文本重排可能用到的程序、管线与合成 RT，`prepareVariantsOf`）：失败的原因（装的时候冻结这一层、记 warning），
   * 成功为 null。整场加载时为 undefined：变体在 `build` 的错误作用域之外逐层另备（`prepareVariants`，坏 WGSL 只落在图层自己的作用域里）。
   */
  readonly variants: string | null | undefined;
  /** 阴影投射者备好的程序与管线；整场加载时为 null（投射者在变体之后逐层另建，`buildShadowCasters`）。 */
  readonly shadows: readonly ShadowCasterPrep[] | null;
  /** 备它的场景（装进别的场景时抛错）。 */
  readonly owner: GpuScene;
  /** 已装上或已放弃。 */
  settled: boolean;
}

/** 缺省的粒子序号（L4，`GpuScene.build` 的 `particleOrdinal` 没给时）：按 `bundle.layers` 里带 `particle` 的顺序数，之后装的对象接着往后数（同登记表）。 */
function defaultParticleOrdinals(bundle: Pick<SceneBundle, "layers">): (object: number) => number {
  const ordinals = new Map<number, number>();
  let next = 0;
  for (const layer of bundle.layers) if (layer.particle) ordinals.set(layer.object, next++);
  return (object) => {
    let ordinal = ordinals.get(object);
    if (ordinal === undefined) ordinals.set(object, (ordinal = next++));
    return ordinal;
  };
}

/** 投射者管线的缓存键（L4，`shadowPipelineFor`）：程序、网格布局与 A2C 定一条管线（剔除恒 NONE、深度格式恒为阴影图集）。 */
function shadowPipelineKey(program: GpuProgram, layout: MeshVertexLayout, a2c: boolean): string {
  return `shadow|${program.index}|mesh:${layout.key}${a2c ? "|a2c" : ""}`;
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
  | { kind: "model"; layer: SceneLayer; draws: Draw[] }
  /**
   * 有裁切的 puppet（P12f）：编码时按当前命令表现排——第 j 个普通命令画 `normals[j]`，记录 r 先清遮罩 RT、再画 `masks[r]`（画进遮罩 RT）、
   * 再画 `targets[r]`（回场景）。模板 draw 的索引缓冲是私有的，每帧编码之前由 `syncPuppetIndices` 按绘制顺序的版本写进当前的段。
   */
  | {
      kind: "puppet-clip";
      layer: SceneLayer;
      resources: LayerResources;
      normals: Draw[];
      masks: Draw[];
      targets: Draw[];
    };

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
  /** 写不写 alpha：`"only"` 只写 alpha、不写 RGB（P13c：sprite 的遮挡方块，WPE 写掩码 8），键里照写成 `only`。 */
  alpha: boolean | "only";
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
  /**
   * 片元用程序的 A2C 入口（P8 步骤 5，`writeState.ts` 的 `alphaToCoverage`、`programs.ts` 的 `alphaToCoverageEntry`）：步骤的实际混合是
   * `alphatocoverage` 时出现，管线键多一个后缀，其余键和加这一项之前逐字相同。
   */
  alphaToCoverage?: true;
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
  alphaToCoverage,
}: PipelineSpec): string {
  return `${program}|${blending}|${format}|${alpha}${topology === "triangle-list" ? "|list" : ""}${alphaMax ? "|max" : ""}${mesh !== undefined ? `|mesh:${mesh}` : ""}${cull ? `|cull:${cull}` : ""}${depth ? `|depth:${depthFlags(depth)}` : ""}${alphaToCoverage ? "|a2c" : ""}`;
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
 * 写入状态（P8 步骤 5，`writeState.ts`）：写不写 alpha 在上面的缺省值上叠材质的 `alphawriting`（`writesAlpha`），步骤的实际混合是
 * `alphatocoverage` 时开 A2C（`alphaToCoverage`）；两者都没用到的步骤，管线键与改前逐字相同。
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
  const base = target.kind !== "scene" || alphaMax || (inGroup && !upload);
  return {
    program: pass.program!,
    blending,
    // 裁切遮罩 RT（P12b1 步骤 5）是 R8：遮罩段画进它（`render/graph.ts` 的 `puppetSteps`）
    format:
      target.kind === "fbo" ? fboFormat(target.effect, target.name) : target.kind === "clip-mask" ? "r8unorm" : format,
    // sprite 的遮挡方块（P13c，S3）只写 alpha
    alpha:
      step.kind === "mesh" && step.occlusion
        ? "only"
        : writesAlpha(base, { upload, alphaMax, alphaWriting: pass.alphaWriting }),
    topology:
      step.kind === "text" || drawsMesh(step) || (step.kind === "particles" && !geometry)
        ? "triangle-list"
        : "triangle-strip",
    ...(alphaMax ? { alphaMax: true } : {}),
    ...(drawsMesh(step) ? { mesh: mesh ?? "" } : {}),
    ...(raster.cull ? { cull: "back" as const } : {}),
    ...(sceneDepth && target.kind === "scene" && !group ? { depth: { test: raster.test, write: raster.write } } : {}),
    ...(alphaToCoverage(blending) ? { alphaToCoverage: true as const } : {}),
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
 * 一份计划里渲染器画不了的项（加载时的自查与 `prepareVariants` 共用）。`particle` 是图层的粒子系统树：每个粒子步骤按它自己那个系统、
 * 自己那一条 renderer（`step.renderer`，P4f 步骤 4）的种类查程序的输入（子系统的 renderer 可以和父不同，P4e 步骤 1）。`model` 是图层的
 * 模型（P5c 步骤 2）：每个网格步骤按网格格式查程序的输入（`meshVertexLayout`）。
 */
function planProblems(
  plan: LayerPlan,
  bundle: SceneBundle,
  particle?: SceneParticle | null,
  model?: SceneModel | null,
  /** 图层的 puppet（P12a 步骤 4）：上屏绘制按网格 0 的格式查程序的输入。 */
  puppet?: Pick<ScenePuppetLayer, "mesh" | "textureChannels"> | null,
): string[] {
  const problems = [...plan.reasons];
  for (const step of plan.steps) {
    if (step.kind !== "draw" && step.kind !== "particles" && step.kind !== "text" && step.kind !== "mesh") continue;
    const program = step.pass.program === null ? undefined : bundle.programs[step.pass.program];
    if (!program) problems.push("render:no-program");
    else if (step.kind === "particles")
      problems.push(
        ...particleAttributeProblems(
          program,
          particle ? particleDraws(particleNode(particle, step.node))[step.renderer]?.renderer?.kind : undefined,
        ),
      );
    else if (step.kind === "mesh") {
      const mesh = model?.meshes[step.mesh];
      if (!mesh) problems.push(`render:mesh:${step.mesh}`);
      else problems.push(...meshVertexLayout(program.attributes ?? [], mesh.format).problems);
    } else if (step.kind === "draw" && step.geometry === "puppet") {
      if (!puppet) problems.push("render:puppet");
      else problems.push(...meshVertexLayout(program.attributes ?? [], puppet.mesh.format, !!step.prelit).problems);
    } else if (step.kind === "draw" && step.geometry === "texchan") {
      // 纹理通道网格（P12b2-2）：按通道网格自己的格式查
      if (!puppet?.textureChannels) problems.push("render:puppet");
      else problems.push(...meshVertexLayout(program.attributes ?? [], puppet.textureChannels.mesh.format).problems);
    }
    // 视频纹理（P9a）没有 mip：渲染器建空纹理、运行时拷帧，不算缺
    for (const input of Object.values(step.inputs)) {
      // 用户纹理（P11b）：缺省纹理照查，用户图是运行时的事
      const ref = input.kind === "user" ? input.fallback : input;
      if (ref.kind === "texture" && !bundle.textures[ref.index]?.mips.length && !bundle.textures[ref.index]?.video)
        problems.push(`render:texture-missing:${ref.index}`);
    }
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
  // puppet 的变形纹理（P12b1 步骤 4）：`rgba32float`（要 float32-filterable；rgba16snorm 在 Dawn 上不可过滤），没有就退回
  if (
    buildableLayers(bundle).some((layer) => layer.puppet?.morph || layer.model?.skeleton?.morphs.some(Boolean)) &&
    !features.has("float32-filterable")
  )
    reasons.add("render:morph-texture");
  // 体积光（P13e）：Back / Single 转成 `r32float` 后线性采样，要 float32-filterable；材质缺了也退回
  if (bundle.volumetrics) {
    if (!features.has("float32-filterable")) reasons.add("render:volumetrics");
    const { lights, blurH, blurV, combine } = bundle.volumetrics;
    for (const pass of [
      ...lights.flatMap((light) => [light.back, light.front, light.fullscreen]),
      blurH,
      blurV,
      combine,
    ])
      if (pass && (pass.program === null || !bundle.programs[pass.program]))
        reasons.add(`render:volumetrics:${pass.key}`);
  }
  for (const layer of buildableLayers(bundle))
    for (const reason of planProblems(
      planLayer(layer, bundle.textures, undefined, options.texts?.get(layer.object) ?? null),
      bundle,
      layer.particle,
      layer.model,
      layer.puppet,
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
  if (op.kind === "particle-tree" || op.kind === "model" || op.kind === "puppet-clip") return true;
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
    // 第 2 条起的 renderer 的变体（P4f 步骤 4）：同一个材质，纹理和上面相同，照样过一遍
    for (const draw of particleDraws(particle).slice(1)) draw.passes.forEach(add);
    for (const child of particle.children ?? []) addParticle(child.system);
  };
  for (const layer of bundle.layers) {
    layer.passes.forEach(add);
    if (layer.particle) addParticle(layer.particle);
    // puppet 的材质变体（P12a 步骤 4）：纹理同基础材质，照样过一遍
    layer.puppet?.passes.forEach(add);
    if (layer.puppet?.upload) add(layer.puppet.upload);
    // 纹理通道网格的材质（P12b2-2）：槽 1 是基础图（DOUBLEBUFFERED），照样过一遍
    if (layer.puppet?.textureChannels?.pass) add(layer.puppet.textureChannels.pass);
    // 裁切遮罩的材质（P12b1 步骤 5）：遮罩 pass 的槽 1 是记录的遮罩纹理，目标 pass 同基础材质
    layer.puppet?.clip?.masks.forEach(add);
    if (layer.puppet?.clip) add(layer.puppet.clip.target);
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
  /** fbo 实体（`FboBindings` 的下标指向这里）。卸对象放掉的下标留空、记进 `freeTargets`，之后建的 fbo 复用（L4）。 */
  private readonly targets: RenderTarget[] = [];
  /** `targets` 里放掉的下标（L4，`dropTarget`）：没有一个运行时还指向它们，`addTarget` 先用它们。 */
  private readonly freeTargets: number[] = [];
  /**
   * fbo 共享池（L4 起是字段、带引用计数，原来是 `populate` 的局部变量）：键是名字、尺寸、格式、寻址（非 unique）或图层与 effect 的 id
   * （unique，每层独占），值是 `targets` 下标与取用它的次数。装对象时取（`acquireFbo`），卸对象时还（`releaseFbo`），归零释放。
   */
  private readonly fboPool = new Map<string, { id: number; refs: number }>();
  /** 场景目标：`current` 是这一帧画的那张，`alternate` 只在清屏可能关掉时有（L11）。 */
  private current: SceneTarget | null = null;
  private alternate: SceneTarget | null = null;
  /** `linearizeBase` 的管线，第一次用时才建。 */
  private linearBase: { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup } | null = null;
  private snapshot: RenderTarget | null = null;
  /** `_rt_Reflection` 与 `_rt_MipMappedFrameBuffer`（P13b1，`reflection.ts`）；bundle 里没有读者时为 null。 */
  private reflectionTargets: ReflectionTargets | null = null;
  /** 阴影图集（P13d，`render/shadows.ts`）：有阴影档位与阴影计数时才有 */
  private shadowAtlas: ShadowAtlas | null = null;
  /** 阴影 pass 的投射者绘制（P13d）：不透明且 castshadow 的模型网格，按对象建（L4：`installShadowCasters`） */
  private shadowCasters: ShadowCasterDraw[] = [];
  /** 投射者 → 所属对象与它独有的资源（P6d3、L4：卸对象时把它的投射者从 `shadowCasters` 去掉并释放）。 */
  private readonly shadowCasterRecords = new Map<ShadowCasterDraw, ShadowCasterRecord>();
  /** 投射者的管线（L4）：按「程序、网格布局、A2C」缓存（`shadowPipelineFor`），同 `pipelines` / `readyPipelines` 的两张表。 */
  private readonly shadowPipelines = new Map<string, Promise<GPURenderPipeline>>();
  private readonly readyShadowPipelines = new Map<string, GPURenderPipeline>();
  /** 正在编码的这一帧的状态（P13d）：投射者每帧按它取模型的世界矩阵（脚本、关键帧可能移动了模型） */
  private encodingState: SceneState | null = null;
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
  /** 体积光（P13e，`render/volumetrics.ts`）：bundle 有 `volumetrics` 时才有。 */
  private volumetrics: VolumetricsRenderer | null = null;
  /** 最近一帧的灯光缓冲与阴影条目（`frameLightValues`）：带阴影的体积光点光取自己的阴影投影与方块变换。 */
  private lightFrameCache: LightFrame | null = null;
  /** 最近一次 `sync` / 建场景的状态（P13f2）：`update` 没给状态时按它组灯记录。 */
  private lightState: SceneState | null = null;
  /** 遗留灯（P13f2）：这一帧画的值、按本帧末状态算的下一帧的值、换代用的帧时刻（`frameLightValues`）。 */
  private legacyCurrent: Record<string, number[]> | null = null;
  private legacyNext: Record<string, number[]> | null = null;
  private legacyTime: number | null = null;
  /**
   * 本帧的主视图（`render/views.ts` 的 `SceneView`）。平面反射 pass 的视图由它现算（`reflectedView`，P13b2），两者走同一套 uniform 规则
   * （`uniformValues` 的 `view` 参数）。
   * - `viewProjection`：场景级视图投影，`baseViewProjection · T(−s)`，s 是本帧的抖动（`setCamera`）；
   * - `perspectiveViewProjection`：透视覆盖（透视粒子 `flags & 4`、`perspective: true` 的图层）的视图投影，
   *   `basePerspectiveViewProjection · T(−s)`；
   * - `sceneCamera`：场景相机的投影与视图（WPE 分开存：每次 draw 先在 V 上做视差平移，再 `P ⊗ V`；rea-matrix-order 2.1、2.3）。
   *   正交、无相机对象时 V 是单位阵或抖动的 `T(−s)`（lookAt 在这种输入下正好是平移）。`viewProjection` 恒等于 `mulAffine(projection, view)`；
   * - `eye`：`g_EyePosition`；
   * - `viewVectors`（P5d 步骤 2）：`g_ViewForward` / `g_ViewRight` / `g_ViewUp` 与粒子朝向的视线、上方向。正交场景恒为常量，透视场景随
   *   `setCamera` 换。
   */
  private view: SceneView = {
    viewProjection: new Float32Array(16),
    perspectiveViewProjection: new Float32Array(16),
    sceneCamera: { projection: new Float32Array(16), view: identity() },
    eye: [],
    viewVectors: ORTHO_VIEW_VECTORS,
  };
  /** 不带抖动的场景视图投影（`sceneViewProjection(general, zoom)`，建场景时算，zoom 变了重算）。 */
  private baseViewProjection: Float32Array = new Float32Array(16);
  /** 不带抖动的透视粒子视图投影（`particleViewProjection(general, zoom)`，建场景时算，zoom 变了重算）。 */
  private basePerspectiveViewProjection: Float32Array = new Float32Array(16);
  /** 本帧的抖动偏移 s（P5a 步骤 3，`setCamera`）：不跨帧，只记本帧的值。 */
  private shake: [number, number] = [0, 0];
  /** 当前的正交缩放（P5a 步骤 4，`setCamera`）：建场景时取编译期的 `general.zoom`，两份基准矩阵按它算。 */
  private zoom = 1;
  /**
   * 光标反投影用的总缩放（P6c 修复 2）：不裁时就是 `zoom`，有相机对象时是 `general.zoom × camera.zoom`（`setCamera` / `applyCameraObject` 记）。
   */
  private pointerZoom = 1;
  /**
   * `fill` 且窗口与场景比例不同时的裁切边距（`fillCropEdges`，渲染器每帧设、`ParticleOptions.cursorCrop` 建场景时给）：非空时光标
   * （命中与世界坐标、粒子的跟随指针）按裁过的 `P·V` 与窗口归一化指针反投影，传进来的 `cursor` 也是窗口指针。透视场景与按指定尺寸画
   * （`crop`，投影本来就裁了）时忽略。
   */
  private cursorCrop: Edges | null = null;
  /**
   * 文本 `anchor` 用的 `E0..E3`（P6e 点 5，渲染器每帧按样式与画布尺寸设，`anchorEdgesFor`；缺省全 0）。按指定尺寸画（`crop`）时用投影的那一份
   * 裁切边距，透视场景恒为 0（WPE 不算）。见 {@link GpuScene.anchorEdgesNow}。
   */
  private anchorEdges: Edges = [0, 0, 0, 0];
  /**
   * 按指定尺寸画（dev 探针，`build` 的 `target`，只对正交场景）：投影的裁切边距与窗口（= 场景目标）尺寸，所有正交投影与透视粒子投影都带它
   * （建场景、`setCamera` 的 zoom 重算）。产品不传，恒为 null，字节不变。
   */
  private crop: ProjectionCrop | null = null;
  /**
   * 按指定尺寸画时每帧的清屏色（对齐方式 1 / 3 的 `schemecolor`）；null 用 `clearcolor`。主场景目标与平面反射 RT 都用它：WPE 帧首选一个
   * 设备清屏色，反射 RT 跟着拿到（p13-REPORT「P13b2 补测：对齐方式与反射 RT 的清屏色」，反射开 / 关都实测过）。
   */
  private targetClear: readonly [number, number, number] | null = null;
  /** `setCamera` 改了相机、draw 还没按新相机重写：下一次 `setParallax` 整体刷一遍（与视差的刷新合成一次）。 */
  private cameraDirty = false;
  /**
   * 正交场景当前的相机来自相机对象（P5d 步骤 3，`applyCameraObject`）：这时 VP、透视覆盖、眼位与视图向量都是相机对象的，`zoom` /
   * `shake` / 两份基准矩阵还是上一次没有相机对象时的。回到没有相机对象时要整套重算（不能按 zoom 与 s 没变提前返回）。
   */
  private objectCamera = false;
  /** 本帧的视差（P5a 步骤 2，`setParallax`）：null 为关着，绘制不加平移。 */
  private parallax: SceneParallax | null = null;
  /**
   * 粒子层全场共用的索引缓冲（`quadIndices`），建场景时按最大的 `maxcount` 建；之后装的对象要的更多时重建（L4，`ensureParticleIndices`），
   * draw 不持有它、编码时现取。没有粒子层时为 null。
   */
  private particleIndices: { buffer: GPUBuffer; format: GPUIndexFormat; particles: number } | null = null;
  /** 粒子层（`objects` 下标）→ 粒子序号（定种子用，`build` 的 `particleOrdinal` 给）：装对象时取一次，卸时删（L4）。 */
  private readonly particleOrdinals = new Map<number, number>();
  /** operator 遍数（`ParticleOptions.passes`，运行中由 `setFrameRate` 改）：新建的系统树用它。 */
  private particlePasses: 1 | 2;
  /** 宿主的帧上限（`ParticleOptions.fps`，运行中由 `setFrameRate` 改）：rope 的 `TL`、`TP0`（`writeRopeSegments`）。 */
  private particleFps: number;
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
  /**
   * 帧表纹理的共享计时器（P6e 点 2，`render/sheets.ts`），键是 bundle 纹理下标，第一次画到这张纹理时按 `{0, 0, 0}` 建（WPE 纹理对象构造时清 0）。
   * 同一张 `.tex` 一份：用它的所有图层、effect、粒子共用（WPE 纹理按名字缓存，rea-p6e-sheet 2.2【推】，`bundle.ts` 也按解析后的路径去重）。
   * 本步只在同一个 `GpuScene` 内保持：整场重新加载建新的 `GpuScene` 时计时器从头开始，WPE 重载场景时纹理对象是否重建没查（rea-p6e-sheet 未查清 2）。
   */
  private readonly sheetClocks = new Map<number, SheetClock>();
  /** 每个 draw 里帧表纹理的槽（程序真的绑定的槽，且输入是静态纹理、纹理带帧表）：建一次，空数组也记下。 */
  private readonly sheetSlots = new WeakMap<Draw, { slot: number; index: number }[]>();
  /**
   * 渲染帧号（WPE `ctx+0x144`，每帧开头加 1，共享计时器据此「每帧只推进一次」）：每个帧的唯一入口 `stepParticles` 里加 1（渲染器与 dev 探针每帧
   * 恰好调一次；`update` 在探针里一帧可能调几次，不能用）。从 1 起，所以第一帧的第一次绑定就推进（`lastFrame` 初值 0）。
   */
  private sheetFrameNo = 0;
  /** 本帧的 `g_Frametime`（最近一次 `update` 的 `frametime`，已钳过；补画帧为 0）：共享计时器按它推进。 */
  private sheetDt = 0;
  /**
   * 图层脱离帧号的来源（脚本 `ITextureAnimation`，P6e 点 3 接 `SceneState`）：`>= 0` 时这个图层整段绘制里的所有帧表纹理都画这一格、不推进
   * 共享计时器；`< 0` 走共享计时器。本步没有来源，一律 −1。
   */
  private sheetOverride: (object: number) => number = () => -1;
  /** HDR 下图层颜色乘 `brightness`（B10），就地刷新时按状态里的 brightness 现算。 */
  private hdr = false;
  /** 上传后的场景纹理，下标同 `bundle.textures`；没上传的为 null（`uploadableTextures`）。 */
  private textures: (GPUTexture | null)[] = [];
  /** 多图像帧表（P6e 点 4）第 1 张起的其余图像的 GPU 纹理（下标 k 是图像 k + 1），键同 `textures`；只有这类纹理有条目。 */
  private readonly extraTextures = new Map<number, GPUTexture[]>();
  private dummies!: ReturnType<GpuScene["createDummies"]>;
  private readonly samplers = new Map<string, GPUSampler>();
  private readonly programs = new Map<number, Promise<GpuProgram>>();
  private readonly pipelines = new Map<string, Promise<GPURenderPipeline>>();
  /**
   * 脚本写过材质状态字段后，新状态的管线还没备好的图层（P6d1b，`objects` 下标）：`deferPassStatePipelines` 在后台建管线，建好（`passStateReady`）
   * 后 `sync` 对它们强制重建。加载时只备了 bundle 值的管线，运行中写出的新组合（混合、剔除、深度）要现建，WebGPU 的建管线是异步的。
   */
  private readonly passStateWaiting = new Set<number>();
  private readonly passStateReady = new Set<number>();
  private readonly passStateJobs = new Set<Promise<void>>();
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
  /**
   * bundle 的全部图层（含没有资源的分组节点），按 `objects` 下标：组的尺寸、`copyBackground` 与父链上组的层数从这里查。建场景时按
   * `bundle.layers` 填，之后随装卸维护（L4；卸的图层还是别的图层的组时留着，子层画的路径上还要查它）。
   */
  private readonly layerByObject = new Map<number, SceneLayer>();
  /** 建了资源的图层按 `objects` 下标：组的 `subtree` op 按它找子孙的 op（P5b 步骤 4）。 */
  private readonly runtimeByObject = new Map<number, LayerRuntime>();
  /**
   * 运行时对象表的派生（P6d3）：顶层绘制顺序与对象 → 位置，按 `SceneState.structureVersion` 缓存（`structure`）。
   */
  private structureCache: { version: number; top: LayerRuntime[]; position: Map<number, number> } | null = null;
  /** `sync` 已清理到的结构代数（`releaseRemoved`）；-1 表示还没扫过。 */
  private structureSeen = -1;
  /** 已被删除并释放了资源的对象（P6d3）：灯与体积光的灯表跳过它们。 */
  private readonly removedObjects = new Set<number>();
  /** 结构变化记下、还没重排的对象（L7，`restructure`）：`flushRestructure` 或下一次 `sync` 做掉。 */
  private readonly pendingRestructure = new Set<number>();
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
  /** 用户纹理的来源（P11b，`build` 的 `userTextures`）；null 时全部槽用缺省纹理。 */
  private userProvider: UserTextureProvider | null = null;
  /** 用户纹理的 GPU 纹理，按 WPE 的纹理名缓存：几个槽共用同一张，没有槽引用时 `sync` 末尾销毁。 */
  private readonly userGpu = new Map<string, UserGpu>();
  /** 已经记过 warning 的用户纹理（超出设备上限、拷贝失败），每个纹理名只记一次。 */
  private readonly userWarned = new Set<string>();
  /**
   * 加载之后真正写过的属性来源（`SceneState.userWritten` 同一个集合，只增，`build` 时接上）：RT 参考的槽从第一次写入起才生效（M8）。
   * 解码完成只标脏、不进这个集合，所以加载期晚到的解码不会让槽提前生效。
   */
  private userWritten: ReadonlySet<string> = new Set();
  /** PNG gamma 校正的渲染管线（`render/userGamma.ts`）：第一次遇到带表的图时建，随场景销毁。 */
  private gammaPass: GammaPass | null = null;
  /** 视频纹理的帧来源（P9a，`setVideoSink`）；null 时视频纹理保持全 0。 */
  private videoSink: VideoSink | null = null;
  /**
   * puppet 运行时的来源（P12a，`setPuppets`）：`update` 每帧按图层写 `g_Bones`（P12b1 起还有 `g_BonesAlpha`、`g_MorphOffsets` / `g_MorphWeights`），
   * 挂点的 `Pose` 也从这里取（`attachPose`）；null 时 `g_Bones` 保持全 0、挂点按普通父子。
   */
  private puppets: PuppetSource | null = null;
  /** 设备开着的特性（`build` 的 `features`）：变形纹理要 `float32-filterable`（P12b1 步骤 4）。 */
  private features: ReadonlySet<string> = new Set();
  /** 挂点（P12b1 步骤 3，`SceneLayer.attachment`）：子对象 → 挂点；没有挂点的场景为空。 */
  private attachments = new Map<number, SceneAttachment>();
  /** 挂点子对象与全部子孙（`objects` 下标，第一次 `sync` 时按状态里的父子关系算）：姿势每帧变，每次 `sync` 都并进 `dirty.layers`。 */
  private attachedLayers: number[] | null = null;
  /** `worldMatrixOf` / `drawMatrixOf` 的挂点钩子（P12b1 步骤 3）：稳定的闭包，没有挂点时恒返回 null。 */
  private readonly attachHook = (object: number): Mat4 | null => this.attachPose(object);
  /**
   * WPE 世界矩阵缓存的影子（B1，`WorldStamps`）：有挂点时才建，没有挂点的场景为 null（调用序列不变）。更新阶段（`stepParticles` 开头）与
   * 渲染阶段（`drawPhase`）各求值一次，渲染阶段里挂点子树的结果留在 `drawSeeds`，由 `sync` 与 `encode` 预置进 `worlds`。
   */
  private stamps: WorldStamps | null = null;
  /** 本帧走过更新阶段（`drawPhase` 据此区分补画帧，取走即清）。 */
  private stampUpdated = false;
  /** 渲染阶段挂点子树的世界矩阵（B1）：`sync` 与 `encode` 经 `liveSeeds` 读，不取走；更新阶段开头清空，之后又有变换写入时作废。 */
  private drawSeeds: Map<number, Mat4> | null = null;
  private readonly hasAttachment = (object: number): boolean => this.attachments.has(object);
  /** 没有透明度来源时 `g_BonesAlpha` 的全 1（按骨骼数缓存，P12b1 步骤 4）。 */
  private readonly onesCache = new Map<number, Float32Array>();
  /** 每个带变形的 puppet（`objects` 下标）的变形纹理（P12b1 步骤 4）：建场景时上传一次，`morph` 引用解析到这里。 */
  private readonly morphTargets = new Map<string, RenderTarget>();
  /** 裁切遮罩 RT（P12b1 步骤 5）：有裁切的 puppet 才建，场景目标宽高各一半。 */
  private clipMask: RenderTarget | null = null;
  /** 已经记过 warning 的视频纹理（`size:<下标>` / `copy:<下标>`）：每张纹理每种只记一次。 */
  private readonly videoWarned = new Set<string>();
  /**
   * 模型网格的 GPU 缓冲（P5c 步骤 2，`meshBuffer`）：按 mdl 文件缓冲 → 「用途、视图偏移与长度」去重，同一个 mdl 被几个对象引用时共用一份
   * （编译期同一路径只解析一次，几个对象的网格是同一块缓冲上的同一个视图）。随场景销毁，图层重建不释放。
   */
  private readonly meshBuffers = new Map<ArrayBufferLike, Map<string, GPUBuffer>>();
  /** 网格的占位顶点缓冲（全零，`MESH_PLACEHOLDER_BYTES`）：第一个有占位属性的网格建，全场共用。 */
  private meshPlaceholder: GPUBuffer | null = null;
  /**
   * 平面反射 pass 的名单（P13b2，`bundle.reflection.list`，`objects` 下标）：反射开时才有，否则 null（只清屏，P13b1）。登记表原地维护
   * 那个数组（L3a），这里按 `structureVersion` 从它刷新（`syncReflectionList`，L4），查用 `reflected`。
   */
  private reflectionSet: Set<number> | null = null;
  /** `reflectionSet` 刷新时的结构代数；-1 表示还没刷过。 */
  private reflectionSeen = -1;
  /** 单个对象的变体段排成一串（L4，`serialVariants`）：各段自己开错误作用域，并行会让作用域互相错位。 */
  private variantChain: Promise<unknown> = Promise.resolve();
  /** 参加反射 pass 的 draw 的副本（P13b2）：第一次画到时建（`reflectionCopyOf`），draw 被重建时释放。 */
  private readonly reflectionCopies = new Map<Draw, ReflectionCopy>();
  /** sprite 的遮挡计数与 k（P13c，`render/sprite.ts`）：sprite 图层的 `objects` 下标 → 计数器，第一次画到它时建。 */
  private readonly spriteCounters = new Map<number, SpriteCounter>();
  /** 计数 pass 的颜色目标（只为满足附件要求，写掩码 0），和场景目标同尺寸；第一次计数时建。 */
  private spriteTarget: GPUTextureView | null = null;
  /** `spriteTarget` 的纹理（`resize` 换尺寸时释放）。 */
  private spriteTexture: GPUTexture | null = null;
  /** 泛光链、体积光建的资源（`own` 登记的那些）：`resize` 整条重建、旧的整批释放。 */
  private bloomOwned = new Set<{ destroy(): void }>();
  private volumetricsOwned = new Set<{ destroy(): void }>();
  /** `resize` 串行（一次换尺寸做完才开始下一次）。 */
  private resizing: Promise<void> = Promise.resolve();
  /** `destroy` 之后为真：进行中的 `resize` 醒来后放弃。 */
  private disposed = false;

  private constructor(
    private readonly device: GPUDevice,
    private readonly bundle: SceneBundle,
    private readonly warnings: string[],
    particles: ParticleOptions,
    /** 粒子序号（L4，`build` 的 `particleOrdinal`）：装粒子层时取一次（`particleOrdinals`）。 */
    private readonly particleOrdinal: (object: number) => number,
  ) {
    this.particlePasses = particles.passes ?? 1;
    this.particleFps = particles.fps ?? 60;
    this.particleSeed = particles.seed ?? Math.floor(Math.random() * 2 ** 32);
    this.particleROverride = particles.rOverride;
    this.particleCursor = particles.cursor ?? [0.5, 0.5];
    this.cursorCrop = particles.cursorCrop ?? null;
    this.particleAudio = particles.audio ?? silentParticleAudio();
  }

  /** 顶层绘制顺序（按 `state.order`）与位置表（P6d3），随 `structureVersion` 重建。 */
  private structure(state: SceneState): { top: LayerRuntime[]; position: Map<number, number> } {
    const cache = this.structureCache;
    if (cache && cache.version === state.structureVersion) return cache;
    const fresh = { version: state.structureVersion, ...layerStructure(state.order, this.runtimeByObject) };
    this.structureCache = fresh;
    return fresh;
  }

  /**
   * 对象被删（`SceneState.flushDestroy`，P6d3）后的清理：`state.layers` 里已经没有的对象逐个 `teardown`（`removeObject` 的同一段）。这仍是
   * 「状态里没有了就释放」的唯一通路（L4）：宿主的删除路径只改状态与登记表，下一次 `sync` 先于任何读取走到这里。
   */
  private releaseRemoved(state: SceneState): void {
    this.structureCache = null;
    const gone = this.layers.filter((runtime) => !state.layers.has(runtime.object)).map((runtime) => runtime.object);
    for (const object of gone) this.teardown(object);
  }

  /**
   * 卸掉一个对象（L4，`releaseRemoved` 的单对象版）：释放它独有的 GPU 资源（各 draw 的顶点 / uniform 缓冲、文本索引缓冲、反射副本、被依赖层
   * 的独占 RT、文本层独占的合成 RT 与 fbo、变形纹理、阴影投射者的 draw 与副本），还掉池化 fbo 的引用（归零释放），摘掉粒子序号、挂点、
   * 从全部索引里去掉。共享的程序、管线、纹理、池化合成 RT 不动。没有运行时（没建资源）时什么都不做。
   * 只能在帧边界调（`sync` 之前或 `encode` 之后）。
   */
  removeObject(object: number): void {
    this.teardown(object);
  }

  /**
   * `removeObject` 的实现。`replacing`（`installObject` 替换同一对象，L5）：不记进 `removedObjects`、不动挂在它骨骼上的子对象的挂点，
   * `layerByObject` 留给新图层覆盖。`keepTarget`（L6b）：被依赖图层的独占 RT 留着不释放（替换时新旧形状相同、沿用旧的那张，引用方
   * 的 bind group 不用重绑），由调用方覆盖 `layerTargets`。
   */
  private teardown(object: number, options: { replacing?: boolean; keepTarget?: boolean } = {}): void {
    const runtime = this.runtimeByObject.get(object);
    if (!runtime) return;
    const replacing = options.replacing ?? false;
    if (!replacing) this.removedObjects.add(object);
    for (const draw of runtime.draws) this.releaseDraw(draw);
    runtime.draws = [];
    runtime.ops = [];
    runtime.tree = null;
    this.drawsByLayer.delete(object);
    this.runtimeByObject.delete(object);
    this.trees.delete(object);
    const own = this.layerTargets.get(object);
    if (own && !options.keepTarget) {
      this.releaseTarget(own);
      this.layerTargets.delete(object);
    }
    // 被依赖的文本层第 0 张就是独占 RT（P8 步骤 6）：上面已按 `keepTarget` 处理，这里不再放一次
    if (runtime.layer.text)
      for (const target of runtime.resources.composites.splice(0)) if (target !== own) this.releaseTarget(target);
    for (const record of this.textFbos.get(object) ?? []) this.dropTarget(record.id);
    this.textFbos.delete(object);
    for (const key of [...this.morphTargets.keys()])
      if (key === morphKey(object) || key.startsWith(`${object}:`)) {
        this.releaseTarget(this.morphTargets.get(key)!);
        this.morphTargets.delete(key);
      }
    this.spriteCounters.delete(object);
    this.passStateWaiting.delete(object);
    this.passStateReady.delete(object);
    // L4：池化 fbo 的引用、粒子序号、挂点、投射者、图层表
    for (const key of runtime.fboKeys) this.releaseFbo(key);
    runtime.fboKeys = [];
    this.particleOrdinals.delete(object);
    this.attachments.delete(object);
    if (!replacing)
      for (const [child, attachment] of [...this.attachments])
        if (attachment.parent === object) this.attachments.delete(child);
    this.attachedLayers = null;
    if (this.shadowCasterRecords.size)
      this.shadowCasters = this.shadowCasters.filter((caster) => {
        const record = this.shadowCasterRecords.get(caster);
        if (!record || record.object !== object) return true;
        this.shadowCasterRecords.delete(caster);
        this.releaseDraw(record.draw);
        for (const copy of record.copies.values()) this.release(copy.buffer);
        return false;
      });
    // 删组（L7）：删除生效时登记表已经 `restructure`，子层的 `group` 已不是它，这里直接摘
    if (!replacing) this.layerByObject.delete(object);
    const at = this.layers.indexOf(runtime);
    if (at >= 0) this.layers.splice(at, 1);
    this.structureCache = null;
  }

  /** 一个 draw 从全部索引里摘掉并释放它独有的缓冲（网格共用的顶点 / 索引缓冲不动，puppet 私有的顶点缓冲例外）。 */
  private releaseDraw(draw: Draw): void {
    this.draws.delete(draw);
    const byPass = this.drawsByPass.get(draw.passKey);
    if (byPass) {
      const rest = byPass.filter((item) => item !== draw);
      if (rest.length) this.drawsByPass.set(draw.passKey, rest);
      else this.drawsByPass.delete(draw.passKey);
    }
    if (!draw.mesh || draw.mesh.privateVertices) this.release(draw.vertexBuffer);
    if (draw.mesh?.ordered) this.release(draw.mesh.indexBuffer);
    if (draw.uniformBuffer) this.release(draw.uniformBuffer);
    if (draw.text) this.release(draw.text.indexBuffer);
    const copy = this.reflectionCopies.get(draw);
    if (copy) {
      this.release(copy.buffer);
      this.reflectionCopies.delete(draw);
    }
    this.particleTimings?.delete(draw);
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

  /** 图层当前的组归属（L7）：管线、uniform、池化合成 RT 随它变（`LayerRuntime.placement`）。 */
  private placementOf(layer: SceneLayer): LayerPlacement {
    return { group: this.groupOf(layer)?.object ?? null, depth: this.groupDepth(layer) };
  }

  /** 这个对象有没有 GPU 运行时（L7：宿主判断组内不支持组合要不要卸）。 */
  hasObject(object: number): boolean {
    return this.runtimeByObject.has(object);
  }

  /**
   * 结构变化（L7）：登记表 `restructure` 报出派生量（组、组的层数、子树、挂点、effect 的组内标记）变了的对象，记下，下一次 `flushRestructure`
   * 或 `sync`（`releaseRemoved` 之后、effect 开关的重建之前）当场重排。`SceneLayer` 和登记表是同一份，`groupOf` / `groupDepth` / 顶层表读到的已是
   * 新值，这里补的只是 draw、管线与资源。
   */
  restructure(objects: Iterable<number>): void {
    for (const object of objects) this.pendingRestructure.add(object);
  }

  /**
   * 把记下的结构变化当场做掉（L7）：宿主在一帧的脚本与删除生效之后调（出错整场重载）；没调时 `sync` 做。先释放被删对象（删组之后它的资源不再有人读），
   * 再 `applyRestructure`。只能在帧边界调。
   */
  flushRestructure(state: SceneState): void {
    if (!this.pendingRestructure.size) return;
    if (state.structureVersion !== this.structureSeen) {
      this.structureSeen = state.structureVersion;
      this.releaseRemoved(state);
    }
    this.applyRestructure(state, new Map<number, Mat4>(this.liveSeeds(state) ?? []));
  }

  /**
   * 重排记下的对象（L7）：
   * 1. 挂点：按 `layer.attachment` 写 / 删 `attachments`（没有 GPU 运行时的分组节点也挂在骨骼上，同建场景）；
   * 2. 有运行时的逐个 `restructureLayer`：计划签名与组归属都没变的不动（本来就是组、只是子表变了：`subtree` op 每帧读 `layer.subtree`；顶层之间换父），
   *    变了的重建（缺的管线同步建）。
   * 一个对象重排失败时卸掉它（不画，旧的 draw 可能和新的组归属对不上），其余照做，最后抛 `SceneRenderError`（宿主整场重载）。
   */
  private applyRestructure(state: SceneState, worlds: Map<number, Mat4>): void {
    const objects = [...this.pendingRestructure];
    this.pendingRestructure.clear();
    this.structureCache = null;
    for (const object of objects) {
      const layer = this.runtimeByObject.get(object)?.layer ?? this.layerByObject.get(object);
      if (!layer) continue;
      if (layer.attachment) {
        this.attachments.set(object, layer.attachment);
        this.stamps ??= new WorldStamps();
      } else this.attachments.delete(object);
    }
    this.attachedLayers = null;
    const failures: string[] = [];
    for (const object of objects) {
      const runtime = this.runtimeByObject.get(object);
      if (!runtime) continue;
      try {
        this.restructureLayer(runtime, state, worlds);
      } catch (error) {
        this.teardown(object);
        failures.push(...reasonsOf(error, "render:restructure"));
      }
    }
    if (failures.length) throw new SceneRenderError([...new Set(failures)]);
  }

  /**
   * 一个图层按当前的组归属重排（L7）：
   * - 在顶层而场景目标没有深度附件、它的计划（含变体）要测深度（出组回到顶层，或组合层成了组、多了上屏）：抛 `render:restructure-depth`（深度附件建场景时
   *   按全部计划定一次，是场景级不变量；加载时就在顶层的图层这条判定同建场景，不会成立）；
   * 组归属变了时：
   * - 组的层数变了：池化合成 RT 按层数分池，借的换掉（被依赖层独占的第 0 张留着；文本层的合成 RT 本来就独占）；
   * - 重建（`rebuildLayer` 的 `syncPipelines`：管线缺了同步建，程序不变）；
   * - 可变 effect 的变体按新的组归属同步备一遍管线（同 `prepareVariants`），备不好时冻结这一层（切换走整场重编译）。
   * 组归属没变时只按签名重建（组的子树从空变成非空，计划多了子树与上屏）。
   */
  private restructureLayer(runtime: LayerRuntime, state: SceneState, worlds: Map<number, Mat4>): void {
    const { layer } = runtime;
    const placement = this.placementOf(layer);
    const moved = !samePlacement(placement, runtime.placement);
    if (layer.group == null && !this.depthTarget) {
      const plans = [
        this.planOf(layer, state),
        ...variantPlans(layer, this.bundle.textures, null, [this.width, this.height]),
      ];
      if (wantsDepth([{ layer, plans }])) throw new SceneRenderError(["render:restructure-depth"]);
    }
    if (moved && placement.depth !== runtime.placement.depth && !layer.text)
      runtime.resources.composites.splice(this.layerTargets.has(runtime.object) ? 1 : 0);
    this.rebuildLayer(runtime, state, worlds, { syncPipelines: true });
    if (!moved) return;
    const text = layer.text ? (state.texts.get(layer.object) ?? null) : null;
    const plans = variantPlans(layer, this.bundle.textures, text, [this.width, this.height]);
    if (!plans.length) return;
    const variants = this.prepareVariantsNow(
      { layer, resources: runtime.resources, layerTarget: this.layerTargets.get(runtime.object) ?? null },
      plans,
    );
    const failure = variants ? variants.failure : "管线同步建不出（缺程序或 A2C）";
    if (failure !== null) this.freezeVariants(layer, state, failure);
  }

  /**
   * 换场景目标尺寸（WPE `FUN_14017f1b0`：只重建按窗口分配的 RT、改 g_Screen，场景接着跑）。状态、粒子树、脚本、关键帧、puppet、帧表计时器、
   * 视频播放器、文本图集、用户纹理都不动，不重新预热。`next` 的规则同 `build` 的 `size` / `target`（`targetPlan`）：正交场景 `edges` 非空时场景目标
   * = `size`（超设备上限抛 `render:target-size:…`），`edges` 与 `clear` 一并换成新的（投影边距、清屏色）；`edges` 为 null 的正交场景
   * 按场景分辨率画（`size` 不看）；透视场景只看 `size`（钳设备上限，`edges` / `clear` 忽略）。尺寸、边距、清屏色都没变时什么都不做；
   * 只有边距 / 清屏色变、尺寸不变时只换投影与清屏色，不重建 RT。
   *
   * 异步（泛光链与体积光建管线要等），但换的那一刻是同步的：先在旁边把新的场景目标 / 交替目标 / 深度 / 快照 / 反射两张 RT / 裁切遮罩 /
   * 计数目标 / 泛光链 / 体积光全建好（这期间 `encode` 照旧画旧尺寸、不受影响），再在一次同步调用里换上、释放旧的、整层强制重建全部图层
   * （绑定组、fullscreen 合成 RT 与 fbo、`g_Screen` 等静态 uniform）。所以 `resize` 返回的 Promise 兑现之后，下一次 `encode` 画的就是新尺寸；
   * 调用方在它兑现之前继续画旧尺寸即可（拉伸上屏）。多次调用串行。透视场景的投影宽高比由渲染器每帧的 `setCamera` 更新，调用方在
   * 下一次 `encode` 之前照常调。重排失败（`rebuildLayer` 抛错）时场景已经换成新尺寸而部分图层仍是旧 draw，调用方应整场重新加载。
   * `state` 是这个场景的状态（重建 draw 按它写 uniform）。
   */
  resize(
    next: {
      size: readonly [number, number];
      edges: Edges | null;
      clear: readonly [number, number, number] | null;
    },
    state: SceneState,
  ): Promise<void> {
    const run = this.resizing.then(() => this.resizeNow(next, state));
    this.resizing = run.catch(() => {});
    return run;
  }

  private async resizeNow(next: Parameters<GpuScene["resize"]>[0], state: SceneState): Promise<void> {
    if (this.disposed) return;
    const { device, bundle } = this;
    const plan = this.targetPlan(next.size, next);
    const dims = plan.dims;
    const [width, height] = dims;
    const { sized } = plan;
    const crop: ProjectionCrop | null = sized ? { edges: sized.edges, window: [width, height] } : null;
    const clear = sized ? sized.clear : null;
    const sameSize = width === this.width && height === this.height;
    const sameClear =
      this.targetClear === clear ||
      (!!this.targetClear && !!clear && this.targetClear.every((value, index) => value === clear[index]));
    const sameCrop =
      this.crop === crop ||
      (!!this.crop && !!crop && this.crop.edges.every((value, index) => value === crop.edges[index]));
    if (sameSize && sameCrop && sameClear) return;
    if (sameSize) {
      this.applyCrop(crop, clear);
      // 全部 draw 的矩阵 uniform 按新投影当场重写（不等渲染器下一帧的 `setParallax`）
      if (!bundle.general.perspective) this.setParallax(this.parallax, state);
      return;
    }

    // 一、旁边建新的：同步段里量出 `createX` 加进 `targetBytes` 的量、先减回去，换的时候一次性记账（建的期间旧的还在画）
    const bytesBefore = this.targetBytes;
    const staged = {
      current: this.createSceneTarget("scene target", 0, dims),
      alternate: this.alternate ? this.createAlternateTarget(dims) : null,
      depth: this.depthTarget ? this.createDepthTarget(dims) : null,
      snapshot: this.snapshot || this.bloom ? this.createSnapshot(dims) : null,
      reflection: this.reflectionTargets ? ReflectionTargets.create(device, bundle, width, height, this.hdr) : null,
      clipMask: this.clipMask ? this.createClipMask(dims) : null,
      sprite: this.spriteTarget ? this.createSpriteTarget(dims) : null,
    };
    const stagedBytes = this.targetBytes - bytesBefore + (staged.reflection?.bytes ?? 0);
    this.targetBytes = bytesBefore;
    const bloomOwned = new Set<{ destroy(): void }>();
    const volumetricsOwned = new Set<{ destroy(): void }>();
    let bloom: BloomChain | null = null;
    let volumetrics: VolumetricsRenderer | null = null;
    const discard = () => {
      for (const resource of [
        staged.current.texture,
        staged.alternate?.texture,
        staged.depth?.texture,
        staged.snapshot?.texture,
        staged.clipMask?.texture,
        staged.sprite?.texture,
        ...bloomOwned,
        ...volumetricsOwned,
      ])
        if (resource) this.release(resource);
      staged.reflection?.destroy();
    };
    try {
      if (this.bloom && bundle.bloom)
        bloom = await BloomChain.create({
          device,
          bloom: bundle.bloom,
          params: state.bloom,
          programs: this.readyPrograms,
          format: this.format,
          width,
          height,
          source: staged.snapshot!.view,
          pipelineFor: (program, blending, target) => this.pipelineFor(program, blending, target, false),
          own: (resource) => {
            bloomOwned.add(resource);
            return this.own(resource);
          },
        });
      if (this.volumetrics && bundle.volumetrics && staged.depth)
        volumetrics = await VolumetricsRenderer.create({
          device,
          volumetrics: bundle.volumetrics,
          programs: this.readyPrograms,
          width,
          height,
          hdr: this.hdr,
          sceneFormat: this.format,
          depth: staged.depth.texture,
          shadowAtlas: this.shadowAtlas ? { view: this.shadowAtlas.view, sampler: this.shadowAtlas.sampler } : null,
          own: (resource) => {
            volumetricsOwned.add(resource);
            return this.own(resource);
          },
        });
    } catch (error) {
      discard();
      throw error;
    }
    if (this.disposed) {
      discard();
      return;
    }

    // 二、同步换上（中间不让出，没有 `encode` 能插进来）
    const old = {
      width: this.width,
      height: this.height,
      current: this.current,
      alternate: this.alternate,
      depth: this.depthTarget,
      snapshot: this.snapshot,
      reflection: this.reflectionTargets,
      clipMask: this.clipMask,
      sprite: this.spriteTexture,
      bloom: this.bloom,
      volumetrics: this.volumetrics,
      bloomOwned: this.bloomOwned,
      volumetricsOwned: this.volumetricsOwned,
    };
    const texel = texelBytes(this.format);
    let oldBytes = 0;
    if (old.current) oldBytes += old.width * old.height * texel;
    if (old.alternate) oldBytes += old.width * old.height * texel;
    if (old.depth) oldBytes += old.width * old.height * 4;
    if (old.snapshot) oldBytes += old.snapshot.width * old.snapshot.height * texelBytes(old.snapshot.format);
    if (old.clipMask) oldBytes += old.clipMask.width * old.clipMask.height * texelBytes(old.clipMask.format);
    if (old.sprite) oldBytes += old.width * old.height;
    oldBytes += (old.reflection?.bytes ?? 0) + (old.bloom?.bytes ?? 0) + (old.volumetrics?.bytes ?? 0);
    this.targetBytes += stagedBytes + (bloom?.bytes ?? 0) + (volumetrics?.bytes ?? 0) - oldBytes;

    this.width = width;
    this.height = height;
    this.current = staged.current;
    // 等待期间才懒建的（脚本第一次关清屏、第一次要快照 / 遮罩 / 计数）这里按新尺寸补建
    this.alternate = staged.alternate ?? (old.alternate ? this.createAlternateTarget(dims) : null);
    this.depthTarget = staged.depth;
    this.snapshot = staged.snapshot ?? (old.snapshot ? this.createSnapshot(dims) : null);
    this.reflectionTargets = staged.reflection;
    this.clipMask = staged.clipMask ?? (old.clipMask ? this.createClipMask(dims) : null);
    const sprite = staged.sprite ?? (old.sprite ? this.createSpriteTarget(dims) : null);
    this.spriteTexture = sprite?.texture ?? null;
    this.spriteTarget = sprite?.view ?? null;
    this.bloom = bloom;
    this.volumetrics = volumetrics;
    this.bloomOwned = bloomOwned;
    this.volumetricsOwned = volumetricsOwned;
    this.linearBase = null;
    for (const resource of [
      old.current?.texture,
      old.alternate?.texture,
      old.depth?.texture,
      old.snapshot?.texture,
      old.clipMask?.texture,
      old.sprite,
      ...old.bloomOwned,
      ...old.volumetricsOwned,
    ])
      if (resource) this.release(resource);
    old.reflection?.destroy();
    this.applyCrop(crop, clear);
    // 透视场景的宽高比变了：先按加载时的相机（同建场景）换上，渲染器每帧的 `setCamera` 随后换成当帧的
    if (bundle.general.perspective)
      this.applyPerspective(initialPerspectiveFrame(bundle.general.camera, state.general, width, height));

    // 三、整层强制重建：绑定组指向新的快照 / 反射 / 遮罩 / 深度，fullscreen 的合成 RT 与 fbo 按新尺寸，g_Screen 等静态 uniform 重写。
    // `syncPipelines`：粒子层沿用粒子树（模拟不重来）、缺的管线当场建（格式不变，正常都在就绪表里）
    const worlds = new Map<number, Mat4>(this.liveSeeds(state) ?? []);
    const encoder = device.createCommandEncoder({ label: "scene resize" });
    const heldBefore = new Set<RenderTarget>(this.layers.flatMap((runtime) => runtime.resources.composites));
    for (const runtime of [...this.layers]) {
      const { layer } = runtime;
      if (layer.fullscreenSize === "scene" && !layer.text && !this.ownsSizing(layer))
        this.resizeBorrowed(runtime, encoder);
      this.rebuildLayer(runtime, state, worlds, { force: true, syncPipelines: true });
    }
    device.queue.submit([encoder.finish()]);
    // 共享合成 RT 池里换尺寸之后没有人再借的那几组（旧尺寸的）立刻释放，不等场景销毁
    const heldAfter = new Set<RenderTarget>(this.layers.flatMap((runtime) => runtime.resources.composites));
    for (const [key, pool] of [...this.compositePool]) {
      if (!pool.some((target) => heldBefore.has(target)) || pool.some((target) => heldAfter.has(target))) continue;
      for (const target of pool) this.releaseTarget(target);
      this.compositePool.delete(key);
    }
  }

  /**
   * 投影裁切与清屏色换新（`resize`）：两份基准矩阵按当前 zoom 重算，正交相机（没有相机对象时）立刻换上并标记相机变了，下一次 `setParallax`
   * 把全部 draw 的矩阵 uniform 按新投影重写；有相机对象时视图投影由渲染器下一帧按新裁切交（`applyCameraObject` 比较后更新）。
   * 透视场景没有裁切，只记清屏色。
   */
  private applyCrop(crop: ProjectionCrop | null, clear: readonly [number, number, number] | null): void {
    this.crop = crop;
    this.targetClear = clear;
    const { general } = this.bundle;
    if (general.perspective) return;
    this.baseViewProjection = sceneViewProjection(general, this.zoom, crop?.edges);
    this.basePerspectiveViewProjection = particleViewProjection(general, this.zoom, undefined, crop ?? undefined);
    this.cameraDirty = true;
    if (this.objectCamera) return;
    const [x, y] = this.shake;
    const still = x === 0 && y === 0;
    const view = still ? identity() : translation(-x, -y, 0);
    this.view.sceneCamera = { projection: this.baseViewProjection, view };
    this.view.viewProjection = still ? this.baseViewProjection : mulAffine(this.baseViewProjection, view);
    this.view.perspectiveViewProjection = still
      ? this.basePerspectiveViewProjection
      : multiply(this.basePerspectiveViewProjection, translation(-x, -y, 0));
  }

  /**
   * 尺寸随场景目标的借用式合成 RT 与池化 fbo（`resize`，只 `fullscreenSize: "scene"` 的图层，且不是文本层、槽 0 没有用户纹理：那两种自己独占、
   * `rebuildLayer` 里按排版 / 图像尺寸原地换）：合成 RT 尺寸不对的丢掉引用（`rebuildLayer` → `ensureComposites` 按新尺寸从池里重借；被依赖层的
   * 独占第 0 张留着）；fbo 先取新尺寸的引用、再还旧引用（尺寸没变的键同一个，引用先加后减不会释放重建）；`unique` 的 fbo 键里没有尺寸，尺寸变了
   * 在同一个下标上原地换，清屏记进 `encoder`。
   */
  private resizeBorrowed(runtime: LayerRuntime, encoder: GPUCommandEncoder): void {
    const { layer, resources } = runtime;
    const size = this.compositeSizeOf(layer, [this.width, this.height]);
    const keep = this.layerTargets.has(runtime.object) ? 1 : 0;
    if (resources.composites.slice(keep).some((target) => target.width !== size[0] || target.height !== size[1]))
      resources.composites.splice(keep);
    const keys: string[] = [];
    const maps = layer.effects.map(
      (effect) =>
        new Map(
          effect.fbos.map((fbo) => [fbo.name, this.acquireFbo(layer, effect, fbo, size, encoder, keys)] as const),
        ),
    );
    for (const key of runtime.fboKeys) this.releaseFbo(key);
    layer.effects.forEach((effect, e) => {
      for (const fbo of effect.fbos) {
        if (!fbo.unique) continue;
        const id = maps[e].get(fbo.name)!;
        const [fw, fh] = fboSize(fbo, size);
        const current = this.targets[id];
        if (current.width === fw && current.height === fh) continue;
        this.releaseTarget(current);
        this.targets[id] = this.createFbo(
          fbo,
          [fw, fh],
          fboFormatOf(fbo),
          `unique|${layer.id}|${effect.id}|${fbo.name}`,
          encoder,
        );
      }
    });
    resources.fbos = new FboBindings(maps);
    runtime.fboKeys = keys;
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
       * 用户纹理的来源（P11b 步骤 2，宿主的 `UserTextureSources`）：建场景与每次 `sync` 换图都问它「这个属性现在的图、按这个参考尺寸裁成什么」。
       * 不给时所有用户纹理槽都用缺省纹理。
       */
      userTextures?: UserTextureProvider;
      /**
       * 场景目标尺寸（P5d 步骤 2）：透视场景必给（按画布尺寸渲染，已定 6；渲染器传 `fullResolution`），经 `sceneTargetSize` 钳设备上限；
       * 正交场景不给，照旧按 `general.width/height`。透视场景没给时按 1920×1080。
       */
      size?: readonly [number, number];
      /**
       * 按指定尺寸画（dev 探针，`.claude/plans/wpe-import/3-scene/phase-render-size.md`，只对正交场景）：场景目标就是 `size`（超过设备上限时报错、
       * 不缩），样式做进正交投影的四个裁切边距（`edges`，`alignEdges`，照 WPE），`clear` 非空时主场景目标每帧清成它而不是 `clearcolor`
       * （对齐方式 1 / 3 的 `schemecolor`；`clearenabled` 仍决定清不清）。视差、`g_EyePosition`、抖动是场景单位，不受影响；
       * `g_Screen`、快照、泛光、反射、深度、fullscreen 合成 RT 随场景目标走。产品不传，字节不变；透视场景传了也忽略（本来就按 `size` 画）。
       */
      target?: { size: readonly [number, number]; edges: Edges; clear: readonly [number, number, number] | null };
      /** 加载进度（`progress.ts` 的 `gpu` 阶段）：着色器程序开建前报 `0 / 总数`，之后每建好（或失败）一个报一次。 */
      onProgress?: (done: number, total: number) => void;
      /**
       * 粒子序号（L4）：粒子层的随机种子是 `ParticleOptions.seed` + 它。L3a 起登记表是它的属主，宿主传 `registry.particleOrdinal`；不给时按
       * `bundle.layers` 里带 `particle` 的顺序数（之后装的对象接着往后数），和登记表的规则一致（dev 探针走这一条）。
       */
      particleOrdinal?: (object: number) => number;
    } = {},
  ): Promise<GpuScene> {
    if (options.texts) state.setTexts(options.texts);
    const reasons = checkRenderable(bundle, features, { ...options, texts: state.texts });
    if (reasons.length) throw new SceneRenderError(reasons);
    const scene = new GpuScene(
      device,
      bundle,
      warnings,
      options.particles ?? {},
      options.particleOrdinal ?? defaultParticleOrdinals(bundle),
    );
    scene.features = features;
    scene.relayouter = options.relayout ?? null;
    scene.userProvider = options.userTextures ?? null;
    scene.userWritten = state.userWritten;
    // 加载时（宿主排版期间）的图集重置不算：运行中重置了才连带重排
    for (const atlas of layoutAtlases(...state.texts.values())) scene.atlasResets.set(atlas, atlas.resets);
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let failure: unknown = null;
    try {
      await scene.populate(state, options.size, options.target, options.onProgress);
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
    // 必须在上面的错误作用域之外：`createShaderModule` 遇到坏 WGSL 会报校验错误，留在里面会让整场失败。这两步就是 `prepareObject` 的
    // 变体段与 `installObject` 的投射者段（L4），整场加载时在作用域之外逐对象跑，顺序同以前（变体在投射者之前）
    await scene.prepareVariants(state);
    await scene.buildShadowCasters(state);
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

  private createSceneTarget(
    label: string,
    extraUsage = 0,
    [width, height]: readonly [number, number] = [this.width, this.height],
  ): SceneTarget {
    const { format } = this;
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
  private createDepthTarget([width, height]: readonly [number, number] = [this.width, this.height]): {
    texture: GPUTexture;
    view: GPUTextureView;
  } {
    const texture = this.own(
      this.device.createTexture({
        label: "scene depth",
        size: { width, height },
        format: SCENE_DEPTH_FORMAT,
        // 有 sprite 时（P13c）计数 pass 把深度当纹理读；有体积光时（P13e）每盏灯把它转成 `r32float`
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          (this.bundle.layers.some((layer) => layer.sprite) || this.bundle.volumetrics
            ? GPUTextureUsage.TEXTURE_BINDING
            : 0),
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
    return this.sampler(samplerDescriptor(texture));
  }

  /**
   * `mesh`：网格步骤（P5c 步骤 2）的顶点布局；`cull`、`depth`：步骤的剔除与深度状态（P5d 步骤 1），见 `createPipeline`；键里只在出现时
   * 加后缀（`pipelineKey`）。`alphaToCoverage`：片元用程序的 A2C 入口（P8 步骤 5）。
   */
  private pipelineFor(
    program: GpuProgram,
    blending: string | null,
    format: GPUTextureFormat,
    alpha: PipelineSpec["alpha"],
    topology: PipelineSpec["topology"] = "triangle-strip",
    alphaMax = false,
    mesh?: MeshVertexLayout,
    cull?: PipelineSpec["cull"],
    depth?: PipelineSpec["depth"],
    alphaToCoverage?: PipelineSpec["alphaToCoverage"],
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
      alphaToCoverage,
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
        alphaToCoverage,
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
  private meshLayoutOf(layer: SceneLayer, step: MeshStep | PuppetDrawStep | TexchanDrawStep): MeshVertexLayout {
    // puppet 的上屏绘制（P12a 步骤 4）用网格 0 的格式，纹理通道绘制（P12b2-2）用通道网格的格式，其余是模型的网格
    const format =
      step.kind === "mesh"
        ? layer.model?.meshes[step.mesh]?.format
        : step.geometry === "texchan"
          ? layer.puppet?.textureChannels?.mesh.format
          : layer.puppet?.mesh.format;
    if (format === undefined)
      throw new SceneRenderError([step.kind === "mesh" ? `render:mesh:${step.mesh}` : "render:puppet"]);
    const program = step.pass.program === null ? undefined : this.bundle.programs[step.pass.program];
    // 预光照的 puppet 基础 pass（P13j-2）：`a_PositionC1` 读位置那一项（WPE 的那份网格里它是位置的拷贝）
    return meshVertexLayout(program?.attributes ?? [], format, isPrelitDraw(step));
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
    this.snapshot = this.createSnapshot([this.width, this.height]);
  }

  /** `_rt_FullFrameBuffer` 按 `dims` 建一张（建场景与 `resize` 共用）。 */
  private createSnapshot([width, height]: readonly [number, number]): RenderTarget {
    const { format } = this;
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
    return {
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
   * 只建不登记：调用方放进 `layerTargets`（L4：备对象时建、装的时候登记）。
   * `size`（P8 步骤 6）：文本层的尺寸来自排版（`textCompositeSize`），不走 `compositeSizeOf`，调用方给。
   */
  private createLayerTarget(layer: SceneLayer, size?: readonly [number, number]): RenderTarget {
    const baseTexture = this.baseTexture(layer);
    // 槽 0 的用户纹理有图时按它的尺寸（P11b 步骤 2）
    const [width, height] = size ?? this.compositeSizeOf(layer);
    const { clamp, nearest } = compositeSampling(layer, baseTexture);
    const address: GPUAddressMode = clamp ? "clamp-to-edge" : "repeat";
    const filter: GPUFilterMode = nearest ? "nearest" : "linear";
    return this.createTarget(
      layerCompositeName(layer.id),
      width,
      height,
      this.format,
      this.sampler({ addressModeU: address, addressModeV: address, magFilter: filter, minFilter: filter }),
    );
  }

  /**
   * 本图层的合成 RT 至少 `plan.composite.count` 张，不够就从共享池补。文本层的由本层独占（`ensureTextComposites`，P6b 1e）。
   * 被依赖的图层（P8 步骤 4）第 0 张是它的独占 RT（`own`，缺省取 `layerTargets`；备好还没装的对象由调用方给，L4），其余照旧从同键的池里借；
   * 之后的重建（effect 开关、`prepareVariants`）只往后补，第 0 张一直是它。
   */
  private ensureComposites(
    runtime: LayerHandle,
    plan: LayerPlan,
    own: RenderTarget | null | undefined = this.layerTargets.get(runtime.layer.object),
  ): void {
    if (!plan.composite) return;
    if (runtime.layer.text) {
      this.ensureTextComposites(runtime, plan.composite);
      return;
    }
    const { width, height, count } = plan.composite;
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
   * 被依赖的文本层（P8 步骤 6）第 0 张是它的独占 RT（`layerTargets`）：尺寸变了释放旧的、按新排版建新的（初值 0）登记回去，其余张照旧独占；
   * 引用方由调用方重绑（`syncTexts` → `rebindDependents`）。
   */
  private ensureTextComposites(
    runtime: LayerHandle,
    { width, height, count }: NonNullable<LayerPlan["composite"]>,
  ): void {
    const { composites } = runtime.resources;
    const own = this.resizeTextOwnTarget(runtime, [width, height]);
    if (composites.some((target) => target.width !== width || target.height !== height))
      for (const target of composites.splice(0)) if (target !== own) this.releaseTarget(target);
    if (own && composites[0] !== own) {
      for (const target of composites.splice(0)) if (target !== own) this.releaseTarget(target);
      composites.push(own);
    }
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

  /**
   * 被依赖文本层的独占 RT 按当前排版尺寸换新（P8 步骤 6，实测 `p8-deptext` 第 2、5 条：重排当帧换新 RT、初值全 0，空文字是 4×4）：
   * 尺寸相同什么都不做；不同则从本层合成 RT 列表里摘掉、释放旧的、建新的登记回 `layerTargets`。不是被依赖的层返回 undefined。
   */
  private resizeTextOwnTarget(runtime: LayerHandle, size: readonly [number, number]): RenderTarget | undefined {
    const object = runtime.layer.object;
    const own = this.layerTargets.get(object);
    if (!own || (own.width === size[0] && own.height === size[1])) return own;
    const { composites } = runtime.resources;
    const at = composites.indexOf(own);
    if (at >= 0) composites.splice(at, 1);
    this.releaseTarget(own);
    const fresh = this.createLayerTarget(runtime.layer, size);
    this.layerTargets.set(object, fresh);
    return fresh;
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
      `${layer.text ? "text" : "owned"} ${layer.id}|${effect}|${fbo.name}|${fw}x${fh}|${format}|${fbo.repeat}`,
      encoder,
    );
  }

  /**
   * 备对象时给文本层（与槽 0 有用户纹理的图层）建独占的 effect fbo（P6b 1e，已定 6）：全部 effect（关着的也建，同共享池的规则），每个 effect
   * 的每个名字一张，不和别的图层、也不和本层别的 effect 共用。返回的记录装的时候进 `textFbos`（L4），之后尺寸变了原地换。
   */
  private createTextFbos(
    layer: SceneLayer,
    size: readonly [number, number],
    encoder: GPUCommandEncoder,
  ): { maps: Map<string, number>[]; records: TextFbo[] } {
    const records: TextFbo[] = [];
    const maps = layer.effects.map(
      (effect, e) =>
        new Map(
          effect.fbos.map((fbo) => {
            const id = this.addTarget(this.createTextFbo(layer, e, fbo, size, encoder));
            records.push({ id, effect: e, fbo });
            return [fbo.name, id] as const;
          }),
        ),
    );
    return { maps, records };
  }

  /**
   * 从 fbo 共享池取一张（L4，原 `populate` 里的内联）：键是名字、尺寸、格式、寻址（unique 的按图层与 effect 独占），没有就建（创建后清成
   * `clear` 色，`createFbo`，清屏记进 `encoder`）；引用加一，键记进 `keys`（卸对象时逐个还，`releaseFbo`）。返回 `targets` 下标。
   */
  private acquireFbo(
    layer: SceneLayer,
    effect: SceneLayer["effects"][number],
    fbo: SceneFbo,
    size: readonly [number, number],
    encoder: GPUCommandEncoder,
    keys: string[],
  ): number {
    const [fw, fh] = fboSize(fbo, size);
    const fboFormat = fboFormatOf(fbo);
    const key = fbo.unique
      ? `unique|${layer.id}|${effect.id}|${fbo.name}`
      : `${fbo.name}|${fw}x${fh}|${fboFormat}|${fbo.repeat}`;
    let entry = this.fboPool.get(key);
    if (!entry) {
      // 创建后清成 `clear` 色（`createFbo`）
      const target = this.createFbo(fbo, [fw, fh], fboFormat, key, encoder);
      entry = { id: this.addTarget(target), refs: 0 };
      this.fboPool.set(key, entry);
    }
    entry.refs++;
    keys.push(key);
    return entry.id;
  }

  /** 还一次 fbo 共享池的引用（L4）：归零时释放那张 fbo、删键、下标进 `freeTargets`。 */
  private releaseFbo(key: string): void {
    const entry = this.fboPool.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.fboPool.delete(key);
    this.dropTarget(entry.id);
  }

  /** 一张 fbo 进 `targets`（L4）：先用放掉的下标，没有就追加（建场景时没有放掉的，下标同以前按建的先后）。 */
  private addTarget(target: RenderTarget): number {
    const id = this.freeTargets.pop() ?? this.targets.length;
    this.targets[id] = target;
    return id;
  }

  /** 释放 `targets` 里的一张并空出下标（L4）。没有运行时还指向它（卸对象、放弃备好的对象、池引用归零时才调）。 */
  private dropTarget(id: number): void {
    const target = this.targets[id];
    if (target) this.releaseTarget(target);
    delete this.targets[id];
    this.freeTargets.push(id);
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
    // 被依赖（P8 步骤 6）：独占 RT 按排版换尺寸（空文字是 4×4、不画），不随合成 RT 释放
    const own = layout
      ? this.resizeTextOwnTarget(runtime, textCompositeSize(layout))
      : this.layerTargets.get(runtime.object);
    if (!plan.composite)
      for (const target of resources.composites.splice(0)) if (target !== own) this.releaseTarget(target);
    if (layout) this.resizeTextFbos(runtime.object, textCompositeSize(layout));
  }

  /** 这个图层在当前开关下的计划：`planLayer` 的回调给 `layer.effects` 下标，状态按 scene.json 坐标（`source`）存。 */
  private planOf(layer: SceneLayer, state: SceneState): LayerPlan {
    return planLayer(
      // 脚本写过的材质状态字段（P6d1b）：基础材质与 effect 的 pass 取「bundle 值 + 覆盖」，没写过时就是原图层
      applyPassStates(layer, state.passStates),
      this.bundle.textures,
      (e) => state.effectEnabled(layer.object, layer.effects[e].source),
      state.texts.get(layer.object) ?? null,
      [this.width, this.height],
      this.userBaseOf(layer),
    );
  }

  /** 解析一个槽的用户纹理的裁切（不碰 GPU）：没有图、来源不是属性、RT 参考的槽还没生效（M8）时 null。 */
  private userCrop(slot: UserTextureSlot): UserTextureCrop | null {
    const provider = this.userProvider;
    if (!provider || !isDynamicSource(slot.source.kind)) return null;
    let reference: { width: number; height: number } | null;
    if (slot.keepAspect) reference = null;
    else if (slot.reference.kind === "size") reference = slot.reference;
    else {
      // 缺省是被依赖图层的合成 RT：参考尺寸取那张 RT（M3）；加载时属性就有值的不生效（M8，rea-p11b 5.2），第一次写入之后才生效
      if (!this.userWritten.has(slot.source.name)) return null;
      const target = this.layerTargets.get(slot.reference.object);
      if (!target) return null;
      reference = target;
    }
    return provider.crop(slot.source.name, reference);
  }

  /**
   * 用户纹理的 GPU 纹理：按 WPE 的纹理名缓存，第一次用到时建并上传（裁切写在拷贝的源矩形上，不读回）。尺寸超过设备上限、拷贝失败时记一条
   * warning（每个名字一次）、返回 null，槽用缺省纹理。
   */
  private userGpuOf(crop: UserTextureCrop): UserGpu | null {
    const { rect, image, key, animation, pad } = crop;
    const found = this.userGpu.get(key);
    if (found) {
      // GIF / 视频换了帧来源对象（值换过，WPE 从头开始）：旧的释放、按新的重建；同一个对象继续用
      if (found.animation === animation) return found;
      this.targetBytes -= found.width * found.height * 4;
      this.release(found.texture);
      this.userGpu.delete(key);
    }
    if (!image && !animation) return null;
    const limit = this.device.limits.maxTextureDimension2D;
    if (rect.width > limit || rect.height > limit) {
      this.warnUser(key, `用户纹理 ${key} 的尺寸 ${rect.width}×${rect.height} 超过设备上限 ${limit}，用缺省纹理`);
      return null;
    }
    const size = { width: rect.width, height: rect.height };
    // copyExternalImageToTexture 要求目标带 RENDER_ATTACHMENT；GIF 只用 writeTexture（TEXTURE_BINDING | COPY_DST），视频与静态图要它
    const usage =
      animation?.kind === "gif"
        ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
    const texture = this.own(this.device.createTexture({ label: `user ${key}`, size, format: "rgba8unorm", usage }));
    if (animation) {
      // 初始内容：GIF 是当前画布，视频没有（全 0，等第一次 `drawn` 交帧，同 WPE 的初始数据）
      const initial = animation.current();
      if (initial) this.uploadUserFrame(key, texture, rect, initial);
    } else if (image && pad) {
      // 快捷方式图标（P11d）：纹理是补透明边后的尺寸（`rect`），整张图标拷到 `pad` 偏移处，其余保持建纹理时的全 0（WebGPU 保证）；不带 gamma 表
      try {
        this.device.queue.copyExternalImageToTexture(
          { source: image.source },
          { texture, origin: { x: pad.x, y: pad.y }, premultipliedAlpha: false },
          { width: image.width, height: image.height },
        );
      } catch (error) {
        this.release(texture);
        this.warnUser(key, `用户纹理 ${key} 拷进纹理失败：${oneLine(String(error))}，用缺省纹理`);
        return null;
      }
    } else if (image) {
      let temp: GPUTexture | null = null;
      try {
        // 带 gamma 表（PNG `gAMA`）时先拷进同尺寸的临时纹理，再用 GPU 逐字节查表画进最终纹理（`render/userGamma.ts`）；不带表直接拷
        if (image.gamma)
          temp = this.device.createTexture({ label: `user ${key} gamma source`, size, format: "rgba8unorm", usage });
        this.device.queue.copyExternalImageToTexture(
          { source: image.source, origin: { x: rect.x, y: rect.y } },
          { texture: temp ?? texture, premultipliedAlpha: false },
          size,
        );
        if (temp && image.gamma) {
          this.gammaPass ??= createGammaPass(this.device);
          encodeGamma(this.device, this.gammaPass, image.gamma, temp, texture).destroy();
        }
      } catch (error) {
        this.release(texture);
        this.warnUser(key, `用户纹理 ${key} 拷进纹理失败：${oneLine(String(error))}，用缺省纹理`);
        return null;
      } finally {
        temp?.destroy();
      }
    }
    const gpu: UserGpu = { texture, view: texture.createView(), width: rect.width, height: rect.height, animation };
    this.userGpu.set(key, gpu);
    this.targetBytes += rect.width * rect.height * 4;
    return gpu;
  }

  /**
   * 把 GIF 的画布 / 视频的画面的 `rect` 一块传进用户纹理（P11b 步骤 4）：GIF 是 `writeTexture`（`offset` 指到裁切起点、行距取整张画布，
   * rea-p11b 2.1），视频是 `copyExternalImageToTexture`（源矩形起点 = `rect`，整像素）。画面装不下 `rect`、拷贝抛错时记一条 warning
   * （每个纹理名每种一次）、这一帧不更新，不让整帧失败。
   */
  private uploadUserFrame(key: string, texture: GPUTexture, rect: CropRect, frame: UserTextureFrame): void {
    const size = { width: rect.width, height: rect.height };
    if (frame.kind === "pixels") {
      this.device.queue.writeTexture(
        { texture },
        frame.data as Uint8Array<ArrayBuffer>,
        { offset: (rect.y * frame.width + rect.x) * 4, bytesPerRow: frame.width * 4, rowsPerImage: rect.height },
        size,
      );
      return;
    }
    const { displayWidth: videoWidth, displayHeight: videoHeight } = frame.frame;
    if (!videoWidth || !videoHeight) return;
    if (videoWidth < rect.x + rect.width || videoHeight < rect.y + rect.height) {
      this.warnUser(
        `${key}#size`,
        `用户视频 ${key} 的画面 ${videoWidth}×${videoHeight} 装不下裁切矩形 ${rect.width}×${rect.height}（起点 ${rect.x}, ${rect.y}），不更新`,
      );
      return;
    }
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: frame.frame, origin: { x: rect.x, y: rect.y } },
        { texture },
        size,
      );
    } catch (error) {
      this.warnUser(`${key}#copy`, `用户视频 ${key} 拷进纹理失败：${oneLine(String(error))}`);
    }
  }

  /** 一个 draw 的 GIF / 视频用户纹理：只看着色器真正绑定的槽，按纹理名去重；没有帧来源的（静态图、没图）不进。 */
  private userAnimationsOf(program: GpuProgram, inputs: Record<number, TextureRef>): UserAnim[] {
    const found = new Map<string, UserAnim>();
    for (const binding of program.textures) {
      const ref = inputs[binding.slot];
      if (ref?.kind !== "user") continue;
      const crop = this.userCrop(ref.slot);
      if (!crop?.animation || found.has(crop.key)) continue;
      const gpu = this.userGpuOf(crop);
      if (gpu) found.set(crop.key, { key: crop.key, animation: crop.animation, gpu, rect: crop.rect });
    }
    return [...found.values()];
  }

  /** 画到这个 draw 绑定的 GIF / 视频：每个纹理名问一次 `drawn()`，有新内容就上传（同一帧另一个 draw 再问时已经交出过，不重复）。 */
  private drawnUserAnimations(item: Draw): void {
    for (const { key, animation, gpu, rect } of item.userAnimations) {
      // 这张 GPU 纹理已被换掉（值换过）：等 `sync` 重绑，不往已释放的纹理上传
      if (this.userGpu.get(key) !== gpu) continue;
      const frame = animation.drawn();
      if (frame) this.uploadUserFrame(key, gpu.texture, rect, frame);
    }
  }

  private warnUser(key: string, message: string): void {
    if (this.userWarned.has(key)) return;
    this.userWarned.add(key);
    this.warnings.push(message);
  }

  /** 用户纹理的采样：线性或点（槽的 `nearest`）、寻址按槽的 `clamp`、1 级 mip、无各向异性（p11-REPORT「属性纹理」第 4 条）。 */
  private userSampler(slot: UserTextureSlot, forceNearest = false): GPUSampler {
    // 快捷方式图标（P11d，p11-REPORT「P11d 补测」）：寻址一律夹取、过滤一律线性，不看缺省纹理的标志位（缺省纹理 `util/clouds_256` 本来是重复寻址）
    const shortcut = slot.source.kind === "usershortcut";
    const address: GPUAddressMode = slot.clamp || shortcut ? "clamp-to-edge" : "repeat";
    // GIF 强制点采样（p11-REPORT M5，WPE 的 GIF 纹理不走线性）；视频与静态图按槽的 `nearest`
    const filter: GPUFilterMode = forceNearest || (slot.nearest && !shortcut) ? "nearest" : "linear";
    return this.sampler({
      addressModeU: address,
      addressModeV: address,
      magFilter: filter,
      minFilter: filter,
      mipmapFilter: "nearest",
      maxAnisotropy: 1,
    });
  }

  /** 一个用户引用此刻用的图（GPU 纹理与采样器）；没有图时 null，调用方用 `ref.fallback`。 */
  private resolveUser(ref: UserRef): UserResolved | null {
    const crop = this.userCrop(ref.slot);
    const gpu = crop ? this.userGpuOf(crop) : null;
    return gpu ? { gpu, sampler: this.userSampler(ref.slot, crop?.animation?.kind === "gif") } : null;
  }

  /** 图像层基础 pass 槽 0 此刻的用户纹理尺寸（`planLayer` 的 `userBase`）；没有图时 null。 */
  private userBaseOf(layer: SceneLayer): UserBase | null {
    const slot = baseUserSlot(layer);
    const crop = slot ? this.userCrop(slot) : null;
    if (!crop) return null;
    const { width, height } = crop.rect;
    return { width, height, textureWidth: width, textureHeight: height };
  }

  /**
   * 合成 RT 的尺寸（`compositeSize` + 槽 0 的用户纹理，P11b 步骤 2）：有图时取裁后尺寸（instanced、fullscreen 也是，rea-p11b 4.2），
   * 没有图时同以前。
   */
  private compositeSizeOf(layer: SceneLayer, sceneSize?: readonly [number, number]): [number, number] {
    const user = this.userBaseOf(layer);
    const sizing =
      user && Array.isArray(layer.fullscreenSize)
        ? { ...layer, fullscreenSize: [user.width, user.height] as [number, number] }
        : layer;
    return compositeSize(sizing, user ?? this.baseTexture(layer), sceneSize);
  }

  /**
   * 图层的合成 RT 与 effect fbo 由本层独占、按槽 0 的尺寸换（P11b 步骤 2）：文本层（排版尺寸）与基础 pass 槽 0 有用户纹理的图像层。
   * 后者的 fbo 在 `populate` 里就建成独占的（`createTextFbos`），换图后 `ensureUserSizing` 原地换尺寸。
   */
  private ownsSizing(layer: SceneLayer): boolean {
    return !!layer.text || baseUserSlot(layer) !== null;
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
      drawsMesh(step) ? this.meshLayoutOf(layer, step).key : undefined,
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
        const { blending, format, alpha, topology, alphaMax, cull, depth, alphaToCoverage } = this.pipelineOf(
          step,
          runtime,
        );
        const mesh = drawsMesh(step) ? this.meshLayoutOf(runtime.layer, step) : undefined;
        // 反射副本的管线（P13b2）：HDR 场景目标是 rgba16float，反射图是 rgba8unorm，名单里画到场景的步骤另建一份（其余键相同），
        // 编码时同步取（`reflectionPipeline`）。LDR 两者同格式，直接用主管线
        if (
          this.hdr &&
          this.reflected(runtime.layer.object) &&
          step.target.kind === "scene" &&
          runtime.layer.group == null
        )
          await this.pipelineFor(
            program,
            blending,
            REFLECTION_TARGET_FORMAT,
            alpha,
            topology,
            alphaMax,
            mesh,
            cull,
            depth,
            alphaToCoverage,
          );
        prepared.set(step, {
          program,
          pipeline: await this.pipelineFor(
            program,
            blending,
            format,
            alpha,
            topology,
            alphaMax,
            mesh,
            cull,
            depth,
            alphaToCoverage,
          ),
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
   * `preparedOf` 的同步建管线版（L7，结构变化的重排）：程序取 `readyPrograms`，管线取就绪表或当帧同步建（`prepareLayerNow`，含 HDR 反射副本），
   * 程序不在或管线建不出（A2C）时抛 `render:variant-missing`。
   */
  private preparedOfSync(plan: LayerPlan, runtime: LayerHandle): Map<DrawLike, PreparedDraw> {
    const prepared = this.prepareLayerNow(plan, runtime);
    if (!prepared) throw new SceneRenderError(["render:variant-missing"]);
    return prepared;
  }

  /**
   * 关着的 effect 也在加载时备好（WPE 同样）。逐图层进行（`prepareVariantsOf`，各开自己的错误作用域），失败不影响当前画面，这一层之后走整场
   * 重编译。整场加载时在 `build` 的错误作用域之外、全部对象装好之后跑（L4：单个对象的同一段在 `prepareObject` 里，装之前）。
   */
  private async prepareVariants(state: SceneState): Promise<void> {
    for (const runtime of this.layers) {
      const failure = await this.prepareVariantsOf(runtime, state);
      if (failure !== null) this.freezeVariants(runtime.layer, state, failure);
    }
  }

  /**
   * 一个图层的变体段（原 `prepareVariants` 的循环体）：`variantPlans` 的每份计划查问题、借合成 RT、建快照、查 copy / swap、备程序与管线，全在这一层
   * 自己的错误作用域里。文本层（P6b 1e）备的是运行中重排可能出现的全部步骤（`variantPlans` 的假想排版）：只备程序与管线，合成 RT 由本层按当时的
   * 排版尺寸建（`ensureTextComposites`），快照用到时 `buildLayer` 再建。备不好时运行中出现新步骤会报 `render:variant-missing`。
   * `own`：被依赖图层的独占 RT（缺省取 `layerTargets`；备好还没装的对象由 `prepareObject` 给）。返回失败的原因，成功为 null。
   */
  private async prepareVariantsOf(
    runtime: LayerHandle,
    state: SceneState,
    own: RenderTarget | null | undefined = this.layerTargets.get(runtime.layer.object),
  ): Promise<string | null> {
    const { layer } = runtime;
    const text = layer.text ? (state.texts.get(layer.object) ?? null) : null;
    const plans = variantPlans(layer, this.bundle.textures, text, [this.width, this.height]);
    if (!plans.length) return null;
    this.device.pushErrorScope("out-of-memory");
    this.device.pushErrorScope("validation");
    let failure: unknown = null;
    try {
      for (const plan of plans) {
        const problems = planProblems(plan, this.bundle, layer.particle, layer.model, layer.puppet);
        if (problems.length) throw new SceneRenderError(problems);
        if (layer.text) {
          await this.prepareLayer(plan, runtime);
          continue;
        }
        this.ensureComposites(runtime, plan, own);
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
    return failure || error ? String(failure ?? error!.message) : null;
  }

  /** 变体段没备好（`prepareVariantsOf` 的失败）：冻结这一层（切换都走整场重编译）并记 warning。 */
  private freezeVariants(layer: SceneLayer, state: SceneState, failure: string): void {
    state.freezeLayer(layer.object);
    this.warnings.push(
      layer.text
        ? `文本图层 ${layer.object} 的步骤备不好，运行中重排出现新步骤时画不了：${failure}`
        : `图层 ${layer.object} 的可变 effect 备不好，切换时整场重新加载：${failure}`,
    );
  }

  /**
   * 单个对象的变体段排成一串（L4）：各段自己 push / pop 错误作用域，几段并行时 pop 会弹到别的段的作用域。整场加载不经过这里（`prepareVariants`
   * 本来就是逐层 await）。
   */
  private serialVariants(task: () => Promise<string | null>): Promise<string | null> {
    const run = this.variantChain.then(task, task);
    this.variantChain = run.catch(() => undefined);
    return run;
  }

  /** copy / swap / clear / subtree 的检查：切换时不能再失败，所以 `prepareVariants` 对每份计划先过一遍。 */
  private checkPlanOps(plan: LayerPlan, { layer, resources }: LayerHandle): void {
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
    /**
     * 沿用的粒子树（L6，`installCore` 替换同一对象且粒子定义相同时给）：模拟器（粒子、计时、脚本控制、事件实例）与控制点输入照旧，只换成新图层与
     * 新资源、模板与 draw 重建；不给时新建并预热（`createParticleTree`）。
     */
    reuse: ParticleTree | null = null,
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
      const tree = reuse
        ? { ...reuse, layer, resources, templates: new Map<string, ParticleTemplate>() }
        : this.createParticleTree(layer, resources, state);
      if (tree.framebuffer) this.ensureSnapshot();
      for (const step of steps) {
        // 同一系统的各 renderer 步骤（P4f 步骤 4）在计划里连着、同一个模板路径，收进同一个模板
        const path = step.node.join("/");
        let template = tree.templates.get(path);
        if (!template) {
          template = { node: step.node, instanced: step.instanced, renderers: [], pool: [] };
          tree.templates.set(path, template);
        }
        const entry = { step, prepared: prepared.get(step)! };
        template.renderers.push(entry);
        // 顶层与 static 子孙每帧恰好一次：建场景时建好第 0 组（顺序同 P4e 步骤 1 的先序，一个系统的各 renderer 连着）；事件实例下的
        // 模板第一次用到时整组建
        if (step.instanced) continue;
        const system = tree.system.node(step.node);
        if (!system) throw new SceneRenderError([`render:particle-node:${path}`]);
        const draw = this.createDraw(layer, step, resources, entry.prepared, state, worlds, system);
        (template.pool[0] ??= []).push(draw);
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
    // puppet 的裁切模板（P12f）：同一图层的普通 / 遮罩 / 目标模板收成一个 `puppet-clip` op（位置放在第一个模板的地方），遮罩 RT 的清除由 op 编码时做
    let clipOp: Extract<Op, { kind: "puppet-clip" }> | null = null;
    for (const step of plan.steps) {
      if (step.kind === "clear" && step.clipRecord !== undefined) continue;
      if (step.kind === "draw" && step.clipSlot !== undefined) {
        const draw = this.createDraw(layer, step, resources, prepared.get(step)!, state, worlds);
        draws.push(draw);
        if (!clipOp) {
          clipOp = { kind: "puppet-clip", layer, resources, normals: [], masks: [], targets: [] };
          ops.push(clipOp);
        }
        const slot = step.clipSlot;
        if (slot.kind === "normal") clipOp.normals[slot.slot] = draw;
        else if (slot.kind === "mask") clipOp.masks[slot.record] = draw;
        else clipOp.targets[slot.record] = draw;
        continue;
      }
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
    // 与 `runtime.draws` 同一个数组：之后按需建的实例化 draw（`addPooledGroup`）追加一次两边都有
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

  /**
   * 一个图层的 puppet 资源（P12b1 步骤 4、5；L4 起按图层，原来是建场景时全部一次）：
   * - 带 `morph` 的 puppet 一张变形纹理（`side × side`，`rgba32float`，点采样、重复，WPE 实测）；设备没有 `float32-filterable` 时抛
   *   `render:morph-texture`（`checkRenderable` 已先按特性报过）；模型对象（P12b2-1）每个有变形目标的网格一张。返回给调用方，装的时候进
   *   `morphTargets`（`morph` 引用只指向本对象自己）。
   * - 有裁切的 puppet 第一次遇到时建全场一张 `r8unorm` 遮罩 RT（宽高各为场景目标的一半，至少 2；WPE 是后备缓冲的一半，我们的对应物是场景
   *   目标），之后共用、随场景销毁。
   */
  private ensurePuppetResources(layer: SceneLayer): Map<string, RenderTarget> {
    const morphs = new Map<string, RenderTarget>();
    const morph = layer.puppet?.morph;
    const meshes = layer.model?.skeleton?.morphs ?? [];
    // 先查特性，什么都没建时抛
    if ((morph || meshes.some(Boolean)) && !this.features.has("float32-filterable"))
      throw new SceneRenderError(["render:morph-texture"]);
    if (morph) morphs.set(morphKey(layer.object), this.uploadMorph(layer, morph));
    meshes.forEach((item, m) => {
      if (item) morphs.set(morphKey(layer.object, m), this.uploadMorph(layer, item, m));
    });
    if (layer.puppet?.clipping && !this.clipMask) this.clipMask = this.createClipMask([this.width, this.height]);
    return morphs;
  }

  /** puppet 裁切遮罩 RT：场景目标一半大（`clipMaskSize`），建场景与 `resize` 共用。 */
  private createClipMask([sceneWidth, sceneHeight]: readonly [number, number]): RenderTarget {
    const [width, height] = clipMaskSize(sceneWidth, sceneHeight);
    return this.createTarget(
      "clip mask",
      width,
      height,
      "r8unorm",
      this.sampler({
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
      }),
    );
  }

  /** 一个 puppet（或模型网格 `mesh`）的变形纹理上传（`morphTexelData` 转好数据，`writeTexture` 一次）。 */
  private uploadMorph(
    layer: SceneLayer,
    morph: Pick<NonNullable<ScenePuppetLayer["morph"]>, "side" | "texels">,
    mesh?: number,
  ): RenderTarget {
    const { device } = this;
    const side = morph.side;
    const texture = this.own(
      device.createTexture({
        label: `morph ${layer.object}${mesh === undefined ? "" : ` mesh ${mesh}`}`,
        size: { width: side, height: side },
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
    const data = morphTexelData(morph.texels);
    device.queue.writeTexture(
      { texture },
      data.buffer as ArrayBuffer,
      { offset: data.byteOffset, bytesPerRow: side * 16, rowsPerImage: side },
      { width: side, height: side },
    );
    this.targetBytes += side * side * 16;
    return {
      texture,
      view: texture.createView(),
      width: side,
      height: side,
      format: "rgba32float",
      // WPE 点采样、重复（p12b 步骤 0b 实测）
      sampler: this.sampler({
        addressModeU: "repeat",
        addressModeV: "repeat",
        magFilter: "nearest",
        minFilter: "nearest",
      }),
    };
  }

  /**
   * 场景目标的尺寸与「按指定尺寸画」的参数（建场景与 `resize` 共用，保证「建在 B」和「换到 B」同一份规则）：
   * 正交场景给了 `target`（`edges` 非空）时场景目标 = 指定尺寸，超设备上限直接报错、不缩（缩了就不是指定的尺寸）；透视场景按画布尺寸
   * `size`（P5d 步骤 2，钳设备上限）；正交场景没有 `target`（或 `edges` 为 null）时按场景尺寸。
   */
  private targetPlan(
    size: readonly [number, number] | undefined,
    target:
      | { size: readonly [number, number]; edges: Edges | null; clear: readonly [number, number, number] | null }
      | undefined,
  ): {
    dims: [number, number];
    sized: { size: readonly [number, number]; edges: Edges; clear: readonly [number, number, number] | null } | null;
  } {
    const { device, bundle } = this;
    const { general } = bundle;
    const max = device.limits.maxTextureDimension2D;
    const sized = !general.perspective && target && target.edges ? { ...target, edges: target.edges } : null;
    if (sized && (sized.size[0] > max || sized.size[1] > max))
      throw new SceneRenderError([`render:target-size:${sized.size[0]}x${sized.size[1]}>${max}`]);
    const dims: [number, number] = sized
      ? [sized.size[0], sized.size[1]]
      : general.perspective
        ? sceneTargetSize(size?.[0] ?? 1920, size?.[1] ?? 1080, max)
        : sceneTargetSize(general.width, general.height, max);
    return { dims, sized };
  }

  private async populate(
    state: SceneState,
    size?: readonly [number, number],
    target?: { size: readonly [number, number]; edges: Edges; clear: readonly [number, number, number] | null },
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const { device, bundle } = this;
    const { general } = bundle;
    const plan = this.targetPlan(size, target);
    const { sized } = plan;
    if (sized) {
      this.crop = { edges: sized.edges, window: [sized.size[0], sized.size[1]] };
      this.targetClear = sized.clear;
    }
    const [width, height] = plan.dims;
    const hdr = (this.hdr = general.postprocess.hdr);
    const format = (this.format = sceneTargetFormat(hdr));
    this.width = width;
    this.height = height;
    this.view.eye = eyePosition(general);
    this.current = this.createSceneTarget("scene target");
    // 两张都是空的：不清屏时初始底色就是黑，`clearcolor` 不出现（L11）
    if (general.clearVariable) this.alternate = this.createAlternateTarget();

    // 纹理（L4）：场景级先传现有的全部（规则同 `uploadableTextures`），之后对象带来的新纹理在备对象时追加（`ensureTextures`）
    this.ensureTextures(0);
    this.dummies = this.createDummies();
    // 反射的两张常量 RT（P13b1）：场景目标尺寸，只在有读者时建；要在建任何 draw 之前就位（`resolveTexture`）
    this.reflectionTargets = ReflectionTargets.create(device, bundle, width, height, hdr);
    if (this.reflectionTargets) this.targetBytes += this.reflectionTargets.bytes;
    // 图集尺寸按加载时的灯记录打包（P13f2：灯是运行时状态，之后条目变多时只画放得下的视口，同 P13d）
    this.shadowAtlas = ShadowAtlas.create(device, bundle, lightRecords(bundle.lightObjects ?? [], state, new Map()));
    this.lightState = state;
    if (bundle.legacyLights) this.legacyNext = this.legacyFrame(state);
    if (this.shadowAtlas) this.targetBytes += this.shadowAtlas.width * this.shadowAtlas.height * 4;
    this.atlasTextures = new TextAtlasTextures(
      device,
      this.sampler(ATLAS_SAMPLER),
      (resource) => this.own(resource),
      (resource) => this.release(resource),
    );

    const built = buildableLayers(bundle);
    // 场景级的派生表（L4：不再在构造函数里从 bundle 算死）：全部图层（含没有资源的分组节点：组的尺寸、`copyBackground` 与层数从这里查，
    // 子层可能排在组前面装）、平面反射名单。之后随装卸维护（`installObject` / `removeObject`、`sync` 按结构代数刷名单）
    for (const layer of bundle.layers) this.layerByObject.set(layer.object, layer);
    this.syncReflectionList(state, true);
    // 挂点（P12b1 步骤 3）：全部图层（没有资源的分组节点也会挂在骨骼上，子孙的世界矩阵沿父链要经它）在建任何 draw 之前就位；之后装的对象
    // 自己补（`installObject`）。puppet 的变形纹理与裁切遮罩 RT（P12b1 步骤 4、5）改在备对象时建（`ensurePuppetResources`），同样早于任何 draw
    for (const layer of bundle.layers) if (layer.attachment) this.attachments.set(layer.object, layer.attachment);
    if (this.attachments.size) this.stamps = new WorldStamps();
    const plans = built.map((layer) => this.planOf(layer, state));
    // 深度附件（P5d 步骤 1）：按全部可能用到的计划判定（加载时的计划与预建的变体），要在建任何管线之前定下来，管线的深度状态跟着它。
    // 脚本拿得到材质对象（用到 `getEffect`，P6d1b）时也建：运行中可能写 `depthtest = 'enabled'`，WPE 的场景目标恒有深度缓冲；
    // 加载时没有一个 pass 测深度，比较恒为 always、不写深度（`rasterState` 的写要先测），画面不变
    if (
      bundle.scripts.usesEffectAccess ||
      bundle.volumetrics !== undefined ||
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
    if (bundle.volumetrics) {
      const { lights, blurH, blurV, combine } = bundle.volumetrics;
      for (const pass of [
        ...lights.flatMap((light) => [light.back, light.front, light.fullscreen]),
        blurH,
        blurV,
        combine,
      ])
        if (pass && pass.program !== null) used.add(pass.program);
    }
    let programsBuilt = 0;
    onProgress?.(0, used.size);
    const settled = await Promise.allSettled(
      [...used].map((index) => this.ensureProgram(index).finally(() => onProgress?.(++programsBuilt, used.size))),
    );
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
    // 组合层运行中挂上子层变成组时要的程序（L7，`groupPrograms`）：不在加载时的计划里，另外备好，重排时管线才能当帧同步建。备不好不让场景退回
    // （真变成组时重排失败、整场重载，那时按组编译、照常报）
    const spare = new Set(built.flatMap((layer) => groupPrograms(layer)).filter((index) => !used.has(index)));
    await Promise.allSettled([...spare].map((index) => this.ensureProgram(index)));

    const setup = device.createCommandEncoder({ label: "scene setup" });
    // 建场景时 s 是 (0, 0)：两份相同，`setCamera` 换成带抖动的。缩放取编译期的值（P5a 步骤 4），预热的指针反投影就带上它
    this.zoom = this.pointerZoom = general.fields.zoom;
    const sceneProjection = sceneViewProjection(general, this.zoom, this.crop?.edges);
    this.view.viewProjection = this.baseViewProjection = sceneProjection;
    this.view.sceneCamera = { projection: sceneProjection, view: identity() };
    this.view.perspectiveViewProjection = this.basePerspectiveViewProjection = particleViewProjection(
      general,
      this.zoom,
      undefined,
      this.crop ?? undefined,
    );
    // 透视场景（P5d 步骤 2）：建场景时取加载时的相机（路径从头、g_Time 0），渲染器第一帧就用 `setCamera` 换成当帧的；预热的指针
    // 反投影用它。透视粒子那一份（`perspectiveViewProjection`）照旧（透视场景里的透视粒子照报 `camera:perspective:particle`）
    if (general.perspective)
      this.applyPerspective(initialPerspectiveFrame(general.camera, state.general, width, height));
    // 粒子的索引缓冲：全场一份，按最大的 maxcount 建（含子系统的，每个粒子步骤按它画的那个系统，P4e 步骤 1）；之后装的对象要的更多时
    // 才重建（`ensureParticleIndices`），整场加载时一次建够
    const particleCapacity = Math.max(-1, ...built.map((layer, index) => this.particleCapacityOf(layer, plans[index])));
    if (particleCapacity >= 0) this.ensureParticleIndices(particleCapacity);

    // 逐对象备好（L4，`prepareObject` 的主段 `prepareMain`）：并行。各对象的同步一段（变形纹理、fbo 取引用 / 建、被依赖层的独占 RT，fbo 的
    // 清屏记进 `setup`）在 `map` 里按图层顺序跑完，之后才开始等管线；程序上面已经全部建好，这里只命中缓存
    const prepared = await Promise.all(
      built.map((layer, index) => this.prepareMain(layer, state, plans[index], setup)),
    );
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
        own: (resource) => {
          this.bloomOwned.add(resource);
          return this.own(resource);
        },
      });
      this.bloom = chain;
      this.targetBytes += chain.bytes;
    }
    // 体积光（P13e）：场景目标、深度、阴影图集都已就位
    if (bundle.volumetrics && this.depthTarget) {
      this.volumetrics = await VolumetricsRenderer.create({
        device,
        volumetrics: bundle.volumetrics,
        programs,
        width,
        height,
        hdr,
        sceneFormat: format,
        depth: this.depthTarget.texture,
        shadowAtlas: this.shadowAtlas ? { view: this.shadowAtlas.view, sampler: this.shadowAtlas.sampler } : null,
        own: (resource) => {
          this.volumetricsOwned.add(resource);
          return this.own(resource);
        },
      });
      this.targetBytes += this.volumetrics.bytes;
    }
    // 被依赖图层的独占 RT（P8 步骤 4）：在任何 `buildLayer` 之前进表，引用方排在被依赖者前面时建 draw 也解析得到（`resolveTexture`）
    for (const item of prepared) if (item.layerTarget) this.layerTargets.set(item.layer.object, item.layerTarget);
    // 按图层顺序装上（L4，`installObject` 的主段 `installCore`）；世界矩阵按这一刻的状态算，全部图层共用一份缓存
    const worlds = new Map<number, Mat4>();
    for (const item of prepared) {
      this.claim(item);
      this.installCore(item, state, worlds);
    }
    device.queue.submit([setup.finish()]);
  }

  /**
   * 场景纹理按增量上传（L4）：`bundle.textures[from…]` 里可上传的传上去、其余留 null（规则同 `uploadableTextures`，按下标区间算）。
   * 建场景时 `from` 为 0；登记表追加了纹理（`SceneRegistry.applyDelta`）之后，备对象时从已有的个数接着传。
   * 给了 `layer` 时再补传它要用、之前没传的（建场景时只被「关着且带不支持项」的 effect 用到的纹理，被新对象用到；或场景从空的图层表起步）：
   * 整场加载时这一项是空操作（`uploadableTextures` 对全部图层取并集，单个图层的是它的子集）。
   */
  private ensureTextures(from: number, layer?: SceneLayer): void {
    const { bundle } = this;
    if (from < bundle.textures.length) {
      const uploadable = uploadableTextures(bundle);
      for (let index = from; index < bundle.textures.length; index++)
        this.textures[index] = uploadable.has(index) ? this.uploadAt(index) : null;
    }
    if (!layer) return;
    for (const index of uploadableTextures({ layers: [layer] }))
      if (!this.textures[index] && bundle.textures[index]) this.textures[index] = this.uploadAt(index);
  }

  /** 上传第 `index` 张场景纹理；多图像帧表（P6e 点 4）的其余图像各上传一张，记进 `extraTextures`，都由 `own` 随场景释放。 */
  private uploadAt(index: number): GPUTexture {
    const texture = this.bundle.textures[index];
    const extra = texture.images;
    if (extra?.length)
      this.extraTextures.set(
        index,
        extra.map((mips) => this.own(uploadTexture(this.device, { ...texture, mips, images: undefined }))),
      );
    return this.own(uploadTexture(this.device, texture));
  }

  /**
   * 平面反射名单按结构代数从活的 `bundle.reflection.list` 刷新（L4；登记表原地维护那个数组）：建场景时强制刷一次，`sync` 开头与备对象时代数变了
   * 再刷。没开平面反射时恒为 null（反射 pass 不存在，只清屏）。
   */
  private syncReflectionList(state: Pick<SceneState, "structureVersion">, force = false): void {
    if (!force && state.structureVersion === this.reflectionSeen) return;
    this.reflectionSeen = state.structureVersion;
    const reflection = this.bundle.reflection;
    this.reflectionSet = reflection?.planar && reflection.enabled ? new Set(reflection.list ?? []) : null;
  }

  /** 对象在平面反射名单里（P13b2）。 */
  private reflected(object: number): boolean {
    return this.reflectionSet?.has(object) ?? false;
  }

  /** 一份计划里粒子步骤要的最大 `maxcount`（含子系统，每个步骤按它画的那个系统，P4e 步骤 1）；没有粒子步骤为 -1。 */
  private particleCapacityOf(layer: SceneLayer, plan: LayerPlan): number {
    const particle = layer.particle;
    let max = -1;
    if (particle)
      for (const step of plan.steps)
        if (step.kind === "particles") max = Math.max(max, particleNode(particle, step.node).maxcount);
    return max;
  }

  /**
   * 备对象的同步一段（L4，不 await，不碰正在画的东西）：新纹理、变形纹理（与第一次用到的裁切遮罩）、fbo（池化的取引用、独占的建；fbo 一律按真实
   * 合成尺寸：全部 effect 关着时也是，打开时不用重建。文本层取排版的合成 RT 尺寸，P6b 1d；槽 0 有用户纹理的图像层同样独占，P11b 步骤 2）、
   * 被依赖层的独占 RT（P8 步骤 4）。新建 fbo 的清屏记进 `encoder`。中途抛错时收回这一段已经建的。
   */
  private stageObject(
    layer: SceneLayer,
    state: SceneState,
    plan: LayerPlan,
    encoder: GPUCommandEncoder,
  ): PreparedObject {
    this.ensureTextures(this.textures.length, layer);
    const morphs = this.ensurePuppetResources(layer);
    const fboKeys: string[] = [];
    let textFbos: TextFbo[] | null = null;
    let layerTarget: RenderTarget | null = null;
    try {
      const textLayout = layer.text ? state.texts.get(layer.object) : undefined;
      const size = textLayout ? textCompositeSize(textLayout) : this.compositeSizeOf(layer, [this.width, this.height]);
      let maps: Map<string, number>[];
      if (this.ownsSizing(layer)) ({ maps, records: textFbos } = this.createTextFbos(layer, size, encoder));
      else
        maps = layer.effects.map(
          (effect) =>
            new Map(
              effect.fbos.map(
                (fbo) => [fbo.name, this.acquireFbo(layer, effect, fbo, size, encoder, fboKeys)] as const,
              ),
            ),
        );
      if (layer.dependedOn)
        layerTarget = this.createLayerTarget(
          layer,
          // 文本层的独占 RT 取排版的尺寸（P8 步骤 6，空排版得 4×4）
          layer.text ? textCompositeSize(textLayout ?? { compositeSize: [1, 1] }) : undefined,
        );
      return {
        layer,
        plan,
        prepared: new Map(),
        resources: { composites: [], fbos: new FboBindings(maps), ...this.textAtlasesOf(textLayout) },
        fboKeys,
        textFbos,
        layerTarget,
        morphs,
        variants: undefined,
        shadows: null,
        owner: this,
        settled: false,
      };
    } catch (error) {
      for (const key of fboKeys) this.releaseFbo(key);
      for (const record of textFbos ?? []) this.dropTarget(record.id);
      if (layerTarget) this.releaseTarget(layerTarget);
      for (const target of morphs.values()) this.releaseTarget(target);
      throw error;
    }
  }

  /**
   * 备对象的主段（L4）：同步一段（`stageObject`）+ 计划的程序与管线（`prepareLayer`）。整场加载并行调它（变体与投射者在 `build` 里另跑），
   * `prepareObject` 在它之后接变体段与投射者。失败时收回自己建的。
   */
  private async prepareMain(
    layer: SceneLayer,
    state: SceneState,
    plan: LayerPlan,
    encoder: GPUCommandEncoder,
  ): Promise<PreparedObject> {
    const staged = this.stageObject(layer, state, plan, encoder);
    try {
      return { ...staged, prepared: await this.prepareLayer(plan, staged) };
    } catch (error) {
      this.discardPrepared(staged);
      throw error;
    }
  }

  /**
   * 备好一个对象（L4，异步，不改正在画的东西）：计划（自查同 `rebuildLayer`）→ 新纹理 → 变形纹理 → fbo（取引用）与被依赖层的独占 RT →
   * 程序与管线（含 HDR 反射副本）→ 变体段（`prepareVariantsOf`，自己的错误作用域，单个对象之间排成一串；失败不抛，装的时候冻结这一层）→
   * 阴影投射者的程序与管线。fbo 的清屏当场提交（只清新建的）。失败时只收回自己建的，抛 `SceneRenderError`。
   * 计划按调用这一刻的状态定：备好之后、装之前状态里的 effect 开关又变了时，装上后由 `sync` 照常重建。
   */
  async prepareObject(layer: SceneLayer, state: SceneState): Promise<PreparedObject> {
    this.syncReflectionList(state);
    const plan = this.planOf(layer, state);
    const problems = planProblems(plan, this.bundle, layer.particle, layer.model, layer.puppet);
    if (problems.length) throw new SceneRenderError(problems);
    const encoder = this.device.createCommandEncoder({ label: `prepare object ${layer.object}` });
    const staged = this.stageObject(layer, state, plan, encoder);
    this.device.queue.submit([encoder.finish()]);
    try {
      const prepared = await this.prepareLayer(plan, staged);
      const variants = await this.serialVariants(() => this.prepareVariantsOf(staged, state, staged.layerTarget));
      const shadows = await this.prepareShadowCasters(layer);
      // 组合层运行中变成组时要的程序（L7，同 `populate`）：备不好不算失败
      await Promise.allSettled(groupPrograms(layer).map((index) => this.ensureProgram(index)));
      return { ...staged, prepared, variants, shadows };
    } catch (error) {
      this.discardPrepared(staged);
      throw error instanceof SceneRenderError
        ? error
        : new SceneRenderError([`webgpu:prepare:${oneLine(String(error))}`]);
    }
  }

  /**
   * 程序与管线都已就绪时不经 await 备好（L4，克隆命中缓存）：先查主计划、变体计划与投射者要的程序都在 `readyPrograms` 里，缺一个就返回 null、
   * 什么都不建（调用方走 `prepareObject`）。管线查 `readyPipelines`，缺的同步建（`createPipelineNow`，当帧生效，同 WPE）；A2C 管线要异步建的
   * 片元模块，缺时同样返回 null（收回已建的）。变体段没有错误作用域（同步路径 pop 不了），只认得出计划问题与 copy / swap 的检查。
   */
  prepareObjectSync(layer: SceneLayer, state: SceneState): PreparedObject | null {
    this.syncReflectionList(state);
    const plan = this.planOf(layer, state);
    const problems = planProblems(plan, this.bundle, layer.particle, layer.model, layer.puppet);
    if (problems.length) throw new SceneRenderError(problems);
    const text = layer.text ? (state.texts.get(layer.object) ?? null) : null;
    const variants = variantPlans(layer, this.bundle.textures, text, [this.width, this.height]);
    const shadowSteps = this.shadowCasterSteps(layer);
    const programs = new Set<number>();
    for (const item of [plan, ...variants])
      for (const step of item.steps)
        if (isDrawLike(step) && step.pass.program !== null) programs.add(step.pass.program);
    for (const { step } of shadowSteps) programs.add(step.pass.program!);
    for (const index of programs) if (!this.readyPrograms.has(index)) return null;
    // 组合层运行中变成组时要的程序（L7，同 `populate`）：不挡同步装，没备好的后台备（备不好不算失败）
    for (const index of groupPrograms(layer))
      if (!this.readyPrograms.has(index)) void this.ensureProgram(index).catch(() => {});
    const encoder = this.device.createCommandEncoder({ label: `prepare object ${layer.object}` });
    const staged = this.stageObject(layer, state, plan, encoder);
    this.device.queue.submit([encoder.finish()]);
    try {
      const prepared = this.prepareLayerNow(plan, staged);
      const variantResult = prepared ? this.prepareVariantsNow(staged, variants) : null;
      const shadows = variantResult ? this.prepareShadowCastersNow(shadowSteps) : null;
      if (!prepared || !variantResult || !shadows) {
        this.discardPrepared(staged);
        return null;
      }
      return { ...staged, prepared, variants: variantResult.failure, shadows };
    } catch (error) {
      this.discardPrepared(staged);
      throw error instanceof SceneRenderError
        ? error
        : new SceneRenderError([`webgpu:prepare:${oneLine(String(error))}`]);
    }
  }

  /** `prepareLayer` 的同步版（L4，`prepareObjectSync`）：程序取 `readyPrograms`，管线取 `readyPipelines` 或同步建；缺程序或建不了时 null。 */
  private prepareLayerNow(plan: LayerPlan, runtime: LayerHandle): Map<DrawLike, PreparedDraw> | null {
    const prepared = new Map<DrawLike, PreparedDraw>();
    for (const step of plan.steps) {
      if (!isDrawLike(step)) continue;
      const program = this.readyPrograms.get(step.pass.program!);
      if (!program) return null;
      const spec = this.pipelineOf(step, runtime);
      const mesh = drawsMesh(step) ? this.meshLayoutOf(runtime.layer, step) : undefined;
      // 反射副本的管线（同 `prepareLayer`）
      if (
        this.hdr &&
        this.reflected(runtime.layer.object) &&
        step.target.kind === "scene" &&
        runtime.layer.group == null &&
        !this.pipelineNow(program, { ...spec, format: REFLECTION_TARGET_FORMAT }, mesh)
      )
        return null;
      const pipeline = this.pipelineNow(program, spec, mesh);
      if (!pipeline) return null;
      prepared.set(step, { program, pipeline });
    }
    return prepared;
  }

  /**
   * 变体段的同步版（L4，`prepareObjectSync`）：步骤同 `prepareVariantsOf`，只是没有错误作用域。计划问题、copy / swap 检查失败记进 `failure`（装的时候
   * 冻结），缺程序或建不了管线时返回 null。L7 起结构变化后的重排也用它（传装好的运行时与它的独占 RT）。
   */
  private prepareVariantsNow(
    staged: LayerHandle & Pick<PreparedObject, "layerTarget">,
    plans: readonly LayerPlan[],
  ): { failure: string | null } | null {
    const { layer } = staged;
    for (const plan of plans) {
      let ready: Map<DrawLike, PreparedDraw> | null;
      try {
        const problems = planProblems(plan, this.bundle, layer.particle, layer.model, layer.puppet);
        if (problems.length) throw new SceneRenderError(problems);
        if (!layer.text) {
          this.ensureComposites(staged, plan, staged.layerTarget);
          if (wantsSnapshot(plan)) this.ensureSnapshot();
          this.checkPlanOps(plan, staged);
        }
        ready = this.prepareLayerNow(plan, staged);
      } catch (error) {
        return { failure: String(error) };
      }
      if (!ready) return null;
    }
    return { failure: null };
  }

  /** 一条管线：就绪表里有就用，没有就同步建（`createPipelineNow`）；建不了时 null。 */
  private pipelineNow(program: GpuProgram, spec: PipelineSpec, mesh?: MeshVertexLayout): GPURenderPipeline | null {
    return this.readyPipelines.get(pipelineKey(spec)) ?? this.createPipelineNow(program, spec, mesh);
  }

  /**
   * 同步建一条管线（L4，`prepareObjectSync` 缺管线时，已定：当帧生效，同 WPE）：描述仍由 `createPipeline` 给（不另写一份），用 `capturePipeline`
   * 接住它交给同步的 `createRenderPipeline`。A2C 的片元模块是异步建的，建不了，返回 null。建好的进 `pipelines` 与 `readyPipelines`。
   */
  private createPipelineNow(
    program: GpuProgram,
    spec: PipelineSpec,
    mesh?: MeshVertexLayout,
  ): GPURenderPipeline | null {
    if (spec.alphaToCoverage) return null;
    const made = this.capturePipeline((device) =>
      createPipeline(
        device,
        program,
        spec.blending,
        spec.format,
        spec.alpha,
        spec.topology,
        spec.alphaMax ?? false,
        mesh?.buffers,
        spec.cull,
        spec.depth,
        false,
      ),
    );
    if (!made) return null;
    const key = pipelineKey(spec);
    this.pipelines.set(key, made.promise);
    this.readyPipelines.set(key, made.pipeline);
    return made.pipeline;
  }

  /**
   * 把一个「建管线」的异步函数变成同步的（L4）：`createPipeline` / `createShadowPipeline` 不带 A2C 时在第一个 await 之前就调到
   * `device.createRenderPipelineAsync`，这里给它一个只有这个方法的设备替身，当场改调同步的 `createRenderPipeline` 并记下结果。没在同步段里调到
   * （带 A2C、或实现改了）时返回 null，调用方退回异步路径。
   */
  private capturePipeline(
    build: (device: GPUDevice) => Promise<GPURenderPipeline>,
  ): { pipeline: GPURenderPipeline; promise: Promise<GPURenderPipeline> } | null {
    const device = this.device;
    const made: { pipeline?: GPURenderPipeline } = {};
    const capture = {
      createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) =>
        Promise.resolve((made.pipeline = device.createRenderPipeline(descriptor))),
    } as unknown as GPUDevice;
    const promise = build(capture);
    void promise.catch(() => {});
    return made.pipeline ? { pipeline: made.pipeline, promise } : null;
  }

  /** 认领一个备好的对象（L4）：必须是本场景备的、还没装也没放弃。 */
  private claim(prepared: PreparedObject): void {
    if (prepared.owner !== this) throw new SceneRenderError(["render:prepared-scene"]);
    if (prepared.settled) throw new SceneRenderError(["render:prepared-settled"]);
    prepared.settled = true;
  }

  /**
   * 同步装上一个备好的对象（L4）：`LayerRuntime` → `layerByObject` / 独占 fbo / 变形纹理 / 被依赖层的独占 RT 进表 → 粒子序号、挂点 → `buildLayer`
   * （合成 RT、draw、粒子树预热）→ `install` → 变体段失败时冻结 → 阴影投射者 → 粒子索引扩容。`encode` 读的是装好的整体，半装的状态画不到。
   * 同一对象已有运行时（L5 的替换）时先卸掉旧的，粒子树的脚本暂停 / 停止接回新树；别的图层引用旧的被依赖层独占 RT 的 draw 不重绑（L5 定）。
   * L6（单对象重编译）：新旧图层的粒子定义相同（`sameParticleDefinition`）时沿用旧的粒子树（模拟状态、脚本控制都在，不预热），只重建 draw。
   * 出错时回滚本次加的（运行时、draw、索引、fbo 引用、投射者），抛 `SceneRenderError`，由调用方整场重载。
   * **只能在帧边界调**：`sync` 之前或 `encode` 之后（L5 定具体时机）。
   */
  installObject(prepared: PreparedObject, state: SceneState): void {
    this.claim(prepared);
    const worlds = new Map<number, Mat4>(this.liveSeeds(state) ?? []);
    try {
      this.installCore(prepared, state, worlds);
    } catch (error) {
      throw error instanceof SceneRenderError
        ? error
        : new SceneRenderError([`webgpu:install:${oneLine(String(error))}`]);
    }
  }

  /**
   * `installObject` 的主体（整场加载也走它，`worlds` 由调用方给：整场加载时全部图层共用一份）。认领由调用方做。整场加载时 `prepared.variants`
   * 为 undefined、`shadows` 为 null，变体与投射者在 `build` 里另跑；粒子索引已经一次建够，这里不重建。
   */
  private installCore(prepared: PreparedObject, state: SceneState, worlds: Map<number, Mat4>): void {
    const { layer } = prepared;
    const object = layer.object;
    const previous = this.runtimeByObject.get(object);
    const previousTree = this.trees.get(object);
    const at = previous ? this.layers.indexOf(previous) : -1;
    // 替换被依赖的图层（L6b）：它的独占合成 RT 被引用方的 bind group 烤着。新旧形状相同（`size` 没重编）时沿用旧的那张，引用方不用重绑；
    // 形状变了才换新的，旧的由 `teardown` 释放、引用方在下面重绑（这中间是同步的，不提交引用方的 draw）
    const previousTarget = previous ? (this.layerTargets.get(object) ?? null) : null;
    const reuseTarget =
      previousTarget && prepared.layerTarget && sameTargetShape(previousTarget, prepared.layerTarget)
        ? previousTarget
        : null;
    if (reuseTarget && prepared.layerTarget) this.releaseTarget(prepared.layerTarget);
    if (previous) this.teardown(object, { replacing: true, keepTarget: !!reuseTarget });
    const runtime: LayerRuntime = {
      object,
      layer,
      ops: [],
      draws: [],
      resources: prepared.resources,
      signature: planSignature(prepared.plan),
      // 管线按装的这一刻的组归属取（`pipelineOf` 读 `groupOf`，`layerByObject` 已有全部组）
      placement: this.placementOf(layer),
      tree: null,
      fboKeys: [...prepared.fboKeys],
    };
    if (at >= 0) this.layers.splice(at, 0, runtime);
    else this.layers.push(runtime);
    this.runtimeByObject.set(object, runtime);
    this.structureCache = null;
    this.removedObjects.delete(object);
    this.layerByObject.set(object, layer);
    if (prepared.textFbos) this.textFbos.set(object, prepared.textFbos);
    for (const [key, target] of prepared.morphs) this.morphTargets.set(key, target);
    const layerTarget = reuseTarget ?? prepared.layerTarget;
    if (layerTarget) this.layerTargets.set(object, layerTarget);
    try {
      // 粒子序号（定种子）：登记表或缺省的计数给，装的时候取一次（单图层重建的 `createParticleTree` 读表）
      if (layer.particle) this.particleOrdinals.set(object, this.particleOrdinal(object));
      if (layer.attachment) {
        this.attachments.set(object, layer.attachment);
        this.stamps ??= new WorldStamps();
      }
      this.attachedLayers = null;
      // 替换同一对象（L6 单对象重编译）而粒子定义没变（重编译的是它身上别的字段）：沿用旧的粒子树，粒子不重来；变了才新建、预热，接回脚本暂停 / 停止
      const reuse =
        previousTree && layer.particle && sameParticleDefinition(previousTree.layer.particle, layer.particle)
          ? previousTree
          : null;
      const built = this.buildLayer(runtime, prepared.plan, prepared.prepared, state, worlds, reuse);
      this.install(runtime, built);
      if (previousTree && built.tree && !reuse) built.tree.system.adoptScriptControl(previousTree.system);
      if (typeof prepared.variants === "string") this.freezeVariants(layer, state, prepared.variants);
      if (prepared.shadows) this.installShadowCasters(runtime, prepared.shadows, state);
      this.ensureParticleIndices(this.particleCapacityOf(layer, prepared.plan));
      // 被依赖图层换了独占 RT（L6b，形状变了）：引用它的 draw 的 bind group 与 `g_Texture<n>Resolution` 还按旧的那张，重绑（同 P11b 换图）
      if (previousTarget && previousTarget !== layerTarget) this.rebindDependents(object, state, worlds);
    } catch (error) {
      this.teardown(object);
      throw error;
    }
  }

  /**
   * 放弃一个备好、不装的对象（L4）：还掉 fbo 引用、释放它独占的 fbo、被依赖层的独占 RT 与变形纹理。已装上或已放弃的什么都不做。借过的池化合成 RT、
   * 建过的管线留在共享池与缓存里。
   */
  discardPrepared(prepared: PreparedObject): void {
    if (prepared.owner !== this || prepared.settled) return;
    prepared.settled = true;
    for (const key of prepared.fboKeys) this.releaseFbo(key);
    for (const record of prepared.textFbos ?? []) this.dropTarget(record.id);
    if (prepared.layerTarget && this.layerTargets.get(prepared.layer.object) !== prepared.layerTarget)
      this.releaseTarget(prepared.layerTarget);
    for (const [key, target] of prepared.morphs) if (this.morphTargets.get(key) !== target) this.releaseTarget(target);
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

  /**
   * 一个纹理输入的尺寸（`g_Texture<n>Resolution`）：静态纹理取 bundle 里的，RT 与图集取目标的，用户纹理有图时取裁后尺寸（图像尺寸 = 纹理尺寸，
   * p11-REPORT 第 5 条）、没有图取缺省纹理的。
   */
  private inputSize(ref: TextureRef | undefined, resources: LayerResources): TextureSize | undefined {
    if (!ref) return undefined;
    if (ref.kind === "user") {
      const user = this.resolveUser(ref);
      if (user)
        return {
          width: user.gpu.width,
          height: user.gpu.height,
          textureWidth: user.gpu.width,
          textureHeight: user.gpu.height,
        };
      return this.inputSize(ref.fallback, resources);
    }
    if (ref.kind === "texture") return this.bundle.textures[ref.index];
    const target = this.resolveTexture(ref, resources);
    if (!target) return undefined;
    const size: TextureSize = {
      width: target.width,
      height: target.height,
      textureWidth: target.width,
      textureHeight: target.height,
    };
    // `g_Texture<n>MipMapInfo`（P13b1，步骤 0 R7）：只有绑 mip 帧缓冲的槽有，值是它的 mip 数
    if (ref.kind === "mip-framebuffer") size.mipCount = this.reflectionTargets?.mipLevelCount;
    return size;
  }

  private resolveTexture(ref: TextureRef, resources: LayerResources): RenderTarget | null {
    if (ref.kind === "composite") return resources.composites[ref.index] ?? null;
    if (ref.kind === "fbo") return this.targets[resources.fbos.resolve(ref.effect, ref.name)] ?? null;
    if (ref.kind === "framebuffer") return this.snapshot;
    // 反射的两张 RT（P13b1）：没建（bundle 没记读者）时为 null，建 draw 时报 `render:texture-rt:<kind>`
    if (ref.kind === "reflection") return this.reflectionTargets?.reflection ?? null;
    if (ref.kind === "mip-framebuffer") return this.reflectionTargets?.mipFramebuffer ?? null;
    // 阴影图集（P13d）：没建（没有阴影档位或计数）时为 null，建 draw 时报 `render:texture-rt:shadow-atlas`
    if (ref.kind === "shadow-atlas") return this.shadowAtlas;
    if (ref.kind === "atlas") return (ref.color ? resources.atlases?.color : resources.atlases?.main) ?? null;
    // 别的图层的独占 RT（P8 步骤 4）；那一层没建资源时为 null，建 draw 时报 `render:texture-rt:layer`
    if (ref.kind === "layer") return this.layerTargets.get(ref.object) ?? null;
    // puppet 的变形纹理与裁切遮罩 RT（P12b1 步骤 4、5）
    if (ref.kind === "morph") return this.morphTargets.get(morphKey(ref.object, ref.mesh)) ?? null;
    if (ref.kind === "clip-mask") return this.clipMask;
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

  /**
   * 全场一份的粒子索引缓冲（`quadIndices`）：每粒子 `0 1 2 0 2 3`，建场景时按全场最大的 `maxcount` 写一次。之后装的对象要的更多时（L4）
   * 重建并释放旧的；容量够就不动。draw 不持有它，编码时现取 `particleIndices`。`capacity` 为负（没有粒子步骤）时什么都不做。
   */
  private ensureParticleIndices(capacity: number): void {
    if (capacity < 0) return;
    const particles = Math.max(1, capacity);
    if (this.particleIndices && this.particleIndices.particles >= particles) return;
    if (this.particleIndices) this.release(this.particleIndices.buffer);
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
    const world = worldMatrixOf(layer.object, state.layers, new Map(), this.attachHook);
    const inputs = { world, pointer: pointerScenePoint(this.cursorViewProjection(), this.particleCursor) };
    system.prewarm(inputs);
    if (system.prewarmTruncated)
      this.warnings.push(`粒子层 ${layer.object} 预热到工作量上限，提前结束（starttime ${compiled.starttime}）`);
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

  /** 挂点钩子的公开入口（P6d3a，`ScriptApiState.attachPose`）：父 puppet 骨骼的 `Pose · Att`，没有挂点为 null。 */
  attachMatrix(object: number): Mat4 | null {
    return this.attachPose(object);
  }

  /**
   * 脚本 `getTransformMatrix`（P6d1a）：WPE 调的就是带戳的世界矩阵函数（`FUN_1401850a0`），脚本调用当场按戳规则求值并改写戳与缓存，
   * 之后的绘制沿用。我们的变换写入先记在 `SceneState.transformWrites`、等 `stepParticles` / `drawPhase` 才清戳，所以这里先把已记的写入
   * 清戳（等价于 WPE 的写入当场清戳），再走 `WorldStamps.evaluate`，最后乘自身偏移（`withSelfOffset`，与 `drawMatrixOf` 同一个函数）。
   * 取走写入后，`drawPhase` 的预置（`drawSeeds`）不能再靠 `hasTransformWrites` 判作废，所以取到了写入就直接作废它（WPE 里写过的对象
   * 戳为 0、渲染时重算，同此）；`drawPhase` 自己随后仍会 `invalidate` 本帧新写入，不受影响。没有挂点（没有 `stamps`）时与以前一样现算。
   */
  transformMatrix(object: number, state: SceneState): Mat4 {
    const stamps = this.stamps;
    if (!stamps) return drawMatrixOf(object, state.layers, new Map(), this.attachHook);
    if (state.hasTransformWrites()) {
      stamps.invalidate(state.takeTransformWrites());
      this.drawSeeds = null;
    }
    const world = stamps.evaluate(object, state.layers, this.hasAttachment, this.attachHook);
    return withSelfOffset(world, state.layers.get(object)?.offset);
  }

  /**
   * 粒子层脚本方法的落点（P4f 步骤 3，`IParticleSystem`，`script/api.ts` 的 `installParticle`）：接到这一层的根系统（子系统与事件实例
   * 脚本拿不到，rea-p4f-script.md 1.5）。`stop` 与 `emitParticles` 改了粒子，标 `stale`（暂停中补画的帧也重写顶点）；`emitParticles` 带
   * 这一层最近一次交给根系统的控制点输入（`ParticleTree.inputs`）。没有这一层的树（不是粒子层、没有可画的模板）时为 null。
   *
   * TODO:[WPE_SCENE] 真实场景没确定：语料里调 `emitParticles` 的两处都在光标回调里（3286859278 的 `Thunderbolt` 要 `input.cursor*`，
   * 3570560686 的按钮挂在 `cursorClick` 上），这两个 API 实现之后在这两张上看脚本发射与 eventspawn 实例（只用确定性工程对过 WPE）。
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

  /**
   * 帧率设置就地生效（`SceneRenderer.setMaxFps`）：operator 遍数（`particlePasses`）与 rope 读的帧上限一起换，下一帧起生效，不重建
   * 系统树。现有的树整棵换遍数（`ParticleSystem.setPasses`，static 子孙与事件池一起）；全部粒子层标脏，暂停中的补画也按新帧上限重写
   * rope 的 `TL`。预热固定 1 遍、拖尾按实际帧时间采样，所以中途切换没有残留状态。
   */
  setFrameRate(fps: number): void {
    const passes = particlePasses(fps);
    if (fps === this.particleFps && passes === this.particlePasses) return;
    this.particleFps = fps;
    this.particlePasses = passes;
    for (const [object, tree] of this.trees) {
      tree.system.setPasses(passes);
      this.markParticlesStale(object);
    }
  }

  /** 这一层的全部粒子绘制标 `stale`（下次编码重写顶点）：步进之后、脚本改了粒子之后。 */
  private markParticlesStale(object: number): void {
    for (const item of this.drawsByLayer.get(object) ?? []) if (item.particles) item.particles.stale = true;
  }

  /**
   * 一次粒子绘制的 CPU 侧顶点：系统是这个模板的一次出现（P4e 步骤 1、2），顶点按这一步的 renderer（`step.renderer`，P4f 步骤 4）、程序
   * 与 `particleUnits` 分配，第一次 `encode` 时写（`stale`）。同一系统的几次绘制各有一份（不共用缓冲）。布局的问题 `checkRenderable`
   * 已经查过。
   */
  private createParticles(step: ParticleStep, program: GpuProgram, system: ParticleSystem): ParticleDraw {
    const geometry = program.result.geometry;
    const units = particleUnits(system, step.instanced, system.alive);
    // 这一步的 renderer：拖尾判断（`refreshParticleGeometry` 的眼位）、朝向与 `g_RenderVar0` 都读它，不读系统的 `def.renderer`
    const renderer = particleDraws(system.def)[step.renderer]?.renderer;
    const base = {
      system,
      renderer,
      units,
      count: 0,
      stale: true,
      trailEye: null,
      hidden: false,
      instanced: step.instanced,
    };
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
    return particles.system.drawTransform(worldMatrixOf(object, state.layers, worlds, this.attachHook)).model;
  }

  /**
   * 按模型矩阵重算粒子层的绘制几何（P4c 步骤 5）：朝向是不是 NaN（`hidden`）、拖尾的眼位（`trailEye`）。建 draw 与就地刷新时调，
   * 和 uniform 同一个模型矩阵（记进 `model`）。拖尾的眼位变了，下一次画之前重写顶点（退化粒子的判断跟着变）。
   * rope 两类（P4d 步骤 1、2，同一个几何着色器）的几何只在 `ORIENTATION ≠ 0` 时读 `g_OrientationForward`（rea-p4d-rope.md 1.5），
   * screen 朝向不受它影响，不因它跳过；`ORIENTATION ≠ 0` 时朝向是 NaN 则整条带子的右向量都是 NaN，WPE 的图元全被丢弃，同样整次跳过。
   */
  private refreshParticleGeometry(particles: ParticleDraw, model: Mat4): void {
    particles.model = model;
    // 子系统按它自己的 renderer 与模型矩阵（P4e 步骤 1）；同一系统的几次绘制各按自己那一条 renderer（P4f 步骤 4，rea-p4f-script.md
    // 8.3）：只有拖尾那次有眼位、跳过退化粒子，朝向是 NaN 只跳过算出 NaN 的那一次
    const renderer = particles.renderer;
    if (!renderer) return;
    particles.hidden =
      particles.rope && renderer.orientation.mode === 0
        ? false
        : orientationBasis(renderer.orientation, model, this.view.viewVectors.forward, this.view.viewVectors.up) ===
          null;
    const eye = renderer.kind === "spritetrail" ? trailEye(this.view.eye, model) : null;
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
    // 子系统的绘制在标签后面带上树里的路径（P4e 步骤 1），顶层的标签不变；同一模板的第 k 个 draw（P4e 步骤 2）再带 `#k`；
    // 系统的第 r 条 renderer（r ≥ 1，P4f 步骤 4）末尾再带 ` r<r>`，第 0 条不带
    const label =
      step.kind === "particles"
        ? `layer ${layer.id} ${layer.name} particles${step.node.length ? ` ${step.node.join("/")}` : ""}${occurrence ? `#${occurrence + 1}` : ""}${step.renderer ? ` r${step.renderer}` : ""}`
        : step.kind === "text"
          ? `layer ${layer.id} ${layer.name} text ${step.part}`
          : step.kind === "mesh"
            ? `layer ${layer.id} ${layer.name} mesh ${step.mesh}`
            : `layer ${layer.id} ${layer.name} ${step.role}${step.geometry === "texchan" ? " texchan" : ""}${step.clipSlot === undefined ? "" : ` clip ${step.clipSlot.kind}${step.clipSlot.kind === "normal" ? step.clipSlot.slot : step.clipSlot.record}`}`;

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
        instances: programInstances(program.result),
      };
    } else if (isTexchanDraw(step)) {
      // puppet 的纹理通道网格（P12b2-2，rea-texchan-model 2：顶点原样、u16 索引、静态缓冲）：mdl 视图按视图共用，位置、`a_BlendIndices`、`a_TexCoordVec4` 都不动
      const channels = layer.puppet?.textureChannels;
      if (!layer.puppet || !channels) throw new SceneRenderError(["render:puppet"]);
      const name = `${layer.puppet.path}#texchan`;
      vertexBuffer = this.meshBuffer(channels.mesh.vertices, GPUBufferUsage.VERTEX, `${name} vertices`);
      meshDraw = {
        indexBuffer: this.meshBuffer(channels.mesh.indices, GPUBufferUsage.INDEX, `${name} indices`),
        indexFormat: "uint16",
        count: channels.mesh.indexCount,
        placeholder: this.meshLayoutOf(layer, step).placeholders ? this.meshPlaceholderBuffer() : null,
      };
    } else if (isPuppetDraw(step)) {
      // puppet 的网格 0（P12a 步骤 4，rea-p12-mdl 9.2）：代替图层四边形。直接上屏时 `a_TexCoord` 乘 `step.uv`（图像 / GPU 纹理）、另传一份
      // 顶点；上屏采样合成 RT 时 uv 为 (1, 1)，直接用 mdl 视图（按视图共用）。索引一律 u16、三角形列表；位置不动、不按 `size` 缩放
      const puppet = layer.puppet;
      if (!puppet) throw new SceneRenderError(["render:puppet"]);
      const name = `${puppet.path}#puppet`;
      const privateVertices = needsScaledVertices(puppet.mesh, step.uv);
      if (privateVertices) {
        const bytes = scaledPuppetVertices(puppet.mesh, step.uv);
        vertexBuffer = this.own(
          device.createBuffer({
            label: `${label} vertices`,
            size: bytes.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          }),
        );
        device.queue.writeBuffer(vertexBuffer, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } else vertexBuffer = this.meshBuffer(puppet.mesh.vertices, GPUBufferUsage.VERTEX, `${name} vertices`);
      // 索引（P12f）：绘制顺序会变的 puppet（`order.dynamic`）与裁切模板（`clipSlot`，每个槽位画哪一段由编码时的当前命令表定）各有一块私有索引缓冲
      // （`INDEX | COPY_DST`，容量 = 整张网格的索引数；不进 `meshBuffer` 的共用缓存——两个图层可能用同一个 mdl、顺序各自不同），内容每帧编码之前
      // 按 `drawOrder` 的版本写（`syncPuppetIndices`，建时版本 −1，第一次编码就写一次）；别的 puppet 照旧共用 mdl 视图
      const slot = step.clipSlot;
      const ordered = slot !== undefined || puppet.order?.dynamic === true;
      const capacity = puppetIndexCapacity(puppet.mesh.indexCount);
      let indexBuffer: GPUBuffer;
      if (ordered) {
        indexBuffer = this.own(
          device.createBuffer({
            label: `${label} indices`,
            size: capacity,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          }),
        );
      } else indexBuffer = this.meshBuffer(puppet.mesh.indices, GPUBufferUsage.INDEX, `${name} indices`);
      meshDraw = {
        indexBuffer,
        indexFormat: "uint16",
        count: ordered ? 0 : puppet.mesh.indexCount,
        placeholder: this.meshLayoutOf(layer, step).placeholders ? this.meshPlaceholderBuffer() : null,
        privateVertices,
        ...(ordered ? { ordered: { slot: slot ?? null, version: -1, capacity, source: null } } : {}),
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
              : // 预光照的基础 pass（P13j）：四边形按合成 RT 尺寸（顶点 · g_AltModelMatrix 是光照的世界位置），整面正交跟着换，画进 RT 的像素不变
                layerQuad(
                  isPrelitDraw(step) ? this.compositeSizeOf(layer) : this.layerSize(layer, state),
                  step.uv,
                  step.inset,
                );
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

    const sizeOf = (ref: TextureRef | undefined) => this.inputSize(ref, resources);

    // uniform：内置值打底，材质常量 / 用户属性覆盖（与就地刷新共用 `drawUniformValues`）
    let block: UniformBlock | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    let frameNames: string[] = [];
    let trailRenderVar = false;
    let puppetObject: number | null = null;
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
      frameNames = [
        ...Object.keys(
          frameBuiltins({ time: 0, frametime: 0, daytime: 0, pointer: [0, 0], pointerLast: [0, 0], cursor: [0, 0] }),
        ),
        // 灯光数组（P13d）：每帧由 `frameLightValues` 排序写整块缓冲后切出来
        ...(this.bundle.lights ? LIGHT_FRAME_UNIFORMS : []),
        // 遗留灯（P13f2）：每帧按上一帧末的状态写（`frameLightValues`）
        ...(this.bundle.legacyLights ? LEGACY_LIGHT_UNIFORMS : []),
      ].filter((name) => block!.has(name) && !(name in pass.uniforms));
      // ropetrail（P4d 步骤 2）的 g_RenderVar0 随计时器每帧变（建 draw 时的值是计时器初值 0 的，`particleBuiltins`）。只有 ropetrail 那次
      // 绘制写（P4f 步骤 4：强制渲染混挂时同系统的 sprite 那次照旧是 0）
      trailRenderVar =
        !!particles?.system.trail &&
        particles.renderer?.kind === "ropetrail" &&
        block.has("g_RenderVar0") &&
        !("g_RenderVar0" in pass.uniforms);
      // skinned puppet（P12a 步骤 4）：`g_Bones` 每帧由 `update` 写，建 draw 时先写一次当前的蒙皮矩阵（建 GPU 资源之前宿主已 `refresh`，
      // 第一帧不会闪出绑定姿势）。矩阵数组按翻译器反射的布局写（`UniformBlock.set` 对 `array<mat4x3<f32>, N>`：每元素 12 个数、列主序、
      // 列步长 16），`skinMatrices` 的输出原样传入，见 `render/p12a.test.ts`
      // P12b1 步骤 4：同一批还有骨骼透明度与变形的 uniform（`writePuppetUniforms`）
      // 模型网格（P12b2-1）：对象有骨骼时同样每帧写，变形的 uniform 按网格（`step.mesh`）
      if (
        ((isPuppetDraw(step) && layer.puppet) ||
          (isTexchanDraw(step) && layer.puppet) ||
          (step.kind === "mesh" && layer.model?.skeleton)) &&
        PUPPET_BLOCK_NAMES.some((name) => block!.has(name))
      ) {
        puppetObject = layer.object;
        this.writePuppetUniforms(block, layer, step);
      }
      uniformBuffer = this.own(
        device.createBuffer({
          label,
          size: block.data.byteLength,
          // sprite 的光斑（P13c）：k 由计算 pass 写进这块缓冲（`SpriteCounter.encodeScale`）
          usage:
            GPUBufferUsage.UNIFORM |
            GPUBufferUsage.COPY_DST |
            (layer.sprite && step.kind === "mesh" && !step.occlusion ? GPUBufferUsage.STORAGE : 0),
        }),
      );
      traceUniforms(uniformBuffer, (program.result.uniforms ?? []) as UniformEntry[]);
      device.queue.writeBuffer(uniformBuffer, 0, block.data);
    }

    // 视频纹理（P9a）：只看着色器真正绑定的槽（WPE 绑定时遍历程序用到的槽表，只更新这些，rea-p9-video 第 2 节第 4 条）
    const videos = [
      ...new Set(
        program.textures.flatMap((binding) => {
          const input = step.inputs[binding.slot];
          // 用户纹理（P11b）的缺省是视频时照样推进（缺省纹理回来时要接得上）
          const ref = input?.kind === "user" ? input.fallback : input;
          return ref?.kind === "texture" && bundle.textures[ref.index]?.video ? [ref.index] : [];
        }),
      ),
    ];

    // 多图像帧表（P6e 点 4）：绑它的槽，bind group 随帧所在的图像换
    const multiImage = program.textures.flatMap((binding) => {
      const ref = step.inputs[binding.slot];
      return ref?.kind === "texture" && this.extraTextures.has(ref.index) ? [binding.slot] : [];
    });
    const sheetImages = new Map<number, number>();
    const entries = (resolveFbo: (effect: number, name: string) => RenderTarget): GPUBindGroupEntry[] => {
      const list: GPUBindGroupEntry[] = [];
      if (uniformBuffer) list.push({ binding: 0, resource: { buffer: uniformBuffer } });
      for (const binding of program.textures) {
        let ref = step.inputs[binding.slot];
        let view: GPUTextureView;
        let sampler: GPUSampler;
        // 用户纹理（P11b）：有图用那张，没有图落到缺省纹理（下面照缺省的种类解析）
        let user: UserResolved | null = null;
        if (ref?.kind === "user") {
          user = this.resolveUser(ref);
          if (!user) ref = ref.fallback;
        }
        if (user) {
          if (binding.kind !== "2d")
            throw new SceneRenderError([`render:texture-kind:${binding.slot}:${binding.kind}`]);
          view = user.gpu.view;
          sampler = user.sampler;
        } else if (!ref) {
          view = this.dummies.views[binding.kind];
          sampler = binding.kind === "2d-comparison" ? this.dummies.comparison : this.dummies.sampler;
        } else {
          // 比较采样的槽（`sampler2DComparison`）只认阴影图集（P13d），别的槽只认 2d
          if (binding.kind === "2d-comparison" ? ref.kind !== "shadow-atlas" : binding.kind !== "2d")
            throw new SceneRenderError([`render:texture-kind:${binding.slot}:${binding.kind}`]);
          if (ref.kind === "texture") {
            // 帧所在的图像（P6e 点 4）：第 k 张（k ≥ 1）取 `extraTextures`；采样器同这张纹理。越界时 WPE 不检查，这里按 0 处理（`bindSheets`）
            const image = sheetImages.get(binding.slot) ?? 0;
            const gpu =
              (image > 0 ? this.extraTextures.get(ref.index)?.[image - 1] : undefined) ?? this.textures[ref.index]!;
            view = gpu.createView();
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
    const dynamic = multiImage.length > 0 || Object.values(step.inputs).some((ref) => ref.kind === "fbo");
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
      puppet: puppetObject,
      resources,
      pipeline,
      vertexBuffer,
      uniformBuffer,
      block,
      frameNames,
      trailRenderVar,
      textureSizes,
      userNames: [
        ...new Set(Object.values(step.inputs).flatMap((ref) => (ref.kind === "user" ? [ref.slot.source.name] : []))),
      ],
      videos,
      userAnimations: this.userAnimationsOf(program, step.inputs),
      dirty: false,
      multiImage,
      sheetImages,
      bindGroup,
      bindGroups: new Map(),
      entries,
      layout: program.bindGroupLayout,
    };
  }

  /** bind group 缓存键：fbo 状态之后追加多图像槽当前的图像号（没有多图像槽时就是原键，单图像不多建）。 */
  private imageKey(draw: Draw, base: string): string {
    return draw.multiImage.length
      ? `${base}|${draw.multiImage.map((slot) => draw.sheetImages.get(slot) ?? 0).join(",")}`
      : base;
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
    const key = this.imageKey(draw, ids.join(","));
    let group = draw.bindGroups.get(key);
    if (!group) {
      group = this.device.createBindGroup({ label: draw.label, layout: draw.layout, entries });
      draw.bindGroups.set(key, group);
    }
    return group;
  }

  /**
   * 图层画自己的世界矩阵（`drawMatrixOf`）；文本层再加 `anchor` 的世界平移（P6e 点 5）。合成 RT 内部的文本矩阵不读它（`textMatrices` 的
   * composite 分支），所以只有直接上屏与合成路径上屏的步骤受影响；`getTransformMatrix` 走另一条路、不带 anchor。
   */
  private drawWorldOf(layer: SceneLayer, state: SceneState, worlds: Map<number, Mat4>): Mat4 {
    const world = drawMatrixOf(layer.object, state.layers, worlds, this.attachHook);
    return layer.text ? withAnchor(world, layer.text.script?.anchor, this.anchorEdgesNow()) : world;
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
    /** 这次绘制所在 pass 的视图：主 pass 用主视图，平面反射 pass 用反射视图（P13b2，`refreshReflection`）。 */
    view: SceneView = this.view,
  ): Record<string, number[]> {
    const common = {
      // 图层画自己的矩阵（P8 步骤 3）：世界矩阵再乘自身偏移（文本排版、图像层对齐），直接上屏、合成链各角色、效果矩阵、
      // `g_LayerModelMatrix` 与文本都用它；粒子下面换成 `model`，模型网格没有偏移（字节同 `worldMatrixOf`）
      world: this.drawWorldOf(layer, state, worlds),
      constants: state.constants.get(step.pass.key) ?? {},
      // HDR 下颜色乘 brightness（B10）；passthrough 的 g_Color4 由材质值覆盖成 (1, 1, 1, 1)
      colorScale: this.hdr ? layerState.brightness : 1,
      screenSize: [this.width, this.height] as [number, number],
      textures,
      eye: view.eye,
      // 视图向量（P5d 步骤 2）：全部 pass 都写，正交场景是常量
      view: view.viewVectors,
      // 读状态，不读编译结果：单图层重建新建的 draw 要拿到当前值
      ambient: state.general.ambientcolor,
      skylight: state.general.skylightcolor,
      // 雾（P13f）：同环境光，读状态现算
      fog: fogUniforms(state.general),
    };
    // 透视覆盖读状态（P5h：脚本写 `thisLayer.perspective` 当帧生效，`p5h-a` 实测），没写过取编译期值
    const persp = layerState.perspective ?? !!layer.perspective;
    // 组里的图层（P5b 步骤 4，p5-REPORT `p5b-grp-*`、`p5b-grpptc`）：视图投影换成组的局部正交 `ortho(±w/2, ±h/2, ±1000) · inverse(W_组)`，
    // 不经 `viewProjectionOf`（组里没有视差、抖动、缩放、透视，它们只作用在组本身，`p5b-grp-par`）。嵌套组自己的 compose 基础 pass
    // 例外，照旧用场景视图投影按屏幕位置采快照（`p5b-nest` 事件 94）；effect 中间 pass 的效果矩阵也按组的局部正交算（WPE 画子树时
    // 投影栈就是它，没有实测）。组的矩阵取它画自己的那个（P8 步骤 3，带组的对齐偏移：`p8-align2` 的 Gc 落在组 RT 的左上角）
    const group = this.groupOf(layer);
    const groupVp =
      group && !(step.kind === "draw" && step.role === "compose")
        ? groupViewProjection(group.size, drawMatrixOf(group.object, state.layers, worlds, this.attachHook))
        : null;
    if (step.kind === "text") {
      // 文本（P6b 1d）：直接上屏用这次画到场景的视图投影（带视差、抖动；组里是组的局部正交），画进合成 RT 用 RT 像素的正交
      // （`textMatrices`）。排版结果在建 draw 前已核对过。`perspective: true` 的文本直接上屏换透视那一份视图投影（P5g，同图像层，
      // `FUN_1401e8aa0` 的 `0x1401e92b3`）；合成路径的字形由 `textMatrices` 用 RT 像素的正交，不读它
      return textUniformValues({
        ...common,
        step,
        layer: layerState,
        layout: state.texts.get(layer.object)!,
        viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, persp),
        msdf: this.msdfInput(layer, state),
      });
    }
    if (step.kind === "particles") {
      // 帧表（P4b 步骤 2）：槽 0 的纹理带帧表时写 `g_RenderVar1`
      const input = step.inputs[0];
      // 槽 0 是用户纹理时帧表仍按缺省纹理（p11-REPORT M4：运行中换图沿用缺省的帧表）
      const base = input?.kind === "user" ? input.fallback : input;
      return particleUniformValues({
        ...common,
        // 世界空间系统（P4c 步骤 4）是单位阵，对象变换改了照样走这里重写，仍是单位阵（`particleModel`）；子系统与事件实例按树算
        // （P4e 步骤 1、2）
        world: model ?? identity(),
        layer: layerState,
        // 透视粒子同样带视差：平移加在世界坐标里，z = 0 平面上和正交一致（p5-REPORT `p5a-fx`）；组里的透视粒子照报
        // （`model:passthrough:children:perspective`），强制渲染时按组的局部正交画
        viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, step.perspective),
        sheet: base?.kind === "texture" ? this.bundle.textures[base.index]?.sheet : undefined,
        // 朝向与拖尾的 g_RenderVar0（P4c 步骤 5）：这次绘制的系统自己的 renderer（P4e 步骤 1）里这一步的那一条（P4f 步骤 4，
        // rea-p4f-script.md 8.3：每条按自己的 `rec+4` 算朝向；拖尾那条写 RV0.xyz，sprite 那条照旧写 0，不复刻上一次绘制的残值）
        renderer: layer.particle
          ? particleDraws(particleNode(layer.particle, step.node))[step.renderer]?.renderer
          : undefined,
      });
    }
    if (isTexchanDraw(step))
      // puppet 的纹理通道网格（P12b2-2，rea-texchan-model 2，p12b2-tc 实测）：MVP 是合成 RT 的 `ortho(0, W, 0, H)`、模型矩阵单位阵，不经图层变换、视差、视图投影；
      // g_Color4 与基础四边形相同（图层颜色 × brightness、alpha），所以颜色组照基础 pass 取图层状态；`g_BlendMap` 每帧由 `writePuppetUniforms` 写
      return drawUniformValues({
        ...common,
        world: identity(),
        step,
        layer: { ...layerState, size: step.rtSize ?? layer.size },
        viewProjection: identity(),
      });
    if (step.kind === "mesh" && layer.sprite)
      // sprite（P13c，`render/sprite.ts`）：模型矩阵是单位阵、视图去平移（对象变换与视差都不参与，S5），颜色组同网格；遮挡方块的两个轴
      // 乘 0.2；光斑的两个轴与 `g_Alpha` 按 k = 0 写，真正的值由计算 pass 每帧盖上（`encodeSprite`）
      return spriteOverrides(
        drawUniformValues({
          ...common,
          world: identity(),
          colorScale: 1,
          step: { role: "direct", inputs: step.inputs },
          layer: { ...layerState, color: [1, 1, 1], alpha: 1, size: layer.size },
          viewProjection: spriteViewProjection(view.sceneCamera),
        }),
        !!step.occlusion,
        view.viewVectors,
      );
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
        viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, persp),
      });
    // fullscreen（P5b 步骤 3，p5-REPORT `p5b-fs` 事件 76）：直接上屏以外的角色（effect、末 pass、passthrough 上屏）模型与视图都是
    // 单位阵、投影是 NDC 正交，不经 `viewProjectionOf`：`origin` / `scale` / `angles`、视差、抖动、透视都不起作用，2×2 的四边形
    // 正好铺满全屏。效果矩阵跟着是单位阵（`size` 是 (2, 2)，`scale(w/2, h/2)` 也是单位阵）。直接上屏照常（下面）
    if (layer.fullscreen && step.role !== "direct")
      return this.userWhiteout(
        step,
        layer,
        common.constants,
        drawUniformValues({
          ...common,
          world: identity(),
          step,
          layer: { ...layerState, size: this.layerSize(layer, state) },
          viewProjection: FULLSCREEN_VIEW_PROJECTION,
        }),
      );
    // 预光照的基础 pass（P13j）：尺寸按合成 RT（同上面的四边形），Alt 矩阵 = 图层世界矩阵（不含对齐偏移；instanced 再乘 size / 图像尺寸）与
    // 图层上屏用的视图投影（同下面末 pass / passthrough 的那一份，组里是组的局部正交）
    const prelit = isPrelitDraw(step);
    const rtSize = prelit ? this.compositeSizeOf(layer) : null;
    return this.userWhiteout(
      step,
      layer,
      common.constants,
      drawUniformValues({
        ...common,
        step,
        layer: { ...layerState, size: rtSize ?? this.layerSize(layer, state) },
        ...(prelit
          ? {
              alt: {
                model: prelitModel(worldMatrixOf(layer.object, state.layers, worlds, this.attachHook), layer, rtSize!),
                viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, persp),
              },
            }
          : {}),
        // 图像层 perspective（P5b 步骤 1，p5-REPORT `p5b-persp`）：画到场景目标的绘制（直接上屏、末 pass、passthrough 上屏）换成透视粒子
        // 那一份视图投影（相机距离随 perspectiveoverridefov 与 zoom 变，已带抖动），视差平移照旧右乘；画进合成 RT / fbo 的 pass 不变。
        // 组里的图层用组的局部正交（组里的透视图层照报，强制渲染时不换透视）
        viewProjection: groupVp ?? this.viewProjectionOf(layer, state, view, persp && step.target.kind === "scene"),
      }),
    );
  }

  /**
   * 组合层与 instanced 的颜色强制为白（P11b 步骤 2，rea-p11b 4.3，p11-REPORT M2）：WPE 每次绘制现读材质的标志位，这个 pass 任一槽的用户纹理
   * 生效时 `g_Alpha` = 1、`g_Color` = (1, 1, 1)（`g_Color4` = (1, 1, 1, 1)，HDR 下也不乘 `brightness`），对象的 alpha 一起被换成 1；
   * 回到缺省纹理的下一次绘制恢复对象的值。材质自己写了这几个名字（`constants`）的不动，`g_UserAlpha` 不是 WPE 写的那两个，也不动。
   */
  private userWhiteout(
    step: DrawLike,
    layer: SceneLayer,
    constants: Record<string, number[]>,
    values: Record<string, number[]>,
  ): Record<string, number[]> {
    if (!layer.passthroughModel && !layer.instanced) return values;
    let active = false;
    for (const ref of Object.values(step.inputs)) if (ref.kind === "user" && this.userCrop(ref.slot)) active = true;
    if (!active) return values;
    if (!("g_Alpha" in constants)) values.g_Alpha = [1];
    if (!("g_Color" in constants)) values.g_Color = [1, 1, 1];
    if (!("g_Color4" in constants)) values.g_Color4 = [1, 1, 1, 1];
    return values;
  }

  /**
   * 一次绘制的视图投影（P5a 步骤 2）：开着视差时是 `base · T(o)`（列向量约定：先把世界坐标平移 o，再投影；WPE 行向量下的
   * `V′ = T(o)·V`，rea-p5-camera.md 6.3），o 由 draw 所属对象的根对象的当前 `origin` 字段与 `parallaxDepth` 算；关着、根不在表里或
   * o 为 0 时原样返回 `base`，字节不变。`base` 是 `view` 的 `viewProjection`，`perspective` 时是 `perspectiveViewProjection`（透视覆盖），
   * 已带抖动的 `T(−s)`（步骤 3），两个平移相乘就是 `VP · T(o − s)`。
   */
  private viewProjectionOf(layer: SceneLayer, state: SceneState, view: SceneView, perspective: boolean): Mat4 {
    const base = perspective ? view.perspectiveViewProjection : view.viewProjection;
    const parallax = this.parallax;
    if (!parallax) return base;
    const root = state.layers.get(rootObject(layer.object, state.layers));
    if (!root) return base;
    const [x, y] = parallaxOffset(parallax.amount, root.parallaxDepth, root.origin, parallax.point);
    if (x === 0 && y === 0) return base;
    // 场景视图投影：照 WPE 在 V 上平移再 P ⊗ V（rea-matrix-order 2.3）；透视覆盖那一份没有分开的 V，照旧右乘
    if (!perspective) {
      const { projection, view: camera } = view.sceneCamera;
      return mulAffine(projection, translateGlm(camera, [x, y, 0]));
    }
    return multiply(base, translation(x, y, 0));
  }

  /**
   * 设文本 `anchor` 的 `E0..E3`（渲染器每帧调，值没变什么都不做）。变了就标相机脏：随后的 `setParallax` 把全部 draw 的由图层算出的 uniform
   * 重写一遍（带 `anchor` 的文本层的矩阵跟着换）。单图层重建新建的 draw 直接按当前值写。
   */
  setAnchorEdges(edges: Edges): void {
    const now = this.anchorEdges;
    if (edges[0] === now[0] && edges[1] === now[1] && edges[2] === now[2] && edges[3] === now[3]) return;
    this.anchorEdges = [edges[0], edges[1], edges[2], edges[3]];
    this.cameraDirty = true;
  }

  /** 文本 `anchor` 实际生效的 `E0..E3`：透视场景全 0；按指定尺寸画时就是投影的裁切边距（同一份 `alignEdges`）；否则渲染器设的。 */
  private anchorEdgesNow(): Edges {
    return resolveAnchorEdges(!!this.bundle.general.perspective, this.crop?.edges, this.anchorEdges);
  }

  /** 设光标的裁切边距（渲染器每帧按样式与画布尺寸调，`fillCropEdges`）；null 是不裁。见 {@link GpuScene.cursorCrop}。 */
  setCursorCrop(edges: Edges | null): void {
    this.cursorCrop = edges;
  }

  /** 实际生效的裁切边距：透视场景与按指定尺寸画（投影已裁）时没有。 */
  private cursorEdges(): Edges | null {
    return this.cursorCrop && !this.bundle.general.perspective && !this.crop ? this.cursorCrop : null;
  }

  /**
   * 光标反投影用的 `P·V`：有裁切边距时是裁过的 P 乘当前 V（`croppedCursorViewProjection`，总缩放取 `pointerZoom`），否则就是场景的
   * `viewProjection`。
   */
  private cursorViewProjection(): Mat4 {
    const edges = this.cursorEdges();
    if (!edges) return this.view.viewProjection;
    return croppedCursorViewProjection(this.bundle.general, this.pointerZoom, edges, this.view.sceneCamera.view);
  }

  /**
   * 光标命中用的本帧相机（P6c，`render/cursor.ts`）：场景级的 `P·V`（`setCamera` 交来的，带抖动、缩放、相机对象）、眼位、视线方向，以及正交场景里
   * `perspective: true` 图层的透视覆盖输入（V、P 与 `perspectiveoverridefov`，`window` 是窗口客户区像素，投影宽高比取它）。渲染器在
   * `setCamera` 之后、脚本之前取（WPE 命中在相机更新之后、脚本之前）。
   */
  cursorCamera(window: readonly [number, number]): CursorCamera {
    const general = this.bundle.general;
    const perspective = !!general.perspective;
    return {
      viewProjection: this.cursorViewProjection(),
      windowCursor: this.cursorEdges() !== null,
      anchorEdges: this.anchorEdgesNow(),
      eye: this.view.eye,
      perspective,
      forward: this.view.viewVectors.forward,
      override: perspective
        ? null
        : {
            view: this.view.sceneCamera.view,
            projection: this.view.sceneCamera.projection,
            fov: general.perspectiveOverrideFov,
            width: general.width,
            height: general.height,
            window,
          },
    };
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
    this.pointerZoom = zoom;
    const zoomed = zoom !== this.zoom;
    if (!zoomed && x === this.shake[0] && y === this.shake[1] && !this.objectCamera) return;
    // 刚离开相机对象（P5d 步骤 3，相机对象被隐藏）：视图向量回到正交常量，下面按 zoom 与 s 整套重算
    if (this.objectCamera) {
      this.objectCamera = false;
      this.view.viewVectors = ORTHO_VIEW_VECTORS;
    }
    if (zoomed) {
      this.zoom = zoom;
      this.baseViewProjection = sceneViewProjection(this.bundle.general, zoom, this.crop?.edges);
      this.basePerspectiveViewProjection = particleViewProjection(
        this.bundle.general,
        zoom,
        undefined,
        this.crop ?? undefined,
      );
    }
    this.shake = [x, y];
    const still = x === 0 && y === 0;
    const view = still ? identity() : translation(-x, -y, 0);
    this.view.sceneCamera = { projection: this.baseViewProjection, view };
    this.view.viewProjection = still ? this.baseViewProjection : mulAffine(this.baseViewProjection, view);
    this.view.perspectiveViewProjection = still
      ? this.basePerspectiveViewProjection
      : multiply(this.basePerspectiveViewProjection, translation(-x, -y, 0));
    this.view.eye = eyePosition(this.bundle.general, [x, y]);
    this.cameraDirty = true;
  }

  /**
   * 透视场景的相机（P5d 步骤 2）：场景级的视图投影换成 `P·V`（普通图像层、粒子、模型、合成链末 pass、视锥剔除、指针反投影都从这里
   * 取，`p5d-persp` / `p5d-2d` / `p5d-ptc` 实测），`g_EyePosition` 是 eye（含路径与抖动），视图向量换成相机的。有变化才标记
   * 相机变了（draw 的重写同正交，留给随后的 `setParallax`）。透视粒子那一份不动（照报）。
   */
  private applyPerspective(frame: PerspectiveCameraFrame): void {
    // P、V 分开记（视差在 V 上平移，`viewProjectionOf`）；放在「没变就返回」之前，保证它们始终和 `viewProjection` 对得上
    this.view.sceneCamera = { projection: frame.projection, view: frame.view };
    const vectors = this.view.viewVectors;
    if (
      same(frame.viewProjection, this.view.viewProjection) &&
      same(frame.eye, this.view.eye) &&
      same(frame.vectors.forward, vectors.forward) &&
      same(frame.vectors.right, vectors.right) &&
      same(frame.vectors.up, vectors.up)
    )
      return;
    this.view.viewProjection = this.baseViewProjection = frame.viewProjection;
    this.view.eye = [...frame.eye];
    this.view.viewVectors = frame.vectors;
    this.cameraDirty = true;
  }

  /**
   * 正交场景的相机对象（P5d 步骤 3）：场景级的视图投影换成 `sceneViewProjection(general, 总缩放) · V`，透视覆盖（透视粒子、
   * `perspective: true` 的图像层 / 模型）换成在相机 V 上做的那一份，`g_EyePosition` 加相机的 eye.xy，视图向量取 V（都在
   * `orthographicCameraObjectFrame` 里算好）。有变化才标记相机变了（draw 的重写同正交，留给随后的 `setParallax`）。
   */
  private applyCameraObject(frame: OrthographicCameraFrame): void {
    this.view.sceneCamera = { projection: frame.projection, view: frame.view }; // 同 applyPerspective
    this.pointerZoom = frame.zoom;
    const vectors = this.view.viewVectors;
    if (
      this.objectCamera &&
      same(frame.viewProjection, this.view.viewProjection) &&
      same(frame.perspectiveViewProjection, this.view.perspectiveViewProjection) &&
      same(frame.eye, this.view.eye) &&
      same(frame.vectors.forward, vectors.forward) &&
      same(frame.vectors.right, vectors.right) &&
      same(frame.vectors.up, vectors.up)
    )
      return;
    this.objectCamera = true;
    this.view.viewProjection = frame.viewProjection;
    this.view.perspectiveViewProjection = frame.perspectiveViewProjection;
    this.view.eye = [...frame.eye];
    this.view.viewVectors = frame.vectors;
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
    this.lightState = state;
    // 平面反射名单随登记表的增删刷新（L4）
    this.syncReflectionList(state);
    // 对象被删（P6d3）：先释放被删对象的资源，后面的刷新与重建就不会再碰它们
    if (state.structureVersion !== this.structureSeen) {
      this.structureSeen = state.structureVersion;
      this.releaseRemoved(state);
    }
    const dirty = state.takeDirty();
    // 挂点子对象（P12b1 步骤 3）：姿势每帧变，它们与全部子孙的世界矩阵每次都要重算（脚本写父的变换也在 `dirty.layers` 里，不重复）
    if (this.attachments.size && this.puppets?.pose)
      for (const object of this.attachedList(state)) dirty.layers.add(object);
    // 本次的状态快照下的世界矩阵：重建与刷新共用，一条父链只算一次。父的变换写过时子孙已在 `dirty.layers` 里（`SceneState.write`）
    // 预置渲染阶段的挂点子树世界矩阵（B1，`drawPhase`）：WPE 里挂点子树绘制沿用更新阶段的缓存；不取走，到下一次更新阶段才清
    const worlds = new Map<number, Mat4>(this.liveSeeds(state) ?? []);
    // 结构变化（L7）：宿主在脚本之后没做掉的（暂停时的补画帧、dev 探针），在释放被删对象之后、下面的各种重建与刷新之前做
    if (this.pendingRestructure.size) this.applyRestructure(state, worlds);
    // 文本最先（P6b 1e）：重排、换进状态、图集纹理、强制重建本层；偏移变了的本层与子孙并进这次的 `dirty.layers`，下面照常刷
    this.syncTexts(dirty, state, worlds);
    // 用户纹理（P11b 步骤 2）：来源写过或解码完成的，换 bind group / 整层重建，在结构与刷新之前，新 draw 照当前状态写 uniform
    this.syncUserTextures(dirty, state, worlds);
    // 材质状态字段（P6d1b）：写过的与管线刚备好的图层按有效 pass 强制重建
    this.syncPassStates(dirty, state, worlds);
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
   * 材质状态字段运行中换管线（P6d1b，`rea-p6d1-matstate.md`）：WPE 每次绑定现读五个字节，写入当帧就画出新状态，没有重取着色器。这里对
   * 写过的图层（`dirty.passStates`）与管线刚备好的图层（`passStateReady`）`rebuildLayer(…, { force: true })`：规划取有效 pass，程序不换。
   * 新组合的管线加载时没备（`prepareVariants` 只按 bundle 值备），`rebuildLayer` 取不到时转后台建（`deferPassStatePipelines`），建好后的下一次
   * `sync` 换上；建的这几帧里画面保持旧状态。
   */
  private syncPassStates(dirty: DirtyState, state: SceneState, worlds: Map<number, Mat4>): void {
    const objects = new Set<number>(dirty.passStates);
    for (const object of this.passStateReady) objects.add(object);
    this.passStateReady.clear();
    for (const object of objects) {
      const runtime = this.layers.find((layer) => layer.object === object);
      if (!runtime) continue;
      this.passStateWaiting.delete(object);
      this.rebuildLayer(runtime, state, worlds, { force: true });
    }
  }

  /**
   * 后台建管线的任务都结束了（单测与 dev 探针等「写完马上要看到新状态」的调用方先等它，再 `sync`）。返回有没有备好、等着下一次 `sync`
   * 换上的图层（调用方据此决定要不要补一次 `sync`）。
   */
  async settlePassStates(): Promise<boolean> {
    while (this.passStateJobs.size) await Promise.all([...this.passStateJobs]);
    return this.passStateReady.size > 0;
  }

  /**
   * 状态覆盖后这份计划的管线没备好：后台建（失败记 warning、这一层保持旧状态），建好把图层记进 `passStateReady`，下一次 `sync` 换上。
   * 同一个图层有新写入时 `sync` 会重新规划、再来一遍，旧任务建好的管线留在缓存里复用。
   */
  private deferPassStatePipelines(runtime: LayerRuntime, plan: LayerPlan): void {
    const object = runtime.object;
    this.passStateWaiting.add(object);
    const job: Promise<void> = this.prepareLayer(plan, runtime).then(
      () => {
        if (this.passStateWaiting.has(object)) this.passStateReady.add(object);
      },
      (error: unknown) => {
        this.passStateWaiting.delete(object);
        this.warnings.push(
          `图层 ${object} 的材质状态改变后管线备不好，保持原状态：${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    this.passStateJobs.add(job);
    void job.finally(() => this.passStateJobs.delete(job));
  }

  /**
   * 用户纹理换图（P11b 步骤 2，`sync` 里文本之后调）：`dirty.userTextures` 里的属性来源（写入当场、解码完成各标一次）：
   * 1. （RT 参考的槽从第一次真正写入起才生效，M8：`state.userWritten`，解码完成不算）；
   * 2. 槽 0 在图像层基础 pass 上的图层整层强制重建（`ensureUserSizing` 换合成 RT 与 fbo，UV 与合成尺寸随 `planLayer`），清它的 fbo；
   *    被依赖图层的独占 RT 换了尺寸，引用它的 draw 重绑；
   * 3. 其余用到这些来源的 draw 只重建 bind group、重写 `g_Texture<n>Resolution` 与颜色组（`rebindDrawInputs`）；
   * 4. 没有槽引用的用户纹理销毁（来回切换时 CPU 侧的解码结果还在来源表里，不重复解码）。
   * 没有标脏的来源时什么都不做，非用户纹理场景的行为不变。
   */
  private syncUserTextures(dirty: DirtyState, state: SceneState, worlds: Map<number, Mat4>): void {
    const names = dirty.userTextures;
    if (!names.size) return;
    const rebuilt = new Set<number>();
    const resized = new Set<number>();
    let encoder: GPUCommandEncoder | null = null;
    for (const runtime of this.layers) {
      const slot = baseUserSlot(runtime.layer);
      if (!slot || !names.has(slot.source.name)) continue;
      const before = this.layerTargets.get(runtime.object);
      // 槽 0 换成用户的图：WPE 删掉这个图层的 `ITextureAnimation`（`FUN_140209360`，tex != A.tex），脚本手里的对象作废（P6e 点 3）
      if (this.userCrop(slot)) state.dropTextureAnimation(runtime.object);
      this.rebuildLayer(runtime, state, worlds, { force: true });
      rebuilt.add(runtime.object);
      if (before && this.layerTargets.get(runtime.object) !== before) resized.add(runtime.object);
      // WPE 重建合成 RT 与 fbo（内容丢失），带 `clear` 的 fbo 回到清屏色
      encoder ??= this.device.createCommandEncoder({ label: "user texture clear" });
      this.clearLayerFbos(encoder, runtime);
    }
    if (encoder) this.device.queue.submit([encoder.finish()]);
    for (const draw of this.draws) {
      // 粒子 draw（P11b2）同样重绑：槽 0 换图 / 清空后对象级重编译是异步的，换上之前这几帧旧粒子层要先绑到新的纹理（清空时落回缺省），
      // 否则下面释放掉的用户纹理还在它的 bind group 里（`Destroyed texture used in a submit`）
      if ((draw.step.kind !== "draw" && draw.step.kind !== "particles") || rebuilt.has(draw.object)) continue;
      const named = draw.userNames.some((name) => names.has(name));
      const referencing =
        resized.size > 0 && Object.values(draw.step.inputs).some((ref) => this.refersToLayer(ref, resized));
      if (named || referencing) this.rebindDrawInputs(draw, state, worlds);
    }
    this.releaseUnusedUserTextures();
  }

  /**
   * 被依赖图层换了独占 RT（L6b，单对象重编译替换它、形状变了）：引用它的 draw 的 bind group 烤着旧那张的句柄，重绑并按新尺寸重写
   * `g_Texture<n>Resolution`。它自己的 draw 刚建好、已按新的，跳过。
   */
  private rebindDependents(object: number, state: SceneState, worlds: Map<number, Mat4>): void {
    const objects = new Set([object]);
    for (const draw of this.draws) {
      if (draw.object === object || draw.step.kind !== "draw") continue;
      if (Object.values(draw.step.inputs).some((ref) => this.refersToLayer(ref, objects)))
        this.rebindDrawInputs(draw, state, worlds);
    }
  }

  /** 这个输入是不是被依赖图层 `objects` 之一的独占 RT（直接引用，或用户纹理的缺省）。 */
  private refersToLayer(ref: TextureRef, objects: ReadonlySet<number>): boolean {
    if (ref.kind === "user") return this.refersToLayer(ref.fallback, objects);
    return ref.kind === "layer" && objects.has(ref.object);
  }

  /**
   * 一个 draw 的输入纹理换了（不重建图层）：重算按槽的纹理尺寸，重建 bind group，重写 `g_Texture<n>Resolution` / `g_Texture<n>Texel`
   * 与颜色组（组合层 / instanced 的强制白）。粒子 draw（P11b2，槽 0 的用户纹理）同样重建 bind group、重写 `g_Texture<n>Resolution`
   * （模型矩阵取这个 draw 上次写的 `particles.model`，只挑纹理尺寸与材质常量写回）；网格的 draw 不处理。
   * 用在用户纹理换图（P11b）与被依赖图层换了独占 RT（L6b）两处；反射副本的 bind group 跟着主 draw 的换（`reflectionCopyOf` 比 `source`）。
   */
  private rebindDrawInputs(draw: Draw, state: SceneState, worlds: Map<number, Mat4>): void {
    const { step, program } = draw;
    if (step.kind !== "draw" && step.kind !== "particles") return;
    const slots = Math.max(10, ...program.textures.map((t) => t.slot + 1));
    draw.textureSizes = Array.from({ length: slots }, (_, slot) => this.inputSize(step.inputs[slot], draw.resources));
    // GIF / 视频的帧来源可能随换值变了（`userGpuOf` 已按新对象重建 GPU 纹理）：重算这个 draw 要上传的
    draw.userAnimations = this.userAnimationsOf(program, step.inputs);
    // 引用 fbo 的 draw 按 swap 状态各缓存一份 bind group，一起作废；静态的重建一份
    draw.bindGroups.clear();
    if (draw.bindGroup)
      draw.bindGroup = this.device.createBindGroup({
        label: draw.label,
        layout: draw.layout,
        entries: draw.entries((effect, name) => this.targets[draw.resources.fbos.resolve(effect, name)]),
      });
    const layerState = state.layers.get(draw.object);
    if (!draw.block || !layerState) return;
    const values = this.uniformValues(
      step,
      draw.layer,
      layerState,
      draw.textureSizes,
      state,
      worlds,
      draw.particles?.model ?? null,
    );
    const names = [
      ...layerRefreshNames(step.pass.uniforms),
      ...Object.keys(values).filter((name) => /^g_Texture\d+(?:Resolution|Texel)$/.test(name)),
    ];
    for (const name of names) {
      const value = values[name];
      if (value) draw.block.set(name, value);
    }
    draw.dirty = true;
  }

  /** 销毁没有槽引用的用户纹理：按全场 draw 的用户引用当前解析出的纹理名算「在用」。 */
  private releaseUnusedUserTextures(): void {
    if (!this.userGpu.size) return;
    const used = new Set<string>();
    for (const draw of this.draws)
      for (const ref of Object.values(draw.step.inputs)) {
        const crop = ref.kind === "user" ? this.userCrop(ref.slot) : null;
        if (crop) used.add(crop.key);
      }
    for (const [key, gpu] of this.userGpu)
      if (!used.has(key)) {
        this.targetBytes -= gpu.width * gpu.height * 4;
        this.release(gpu.texture);
        this.userGpu.delete(key);
      }
  }

  /**
   * 槽 0 换图后本层独占的尺寸相关资源换新尺寸（P11b 步骤 2，`rebuildLayer` 在建 draw 之前调，同文本层的 `ensureTextResources`）：
   * 合成 RT（来自共享池，尺寸变了就丢掉引用、`ensureComposites` 按新尺寸重借；共享池只增不减、没有「没人用就释放」的办法，旧尺寸的留在池里，
   * 只在换图频繁且尺寸各异时多占显存）、effect fbo（独占，原地换尺寸）、被依赖图层的
   * 独占 RT（释放旧的、按新尺寸建，`ensureComposites` 再接回第 0 张；引用它的 draw 由 `syncUserTextures` 重绑）。
   */
  private ensureUserSizing(runtime: LayerRuntime): void {
    const { layer, resources } = runtime;
    const [width, height] = this.compositeSizeOf(layer, [this.width, this.height]);
    if (resources.composites.some((target) => target.width !== width || target.height !== height))
      resources.composites.length = 0;
    const own = this.layerTargets.get(runtime.object);
    if (own && (own.width !== width || own.height !== height)) {
      this.releaseTarget(own);
      this.layerTargets.set(layer.object, this.createLayerTarget(layer));
      resources.composites.length = 0;
    }
    this.resizeTextFbos(runtime.object, [width, height]);
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
      if (!runtime) continue;
      const before = this.layerTargets.get(object);
      this.rebuildLayer(runtime, state, worlds, { force: true });
      // 被依赖的文本层排版换尺寸、独占 RT 换了（P8 步骤 6）：引用方的 bind group 与 `g_Texture<n>Resolution` 当帧重绑
      if (before && this.layerTargets.get(object) !== before) this.rebindDependents(object, state, worlds);
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

  private createAlternateTarget(dims?: readonly [number, number]): SceneTarget {
    return this.createSceneTarget("scene target 2", GPUTextureUsage.COPY_DST, dims);
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
     * `syncPipelines`（L7，结构变化的重排）：管线不在就绪表里时同步建（`preparedOfSync`；进出组只换管线状态、程序不变），建不出照抛；粒子层沿用
     * 现有的粒子树（模拟不重来，同 L6 的替换）。
     */
    options: { force?: boolean; syncPipelines?: boolean } = {},
  ): void {
    const plan = this.planOf(runtime.layer, state);
    const signature = planSignature(plan);
    // 组归属（L7）也比：子层进出组时计划签名不变，管线、uniform 与池化合成 RT 却变了
    const placement = this.placementOf(runtime.layer);
    if (!options.force && signature === runtime.signature && samePlacement(placement, runtime.placement)) return;
    const started = performance.now();
    // 开关组合太多，`prepareVariants` 只查 n + 2 份；全部开着的 effect 都没有绘制 pass 这类组合在这里才查得到
    const problems = planProblems(plan, this.bundle, runtime.layer.particle, runtime.layer.model, runtime.layer.puppet);
    if (problems.length) throw new SceneRenderError(problems);
    // 先取管线（缺了就抛，这时什么都还没换）；文本层再按新排版换独占的合成 RT、fbo 与图集，新 draw 才绑得到
    let prepared: Map<DrawLike, PreparedDraw>;
    try {
      prepared = this.preparedOf(plan, runtime);
    } catch (error) {
      const missing = error instanceof SceneRenderError && error.reasons.includes("render:variant-missing");
      // 结构变化的重排（L7）：缺的管线当帧同步建（已定 3，同 WPE）
      if (missing && options.syncPipelines) prepared = this.preparedOfSync(plan, runtime);
      // 脚本写过材质状态字段的图层：新组合的管线运行中现建（P6d1b），建好之前保持当前画面
      else if (missing && this.stateHasPassOverrides(state, runtime.layer)) {
        this.deferPassStatePipelines(runtime, plan);
        return;
      } else throw error;
    }
    if (runtime.layer.text) this.ensureTextResources(runtime, plan, state);
    else if (baseUserSlot(runtime.layer)) this.ensureUserSizing(runtime);
    const reuse = options.syncPipelines && runtime.layer.particle ? runtime.tree : null;
    const built = this.buildLayer(runtime, plan, prepared, state, worlds, reuse);
    for (const draw of runtime.draws) {
      this.draws.delete(draw);
      this.drawsByPass.delete(draw.passKey);
      // 网格的顶点 / 索引缓冲按视图共用（`meshBuffer`），随场景销毁，这里不释放；puppet 乘过 UV 的私有顶点缓冲例外（P12a）
      if (!draw.mesh || draw.mesh.privateVertices) this.release(draw.vertexBuffer);
      if (draw.mesh?.ordered) this.release(draw.mesh.indexBuffer);
      if (draw.uniformBuffer) this.release(draw.uniformBuffer);
      if (draw.text) this.release(draw.text.indexBuffer);
      const copy = this.reflectionCopies.get(draw);
      if (copy) {
        this.release(copy.buffer);
        this.reflectionCopies.delete(draw);
      }
    }
    this.install(runtime, built);
    runtime.signature = signature;
    runtime.placement = placement;
    if (options.force) return;
    const elapsed = performance.now() - started;
    this.rebuildStats.count++;
    this.rebuildStats.totalMs += elapsed;
    this.rebuildStats.maxMs = Math.max(this.rebuildStats.maxMs, elapsed);
  }

  /** 状态里有这个图层的 pass 的材质状态覆盖（P6d1b）。 */
  private stateHasPassOverrides(state: SceneState, layer: SceneLayer): boolean {
    return applyPassStates(layer, state.passStates) !== layer;
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
  /**
   * MSDF 字形的装饰参数与字号（P6f）：本层排版是 MSDF 画法时给，参数取状态里的当前值（`SceneState.textFields`，属性就地写、当帧生效），没有就取编译期的；
   * 字号取排版结果里钳过的（`TextMesh.pointsize`，WPE `M+0xa8`）。
   */
  private msdfInput(layer: SceneLayer, state: SceneState): { decor: TextDecor; pointsize: number } | undefined {
    const mesh = state.texts.get(layer.object)?.mesh;
    if (!mesh?.msdf) return undefined;
    const decor = state.textFields.get(layer.object)?.decor ?? layer.text?.fields.decor;
    return decor ? { decor, pointsize: mesh.pointsize } : undefined;
  }

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
    // MSDF 字形：装饰参数变了（属性就地写）重算 `g_RenderVar0..3`
    if (draw.step.kind === "text" && draw.step.part === "glyphs") names.push(...MSDF_RENDER_VAR_NAMES);
    // 朝向由模型矩阵算（P4c 步骤 5），对象变换变了一起重写；材质值同样优先
    if (draw.particles) names.push(...PARTICLE_REFRESH_UNIFORMS.filter((name) => !(name in draw.step.pass.uniforms)));
    for (const name of names) {
      const value = values[name];
      if (value) draw.block.set(name, value);
    }
    draw.dirty = true;
    this.refreshReflection(draw, state, worlds, model);
  }

  /**
   * 画一个 sprite（P13c，rea-p13-lights 4.2）：计算 pass（按计数缓冲里上一帧的样本数算 k、写进光斑的 uniform 缓冲）→ 光斑 → 计数 pass（读场景
   * 深度）→ 遮挡方块。两个计算 / 计数 pass 都要先结束场景 pass。只在画进真正的场景目标、场景有深度附件时计数（组里的 sprite 照报
   * `model:passthrough:children:sprite`，强制渲染时不计数，光斑按 k = 0）。
   */
  private encodeSprite(
    encoder: GPUCommandEncoder,
    object: number,
    draws: readonly Draw[],
    hooks: {
      scene: () => GPURenderPassEncoder;
      end: () => void;
      draw: (pass: GPURenderPassEncoder, item: Draw) => void;
    },
    counted: boolean,
  ): void {
    const occlusion = draws.find((item) => item.step.kind === "mesh" && item.step.occlusion);
    const counter = occlusion && counted && this.depthTarget ? this.spriteCounter(object, occlusion) : null;
    for (const item of draws) {
      const isOcclusion = item === occlusion;
      if (counter && !isOcclusion && item.uniformBuffer && item.block) {
        hooks.end();
        counter.encodeScale(
          encoder,
          {
            buffer: item.uniformBuffer,
            up: item.block.offsetOf("g_ViewUp"),
            right: item.block.offsetOf("g_ViewRight"),
            alpha: item.block.offsetOf("g_Alpha"),
          },
          this.height * this.height,
          this.view.viewVectors,
        );
      }
      if (counter && isOcclusion && item.mesh && this.depthTarget) {
        hooks.end();
        counter.encodeCount(encoder, this.depthTarget.view, this.spriteCountTarget(), {
          bindGroup: this.bindGroupOf(item),
          vertexBuffer: item.vertexBuffer,
          placeholder: item.mesh.placeholder,
          indexBuffer: item.mesh.indexBuffer,
          indexFormat: item.mesh.indexFormat,
          count: item.mesh.count,
        });
      }
      hooks.draw(hooks.scene(), item);
    }
  }

  /** sprite 的计数器（第一次画到时按遮挡方块的程序与顶点布局建）。 */
  private spriteCounter(object: number, occlusion: Draw): SpriteCounter {
    let counter = this.spriteCounters.get(object);
    if (!counter) {
      counter = new SpriteCounter(
        this.device,
        {
          program: occlusion.program,
          layout: occlusion.layout,
          vertexBuffers: this.meshLayoutOf(occlusion.layer, occlusion.step as MeshStep).buffers,
        },
        (buffer) => this.own(buffer),
        `layer ${occlusion.layer.id} sprite`,
      );
      this.spriteCounters.set(object, counter);
    }
    return counter;
  }

  private spriteCountTarget(): GPUTextureView {
    if (!this.spriteTarget) {
      const made = this.createSpriteTarget([this.width, this.height]);
      this.spriteTexture = made.texture;
      this.spriteTarget = made.view;
    }
    return this.spriteTarget;
  }

  /** 计数 pass 的颜色目标按 `dims` 建（建场景时懒建与 `resize` 共用）。 */
  private createSpriteTarget([width, height]: readonly [number, number]): {
    texture: GPUTexture;
    view: GPUTextureView;
  } {
    const texture = this.own(
      this.device.createTexture({
        label: "sprite count target",
        size: { width, height },
        format: SPRITE_COUNT_TARGET_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
    );
    this.targetBytes += width * height;
    return { texture, view: texture.createView() };
  }

  /**
   * 各 sprite 计数缓冲里的样本数（dev 探针，P13c 走查）：已提交的帧里最近一次计数 pass 数到的 n，按 `objects` 下标排。还没画到过的 sprite
   * 没有计数器、不列。
   */
  async spriteSamples(): Promise<{ object: number; samples: number }[]> {
    const out: { object: number; samples: number }[] = [];
    for (const [object, counter] of [...this.spriteCounters].sort(([a], [b]) => a - b))
      out.push({ object, samples: await counter.readSamples() });
    return out;
  }

  /** 平面反射 pass 的视图（P13b2，`views.ts`）：透视场景 S·VP·S，正交场景 VP 不变；两者都翻 eye、right、up 的 y。 */
  private reflectedView(): SceneView {
    return mirroredView(this.view, !this.bundle.general.perspective);
  }

  /**
   * 这个 draw 进不进平面反射 pass（P13b2）：对象在名单里、画到场景目标、不在组里、不读反射图（同一纹理不能既采样又作附件），而且是模型网格、
   * 粒子、文本，或图像层的直接上屏（`direct`）。名单里别的种类编译期已照报（`compile/reflection.ts`）。
   */
  private reflects(draw: Draw): boolean {
    if (!this.reflected(draw.object)) return false;
    const { step } = draw;
    if (step.target.kind !== "scene" || draw.layer.group != null) return false;
    if (Object.values(step.inputs).some((ref) => ref.kind === "reflection")) return false;
    if (step.kind === "mesh" || step.kind === "particles" || step.kind === "text") return true;
    return step.kind === "draw" && step.role === "direct";
  }

  /** 按反射视图重算副本的相机项（P13b2）：主 draw 刷新时调（`refreshLayer`）；还没有副本的 draw 不算，建副本时再算。 */
  private refreshReflection(draw: Draw, state: SceneState, worlds: Map<number, Mat4>, model: Mat4 | null): void {
    const copy = this.reflectionCopies.get(draw);
    const layerState = state.layers.get(draw.object);
    if (!copy || !draw.block || !layerState) return;
    const values = this.uniformValues(
      draw.step,
      draw.layer,
      layerState,
      draw.textureSizes,
      state,
      worlds,
      model,
      this.reflectedView(),
    );
    const overlay: Record<string, number[]> = {};
    for (const name of REFLECTION_CAMERA_UNIFORMS) {
      const value = values[name];
      if (value && draw.block.has(name) && !(name in draw.step.pass.uniforms)) overlay[name] = value;
    }
    copy.overlay = overlay;
  }

  /**
   * 一个 draw 的反射副本（P13b2）：第一次画到时建（块与主块同布局，相机项按反射视图算），之后复用；bind group 与主 draw 相同、只换
   * binding 0，主 draw 换了 bind group 就重建。每次调用把主块拷过来、盖上相机项、上传。没有 uniform 块的 draw 返回 null（直接用主
   * draw 的 bind group）。
   */
  private reflectionCopyOf(draw: Draw, state: SceneState, worlds: Map<number, Mat4>): ReflectionCopy | null {
    if (!draw.block || !draw.program.uniformSize) return null;
    let copy = this.reflectionCopies.get(draw);
    if (!copy) {
      const block = new UniformBlock((draw.program.result.uniforms ?? []) as UniformEntry[], draw.program.uniformSize);
      const buffer = this.own(
        this.device.createBuffer({
          label: `${draw.label} reflection`,
          size: block.data.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      traceUniforms(buffer, (draw.program.result.uniforms ?? []) as UniformEntry[]);
      copy = { block, buffer, overlay: {}, source: null, bindGroup: null };
      this.reflectionCopies.set(draw, copy);
      this.refreshReflection(draw, state, worlds, draw.particles?.model ?? null);
    }
    const main = this.bindGroupOf(draw);
    if (copy.source !== main) {
      copy.bindGroup = this.createReflectionGroup(draw, copy);
      copy.source = main;
      copy.groups = undefined;
    }
    // 每帧：主块（已含这一帧的每帧量与刷新）拷过来，盖上反射视图的相机项，排在本帧提交之前上传
    new Uint8Array(copy.block.data).set(new Uint8Array(draw.block.data));
    for (const [name, value] of Object.entries(copy.overlay)) copy.block.set(name, value);
    this.device.queue.writeBuffer(copy.buffer, 0, copy.block.data);
    return copy;
  }

  /** 反射副本的 bind group：同主 draw 的绑定，只把 binding 0 换成副本自己的 uniform 缓冲。 */
  private createReflectionGroup(draw: Draw, copy: ReflectionCopy): GPUBindGroup {
    const buffer = copy.buffer;
    const entries = draw
      .entries((effect, name) => this.targets[draw.resources.fbos.resolve(effect, name)])
      .map((entry) => (entry.binding === 0 ? { binding: 0, resource: { buffer } } : entry));
    return this.device.createBindGroup({ label: `${draw.label} reflection`, layout: draw.layout, entries });
  }

  /**
   * 反射 pass 里一个 draw 的 bind group：多图像帧表（P6e 点 4）要在 `bindSheets` 选完格之后按图像号取（建副本时的那个是上一帧的图像），
   * 其余照旧用 `reflectionCopyOf` 给的。
   */
  private reflectionGroupOf(
    draw: Draw,
    reflection: { bindGroup: GPUBindGroup; copy: ReflectionCopy | null },
  ): GPUBindGroup {
    const { copy } = reflection;
    if (!copy || !draw.multiImage.length) return reflection.bindGroup;
    const key = this.imageKey(draw, "");
    const groups = (copy.groups ??= new Map());
    let group = groups.get(key);
    if (!group) groups.set(key, (group = this.createReflectionGroup(draw, copy)));
    return group;
  }

  /**
   * 帧表纹理的选格与 uniform（P6e 点 2，rea-p6e-sheet 2.2、2.3）：对这个 draw 程序真的绑定的每个帧表纹理槽 `s`，按共享计时器取格（本渲染帧第一次
   * 用到这张纹理时用本帧 `g_Frametime` 推进，同帧再用 dt = 0；`sheetOverride` 给了脱离帧号时都画那一格、不推进），把
   * `g_Texture<s>Rotation` / `Translation` 写进这个 draw 的 uniform（只写程序声明了的名字，同 WPE 只给用到的槽）并上传（排在本帧提交之前）。
   * `encode` 的 `draw` 闭包在确定要画之后才调它：不可见的图层、被剔除的模型、没有存活粒子的系统都到不了这里，也就不碰计时器——WPE 实测
   * （`p6e-shared`）同一张纹理两个图层一隐一显时隐的回来与显的同格，两个都隐时回来接着隐藏前那一格走、不补时间。合成路径里（effect 链、puppet、
   * 组）用到同一张纹理的 pass 各自调一次，同帧共用同一格。`copy` 是平面反射 pass 的副本块（它的 uniform 是自己的缓冲）。
   * 多图像帧表（点 4）：选格时再记下每个多图像槽这格所在的图像号（`Draw.sheetImages`），`bindGroupOf` 据此换绑。
   */
  private bindSheets(draw: Draw, copy: ReflectionCopy | null): void {
    let slots = this.sheetSlots.get(draw);
    if (!slots) {
      slots = [];
      for (const binding of draw.program.textures) {
        const ref = draw.step.inputs[binding.slot];
        if (ref?.kind === "texture" && this.bundle.textures[ref.index]?.frames)
          slots.push({ slot: binding.slot, index: ref.index });
      }
      this.sheetSlots.set(draw, slots);
    }
    if (!slots.length) return;
    const override = this.sheetOverride(draw.object);
    const block = copy ? copy.block : draw.block;
    const buffer = copy ? copy.buffer : draw.uniformBuffer;
    let written = false;
    for (const { slot, index } of slots) {
      const sheet = this.bundle.textures[index].frames!;
      let clock = this.sheetClocks.get(index);
      if (!clock) this.sheetClocks.set(index, (clock = newSheetClock()));
      const frame = sheet.frames[sheetFrameFor(clock, sheet, this.sheetFrameNo, this.sheetDt, override)];
      // 多图像帧表（P6e 点 4）：记下这格所在的图像，之后 `bindGroupOf` 绑那张图像的纹理。同帧里所有用这张纹理的 draw 取同一格、同一张图像。
      // `image` 越界（负数或 ≥ 图像数）时 WPE 不检查，这里按 0 处理（编译期越界帧的坐标已是 0，`readFrames`）
      if (draw.multiImage.includes(slot)) {
        const count = (this.extraTextures.get(index)?.length ?? 0) + 1;
        draw.sheetImages.set(slot, frame.image >= 0 && frame.image < count ? frame.image : 0);
      }
      if (!block) continue;
      if (block.has(`g_Texture${slot}Rotation`)) {
        block.set(`g_Texture${slot}Rotation`, frame.rotation);
        written = true;
      }
      if (block.has(`g_Texture${slot}Translation`)) {
        block.set(`g_Texture${slot}Translation`, frame.translation);
        written = true;
      }
    }
    if (written && block && buffer) this.device.queue.writeBuffer(buffer, 0, block.data);
  }

  /** 图层脱离帧号的来源（`sheetOverride`）：脚本 `ITextureAnimation`（P6e 点 3）接上；null 恢复成一律 −1。 */
  setSheetOverrides(source: ((object: number) => number) | null): void {
    this.sheetOverride = source ?? (() => -1);
  }

  /** 帧表纹理的共享计时器快照（dev 探针 / 测试读）：键是 bundle 纹理下标。 */
  sheetClockOf(index: number): Readonly<SheetClock> | undefined {
    return this.sheetClocks.get(index);
  }

  /** 反射副本的管线（P13b2）：LDR 用主管线；HDR 取加载时备好的 rgba8unorm 那份（`prepareLayer`），缺了说明备漏了。 */
  private reflectionPipeline(draw: Draw): GPURenderPipeline {
    if (!this.hdr) return draw.pipeline;
    const pipeline = this.readyPipelines.get(
      pipelineKey({ ...this.pipelineOf(draw.step, draw), format: REFLECTION_TARGET_FORMAT }),
    );
    if (!pipeline) throw new SceneRenderError(["render:variant-missing"]);
    return pipeline;
  }

  /** 材质常量变化：重写本 pass 的全部材质常量（含用户属性写进 `constantshadervalues` 的那些）。 */
  private refreshPass(draw: Draw, state: SceneState): void {
    const constants = state.constants.get(draw.passKey);
    if (!draw.block || !constants) return;
    for (const [name, values] of Object.entries(constants)) draw.block.set(name, values);
    draw.dirty = true;
  }

  /** 环境光与雾（P13f）变化：只写块里有、材质没覆盖的名字；都没有时不标脏，脚本逐帧写时不重传无关的缓冲。 */
  private refreshLights(draw: Draw, state: SceneState): void {
    const { block, step } = draw;
    if (!block) return;
    for (const [name, key] of Object.entries(LIGHT_UNIFORMS)) {
      if (!block.has(name) || name in step.pass.uniforms) continue;
      block.set(name, state.general[key]);
      draw.dirty = true;
    }
    if (!FOG_UNIFORMS.some((name) => block.has(name))) return;
    for (const [name, value] of Object.entries(fogUniforms(state.general))) {
      if (!block.has(name) || name in step.pass.uniforms) continue;
      block.set(name, value);
      draw.dirty = true;
    }
  }

  /**
   * 阴影 pass 的投射者（P13d，rea-p13-passes 2.6、2.7，rea-p13-shadows R5、R6）：`castShadow` 的模型的每个网格的投射变体（`SceneMesh.shadow`）
   * 建一个 draw，走 `createDraw`（顶点布局、索引、纹理、材质常量、骨骼同网格步骤），管线是只写深度的 `createShadowPipeline`。draw 经 `indexDraw` 进索引，
   * 每帧的量（`g_Time`、骨骼）随 `update` 写；按图集条目各一份 uniform 副本（`g_ModelMatrix` 每帧按当前状态、`g_ViewportViewProjectionMatrices`
   * 是这一条的视图），逐视图 `firstInstance` 取视图号。`fur4` 的投射变体不带 `INSTANCECOUNT`，只画基础网格一层（R6）。
   * 帧级剔正面（`alignmentfliph`）在我们这里没有接，剔除一律 NONE（WPE 材质缺省剔除时的实际状态）。
   * 整场加载时在变体之后逐对象跑（L4：单个对象的同一段是 `prepareObject` 备管线、`installObject` 建 draw）。
   */
  async buildShadowCasters(state: SceneState): Promise<void> {
    if (!this.shadowAtlas) return;
    for (const runtime of [...this.layers]) {
      const shadows = await this.prepareShadowCasters(runtime.layer);
      if (shadows.length) this.installShadowCasters(runtime, shadows, state);
    }
  }

  /**
   * 一个图层的投射者步骤（L4，原 `buildShadowCasters` 的循环体前半）：有阴影图集、模型 `castShadow` 时，每个有投射变体与索引的网格一步。投射
   * 着色器的 `morph` 槽按注解的 `material` 键找（程序的反射就是 `bundle.programs` 里那一份），认不出的运行时名字抛 `SceneRenderError`。
   */
  private shadowCasterSteps(layer: SceneLayer): { step: MeshStep; layout: MeshVertexLayout; a2c: boolean }[] {
    const model = layer.model;
    if (!this.shadowAtlas || !model?.castShadow) return [];
    const out: { step: MeshStep; layout: MeshVertexLayout; a2c: boolean }[] = [];
    for (const [m, mesh] of model.meshes.entries()) {
      const pass = mesh.shadow;
      if (!pass || pass.program === null || !mesh.indexCount) continue;
      const morphSlot = this.bundle.programs[pass.program]?.textures?.find((t) => t.meta?.material === "morph")?.slot;
      const { inputs, reasons } = shadowCasterInputs(
        pass,
        model.skeleton?.morphs[m] && morphSlot !== undefined
          ? { slot: morphSlot, object: layer.object, mesh: m }
          : null,
      );
      if (reasons.length) throw new SceneRenderError(reasons);
      const step: MeshStep = {
        kind: "mesh",
        mesh: m,
        pass,
        target: { kind: "scene" },
        inputs,
        blending: pass.blending,
        raster: rasterState(pass, pass, pass.blending),
      };
      out.push({ step, layout: this.meshLayoutOf(layer, step), a2c: pass.blending === "alphatocoverage" });
    }
    return out;
  }

  /** 一个图层的投射者的程序与管线（L4，异步，逐个网格 await，同以前）。 */
  private async prepareShadowCasters(layer: SceneLayer): Promise<ShadowCasterPrep[]> {
    const out: ShadowCasterPrep[] = [];
    for (const { step, layout, a2c } of this.shadowCasterSteps(layer)) {
      const program = await this.ensureProgram(step.pass.program!);
      out.push({ step, program, pipeline: await this.shadowPipelineFor(program, layout, a2c) });
    }
    return out;
  }

  /** `prepareShadowCasters` 的同步版（L4，`prepareObjectSync`）：缺程序或建不了管线（A2C）时 null。 */
  private prepareShadowCastersNow(
    steps: readonly { step: MeshStep; layout: MeshVertexLayout; a2c: boolean }[],
  ): ShadowCasterPrep[] | null {
    const out: ShadowCasterPrep[] = [];
    for (const { step, layout, a2c } of steps) {
      const program = this.readyPrograms.get(step.pass.program!);
      if (!program) return null;
      const key = shadowPipelineKey(program, layout, a2c);
      let pipeline = this.readyShadowPipelines.get(key) ?? null;
      if (!pipeline && !a2c) {
        const made = this.capturePipeline((device) =>
          createShadowPipeline(device, program, layout.buffers, "none", false, SHADOW_ATLAS_FORMAT),
        );
        if (made) {
          this.shadowPipelines.set(key, made.promise);
          this.readyShadowPipelines.set(key, (pipeline = made.pipeline));
        }
      }
      if (!pipeline) return null;
      out.push({ step, program, pipeline });
    }
    return out;
  }

  /** 投射者的管线（L4 起按键缓存，同 `pipelineFor`）：没有颜色附件、深度是阴影图集，剔除 NONE。 */
  private shadowPipelineFor(program: GpuProgram, layout: MeshVertexLayout, a2c: boolean): Promise<GPURenderPipeline> {
    const key = shadowPipelineKey(program, layout, a2c);
    let pipeline = this.shadowPipelines.get(key);
    if (!pipeline) {
      pipeline = createShadowPipeline(this.device, program, layout.buffers, "none", a2c, SHADOW_ATLAS_FORMAT).then(
        (ready) => {
          this.readyShadowPipelines.set(key, ready);
          return ready;
        },
      );
      this.shadowPipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** 装上一个图层的投射者（L4，原 `buildShadowCasters` 的循环体后半）：建 draw、进索引、进 `shadowCasters` 与归属表。 */
  private installShadowCasters(runtime: LayerRuntime, shadows: readonly ShadowCasterPrep[], state: SceneState): void {
    const worlds = new Map<number, Mat4>();
    for (const { step, program, pipeline } of shadows) {
      const draw = this.createDraw(runtime.layer, step, runtime.resources, { program, pipeline }, state, worlds);
      this.indexDraw(draw);
      const record: ShadowCasterRecord = { object: runtime.object, draw, copies: new Map() };
      const caster = this.shadowCasterOf(record);
      this.shadowCasters.push(caster);
      this.shadowCasterRecords.set(caster, record);
    }
  }

  /** 一个投射者 draw 的逐条目副本（同反射副本的做法，`reflectionCopyOf`）；副本记在 `record.copies`，卸对象时释放。 */
  private shadowCasterOf({ draw, object, copies }: ShadowCasterRecord): ShadowCasterDraw {
    return {
      prepare: (entry: number, views: readonly ShadowView[]) => {
        if (!draw.block) return;
        let copy = copies.get(entry);
        if (!copy) {
          const block = new UniformBlock(
            (draw.program.result.uniforms ?? []) as UniformEntry[],
            draw.program.uniformSize,
          );
          const buffer = this.own(
            this.device.createBuffer({
              label: `${draw.label} shadow ${entry}`,
              size: block.data.byteLength,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
          );
          traceUniforms(buffer, (draw.program.result.uniforms ?? []) as UniformEntry[]);
          const entries = draw
            .entries((effect, name) => this.targets[draw.resources.fbos.resolve(effect, name)])
            .map((item) => (item.binding === 0 ? { binding: 0, resource: { buffer } } : item));
          const bindGroup = this.device.createBindGroup({
            label: `${draw.label} shadow ${entry}`,
            layout: draw.layout,
            entries,
          });
          copy = { block, buffer, bindGroup };
          copies.set(entry, copy);
        }
        new Uint8Array(copy.block.data).set(new Uint8Array(draw.block.data));
        const state = this.encodingState;
        if (state && copy.block.has("g_ModelMatrix"))
          copy.block.set("g_ModelMatrix", worldMatrixOf(object, state.layers, new Map()));
        const matrices = new Float32Array(16 * 6);
        views.forEach((view, index) => matrices.set(view.viewProjection, index * 16));
        if (copy.block.has(SHADOW_CASTER_UNIFORM)) copy.block.set(SHADOW_CASTER_UNIFORM, matrices);
        this.device.queue.writeBuffer(copy.buffer, 0, copy.block.data);
      },
      draw: (pass: GPURenderPassEncoder, entry: number, view: number) => {
        const mesh = draw.mesh;
        if (!mesh) return;
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(0, copies.get(entry)?.bindGroup ?? this.bindGroupOf(draw));
        pass.setVertexBuffer(0, draw.vertexBuffer);
        if (mesh.placeholder) pass.setVertexBuffer(1, mesh.placeholder);
        pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
        pass.drawIndexed(mesh.count, 1, 0, 0, view);
      },
    };
  }

  /**
   * 这一帧的灯光数组（P13d，`compile/lights.ts` 的 `lightFrame`）：按当前视图的 `g_ViewForward` 给灯排序、照 WPE 写整块灯光缓冲；有阴影
   * 图集时打包、算阴影视图并把投影与方块变换写进同一块（`ShadowAtlas.frame`）。WPE 在相机与脚本之后、反射与主 pass 之前算（帧函数
   * `0x14018031a`），我们的 `update` 在 `setCamera` 之后，同序。没有灯（`bundle.lights` 缺）时为空。
   */
  private frameLightValues(input: FrameInput, state?: SceneState): Record<string, number[]> {
    // P13f2：灯记录每帧按状态现组（`render/lights.ts`）；`state` 没给时（探针的部分调用）用最近一次 `sync` 的
    const current = state ?? this.lightState;
    if (state) this.lightState = state;
    let values: Record<string, number[]> = {};
    // 遗留灯（P13f2）：WPE 在动画与脚本之前写（`p13f-light` 的 L1：晚一帧）。这一帧画上一帧末算好的值，再按现在（本帧脚本之后）的状态算
    // 下一帧的；同一帧多次 `update`（探针）不换代，按帧时刻判
    if (this.bundle.legacyLights) {
      if (input.time !== this.legacyTime) {
        this.legacyTime = input.time;
        this.legacyCurrent = this.legacyNext;
      }
      if (current) this.legacyNext = this.legacyFrame(current);
      values = { ...(this.legacyCurrent ?? this.legacyNext ?? {}) };
    }
    const lights = this.bundle.lights;
    if (!lights || !current) return values;
    const forward = this.view.viewVectors.forward;
    // 被删的灯不在 `state.layers` 里，不再参与排序与写缓冲（P6d3）
    const records = lightRecords(this.bundle.lightObjects ?? [], current, new Map(), this.attachHook);
    const frame = lightFrame(records, lights.counts, lights.quality, forward);
    this.shadowAtlas?.frame(frame, forward, this.view.eye);
    this.lightFrameCache = frame;
    return { ...values, ...lightFrameUniforms(frame) };
  }

  /** 遗留灯的三个数组（P13f2，`legacyLightFrame`）按这份状态算。 */
  private legacyFrame(state: SceneState): Record<string, number[]> {
    return legacyLightFrame(legacyLightInputs(this.bundle.lightObjects ?? [], state, new Map(), this.attachHook));
  }

  /**
   * 写每帧变化的 uniform（`g_Time` 等）；被就地改过的 draw 整块重写一次。不步进粒子：粒子由调用方在脚本之前先
   * `stepParticles`（P4c 步骤 4，见那里），这里只写 uniform。`state` 不读，留着和调用方的写法对称。
   * ropetrail（P4d 步骤 2）的 `g_RenderVar0` 每帧按系统当时的计时器写（`trailRenderVar0`，WPE 每次绘制前写，rea-p4d-rope.md
   * 第 4 节）：步进在前，所以是本帧采样之后的计时器。
   */
  update(frame: FrameInput, state?: SceneState): void {
    const values = (this.frameValues = { ...frameBuiltins(frame), ...this.frameLightValues(frame, state) });
    this.sheetDt = frame.frametime;
    for (const draw of this.draws) {
      if (!draw.block || !draw.uniformBuffer) continue;
      if (!draw.frameNames.length && !draw.dirty && !draw.trailRenderVar && draw.puppet === null) continue;
      this.applyFrame(draw, values);
      // skinned puppet（P12a 步骤 4）：每帧把当前蒙皮矩阵写进 `g_Bones`（同 `trailRenderVar` 的做法，这类 draw 每帧都写）
      if (draw.puppet !== null) this.writePuppetUniforms(draw.block, draw.layer, draw.step);
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
    if (values)
      for (const name of draw.frameNames) {
        const value = values[name];
        if (value) draw.block.set(name, value);
      }
    const particles = draw.trailRenderVar ? draw.particles : null;
    // 这次绘制自己的 ropetrail（P4f 步骤 4）；计时器是系统的
    const ropetrail = particles?.renderer?.ropetrail;
    if (particles?.system.trail && ropetrail)
      draw.block.set("g_RenderVar0", trailRenderVar0(ropetrail, particles.system.trail.timer));
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
    // 渲染帧号（共享计时器去重用）：每帧恰好一次，补画帧（帧时间 0）也算一帧、只是 dt 为 0
    this.sheetFrameNo++;
    if (!(frametime > 0)) return;
    // 脱离的图层私有推进（P6e 点 3，WPE 帧函数第 2 步图像层更新的末尾）：不看可见性、不看这张纹理本帧画不画
    if (state)
      advanceTextureAnimations(state.textureAnimations, frametime, (object) => layerSheet(this.bundle, object)?.sheet);
    // 对象更新循环（WPE `FUN_1401891a0`，p12-lag，B1）：本帧号加一，蒙皮 puppet 与粒子层按 objects 顺序各取一次世界矩阵（不看可见性：
    // 隐藏的 puppet 照推进、粒子照更新控制点）；挂点对象在这里每帧重算、戳 = 本帧号，渲染阶段（`drawPhase`）据此沿用这里的值
    if (this.stamps && state) {
      this.drawSeeds = null; // 上一帧渲染阶段的预置到此作废（`liveSeeds`）
      this.stamps.invalidate(state.takeTransformWrites());
      this.stamps.nextFrame();
      const updated = new Set<number>(this.trees.keys());
      for (const layer of this.bundle.layers)
        if (layer.puppet?.skeleton || layer.model?.skeleton) updated.add(layer.object);
      const byOrder = byPosition(this.structure(state).position);
      for (const object of [...updated].sort(byOrder))
        this.stamps.evaluate(object, state.layers, this.hasAttachment, this.attachHook);
      this.stampUpdated = true;
    }
    const worlds = new Map<number, Mat4>();
    let pointer: [number, number] | null = null;
    // 一个粒子层若干次绘制共用一棵系统树（P4e 步骤 1、2）：只步进根（子系统与事件实例由它递归），每棵树一次，图层顺序；步进后这一层的
    // 全部粒子绘制都标 `stale`（实例化的 draw 每帧都可能换实例，一起标）。交给根的控制点输入记进 `tree.inputs`，本帧脚本
    // `emitParticles` 用同一份（P4f 步骤 3）
    // 按对象表顺序（P6d3：`sortLayer` 之后与 WPE 一致；没排过序时就是 `objects` 顺序，与建树顺序相同）
    const treeOrder = state ? byPosition(this.structure(state).position) : null;
    const trees = treeOrder
      ? [...this.trees.values()].sort((a, b) => treeOrder(a.object, b.object))
      : this.trees.values();
    for (const tree of trees) {
      const root = tree.system;
      const object = tree.object;
      if (state && !effectiveVisible(object, state.layers)) {
        // 不可见时控制点照常更新（P4d 步骤 5，rea-p4d-modules.md 5.3）：`W` 与跟随点照可见时的算法算
        const world = worldMatrixOf(object, state.layers, worlds, this.attachHook);
        pointer ??= pointerScenePoint(this.cursorViewProjection(), cursor);
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
      const world = state ? worldMatrixOf(object, state.layers, worlds, this.attachHook) : tree.world;
      pointer ??= pointerScenePoint(this.cursorViewProjection(), cursor);
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
   * skinned puppet 的蒙皮矩阵来源（P12a 步骤 4）：渲染器换上场景时交来（`SceneRenderer.load`，宿主的 `ScenePuppets`）；dev 探针的确定性回放
   * 换上自己的。`update` 每帧把 `skin(图层)` 写进对应 draw 的 `g_Bones`；null 时保持原值（建 draw 时是 0）。
   */
  setPuppets(puppets: PuppetSource | null): void {
    this.puppets = puppets;
  }

  /**
   * 渲染阶段（WPE `FUN_140190c80`，B1）：关键帧动画与脚本之后调。消费变换写入，画出来的对象（自身与父链可见、有 draw）按 objects 顺序各取
   * 一次世界矩阵；挂点子树里画出来的对象的结果留给下一次 `sync` 预置（绘制沿用更新阶段的缓存，见 `WorldStamps`）。返回是否有预置（调用方据此
   * 决定要不要再 `sync`）。没有挂点、本帧没走过更新阶段（补画帧）时返回 false。绘制顺序取 objects 顺序，透视场景的透明排序与组的子层顺序不管
   * （挂点父必定排在子前面，顺序只影响更深的祖先，语料没有这种组合）。
   */
  drawPhase(state: SceneState): boolean {
    const stamps = this.stamps;
    if (!stamps || !this.stampUpdated) return false;
    this.stampUpdated = false;
    stamps.invalidate(state.takeTransformWrites());
    const attached = new Set(this.attachedList(state));
    const seeds = new Map<number, Mat4>();
    for (const object of [...state.layers.keys()].sort(byPosition(this.structure(state).position))) {
      if (!this.drawsByLayer.get(object)?.length || !effectiveVisible(object, state.layers)) continue;
      const world = stamps.evaluate(object, state.layers, this.hasAttachment, this.attachHook);
      if (attached.has(object)) seeds.set(object, world);
    }
    this.drawSeeds = seeds.size ? seeds : null;
    return seeds.size > 0;
  }

  /**
   * 渲染阶段预置的有效值（B1）：`sync` 与 `encode` 共用，不取走（暂停时的补画帧不走 `drawPhase`，仍要沿用，否则画面从滞后跳成不滞后）。
   * `drawPhase` 之后又有变换写入（两帧之间或暂停时改了祖先的属性）时作废、退回现算：WPE 里写过的对象戳为 0、渲染时重算，同此。
   */
  private liveSeeds(state: SceneState): ReadonlyMap<number, Mat4> | null {
    if (!this.drawSeeds) return null;
    if (state.hasTransformWrites()) {
      this.drawSeeds = null;
      return null;
    }
    return this.drawSeeds;
  }

  /** 挂点子对象与全部子孙（按状态里的父子关系，只算一次）。 */
  private attachedList(state: SceneState): number[] {
    if (!this.attachedLayers) {
      const out = new Set<number>();
      for (const object of this.attachments.keys()) for (const item of state.subtree(object)) out.add(item);
      this.attachedLayers = [...out];
    }
    return this.attachedLayers;
  }

  /** 一个 puppet 图层当前的裁切命令表（P12f）：运行时重排过的取 `ScenePuppets.drawOrder`，否则（含手写的假来源）是编译期那份。 */
  private currentClipping(layer: SceneLayer): Pick<PuppetClipping, "commands" | "segments"> | null {
    return this.puppets?.drawOrder?.(layer.object)?.clipping ?? layer.puppet?.clipping ?? null;
  }

  /**
   * 把绘制顺序写进私有索引缓冲（P12f 点 5，`encode` 开头调）：`ordered` 的 draw 已上传的版本与 `ScenePuppets.drawOrder(object).version`（没有来源 / 没重排过为 0，
   * 编译期数据）不同才写，每个模板一次 `writeBuffer`；没有裁切的写整张 `indices`，裁切模板按当前命令表取自己的段（`clipTemplateSegments`），没用到的槽位 `count = 0`。
   * 版本相同不写，所以顺序没变的帧一次上传都没有。
   */
  private syncPuppetIndices(): void {
    // 每个对象每次最多算一回（同一图层的模板共用一份当前顺序与段）
    const plans = new Map<
      number,
      { version: number; whole: Uint16Array | null; segments: ReturnType<typeof clipTemplateSegments> | null }
    >();
    for (const draw of this.draws) {
      const mesh = draw.mesh;
      const ordered = mesh?.ordered;
      const puppet = draw.layer.puppet;
      if (!mesh || !ordered || !puppet) continue;
      const order = this.puppets?.drawOrder?.(draw.object) ?? null;
      const version = order?.version ?? 0;
      if (ordered.version === version && ordered.source === order) continue;
      let plan = plans.get(draw.object);
      if (!plan) {
        const clipping = order?.clipping ?? puppet.clipping;
        plan = {
          version,
          whole: null,
          segments: clipping
            ? clipTemplateSegments(
                clipping,
                (puppet.clipping?.records.length ?? 0) + 1,
                puppet.clipping?.records.length ?? 0,
              )
            : null,
        };
        plans.set(draw.object, plan);
      }
      const slot = ordered.slot;
      let indices: Uint16Array;
      if (!slot) indices = order?.indices ?? (plan.whole ??= fileIndices(puppet.mesh.indices));
      else if (!plan.segments) continue;
      else
        indices =
          slot.kind === "normal"
            ? (plan.segments.normals[slot.slot] ?? new Uint16Array(0))
            : ((slot.kind === "mask" ? plan.segments.masks : plan.segments.targets)[slot.record] ?? new Uint16Array(0));
      const { bytes, count } = indexUpload(indices, ordered.capacity);
      this.device.queue.writeBuffer(mesh.indexBuffer, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
      mesh.count = count;
      ordered.version = version;
      ordered.source = order;
    }
  }

  /**
   * puppet 绘制的每帧 uniform（P12a 步骤 4、P12b1 步骤 4，`update` 与建 draw 共用）：蒙皮矩阵 `g_Bones`、骨骼透明度 `g_BonesAlpha`、变形的
   * `g_MorphOffsets`（u32）/ `g_MorphWeights`。直接上屏、合成上屏与裁切的遮罩 / 目标段都用 puppet 自己的值（p12b 步骤 0b 实测：合成路径
   * 不借别的 puppet 的残留值）。没有透明度来源时 `g_BonesAlpha` 写全 1（块是 0 会让整个 puppet 透明）；没有变形来源时保持 0（不变形）。
   */
  private writePuppetUniforms(block: UniformBlock, layer: SceneLayer, step?: DrawLike): void {
    const puppets = this.puppets;
    if (!puppets) return;
    const object = layer.object;
    const skin = puppets.skin(object);
    // 模型（P12b2-1）：每个对象一份 `g_Bones`，所有网格共用；数组按 `BONECOUNT` 定长，只写前 n 根（`UniformBlock.set` 值不足的分量保持原值，初始 0）
    if (skin && block.has("g_Bones")) block.set("g_Bones", skin);
    if (block.has("g_BonesAlpha")) {
      let alpha = puppets.boneAlpha?.(object) ?? null;
      if (!alpha) {
        const bones = (layer.puppet?.skeleton ?? layer.model?.skeleton?.skeleton)?.parents.length ?? 0;
        alpha = this.onesCache.get(bones) ?? null;
        if (!alpha) this.onesCache.set(bones, (alpha = new Float32Array(bones).fill(1)));
      }
      block.set("g_BonesAlpha", alpha);
    }
    // 纹理通道（P12b2-2）：16 个 float，`UniformBlock.set` 按数组长度（`BLENDROWCOUNT`）取前 `4 × 行数` 个
    if (block.has("g_BlendMap")) {
      const map = puppets.blendMap?.(object);
      if (map) block.set("g_BlendMap", map);
    }
    if (block.has("g_MorphOffsets") || block.has("g_MorphWeights")) {
      const morph = puppets.morph?.(object, step?.kind === "mesh" ? step.mesh : undefined);
      if (morph) {
        block.set("g_MorphOffsets", morph.offsets);
        block.set("g_MorphWeights", morph.weights);
      }
    }
  }

  /**
   * 挂点子对象的 `Pose[骨骼] · Att`（P12b1 步骤 3，`worldMatrixOf` 的 `attach`）：父 puppet 当前的模型空间骨骼矩阵（`ScenePuppets.pose`）取那一根，
   * 右乘 `Att`，一次 `multiply`（WPE 先 `Pose · Att`、再乘本地矩阵，各一次 `FUN_14005ecb0`）。没有挂点、没有姿势来源、静态父（没有姿势）时为 null，
   * 子对象按普通父子。
   */
  private attachPose(object: number): Mat4 | null {
    const attachment = this.attachments.get(object);
    if (!attachment) return null;
    const pose = this.puppets?.pose?.(attachment.parent);
    const at = attachment.bone * 16;
    if (!pose || at < 0 || at + 16 > pose.length) return null;
    return multiply(pose.subarray(at, at + 16), attachment.matrix);
  }

  /**
   * 把播放器解出的当前帧（WebCodecs 的 `VideoFrame`）拷进第 `index` 张纹理（P9a）。拷的尺寸取画面（显示尺寸）与纹理的较小者：WPE 是
   * 缩放到纹理尺寸（rea-p9-video 第 2 节第 3 条），语料 60 段两者都相同，不同时只拷重叠部分并记一条 warning（决定 3）。还没有尺寸
   * （`displayWidth` 为 0）时跳过；拷贝抛错时记一条 warning，不让这一帧失败。两种 warning 每张纹理各记一次。拷完由播放器释放帧。
   */
  private copyVideo(index: number, source: VideoFrame): void {
    const texture = this.textures[index];
    const info = this.bundle.textures[index];
    const videoWidth = source.displayWidth;
    const videoHeight = source.displayHeight;
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
      if (!template || (template.instanced && !system.alive)) return;
      const occurrence = counts.get(template) ?? 0;
      counts.set(template, occurrence + 1);
      visit(system, template, occurrence, model);
    }, object);
  }

  /**
   * 编码一个粒子层（`particle-tree` op，P4e 步骤 2）：沿 `walkParticles` 的先序逐个系统取一组 draw、画。非实例化的模板用建场景时建好的
   * 第 0 组（顺序、uniform、顶点与 P4e 步骤 1 逐字节相同）；实例化的模板第 k 次出现用池里第 k 组，没有就现建（`addPooledGroup`），已有的
   * 换了实例或模型矩阵变了就整组重写随它变的 uniform（`assignParticles`）。uniform 与顶点都在本帧提交之前经队列写入，每个 draw 每帧至多用
   * 一次，所以互不覆盖。先序里第一个需要帧缓冲的系统之前放一个 `"snapshot"` 标记。
   * 一个系统多条 renderer（P4f 步骤 4，rea-p4f-script.md 8.3、8.4）：一组按 renderer 顺序连着画完，`walkParticles` 才往下走子系统（WPE 的
   * renderer 循环在递归之前），所以先序是「父 r0、父 r1、static 子 r0、r1、实例……」。
   * 一帧只排一次（`encode` 按树缓存）：平面反射 pass 与主 pass 画同一次排列（P13b2），池的分配与 uniform 改写只做一遍。
   */
  private arrangeParticles(tree: ParticleTree, state: SceneState, worlds: Map<number, Mat4>): ParticleArrangement {
    const items: ParticleArrangement = [];
    const object = worldMatrixOf(tree.object, state.layers, worlds, this.attachHook);
    this.walkParticles(
      tree,
      object,
      (system, template, occurrence, model) => {
        if (!template.instanced) {
          items.push(...template.pool[0]);
          return;
        }
        const group = template.pool[occurrence];
        if (!group) {
          items.push(...this.addPooledGroup(tree, template, system, state, worlds));
          return;
        }
        for (const item of group) {
          this.assignParticles(item, system, model, state, worlds);
          items.push(item);
        }
      },
      () => items.push("snapshot"),
    );
    return items;
  }

  /**
   * 模型被视锥剔除（P5c 步骤 2，p5-REPORT `p5c-frustum`，rea-p5-mesh 4.4）：被剔就整个模型不画。`viewProjection` 是这个 pass 的场景级视图
   * 投影：主 pass 是带抖动与缩放、不带每个对象的视差的那一份（WPE 在场景绘制开头从相机算一次平面），平面反射 pass 是反射视图的（P13b2，
   * p13-REPORT C8）。世界矩阵不含视差；`perspective: true` 的模型也按它判（WPE 先剔除、后换透视投影，rea 2.6）。组里的模型照报
   * （`model:passthrough:children:model`），强制渲染时不剔：组的局部正交下 WPE 用哪组平面没有实测。
   */
  private modelCulled(layer: SceneLayer, state: SceneState, worlds: Map<number, Mat4>, viewProjection: Mat4): boolean {
    const model = layer.model;
    if (!model || layer.group != null) return false;
    // 带骨骼的模型（P12b2-1）：剔除盒随动画变（可见层动画包围盒的并，没有有效的退回 mdl 的，`ScenePuppets.bounds`）
    return frustumCulled(
      this.puppets?.bounds?.(layer.object) ?? model.bounds,
      worldMatrixOf(layer.object, state.layers, worlds, this.attachHook),
      viewProjection,
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
   * 实例化模板的池里再建一组 draw（P4e 步骤 2，第一次用到时；P4f 步骤 4 起每条 renderer 一个）：同 `createDraw`（顶点缓冲按
   * `particleUnits`），进全场与本层的索引（就地刷新、材质常量、每帧 uniform 都照常覆盖它），之后常驻到场景销毁。这一帧的 `update` 已经
   * 过去，建好后补上这一帧的每帧量再传一次。
   */
  private addPooledGroup(
    tree: ParticleTree,
    template: ParticleTemplate,
    system: ParticleSystem,
    state: SceneState,
    worlds: Map<number, Mat4>,
  ): Draw[] {
    const occurrence = template.pool.length;
    const group = template.renderers.map(({ step, prepared }) => {
      const draw = this.createDraw(tree.layer, step, tree.resources, prepared, state, worlds, system, occurrence);
      // 与 `LayerRuntime.draws` 同一个数组（`install`）：图层重建时一起释放
      this.drawsByLayer.get(tree.object)?.push(draw);
      this.indexDraw(draw);
      if (this.particleTimings) this.particleTimings.set(draw, { simulate: [], vertices: [], upload: [], alive: [] });
      if (draw.block && draw.uniformBuffer && this.frameValues) {
        this.applyFrame(draw, this.frameValues);
        this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
      }
      return draw;
    });
    template.pool.push(group);
    return group;
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
      this.walkParticles(tree, tree.world, (system, { node }, occurrence) =>
        out.push({
          object: tree.object,
          name: tree.layer.name,
          ...(node.length ? { node: [...node] } : {}),
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
   * `node`：系统树里的哪个模板（P4e 步骤 1，`ParticleStep.node`），缺省顶层；`occurrence`：这个模板池里的第几组（P4e 步骤 2，从 0 起，
   * 即最近一次编码时第几次出现的实例），缺省第一组；`renderer`：系统的第几条 renderer（P4f 步骤 4，`ParticleStep.renderer`，即
   * `SceneParticle.draws` 的下标），缺省第一条。这一条没有绘制（越界、强制渲染时跳过的 rope 类）时为 null。
   */
  particleProbe(
    object: number,
    node: readonly number[] = [],
    occurrence = 0,
    renderer = 0,
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
    const template = this.trees.get(object)?.templates.get(node.join("/"));
    // 组里按 `template.renderers` 的顺序；强制渲染跳过的 rope 类不在里面，所以按步骤的 `renderer` 找位置
    const index = template?.renderers.findIndex((item) => item.step.renderer === renderer) ?? -1;
    const draw = index < 0 ? undefined : template?.pool[occurrence]?.[index];
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
    // puppet 的绘制顺序（P12f）：推进已经做完，版本变了的模板索引缓冲在编码之前写好（队列写入排在本帧提交之前）
    this.syncPuppetIndices();
    const { view: sceneView, texture: sceneTexture } = this.current;
    const { clearcolor, clearenabled } = state.general;
    const depthView = this.depthTarget?.view ?? null;
    // 粒子层现排时的世界矩阵（P4e 步骤 2）：这一刻的状态下，一条父链只算一次。同 `sync` 预置渲染阶段的挂点子树世界矩阵（B1）：
    // 挂点子树里粒子层的事件实例（`arrangeParticles` 的模型矩阵）与视锥剔除（`modelCulled`）要和本体用同一份 W，否则实例按新 W、本体按旧 W
    const worlds = new Map<number, Mat4>(this.liveSeeds(state) ?? []);
    // 清屏色：按指定尺寸画、对齐方式 1 / 3 时是 `schemecolor`（`targetClear`），主场景目标与平面反射 RT 共用（反射开 / 关都一样）
    const clear = this.targetClear ?? clearcolor;
    const [r, g, b] = clear;
    // 平面反射 RT（P13b1）：反射关时每帧清成清屏色，在主 pass 之前，不看 clearenabled（rea-p13-passes 1.1）
    // 反射开（P13b2）时改由下面的反射 pass 清屏并作画
    // 阴影 pass（P13d）：在反射与主 pass 之前（帧函数 `0x14018031a`），每帧清图集、画投射者
    this.encodingState = state;
    this.shadowAtlas?.encode(encoder, this.shadowCasters);
    const reflectionTarget = this.reflectionSet ? (this.reflectionTargets?.reflection ?? null) : null;
    if (!reflectionTarget) this.reflectionTargets?.encode(encoder, clear);
    if (this.hdr && !clearenabled) this.linearizeBase(encoder, this.current);
    /** 「画到场景」的目标（P5f）：场景目标，或组画子树时组当前的合成 RT；快照拷的就是它 */
    interface DrawTarget {
      view: GPUTextureView;
      texture: GPUTexture;
      width: number;
      height: number;
    }
    const sceneDrawTarget: DrawTarget = {
      view: sceneView,
      texture: sceneTexture,
      width: this.width,
      height: this.height,
    };
    /**
     * 拷快照（P5f）：拷当前目标。场景目标整张拷；组里是组的合成 RT，只拷左上角重叠部分（`min(宽) × min(高)`），快照其余保持上一次的内容
     * （`p5f-a`、`p5f-e` 实测，WPE 的 ResolveSubresource 在 NVIDIA 驱动上的行为）。
     */
    const snapshot = (target: DrawTarget) => {
      if (!this.snapshot) return;
      const size =
        target.view === sceneView
          ? { width: this.width, height: this.height }
          : {
              width: Math.min(target.width, this.snapshot.width),
              height: Math.min(target.height, this.snapshot.height),
            };
      encoder.copyTextureToTexture(
        { texture: target.texture },
        { texture: this.snapshot.texture, origin: { x: 0, y: 0 } },
        size,
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
    /** `reflection`（P13b2）：反射 pass 里换成副本的管线与 bind group，其余（视频、粒子顶点、几何）同主 pass。 */
    const draw = (
      pass: GPURenderPassEncoder,
      item: Draw,
      reflection?: { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup; copy: ReflectionCopy | null },
    ) => {
      // 视频纹理（P9a）：画到它就记下帧号；有新帧就拷进来，排在本帧提交之前（同 WPE 绑定时 TransferVideoFrame，rea-p9-video
      // 第 2 节第 4 条）。视频尺寸和纹理不同时只拷重叠部分并记一条 warn（决定 3，语料 0 段）
      for (const index of item.videos) {
        const source = this.videoSink?.drawn(index);
        if (source) this.copyVideo(index, source);
      }
      // GIF / 视频用户纹理（P11b 步骤 4）：画到就推进、有新内容就上传，同视频排在本帧提交之前
      if (item.userAnimations.length) this.drawnUserAnimations(item);
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
      // 帧表纹理（P6e 点 2）：到这里这个 draw 一定会画（上面的早退都过了），就是 WPE「绑定时推进」的那一刻；没画到的 draw 不碰计时器。
      // 选格与写 uniform 都在这里，不另写一份「会不会画」的判断，所以和编码的取舍永远是同一套
      this.bindSheets(item, reflection?.copy ?? null);
      pass.setPipeline(reflection?.pipeline ?? item.pipeline);
      pass.setBindGroup(0, reflection ? this.reflectionGroupOf(item, reflection) : this.bindGroupOf(item));
      pass.setVertexBuffer(0, item.vertexBuffer);
      if (item.mesh) {
        // 模型网格（P5c 步骤 2）：mdl 的索引，三角形列表；网格没有的属性从槽 1 的全零占位缓冲读
        if (item.mesh.placeholder) pass.setVertexBuffer(1, item.mesh.placeholder);
        pass.setIndexBuffer(item.mesh.indexBuffer, item.mesh.indexFormat);
        pass.drawIndexed(item.mesh.count, item.mesh.instances ?? 1);
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
    // 运行时对象表的派生（P6d3）：顶层绘制顺序与位置表
    const { top: topLayers, position } = this.structure(state);
    // 反射 pass 的遍历顺序：对象表里有运行时的全部图层（名单里组内的也在，同以前遍历 `this.layers`，只是改按对象表顺序）
    const reflectionOrder = this.reflectionSet
      ? state.order.flatMap((object) => {
          const runtime = this.runtimeByObject.get(object);
          return runtime ? [runtime] : [];
        })
      : [];
    // 粒子层这一帧的排列（`arrangeParticles`）：第一次画到时排，平面反射 pass 与主 pass 共用
    const arrangements = new Map<ParticleTree, ParticleArrangement>();
    const arranged = (tree: ParticleTree): ParticleArrangement => {
      let items = arrangements.get(tree);
      if (!items) arrangements.set(tree, (items = this.arrangeParticles(tree, state, worlds)));
      return items;
    };
    /** `sceneTarget`：「画到场景」的绘制落在哪；缺省是真正的场景目标，组画子树时是组的合成 RT（P5b 步骤 4）。 */
    const runOps = (ops: readonly Op[], sceneTarget: DrawTarget = sceneDrawTarget) => {
      for (const op of ops) {
        if (op.kind === "draw") {
          const { draw: item } = op;
          if (item.step.target.kind === "scene") {
            draw(begin(sceneTarget.view), item);
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
          // 快照要包含清屏色：本帧还没画过场景就先清一次。拷当前目标（P5f）：组里是组的合成 RT（只拷左上角重叠部分）
          if (!started) begin();
          end();
          snapshot(sceneTarget);
        } else if (op.kind === "particle-tree") {
          // 粒子层（P4e 步骤 2）：按本帧的排列画，快照插在先序里第一个需要帧缓冲的系统之前（同上面的快照操作）
          for (const item of arranged(op.tree)) {
            if (item !== "snapshot") draw(begin(sceneTarget.view), item);
            else {
              if (!started) begin();
              end();
              snapshot(sceneTarget);
            }
          }
        } else if (op.kind === "puppet-clip") {
          // 有裁切的 puppet（P12f）：按当前命令表现排（`clipDrawSequence`）。遮罩段画进遮罩 RT（先清、再 load），目标段与普通段回场景
          const clipping = this.currentClipping(op.layer);
          if (!clipping) continue;
          for (const { part, index } of clipDrawSequence(clipping.commands, op.normals.length, op.masks.length)) {
            if (part === "clear") {
              end();
              const target = this.resolveTarget({ kind: "clip-mask" }, op.resources);
              if (target) this.clearTarget(encoder, target, [0, 0, 0, 0], "clear clip mask");
              continue;
            }
            const item = (part === "normal" ? op.normals : part === "mask" ? op.masks : op.targets)[index];
            if (!item?.mesh?.count) continue;
            if (part === "mask") {
              end();
              const target = this.resolveTarget(item.step.target, item.resources);
              if (!target) continue;
              const pass = encoder.beginRenderPass({
                label: item.label,
                colorAttachments: [{ view: target.view, loadOp: "load", storeOp: "store" }],
              });
              draw(pass, item);
              pass.end();
            } else draw(begin(sceneTarget.view), item);
          }
        } else if (op.kind === "model" && op.layer.sprite) {
          // sprite（P13c）：不做视锥剔除，光斑 → 计数 pass → 遮挡方块（`encodeSprite`）
          this.encodeSprite(
            encoder,
            op.layer.object,
            op.draws,
            { scene: () => begin(sceneTarget.view), end, draw: (pass, item) => draw(pass, item) },
            sceneTarget.view === sceneView,
          );
        } else if (op.kind === "model") {
          // 模型（P5c 步骤 2）：先做视锥剔除，被剔就整个模型不画
          if (this.modelCulled(op.layer, state, worlds, this.view.viewProjection)) continue;
          for (const item of op.draws) draw(begin(sceneTarget.view), item);
        } else if (op.kind === "subtree") {
          // 组画子树（P5b 步骤 4）：子孙按先序画，「画到场景」的绘制改画进组当前的合成 RT（嵌套组递归，它的上屏画进这一张）。
          // 不可见的子孙（含祖先）整段跳过；没有资源的（分组节点、声音）没有 op
          end();
          const target = this.resolveTarget(op.target, op.resources);
          if (!target) continue;
          // 不可见的子孙跳过，被依赖的照画进自己的 RT、不上屏（P8 步骤 4，同顶层）
          for (const object of op.layer.subtree) {
            const child = this.runtimeByObject.get(object);
            if (child) runLayer(child, target);
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
    function runLayer(runtime: LayerRuntime, sceneTarget?: DrawTarget): void {
      const ops = layerOpsToRun(runtime.ops, runtime.layer, visible.has(runtime.object));
      if (ops.length) runOps(ops, sceneTarget);
    }
    if (reflectionTarget) {
      // 平面反射 pass（P13b2，rea-p13-passes 1.3，p13-REPORT C1–C12）：主 pass 之前，名单里的对象按 `objects` 顺序、用反射视图画进
      // `_rt_Reflection`，不做透明排序。和主 pass 共用场景深度；`clearenabled` 开时颜色清成 (clearcolor, 1)、深度清 0，关时都接着上一帧（C6）。
      // 模型的视锥剔除用反射视图的 VP（C8）；粒子树用本帧的同一次排列（`arranged`，名单里没有要快照的粒子，跳过快照标记）
      const mirrored = this.reflectedView();
      const loadOp: GPULoadOp = clearenabled ? "clear" : "load";
      const pass = encoder.beginRenderPass({
        label: "_rt_Reflection reflection",
        colorAttachments: [{ view: reflectionTarget.view, clearValue: { r, g, b, a: 1 }, loadOp, storeOp: "store" }],
        ...(depthView
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
      const reflect = (item: Draw) => {
        if (!this.reflects(item)) return;
        const copy = this.reflectionCopyOf(item, state, worlds);
        draw(pass, item, {
          pipeline: this.reflectionPipeline(item),
          bindGroup: copy?.bindGroup ?? this.bindGroupOf(item),
          copy,
        });
      };
      for (const runtime of reflectionOrder) {
        if (!this.reflected(runtime.object) || !visible.has(runtime.object)) continue;
        for (const op of runtime.ops) {
          if (op.kind === "draw") reflect(op.draw);
          else if (op.kind === "particle-tree") {
            for (const item of arranged(op.tree)) if (item !== "snapshot") reflect(item);
          } else if (op.kind === "puppet-clip") {
            // P12f：按当前命令表展开后逐 draw 反射（`reflects` 自己过滤，语义同展开成固定步骤时）
            const clipping = this.currentClipping(op.layer);
            if (!clipping) continue;
            for (const { part, index } of clipDrawSequence(clipping.commands, op.normals.length, op.masks.length)) {
              if (part === "clear") continue;
              const item = (part === "normal" ? op.normals : part === "mask" ? op.masks : op.targets)[index];
              if (item?.mesh?.count) reflect(item);
            }
          } else if (op.kind === "model" && !this.modelCulled(op.layer, state, worlds, mirrored.viewProjection))
            for (const item of op.draws) reflect(item);
        }
      }
      pass.end();
    }
    // 体积光（P13e，V5）：灯不是图层，按 `objects` 下标插进顶层序列。画到一盏灯就拷深度、画进 LightBuffer（一段连续的灯共用一次清屏）；
    // 下一个可见的非灯对象画之前（不可见的不触发）、或列表末尾（泛光之前）合成。组里的灯照报，这里不会有
    const volumetrics = this.volumetrics;
    // 灯按对象表顺序插进顶层序列；被删的灯跳过（P6d3）。可见性是运行时状态（P13f2，`p13f-vol` 的 L4）：自身或父链不可见的灯这一帧不画、
    // 也不开一段（不可见的灯不打断别的灯，V5）
    const lightObjects = (volumetrics?.objects ?? [])
      .filter((object) => state.layers.has(object) && effectiveVisible(object, state.layers))
      .sort(byPosition(position));
    const lightWorlds = new Map<number, Mat4>();
    const volumetricLights = new Map((this.bundle.lightObjects ?? []).map((light) => [light.object, light]));
    let nextLight = 0;
    let pendingComposite = false;
    if (volumetrics) {
      const lights = this.lightFrameCache;
      volumetrics.frame((object) => {
        const layer = this.bundle.layers.find((item) => item.object === object);
        const entry = lights?.entries.find((item) => item.kind === "point" && item.light.object === object);
        const slice = (start: number) => lights!.buffer.subarray(start + entry!.slot * 4, start + entry!.slot * 4 + 4);
        // 灯的几何与常量按这一帧的状态（P13f2）：字段取 `SceneState.lights`，颜色取图层状态，位置与方向取世界矩阵（沿父链）
        const light = volumetricLights.get(object);
        const values = state.lights.get(object);
        const layerState = state.layers.get(object);
        const geometry =
          light && values && layerState && (light.kind === "point" || light.kind === "spot")
            ? volumetricGeometry(
                light.kind,
                values,
                layerState.color,
                worldMatrixOf(object, state.layers, lightWorlds, this.attachHook),
                !this.bundle.general.perspective,
              )
            : undefined;
        return {
          ...(geometry ? { geometry } : {}),
          viewProjection: layer ? this.viewProjectionOf(layer, state, this.view, false) : this.view.viewProjection,
          eye: this.view.eye,
          forward: this.view.viewVectors.forward,
          ...(entry
            ? {
                shadow: {
                  transform: slice(lights!.layout.pointProjectionTransform),
                  projection: slice(lights!.layout.pointProjection),
                },
              }
            : {}),
        };
      });
    }
    const composite = () => {
      if (!volumetrics || !pendingComposite) return;
      if (!started) begin();
      end();
      volumetrics.encodeComposite(encoder, sceneView);
      pendingComposite = false;
    };
    const drawLight = (object: number) => {
      // 读场景深度：本帧还没画过场景就先清一次（同快照）
      if (!started) begin();
      end();
      volumetrics!.encodeLight(encoder, object, !pendingComposite);
      pendingComposite = true;
    };
    const lightsBefore = (object: number) => {
      while (
        volumetrics &&
        nextLight < lightObjects.length &&
        (position.get(lightObjects[nextLight]) ?? Infinity) < (position.get(object) ?? Infinity)
      )
        drawLight(lightObjects[nextLight++]);
    };
    const runTop = (runtime: LayerRuntime) => {
      lightsBefore(runtime.object);
      if (visible.has(runtime.object)) composite();
      runLayer(runtime);
    };
    // 组的子孙（`group` 非空）在顶层不画，由组的 `subtree` op 画（P5b 步骤 4）
    // `group == null`：缺这个字段（手写的图层）也当顶层
    const { perspective, transparentSorting } = this.bundle.general;
    if (perspective && transparentSorting) {
      // 透明排序（P5d 步骤 4，`render/sortOrder.ts`）：只重排顶层这一轮，先按原顺序画不在半透明名单里的，再把半透明的按「当帧状态里的
      // 局部 origin · 当帧相机的视线方向」从远到近画（`viewVectors` 是 `setCamera` 交来的透视帧的，含抖动、相机对象、路径）。组画子树、
      // 模型的网格顺序、粒子树的先序不动；被依赖的图层跟着自己在新顺序里的位置画（同 WPE）
      // 体积光的灯（P13h，rea-p5-mesh 4.2：灯构造时就置半透明位）进第二遍，和半透明对象一起按局部 origin 排序；合成照旧在下一个可见的
      // 非灯对象之前或列表末尾（`FUN_14018aac0` 两遍循环里各有一处 `+0x60 != 6` 判定，末尾一处，`p13h-vol`）
      type Item = { object: number; sortClass?: SortClass; runtime?: LayerRuntime };
      const items: Item[] = topLayers.map((runtime) => ({
        object: runtime.object,
        sortClass: runtime.layer.sortClass,
        runtime,
      }));
      for (const object of lightObjects) items.push({ object, sortClass: "translucent" });
      // 稳定排序的「原顺序」是对象表顺序
      items.sort((a, b) => (position.get(a.object) ?? Infinity) - (position.get(b.object) ?? Infinity));
      for (const item of transparentDrawOrder(items, state, this.view.viewVectors.forward)) {
        if (!item.runtime) drawLight(item.object);
        else {
          if (visible.has(item.object)) composite();
          runLayer(item.runtime);
        }
      }
      nextLight = lightObjects.length;
    } else for (const layer of topLayers) runTop(layer);
    lightsBefore(Infinity);
    composite();
    // 屏幕空间反射（P13g）：反射开时把这一帧（泛光前）拷进 mip 帧缓冲并逐级缩小，读它的对象下一帧读到（rea-p13-passes 4.2：
    // WPE 在 `_rt_FullFrameBuffer` 的拷贝之后、泛光链之前）
    if (this.reflectionTargets?.updatesMip) {
      if (!started) begin();
      end();
      this.reflectionTargets.encodeMipFramebuffer(encoder, sceneTexture);
    }
    if (this.bloom && state.bloomEnabled) {
      // 全部图层画完：整帧快照（只拷这一次）→ 泛光链 → combine 写回场景目标
      if (!started) begin();
      end();
      snapshot(sceneDrawTarget);
      this.bloom.encode(encoder, sceneView, afterBloomStep);
    }
    if (!started) begin();
    end();
  }

  destroy(): void {
    this.disposed = true;
    for (const resource of this.owned) resource.destroy();
    this.owned.clear();
    this.bloomOwned.clear();
    this.volumetricsOwned.clear();
    this.spriteTexture = null;
    this.spriteTarget = null;
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
    this.reflectionTargets?.destroy();
    this.reflectionTargets = null;
    this.shadowAtlas?.destroy();
    this.shadowAtlas = null;
    this.shadowCasters = [];
    this.shadowCasterRecords.clear();
    this.fboPool.clear();
    this.freeTargets.length = 0;
    this.volumetrics = null;
    this.lightFrameCache = null;
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
