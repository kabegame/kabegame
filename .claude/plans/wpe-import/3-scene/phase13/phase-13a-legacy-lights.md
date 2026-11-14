# P13a — 能力表纠错、遗留灯与采样器宏别名（子计划）

> 上级：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13a」。依据：步骤 0 的 [rea-p13-lights.md](rea-p13-lights.md) 第 1 节、第 6.1 节，[p13-REPORT.md](p13-REPORT.md) 第 1、2、19、20 条，总计划「实施记录 / 步骤 0」的 P13a 一条。
> 现状行号按 2026-11-14 的工作区（HEAD `b5be957e` 加别的会话没提交的改动）；`features.ts`、`bundle.ts`、`p2a.test.ts` 别的会话也在改，本节只动下面列出的几处，按块暂存。
> 执行交 sonnet 子代理（2026-11-14 用户：「执行代理用sonnet」），验收由 Claude 独立做。

## 总体设计思路

P13a 是三处互不相干的小改动，共同点是都不碰渲染器：改完之后能多渲染 3 张（`3413921910`、`3498150384`、demon_core），并给 arsenal 去掉翻译器这道坎（它还差 P13b 的 `_rt_Reflection`）。

**`combo:REFLECTION` 不再按名字报。** `ENGINE_COMBOS` 的本意是「值非 0 就要引擎数据的 COMBO」，但 `REFLECTION` 这个名字在工坊 effect `cursorripple` 里是波纹在边界反弹的开关，在 `genericimage2` 没有法线图时也只是着色器内部的分支，都不要引擎数据。真正要引擎数据的两种反射各有自己的标志：平面反射读 `_rt_Reflection`，屏幕空间反射读 `_rt_MipMappedFrameBuffer` 与 `g_Texture3MipMapInfo`，这些已经由 `texture:rendertarget:*` 与 `uniform:*` 报出（步骤 0 核对过 7 张：只有误报的 5 张不报任何 `_rt_*`，另 2 张照样被这两类键挡着）。所以把 `REFLECTION` 移出表，不加别的判断。

**遗留灯照 WPE 的槽位写成材质常量。** 遗留灯（`"light": "point"`）写 `g_LightsPosition[4]`、`g_LightsColorRadius[4]`、`g_LightsColorPremultiplied[3]` 三个数组，读者是 `generic`、`generic2`、`genericimage2` 与声明了同名 uniform 的工程着色器（demon_core）。WPE 的规则是：每个灯对象（不分类型，`lpoint` 也算）在加载时按 `objects` 顺序取第一个空槽，4 个都占了就取槽 0；之后每帧遗留灯把世界平移写进位置、把 `(color × intensity, radius)` 写进颜色半径，隐藏时颜色半径写 `(0, 0, 0, 1)`、位置照写；同槽后写的覆盖先写的；没人写的槽是 `(0, 100, 0)` / `(0, 0, 0, 1)`。`g_LightsColorPremultiplied` 由颜色半径现算。
我们照 V1 灯现在的做法，在编译期算好、随材质常量进 `pass.uniforms`（`lights.ts` 新增 `legacyLightUniforms`），引擎 uniform 判定（`isEngineUniform`）认这三个名字，渲染器不改。和 V1 不同的是写入不看 `LIGHTING`：WPE 只看着色器声明了哪个名字，所以程序反射里读到其中任何一个（没标 `unused`）就给值。父链与每帧写入归 P13f（「灯是运行时状态」）：挂父对象的灯现在照报 `object:parent`，所以编译期取本地 `origin` 就是世界平移；`visible` 绑属性照 V1 登记重编译。「比脚本晚一帧」在编译期常量下没有意义，P13f 再处理。

**翻译器在改写纹理调用时沿对象宏找别名。** 预处理器保留 `#define` 行交给 naga 展开，而 `texSample2D` 等的改写在 naga 之前，所以第一个参数写成 `#define g_NormalMapSampler g_Texture1` 这样的别名时认不出（`generic` 三处、`generic4` / `common_pbr*.h` 的 `GRADIENT_SAMPLER`，之后阴影的 `SHADOW_ATLAS_SAMPLER` / `COOKIE_SAMPLER` 也是这样）。WPE 先预处理再编译，所以别名本来就成立。改写时按正文顺序记下 `#define 名 标识符` / `#undef 名`，第一个参数不是已声明的纹理时沿这张表最多追几层，追到已声明的纹理就按它改写；`#define` 行原样留着（naga 照旧展开，别处没再用到也无害）。第一个参数本来就是纹理的调用逐字节不变，所以语料基线只会多出「新通过」。

关键决策：
- **遗留灯走材质常量、不进 `ENGINE_UNIFORMS`。** 和 V1 灯同一条路，渲染器与 `p2a.test.ts`「内置表与渲染器写的值一一对应」都不用动，避开别的会话正在改的 `render/`；P13f 把两种灯一起搬到运行时。
- **槽位分配不看可见性、不看 `lightconfig`。** WPE 在工厂里分槽，那时连类型都还没解析；隐藏的遗留灯照样占槽并写 `(0, 0, 0, 1)`。
- **combo 键大小写不用改**：WPE 加载时转大写，我们已经这样做（步骤 0 第 20 条）。

## 现状锚点

**a. `REFLECTION` 按名字报**（`apps/wpe-scene/src/compile/features.ts:172`、`:1225`）
```ts
const ENGINE_COMBOS = new Set(["SPRITESHEET", "REFLECTION", "SKINNING", "SKINNING_ALPHA", "MORPHING", "PRELIGHTING"]);
// checkProgramFeatures
  for (const combo of result.combos ?? [])
    if (combo.value !== 0 && ENGINE_COMBOS.has(combo.name.toUpperCase()))
      unsupported.add(`combo:${combo.name.toUpperCase()}`); // 现状：cursorripple 的同名选项（缺省 1）也报
```
`ENGINE_COMBOS` 上面的注释（`:160` 起）写着「反射、蒙皮、变形、预光照：对应的 uniform 也会被 `uniform:*` 报出，这里一并列上，防止只改 COMBO 漏报」。

**b. 遗留灯的 uniform 不是引擎 uniform**（`compile/features.ts:140`）
```ts
export function isEngineUniform(name: string): boolean {
  // 灯光数组由 `lights.ts` 随材质常量写入
  return (
    ENGINE_UNIFORMS.has(name) ||
    UNREAD_UNIFORMS.has(name) ||
    /^g_Texture\d+(?:Resolution|Texel)$/.test(name) ||
    /^g_L(?:Point|Spot|Tube|Directional)_/.test(name) // 现状：g_LightsPosition 等三个数组不在里面，被读到就报 uniform:*
  );
}
```

**c. 灯光数组只给开了 `LIGHTING` 的程序**（`compile/bundle.ts:1135`、`:1715`）
```ts
  /** 开了光照的程序才读；没人用时不解析灯对象，也不登记它们的绑定。 */
  let lights: Record<string, number[]> | null = null;
  const sceneLights = () =>
    (lights ??= lightUniforms(
      scene.objects,
      counts,
      bindingReader(bindings, properties, (path) => recompile("layer-structure", path)),
    ));
// compilePass 的返回值
      uniforms: {
        ...shaderUniforms(result, pass, properties, context.key, bindings, issues),
        ...(result?.ok && usesLighting(result) ? sceneLights() : {}), // 现状：只有 V1 数组，没有遗留灯
      },
```

**d. `lights.ts` 只算 V1**（`compile/lights.ts:7`、`:122`）
```ts
 * - **`"light": "point"` 是遗留灯**，不进这里的数组：它写 `g_LightsPosition` 等，只有 `generic` / `generic2` 读。
// lightUniforms：kind 为 null（含 "point"）的对象直接跳过，不占任何槽
    if (!kind || used[kind] >= counts[kind]) return;
```

**e. 翻译器的纹理调用改写**（`src-tauri/wpesl2wgsl/src/rewrite.rs:1038`、`:1508`）
```rust
    // render()：正文里 #define 行还在，naga 之后才展开
    let body = rewrite_texture_calls(&body, textures).map_err(|message| RewriteError { /* … */ })?;

fn rewrite_texture_calls(body: &str, textures: &[TextureDecl]) -> Result<String, String> {
    // 逐个标识符扫描，遇到 texSample2D 等就拆参数、递归改写参数
        let texture_name = args.first().map(|a| a.trim()).unwrap_or_default();
        let Some(texture) = textures.iter().find(|t| t.name == texture_name) else {
            return Err(format!(
                "{function} 的第一个参数不是已声明的纹理：{texture_name}" // 现状：g_NormalMapSampler、GRADIENT_SAMPLER 走到这里
            ));
        };
```
WPE 着色器里的别名（`assets/shaders`）：
```glsl
// generic.frag（前两条在互斥的 #if 分支里，预处理后只剩一条）
#define g_NormalMapSampler g_Texture1
#define g_LightmapMapSampler g_Texture2
#define g_LightmapMapSampler g_Texture1
#define g_ReflectionSampler g_Texture3
// generic3/4.frag、chroma4、foliage4、fur4；common_pbr.h / common_pbr_2.h 里 texSample2D(GRADIENT_SAMPLER, …)
#define GRADIENT_SAMPLER g_Texture4
#define SHADOW_ATLAS_SAMPLER g_Texture6
#define COOKIE_SAMPLER g_Texture7
```

**f. 测试里拿 `g_LightsPosition` 当「没实现的引擎 uniform」**（`compile/p2a.test.ts:272`、`:314`；`compile/lights.test.ts:156`）
```ts
        // 遗留灯的数组（P13 才写）：没实现的引擎 uniform 照报
        { name: "g_LightsPosition", type: "array<vec4<f32>, 4>", offset: 48, size: 64 },
    expect([...keys].sort()).toEqual(["combo:SPRITESHEET", "uniform:g_LightsPosition"]);
// lights.test.ts
    expect(isEngineUniform("g_LightsPosition")).toBe(false);
```

## 步骤 0 — 遗留灯的确定性工程（Claude，实现之前）

报告「没有实测的」第 1 条在这里补：

- **`p13a-slots`**（正交场景，`ignore/p5/d0/gen_d.py` 的 `quad_model` 画一个 `generic` 网格，工程放 `ignore/p13/a0/`）。`objects` 顺序：
  1. `lpoint`（没有 `lightconfig`，V1 数组为空）→ 预测占槽 0、不写；
  2. `point` A（可见）→ 槽 1；
  3. `point` B（`visible: false`）→ 槽 2 = `(0, 0, 0, 1)`，位置照写 B 的 origin；
  4. `point` C → 槽 3；
  5. `point` D → 槽 0（被后面覆盖）；
  6. `point` E（`visible` 绑属性 `p_f`，缺省 false）→ 槽 0。
  预测槽 0 = E 的 origin + `(0, 0, 0, 1)`；`apply_properties` 把 `p_f` 改成 true 再抓，槽 0 = E 的 `(color·intensity, radius)`。读 `g_LightsPosition`、`g_LightsColorRadius` 与整帧。
- **`p13a-gi2`**：同样的灯，换一个 `genericimage2` 图像层（`LIGHTING: 1`，不带法线图），读 `g_LightsColorPremultiplied` 的打包（`[i].rgb = c_i·r_i²`，`[i].w = c_3[i]·r_3²`）与整帧。
- 抓帧放 `A:\p13a\slots\`，结果写进 `p13-REPORT.md` 新的一节「P13a 的实测」。预测不成立时先改本计划的点 2 再派执行。

**结果（2026-11-14）**：两个工程并成一个 `ignore/p13/proj/p13a-slots`（左 `generic`、右 `genericimage2`），A1–A6 全部成立，见 p13-REPORT「P13a 的实测」。多出一条：`g_LightsColorPremultiplied` 要逐步按单精度算（点 2 已写进注释）。

## 点 1 — `REFLECTION` 移出引擎 COMBO（`compile/features.ts`）

- **修改** `ENGINE_COMBOS` 去掉 `REFLECTION`，注释改写理由：
```ts
/**
 * 值非 0 时需要引擎提供数据、渲染器还没有的 COMBO。…（前文不变）
 * - 蒙皮、变形、预光照：对应的 uniform 也会被 `uniform:*` 报出，这里一并列上，防止只改 COMBO 漏报。
 * - `REFLECTION` 不在这里（P13a）：这个名字在工坊 `cursorripple` 里是波纹在边界反弹的开关、在 `genericimage2` 不带法线图时只是着色器
 *   分支，都不要引擎数据。要引擎数据的两种反射由读到的 RT 报出：平面反射 `texture:rendertarget:_rt_Reflection`，屏幕空间反射
 *   `texture:rendertarget:_rt_MipMappedFrameBuffer` 与 `uniform:g_Texture3MipMapInfo`（p13-REPORT 第 19 条、总计划步骤 0）。
 */
const ENGINE_COMBOS = new Set(["SPRITESHEET", "SKINNING", "SKINNING_ALPHA", "MORPHING", "PRELIGHTING"]); // 修改：去掉 REFLECTION
```

## 点 2 — 遗留灯（`compile/lights.ts`、`compile/features.ts`、`compile/bundle.ts`）

- **新增** `lights.ts`：
```ts
/** 遗留灯的三个数组（rea-p13-lights 1.4）：着色器声明了哪个就写哪个，不看 `LIGHTING`。 */
export const LEGACY_LIGHT_UNIFORMS: ReadonlySet<string> = new Set([
  "g_LightsPosition",
  "g_LightsColorRadius",
  "g_LightsColorPremultiplied",
]);

/**
 * 遗留灯（`"light": "point"`）→ 三个数组（rea-p13-lights 第 1 节，`FUN_14018ff60` 分槽、`FUN_14025d1f0` 写入）：
 * - 每个灯对象（`light` 是字符串，不分类型，`lpoint` 等也算）按 `objects` 顺序取第一个空槽，4 个都占时取槽 0；
 * - 遗留灯写自己的槽：位置 = 世界平移（挂父对象的灯照报 `object:parent`，这里取本地 `origin`；P13f 改成父链），
 *   颜色半径 = 可见 ? `(color·intensity, radius)` : `(0, 0, 0, 1)`，隐藏时位置照写；同槽后写的覆盖先写的；
 * - 没人写的槽：位置 `(0, 100, 0)`、颜色半径 `(0, 0, 0, 1)`（渲染上下文的初值）；
 * - `g_LightsColorPremultiplied[i].rgb = c_i · r_i²`（i = 0..2），`[i].w = c_3[i] · r_3²`（c、r 取颜色半径）。
 * 颜色乘强度、半径平方、两者相乘都逐步按单精度舍入（`Math.fround`，p13-REPORT「P13a 的实测」A5：WPE 的 `108000.0078`）。
 * 位置是 `vec3[4]`，按声明分量展平（12 个数，`UniformBlock.set` 按 16 字节步长写）。
 */
export function legacyLightUniforms(
  objects: readonly SceneObject[],
  read: (value: SceneValue | undefined, path: string) => SceneScalar | undefined,
): Record<string, number[]>;
```
  > 说明：缺键缺省同 `DEFAULTS`（color 0、intensity 0、radius 1）；`visible` 经 `read` 解析，绑属性的照 V1 登记重编译。
- **修改** `lights.ts` 头注释第 7 行改成遗留灯已实现、由 `legacyLightUniforms` 写。
- **修改** `isEngineUniform`：
```ts
export function isEngineUniform(name: string): boolean {
  // 灯光数组由 `lights.ts` 随材质常量写入：V1 四种灯，与遗留灯的三个数组（P13a）
  return (
    ENGINE_UNIFORMS.has(name) ||
    UNREAD_UNIFORMS.has(name) ||
    LEGACY_LIGHT_UNIFORMS.has(name) || // 新增
    /^g_Texture\d+(?:Resolution|Texel)$/.test(name) ||
    /^g_L(?:Point|Spot|Tube|Directional)_/.test(name)
  );
}
```
- **修改** `bundle.ts`：
```ts
  /** 遗留灯（P13a）：程序读到三个数组之一才算；同 `sceneLights` 只解析一次。 */
  let legacy: Record<string, number[]> | null = null;
  const legacyLights = () =>
    (legacy ??= legacyLightUniforms(
      scene.objects,
      bindingReader(bindings, properties, (path) => recompile("layer-structure", path)),
    ));
// compilePass 的返回值
      uniforms: {
        ...shaderUniforms(result, pass, properties, context.key, bindings, issues),
        ...(result?.ok && usesLighting(result) ? sceneLights() : {}),
        ...(result?.ok && readsLegacyLights(result) ? legacyLights() : {}), // 新增
      },
```
  `readsLegacyLights`（放 `lights.ts`）：反射里有 `LEGACY_LIGHT_UNIFORMS` 的名字、没标 `unused`、不是材质常量（没有 `meta.material`）。
  > 说明：遗留只读 `light: "point"` 的字段，V1 只读另外四种，两边登记的绑定路径不重叠；分槽只看 `light` 是不是字符串，不读别的字段、不登记绑定。

## 点 3 — 采样器宏别名（`src-tauri/wpesl2wgsl/src/rewrite.rs`、README）

- **修改** `rewrite_texture_calls`：扫描时遇到行首的 `#define` / `#undef`，整行原样输出并更新别名表（只记「对象宏、替换体是单个标识符」的；函数宏与别的替换体不记，`#undef` 删掉）；第一个参数不是已声明的纹理时沿别名表追（最多 8 层，防环），追到已声明的纹理就按它生成 `texture(sampler2D(<纹理>, kb_sampler_<纹理>), …)`，追不到照旧报原来的错误。参数里递归改写时用同一份到当前位置为止的别名表。
```rust
/// 纹理调用改写。第一个参数可以是 `#define 别名 g_TextureN` 这样的对象宏（P13a）：WPE 先预处理再编译，别名本来就成立；
/// 预处理器把 `#define` 行留给 naga，这一步在 naga 之前，所以按正文顺序自己记别名（`#undef` 删掉）。
fn rewrite_texture_calls(body: &str, textures: &[TextureDecl]) -> Result<String, String>;
```
- **新增** 单测（`rewrite.rs` 的 tests 或 `lib.rs` 端到端）：
  - `generic.frag` 式别名（`#define g_NormalMapSampler g_Texture1` 后 `texSample2D(g_NormalMapSampler, uv)`）改写成 `g_Texture1`；
  - 两层别名、`#undef` 后再用报错、别名指向未声明名报错、函数宏不当别名；
  - 第一个参数本来就是纹理的输出与改动前逐字节相同。
- **修改** README「内部流程」第 5 步「纹理函数」最后一句：「第一个参数必须是已声明的纹理，或按正文顺序 `#define` 成已声明纹理的对象宏（追多层，`#undef` 生效）」。
- 改完 `deno task build:wpesl2wgsl` 重编 wasm（只多出新通过，别的会话用到的输出不变）。

## 点 4 — 测试（`compile/`）

- `lights.test.ts`：
  - `legacyLightUniforms`：步骤 0 的 `p13a-slots` 两种状态逐值相同；空场景三个数组全是初值；`lpoint` 在前占槽 0；第 5 盏起落槽 0、后写覆盖；隐藏写 `(0, 0, 0, 1)` 且位置照写；`g_LightsColorPremultiplied` 的打包（含第 4 盏拆进 w）；
  - `isEngineUniform("g_LightsPosition")` 改成 true，另加 `g_LightsColorRadius`、`g_LightsColorPremultiplied`；
  - `compileScene` 端到端：声明 `g_LightsPosition` 的程序（不开 `LIGHTING`）拿到值、不报 `uniform:*`；不声明的程序 `uniforms` 里没有这三个键；`visible` 绑属性登记重编译。
- `p2a.test.ts`：两处拿 `g_LightsPosition` 当例子的换成仍没实现的 `g_FogDistanceParams`（P13f），断言跟着改；另加一条 `REFLECTION: 1` 不报。

## 验收

子代理（sonnet）：
- `apps/wpe-scene` tsc 0 error；vitest 全过（`KABEGAME_WPE_ROOT=D:/Applications/Steam/steamapps/common/wallpaper_engine`，`node ../../node_modules/vitest/vitest.mjs run`，`--config` 用大写盘符）；Prettier；
- `CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --lib`；`cargo fmt` 对 crate；
- 只改本计划列出的文件，`features.ts` / `bundle.ts` / `p2a.test.ts` 里别的会话的改动不碰。

Claude 独立验收：
1. `git status` 与逐文件 diff 查越界；tsc、vitest、`cargo test -p wpesl2wgsl --lib` 自跑。变异检查：`REFLECTION` 放回表、`legacyLightUniforms` 满槽取 1 不取 0、隐藏不写位置、别名表忽略 `#undef`。
2. **翻译器语料**：改动前在 HEAD 导出基线（`WPESL2WGSL_DUMP_DIR=ignore/p13/a/baseline-head`），先用 HEAD 的 wasm 录请求夹具到 `ignore/p13/requests`；改动后带 `WPESL2WGSL_BASELINE_DIR` 跑 `--test corpus`：WPE 安装目录部分「变了 / 新失败」为空，请求夹具里只有 `generic` / `generic4` 的请求「新通过」（`WPESL2WGSL_BASELINE_ALLOW` 列出）。
3. **场景语料**：HEAD 快照与「HEAD + 本节补丁」快照（`kbp snapshot export` 后打补丁，排除别的会话没提交的改动）各跑一次 `kbp corpus scan`，`kbp corpus diff`：去掉的只有 `combo:REFLECTION`（7 张）、`uniform:g_LightsPosition` / `g_LightsColorRadius`（demon_core）、两条 `shader:generic:rewrite:*`（arsenal）与 `shader:generic4:rewrite:*GRADIENT_SAMPLER`（`3453730450`），没有新增键；能渲染 88 → 91。
4. **确定性工程**：`p13a-slots`、`p13a-gi2` 的两种状态和 WPE 逐像素比（kabegame-dev `render_scene`），uniform 值逐值相同。
5. **真实样本**：`3413921910`、`3498150384` 和 WPE 整帧比（静帧；再按 P5a 的逐帧光标回放一段鼠标划过，看 `cursorripple` 的反弹分支）；demon_core 和 WPE 整帧比（透视，按日志回放）。
6. 测完用 `projects_remove` 删测试行；WPE 只用 `capture_wallpaper`，不改设置。
7. 结果写进总计划「实施记录 / P13a」与 `p13-REPORT.md`，过后才请用户提交。

## 风险

1. **`readsLegacyLights` 的口径**：工程自带着色器声明同名 uniform 却另有用途时，WPE 照写引擎值，我们也照写，和 WPE 一致；作者把它写成材质常量（带 `meta.material`）时按材质常量处理，同 `readsAudioUniforms`。
2. **别名表按正文顺序**：头文件展开后的顺序就是预处理输出的顺序，`generic4` 在 `#include "common_pbr.h"` 之前定义 `GRADIENT_SAMPLER`，按顺序能追到；若有着色器先用后定义，WPE（预处理器）也认不出，照旧报错是对的。
3. **arsenal 仍不能渲染**：还差 `_rt_Reflection`（P13b1）；本节只验证它的翻译通过与 `LIGHTMAP` 的第二套 UV 在 P5c 顶点布局下有值（看翻译结果的属性反射，不比画面）。

## 实施记录（2026-11-14）

**执行**：sonnet 子代理按点 1–4 实现；`pipeline.test.ts` 的默认工程解锁名单漏了 demon_core（「意外解锁」），Claude 补了一行。和计划不同的一处：翻译器遇到行首 `#define` / `#undef` 时只更新别名表，这一行照旧逐字符扫描输出、不整行直出（宏体里原有的纹理调用照旧改写，输出才逐字节不变），接受。

**Claude 独立验收**（工作区 + 「HEAD `446acec1` 快照 + 本节补丁」快照，补丁由 `ignore/p13/a/own_patch.py` 只挑本节的块，`ignore/p13/a/p13a.patch`）：
1. 范围：改动只在计划列出的文件与 `pipeline.test.ts` 一行；`features.ts` / `bundle.ts` / `p2a.test.ts` 里本节的块 8 个，别的会话的改动没有混进来。tsc 0 error；vitest 全量 149 个文件 3469 条（补 demon_core 前 1 条「意外解锁」，补后 `pipeline.test.ts` 16 条全过）；Prettier；`cargo test -p wpesl2wgsl --lib` 100 条。
2. 变异 10 处全部检出（`ignore/p13/a/mutate_a.py`，结果 `ignore/p13/a/out/mutate.txt`）：`REFLECTION` 放回表、满槽取 1、只有遗留灯占槽、隐藏不写位置、不按单精度、第 4 盏的 w 少乘半径、编译不接遗留灯、`readsLegacyLights` 不看 `unused`、`#undef` 不删别名、不追别名。
3. 翻译器语料：WPE 安装目录 828 个导出文件和 HEAD 基线（`ignore/p13/a/baseline-head`）逐字节相同；请求夹具（HEAD 快照录的 `ignore/p13/requests`，926 个）重放只有 7 个 `generic` / `generic4` 请求从失败变成通过（`WPESL2WGSL_BASELINE_ALLOW=generic`），其余一致。wasm 已重编（`bin/wasm` 与前端拷贝同一份）。
4. 场景语料（`kbp corpus diff`，两份快照同一个底）：去掉的只有 `combo:REFLECTION` 7 张、`uniform:g_LightsPosition` / `g_LightsColorRadius`（demon_core 与测试工程）、`uniform:g_LightsColorPremultiplied`（测试工程）、两条 `shader:generic:rewrite:*`（arsenal）、`shader:generic4:rewrite:*GRADIENT_SAMPLER`（`3453730450`），没有新增键；干净 92 → 96，新增 `3413921910`、`3498150384`、demon_core 与 `p13a-slots`，没有掉出。
5. 确定性工程 `p13a-slots` 两种状态和 WPE 逐像素比（排除 FR / CLK）：最大差 1，10 / 12 个像素。
6. 真实样本按 [FINAL_CHECK.md](../FINAL_CHECK.md) 走查（见下一节「最终走查」）。最初一版按原壁纸整帧比，把差异归给「4K 缩放、随机粒子、时钟文字」，这正是原则第 4 条否定的解释，作废重做。
7. 测试行已用 `projects_remove` 删除。WPE 设置改了一项：`playbackfullscreen` 从 `pause` 改成 `run`（2026-11-14 用户：「直接改设置，不是临时改」，不改回），原因见走查第 3 条。

### 最终走查（FINAL_CHECK 原则，2026-11-14）

**复制工程**（`kbp content isolate --instrument`，WPE 与 Kabegame 用同一份，放 `ignore/p13/proj/*-iso`）：

| 原壁纸 | 留下的对象 | 换成固定值 | 为什么 |
|---|---|---|---|
| demon_core | 灯 5、`core` 6、`backgroundsphere` 7 | 无 | 去掉随机粒子（对象 8）；灯与被照的网格原样 |
| `3413921910` | `background` 16、`Reflection` 15762 | 无 | `cursorripple` 挂在 `Reflection`（projectlayer），它读下面画好的画面，所以留背景；其余 44 个对象（粒子、文字、声音）删掉 |
| `3498150384` | 文本 `D a y` 87 与子文本 `Date` 90、`Clock` 88 | 三层的 `text` 换成固定串 | `cursorripple` 挂在 87 上；文字脚本按当前时间出字，探针只能给起点、不能照录制逐帧给（FINAL_CHECK「工具」缺的一项），按原则第 5 条换成固定值；父链、effect、绑定不动 |

**录制与回放**：WPE fps 20、后处理 ultra，每张连抓 5 帧（`capture_sweep`，日志 `ignore/p13/out/*-iso*-log.txt`）；两张 `cursorripple` 工程抓帧期间用户持续动鼠标、日志每帧有光标。我们这边 `renderFrames.ts` 单开宿主逐帧回放（`--cursors log`、`--scripts`、`--postprocess ultra`，demon_core 另给 `--audio`），`kbp cmp frames` 逐帧比；对照组是光标固定在画面外（`--cursor 0.99,0.01`）的同样回放，用来证明录到的帧里确实有波纹。

**结果**：

| 复制工程 | 窗口 | 帧 | 按日志光标回放对 WPE | 光标固定对 WPE（对照） | 判定 |
|---|---|---|---|---|---|
| demon_core-iso | 1920×1080（透视，等于画布） | 182–186 | 每帧 739–2393 个像素 > 0；> 2 的 0–3 个，最大 151 | — | 差异已解释（下面 A、B） |
| 3413921910-iso | 3840×2160（= 场景） | 223–227 | 每帧 5–74 个像素，最大 2 | 每帧 128–156 万个像素，最大 37 | 差异已解释（C） |
| 3498150384-iso | 3840×2160（= 场景） | 228–232 | 每帧 10–41 个像素，最大 8 | 每帧 15–16 万个像素，最大 43 | 差异已解释（C） |

**差异逐处解释**（工具：`ignore/p13/a/` 下的脚本，抓帧在 `A:\p13a\`）：
- **A. demon_core 刺球轮廓 / 内边上的 5 个像素（最大 151）**：落在刺球 draw（WPE event 21、我们 draw 0）。两边常量逐值相同（`g_LightsPosition` / `g_LightsColorRadius` 差 0、`g_ViewProjectionMatrix` 差 1.4e-6、`g_EyePosition` 差 4.8e-7）；按单精度照抄 `core.vert` 的位移（`sin` 与音频 `pow`）算出的 1440 个顶点和 WPE `vs_out` 最多差 0.0005 像素（`edge_check.py`）；这几个像素的中心离两个三角形的公共边只有 0.0008–0.026 像素，覆盖归属翻到另一个三角形（轮廓上一边是背面剔掉的三角形，所以露出背景；内边上两边法线不同，所以颜色不同）。归为已知差异「网格边上的覆盖翻转」：顶点位置在 1e-4 像素量级上的差，来自两边超越函数的实现，不复刻。
- **B. demon_core 1 级的差**：刺球覆盖区内每帧 19–95 个像素（`mask_diff.py`，离轮廓 2 像素以内与以外都有），是光照着色的舍入；覆盖区外的全在背景球上（`backgroundsphere.frag` 以 `uv × 200` 平铺高频纹理、`g_Time` 滚动，双线性权重的舍入），背景球不读灯、不属本节。两类都是 8 位量化边界上的 1 级，归为已知差异。
- **C. `cursorripple` 的差**：落在合成 pass（我们 draw 4 / 6，WPE event 96 / 138）。读回两边的波纹模拟状态 RT（8 位、跨帧来回倒的 `_rt_EightBuffer1` / `2`）逐纹素比：`3498150384` 85504 个纹素里 55–56 个差 1、`3413921910` 147456 个里 9–10 个差 1，都只在 0 号通道，其余逐纹素相同（`rtcmp.py`）。画面上有差的像素全在这些纹素附近：`3498150384` 8 个 > 2 级的像素离最近的有差纹素都在 2.1 像素以内（一个纹素 2.6 像素，`map_texels.py`），`3413921910` 74 个像素最远 9.9 像素（一个纹素 7.5 像素，合成 pass 会采相邻纹素，`map_full.py`）。施力 pass 的输入：`g_PointerPosition` / `Last` / `State`、`g_Frametime` 两边逐值相同；`3498150384` 的 `g_EffectTextureProjectionMatrixInverse` 差 1 个 ulp（WPE 按单精度求逆，w = 0.99999994；我们按双精度求逆再存单精度，w = 1），`3413921910` 的逐值相同、模拟状态照样有个别纹素差 1。所以根源是施力着色器的单精度结果（加上那 1 个 ulp）在 8 位舍入边界两侧，经反馈逐帧带着走、在高对比边缘放大成几级。归为已知差异「8 位反馈 RT 的舍入翻转」，不复刻。`REFLECTION` 的值照旧传给着色器（本节只是不再按名字报），反弹分支两边是同一段代码。

**走查过程里查出的两件事**：
- **窗口必须和场景同尺寸**：第一轮 `3498150384` 用 3840×2130 的窗口（当时 MCP 开不出铺满整屏的窗口），按日志光标回放后仍差到 26 级；同一份复制工程换成 3840×2160 的窗口后只差 8 级、且能逐纹素解释。WPE 把铺满整屏的窗口当成全屏程序，`playbackfullscreen: pause` 时不呈现，所以改了设置（第 7 条）。
- **光标停着时录不到波纹**：前两轮抓帧那几帧光标是停着的，波纹已经衰减完，回放对照组和 WPE 一样「没有波纹」，逐像素相同没有说服力。第三轮让光标一直动，对照组才和 WPE 差出上百万个像素。

**待定**：`g_EffectTextureProjectionMatrixInverse` 按双精度求逆和 WPE 的单精度差 1 个 ulp，是 P7d 效果矩阵的事，不归 P13a。要不要改成照 WPE 按单精度求逆，见回复里的问题。

**没做 / 和计划不同**：
- 原壁纸整张的走查（FINAL_CHECK 流程第 2 步）等各节都走完后整体做一遍；这里只走了复制工程。
- 风险 3 的 arsenal `LIGHTMAP` 第二套 UV 没有单独核对，留给 P13b1（arsenal 要那一节才能渲染，到时整帧比）。
- `cocs/wpe/WPE_SCENE.md`、回归与 changelog 留到 P13 收尾一起写（别的会话也在改这几个文件）。
