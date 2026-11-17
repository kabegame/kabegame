> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`），全部没有实测。范围是 exe 侧：图像层（与 effect）上帧表动画的运行时、`ITextureAnimation` 的 exe 实现、文本 `anchor` 用到的 `E0..E3`。`scenescript64.dll` 侧的 JS 包装（参数转换、对象缓存、只读字段写入时抛不抛错）见并行的 `rea-p6e-script.md`，重叠处以那份为准。帧表读入（`TEXS`）、粒子路径见 [rea-p4b-render.md](../phase4/rea-p4b-render.md) 第 1、2 节；`E0..E3` 的完整公式已在 [rea-render-size.md](../rea-render-size.md) 第 1 节，本文只复核并补 `anchor` 一侧。

# WPE 2.8.42 图像层帧表动画、`ITextureAnimation` 与文本 `anchor` 平移（exe 侧静态逆向）

**概括**
1. **共享计时器在纹理对象上**【确】：帧表纹理（头标志 bit2）的纹理对象自带一份 `{frame +0x9c (int), time +0xa0 (f32), lastFrame +0xa4}`。纹理按名字缓存，同一张 `.tex` 的所有材质共用这一份（缓存键【推】），这就是 d.ts 里 `join()` 说的「所有用这张纹理的材质的共享计时器」。它**只在绑定时推进**：材质应用 `FUN_140155fc0` 对着色器用到的每个纹理槽调纹理虚函数 `+0x20`（`FUN_14015f0d0`），每个渲染帧第一次绑定时用 `g_Frametime`（`ctx+0x14c`）推进一次（按帧号 `ctx+0x144` 去重），之后同帧再绑定 dt 为 0。没有任何材质画到这张纹理的帧（图层不可见、被剔除、所有用户都脱离了）就不推进，也不补时间。
2. **推进算法**【确】：f32，每次调用**最多前进一帧**：`time += dt`；`time ≥ frames[cur].frametime` 时 `frame += 1`、`time −= 旧帧 frametime`，越过末帧回 0（**总是循环**），然后 `time = min(time, frames[新帧].frametime)`。所以帧时长小于渲染帧间隔时动画被卡在「每个渲染帧一帧」，多出的时间丢掉。`dt < 0`（只有脚本 `rate` 为负时出现）对称地往回走一帧并回绕到末帧。当前帧取每帧自己的 `frametime`，`total`（`tex+0xa8`）只给 `duration` 用。
3. **帧 → uniform 与图像**【确】：推进（或取覆盖帧）之后，对槽 `s`（`slot & 0xf`）写 `g_Texture<s>Rotation = (width/W, widthY/H, heightX/W, height/H)`、`g_Texture<s>Translation = (x/W, y/H)`（即帧项 `+0x10..+0x1c` 与 `+0x08..+0x0c`，`W/H` 是该帧 `imageId` 那张图像的第 0 级 mip 尺寸，读入时已除好），并把纹理的当前图像 `tex+0x98` 设成帧的 `imageId`。随后程序绑定 `FUN_1400d7440` 对同一批槽调 `+0x28`（`FUN_1400ee8b0`）绑 `tex+0x98` 号图像的 SRV。**每个槽都算**，不只槽 0；多图像帧表靠换绑另一张独立的 GPU 纹理实现（不是数组层）。这也更正了 rea-p4b 2.7：`tex+0x98` 有运行中写入者，就是这里。
4. **`SPRITESHEET` 不是引擎给图像层写的**【确，有界】：exe 里 `"SPRITESHEET"` 只在粒子（`FUN_1401d2340`）和 puppet 纹理通道的 `fullscreenlayer` 材质（`FUN_140209540`，槽 0 是帧表时）两处写。普通图像层的这个宏来自材质 JSON 自己的 `combos`（编辑器模板 `declarations.json` 的「Image (animated)」写 `SPRITESHEET: 1`；`dino_run` 的材质写的是小写 `spritesheet`）。WPE 自带着色器里只有槽 0 的 `g_Texture0Rotation/Translation` 有读者（`genericimage*.vert`、`passthrough.vert`、`clippingmaskimage4.vert`），图像层路径没有混帧（`SPRITESHEETBLEND` 只在粒子着色器里）。
5. **图层私有状态（脱离）**【确】：`getTextureAnimation()` 在图像层上懒建一个 0xf0 字节的对象 `A`（存 `O+0x4c0`，与 `getVideoTexture` 共用这一格），只有基础材质槽 0 是帧表时才建。`A` 有 `detached(+0x48)`、`playing(+0xe0, 初值 1)`、`rate(+0xe4, 初值 1)`、私有 `{frame +0xe8, time +0xec}`。`detached = 0` 时图层完全跟共享计时器走，`A` 的其它字段不起作用；`detached = 1` 时图层每帧更新（`+0x48`，帧函数第 2 步）用 `g_Frametime × rate` 推进私有状态（只要 `playing`，**不看可见性**），绘制时把私有帧号写进 `ctx+0x132c`，这段绘制里绑定的**所有**帧表纹理都用这个帧号（越界取第 0 帧），也不推进它们的共享计时器。
6. **脚本方法**【确】：`pause()` 在未脱离时先拷共享的 `{frame, time}`，然后 `playing = 0`、脱离；`play()` 只置 `playing = 1`，**不并回**；`stop()` 私有状态清成 `{0, 0}`、`playing = 0`、脱离（停在第 0 帧）；`setFrame(n)` 写 `{n, 0}`，未脱离时同时脱离并置 `playing = 1`（会接着从 `n` 播），已脱离时 `playing` 不变；`getFrame()` 脱离时返回私有帧号原值（可越界），否则返回共享帧号；`isPlaying()` 只有「脱离且没在播」才假；`join()` 只清 `detached`；写 `rate` 为 1 以外的值（含 NaN）且未脱离时，拷共享状态并脱离，写回 1 不并回；`frameCount` / `duration` 每次现读当前材质槽 0 纹理的帧数与 `total`。
7. **越界与负帧**【确】：`setFrame` 的值原样存（int，非整数怎么转归 dll）。绘制时 `≥ 帧数` 画第 0 帧；**负数时不覆盖**，这一段绘制改走共享计时器（并推进它）。私有推进遇到越界帧号按第 0 帧的时长算，满一帧后回到 0。
8. **帧内时机**【确】：帧开头 `ctx+0x144` 加 1、写 `ctx+0x14c`；第 2 步各对象 `+0x48`（私有推进）；紧接着 `FUN_140183a70` 重算 `E0..E3`；第 6 步光标；第 7 步关键帧、计时器、`update`（脚本 API 当场改 `A`）；第 8 步渲染（共享计时器在本帧第一次绑定时推进，脱离的图层用 `A` 的帧号）。所以 `update` 里 `getFrame()`（未脱离时）读到的是上一帧画出的帧，本帧渲染还可能再进一帧。
9. **图层尺寸与 UV**【确】：帧表纹理的图层合成尺寸与 `autosize` 都取帧表头 `tex+0xb0/+0xb4`（TEXS0003 头里的帧宽高；版本 < 3 时是整张图像宽高）。四边形 UV 缩放平时是 `(图像宽/纹理宽, 图像高/纹理高)`，帧表纹理且 `TEXS` 版本 ≥ 3、或有 effect、或 colorBlendMode 合成时改成 `(1, 1)`。0.15 texel 内缩按整张纹理尺寸加在 `a_TexCoord` 上，再经 `Rotation` 映射进帧。语料里图像层的帧表全部是 TEXS0003、没有旋转帧（51 张，见 7.3）。
10. **纹理换了就销毁 `A`**【确】：槽 0 纹理就绪回调 `FUN_140209360` 尾部发现 `A+0x50` 不是新纹理就析构 `A`、清 `O+0x4c0`（用户纹理换图会走到）；析构经基类通知监听者【推：dll 包装由此失效】。
11. **`general.spritesheetrefreshsync`**【确：读入与用途；数值【推】】：场景 JSON 的这个布尔置 `G+0xe0 |= 0x40`，窗口层在每次呈现后按「第一个图像层的槽 0 帧表还差多久换帧」`Sleep`（上限 0.25 s），让渲染节奏跟帧表对齐。语料 217 个场景 0 处使用。
12. **文本 `anchor` 的 `E0..E3`**【确】：独立重读 `FUN_140183a70`，与 rea-render-size 第 1 节逐条一致：`ortho(E0, W − E2, E3, H − E1)`，E 为正是裁掉、为负是留边；0 / 其它 = 铺满裁切、1 = 装下、2 = 拉伸（全 0）、3 = 居中（1 场景单位 = 1 窗口像素）、4 = 自由。**每帧**在第 2 步之后重算（`0x14017fd2e`），另在 resize 与加载时各算一次；透视场景不算（保持 0）。`anchor` 把对象平移到「可见矩形的对应边 / 中心」；同比例窗口下只有 0、1、2 中性，3、4 只有窗口与场景同大才中性（rea-render-size 第 4 节已更正 rea-p6b 3.4 的说法）。`alignmentfliph` 只翻投影的左右，`E` 与 `anchor` 不跟着换边。

**元数据**
- 目标：`wallpaper64.exe` 2.8.42，副本 `ignore/p6/rea/sheet/exe/wallpaper64.exe`（拷自 `ignore/p9/rea/wallpaper64.exe`），开工核对 SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，一致。没运行、没附加 WPE，没写 Steam / WPE 目录。只读了 WPE 的 `assets/shaders/{genericimage*.vert, passthrough.vert, clippingmaskimage4.vert, declarations.json}`、`projects/defaultprojects/dino_run/`（材质、`scene.json`、`.tex` 头），以及经 `kbp content cat` 只读取出的 5 个工坊 `scene.json` 与 51 张图像层帧表纹理。
- 方法：REA 6.9.0 / Ghidra 12.1.4。开工时 `binary_session` 显示没有打开的目标（没有别的会话占着），直接不带快照打开副本；`decompile_all` 按地址区间导出伪代码，`procedure_pseudo_code` / `procedure_callers` / `resolve_containing_procedure` 补单个函数。指令级细节（比较方向、寄存器到字段的对应、f32 运算顺序）用 `ignore/p4/rea/wp.asm` 切片逐条核对。结束时另存 `ignore/p6/rea/sheet/exe/wallpaper64-2.8.42-p6e-sheet.rea-snapshot`（86 KB，11 条 Evidence）并 `close_binary`。坑：本机 Python 是 pyenv 的批处理垫片，命令行参数里的 `|` 会被 cmd 当管道吃掉，正则一律写进 `@文件`。
- 工作文件 `ignore/p6/rea/sheet/exe/`：
  - 反编译（`<目录>/functions/<地址>.c`）：`dec-uni`（uniform 取值 `FUN_1400d8300`）、`dec-img`（图像层 `0x140200000`–`0x140216000`：绘制、组合键、尺寸、就绪回调、`getTextureAnimation`、描述符登记）、`dec-upd`（`0x1401fa000`–`0x1401fe000`：`ITextureAnimation` 小函数、图像层每帧更新 `FUN_1401fdf90`）、`dec-mat`（材质应用 `FUN_140155fc0`）、`dec-tex`（`TEXB` / `TEXS` / 容器）、`dec-layout`（`FUN_140183a70`）。
  - 汇编切片：`bind_frame_14015f0d0.asm`（绑定时选帧）、`advance_14015fdd0.asm`（私有推进）、`texanim_methods_1401fa2a0.asm`（`frameCount` … `join`、`rate` 回调）、`imgdraw_override_140206587.asm`、`imgupd_tail_140206355.asm`、`matapply_tail_140157270.asm`、`progbind_1400d7440.asm`、`texready_140209360.asm`、`gettexanim_14020e670.asm`、`texs_14015e1d0.asm`、`layout_140183a70.asm`、`align_writer.asm`、`refreshsync_1401134c0.asm`。
  - 脚本：沿用 `fn.py` / `grepfn.py` / `slice.py` / `xr.py` / `before.py` / `leastr.py` / `rd.py` / `strs.py` / `vtdump.py` / `vtscan.py`；新增 `nametab.py`（uniform 名 → 编号，输出 `nametab.txt`）、`fnof.py`（grep 结果标所属函数）、`ptrfind.py`（找指向某函数的虚表槽）、`pair.py` / `seqpat.py`（两条指令的先后模式）、`texs.py`（读 `.tex` 头与 TEXS 帧表）、`scan_img_sheets.py`（语料图像层帧表扫描，输出 `img_sheets.txt`、取出的纹理在 `img_sheets/`）、`edges.py`（按 f32 复算 E 与 anchor 平移）、`scripts_of.py` / `showgrep.py` / `showscript.py`（语料脚本）。
  - 语料 grep：`grep_texanim.json`（`TextureAnimation`，53 处 / 13 个场景）、`grep_refreshsync.json`（0 处）。
- 标记：【确】伪代码 / 汇编直接看到；【推】由代码推出或引用旧结论；【确，有界】在注明范围内搜过。

**命名**（沿用 rea-p6d-layers / rea-render-size）
- `R` 渲染器，`G = *R` 场景，`ctx = R+0x10`，`H = G+0x48` 宿主接口。
- `O` 图像层对象（虚表 `0x1404911a8`）：`O+0xc8 = ctx`，`O+0x498` 基础材质，`O+0x4a0` 预光照变体、`O+0x4a8` puppet 直接上屏变体（rea-p12-mdl），`O+0x4c0` = `A`（或视频包装）。
- `tex` 纹理对象（基类构造 `FUN_14015eb90`，基类虚表 `0x14048b810`，D3D 子类 `0x140487088`）：`+0x08 = ctx`，`+0x1c` 头标志（bit2 帧表、bit5 视频），`+0x20/+0x24` 纹理宽高，`+0x2c/+0x30` 图像宽高，`+0x98` 当前图像，`+0x9c` 共享帧号，`+0xa0` 共享时间，`+0xa4` 上次推进的帧号，`+0xa8` 帧表 `FT`。
- `FT`（`tex+0xa8`，rea-p4b 2.1）：`+0 total`、`+4 version`、`+8/+0xc` 头宽高（`tex+0xb0/+0xb4`）、`+0x10/+0x18` 帧向量（`tex+0xb8/+0xc0`，32 字节项 `{frametime, imageId, x, y, width, widthY, heightX, height}`，后 6 项已归一化）。
- `A` = `ITextureAnimation` 的 exe 对象（0xf0 字节，虚表 `0x140491168`），字段见第 3 节。
- `E0..E3` = `R+0x110/+0x114/+0x118/+0x11c` = `ctx+0x100..+0x10c`（左、上、右、下）。

---

## 1. uniform 与它们在 `ctx` 里的位置【确】

- 名表 `FUN_140002860`（`nametab.py`）：`g_Texture<n>` = `0x20 + n`，**`g_Texture<n>Rotation` = `0x2a + n`**，**`g_Texture<n>Translation` = `0x34 + n`**，`g_Texture<n>Resolution` = `0x3e + n`，`g_Texture<n>Texel` = `0x48 + n`（n = 0..9）。
- 取值 `FUN_1400d8300`（`dec-uni`）：
  ```c
  case 0x2a..0x33: *(vec4*)out = *(vec4*)(ctx - 0xd4 + id*0x10);   // = ctx+0x1cc + 0x10*n
  case 0x34..0x3d: *(vec2*)out = *(vec2*)(ctx + 0xcc + id*8);      // = ctx+0x26c + 8*n
  case 0x3e..0x47: t = (*(ctx+0x58))[n]; out = t ? (texW, texH, imgW, imgH) : (2,2,2,2);   // 绑定中的纹理表，见第 2.3 节
  ```
- 这两组数组是 `ctx` 上的全局量：构造 `FUN_14017c6d0`（`0x14017c893` `memset(ctx+0x1cc, 0, 0xa0)`、`0x14017c8cb` 起清 `+0x26c..+0x2bb`）清零，之后**只有** `FUN_14015f0d0` 写（`g_rt.txt` 全文件扫 `+0x1cc` / `+0x26c` 的写入者，其余命中都是别的对象的同偏移）。【确，有界】
  - 推论：材质开了 `SPRITESHEET` 但槽 0 绑的不是帧表纹理时，读到的是**上一次**某个帧表纹理绑在这个槽时留下的值，开机后从没绑过就是全 0（`v_TexCoord` 恒等于 `Translation`）。【推】
  - 槽号 `& 0xf` 最大 15，数组只有 10 项：槽 ≥ 10 的帧表纹理会把 `Rotation` 写进 `Translation` 数组之后的区域。语料里没有这种槽。【确：地址算术】

## 2. 共享计时器：绑定时选帧

### 2.1 调用链【确】
- 纹理虚表 `+0x20` = `FUN_14015f0d0`（`ptrfind.py`：`0x1404870a8`（D3D 子类，表头 `0x140487088`）与 `0x14048b830`（基类，表头 `0x14048b810`）两处都指向它）；`+0x28` = `FUN_1400ee8b0`（绑 SRV）。
- 材质应用 `FUN_140155fc0` 尾部（`0x140157270`–`0x1401572ee`，20 个调用者：图像层的 `+0xe0/+0xe8/+0xf0/+0xf8`、effect、粒子 `FUN_1402366f0`、文本 `FUN_140257c30` / `FUN_140258050` 等）：
  ```c
  ctx->boundTextures(+0x58) = mat + 0xd0;                 // 材质的纹理槽表
  for (b = program(+0x1e0)->slotList(+0x14); *b != 0xff; ++b)   // 着色器真正用到的槽
      mat->tex[*b & 0xf]->vt[0x20](tex, *b & 0xf);        // FUN_14015f0d0：选帧、写 Rotation/Translation、定当前图像
  program->vt[0x8](program, mat+0x120, mat+0x1e8);        // 尾调
  ```
- 程序绑定 `FUN_1400d7440`（`program->vt[0x8]` 的实现之一，`0x1400d7480` 起）：对同一个槽表，`tex = ctx->boundTextures[slot & 0xf]`，`tex->vt[0x28](tex, slot)`（带 0x40 位的是顶点着色器槽）。之后才上传 uniform（读第 1 节的数组）。所以**同一次绘制里先全部选帧，再绑图像，再传常量**。
- 材质应用只有这一条路径走到循环（没有「同一材质跳过」的早退），每次绘制都跑。【确】

### 2.2 `FUN_14015f0d0(tex, slot)`【确：`bind_frame_14015f0d0.asm`】
```c
if (tex->unk_e0 || tex->video_d8) {            // 视频（P9）或另一类动态纹理
    tex->image(+0x98) = 0;
    tex->video_d8 ? video->vt[0x78]() : tex->vt[0x38](tex);   // 尾调，与帧表无关
    return;
}
if (!(tex->flags & 4) || FT.frames 为空) { tex->image = 0; return; }
ctx = tex->ctx(+0x08);
f = ctx->frameOverride(+0x132c);               // int，平时 −1（第 3.3 节）
if (f >= 0) {
    if ((u64)f >= N) f = 0;
    cur = &frames[f];                          // 覆盖：不推进共享计时器，不写 +0xa4
} else {
    dt = (tex->lastFrame(+0xa4) != ctx->frameNo(+0x144)) ? ctx->dt(+0x14c) : 0.0f;
    advance(&tex->frame(+0x9c), &tex->time(+0xa0), FT, dt);   // 第 2.4 节，内联的同一份算法
    tex->lastFrame = ctx->frameNo;
    cur = &frames[推进后的 frame（越界取 0）];
}
s = slot & 0xf;
ctx->Rot[s]   = (cur->f10, cur->f14, cur->f18, cur->f1c);   // 0x14015f2a3–0x14015f2bc：width/W, widthY/H, heightX/W, height/H
ctx->Trans[s] = (cur->f08, cur->f0c);                       // 0x14015f2d3–0x14015f2da：x/W, y/H
tex->image(+0x98) = cur->imageId(+0x04);                    // 0x14015f2e8
```
- `ctx->frameNo`（`ctx+0x144` = `R+0x154`）是帧计数，帧函数 `0x14017fca7` 每帧 `+1`（rea-p10）；`ctx->dt`（`ctx+0x14c`）是 `g_Frametime`（名表 4 号），`0x14017fcc1` 每帧写，已含场景 rate 与暂停淡变、钳在 [0.0001, 0.25]（rea-p11b、rea-framework）。
- 纹理基类构造 `FUN_14015eb90` 把 `+0x98..+0xa7` 清 0（`0x14015ec2b` / `0x14015ebef`），所以共享状态初值 `{frame 0, time 0, lastFrame 0}`；`ctx+0x144` 在 `ctx` 构造时为 0、第一帧开头变 1，所以第一帧的第一次绑定就推进一次。【确】
- 「每帧最多推进一次」只靠 `+0xa4` 与帧号比较：同一帧里反射 pass、主 pass、effect、别的图层再绑这张纹理时 dt = 0，画出的是同一帧。【确】
- 「同一张 `.tex` 一个对象」：纹理管理器 `FUN_14014d500` 按名字缓存（rea-p6d-layers 4.1），所以用同一个文件的图层、effect、粒子共用一份状态。【推：缓存键没逐字段核对】

### 2.3 绑哪张图像（多图像）【确】
- `FUN_1400ee8b0`（rea-p4b 1.2）：`PSSetShaderResources(slot & 0xf, 1, &images[tex->image].srv)`（槽带 0x40 时 VS），再绑采样器 `tex+0x158`。`images` 是 `tex+0x140` 起的 24 字节项向量，每张图像一个独立的 D3D 纹理与 SRV（建纹理 `0x1400edb10`）。
- 所以多图像帧表换帧就是换绑另一张 GPU 纹理；每张图像尺寸可以不同，帧坐标按**该帧 `imageId` 那张图像**的第 0 级 mip 归一化（`FUN_14015e1d0` `0x14015e4c1`–`0x14015e4eb`；`imageId` 越界或没有 mip 时 6 个坐标为 0，rea-p4b 2.1 已述）。`g_Texture<n>Resolution` 仍读头里的整体尺寸（`tex+0x20/+0x24/+0x2c/+0x30`），不随图像变。
- 绑定不检查 `tex->image` 是否越界（`movsxd` 后直接下标）。【确】
- **更正 rea-p4b 2.7**：「没找到运行中写 `tex+0x98` 的地方」——写入者就是 `FUN_14015f0d0`。粒子材质同样经 `FUN_140155fc0` 绑定，所以多图像帧表用在粒子上时，绑的是**共享计时器当前帧**的那张图像（粒子各自的网格 UV 仍只在这一张里取），并且会推进这张纹理的共享计时器。语料里没有这种粒子。【确：路径；画面后果【推】】

### 2.4 推进算法 `advance`【确：`advance_14015fdd0.asm`，与 `0x14015f154`–`0x14015f275` 的内联拷贝逐条相同】
```c
// st = {int frame; f32 time}，frames[N]；全部 f32（addss / subss / minss / maxss）
f = st.frame;
cur = (0 <= f && f < N) ? &frames[f] : &frames[0];
if (dt > 0) {
    st.time += dt;
    if (!(st.time < cur->frametime)) {                  // comiss; jb：time < ft（或 NaN）就不动
        f += 1;  st.time -= cur->frametime;  st.frame = f;
        if ((u64)(i64)f >= N) { st.frame = f = 0; }      // 回绕；f 原本为负时也落到 0
        st.time = min(st.time, frames[f].frametime);     // minss：t < ft ? t : ft
    }
} else if (dt < 0) {
    st.time += dt;
    if (!(0 < st.time)) {                               // time ≤ 0 才退
        f -= 1;  if (f < 0) f = N - 1;  st.frame = f;
        st.time = max(st.time + frames[f].frametime, 0); // maxss
        // 退之前 f ≥ N（越界）时这里读 frames[f−1] 越界，属未定义
    }
}
```
- **每次最多一帧**：没有循环。帧时长 < 渲染帧间隔时，每个渲染帧正好进一帧，多余时间被 `min` 截掉。例：语料里 0.03 s / 帧的序列（`3486806915`、`3516174947`、`3560756264`、`3643916956`）在 30 fps 下以 30 fps 播，而不是 33.3；`3560756264` 写 `rate = 9`，在 30 fps 下同样是每帧一格。【确：代码；数值【推】】
- 帧时长为 0 的帧（粒子帧表常见，例如 `lightning2`）：`time ≥ 0` 恒成立，每次推进都过一帧。
- 没有单次 / 乒乓模式；`frametime` 取每帧自己的值，`total` 不参与。

## 3. 图层私有状态：`ITextureAnimation` 对象 `A`

### 3.1 创建：图像层方法 `getTextureAnimation` = `FUN_14020e670`【确】
- 登记在图像层方法表 `DAT_1404e8620`（`FUN_140211070`，`0x14021122c` 起），返回类型码 `0x800`（对象），无参数。与 `getVideoTexture`（`FUN_14020e7b0`）共用 `O+0x4c0`。
```c
if (O->texAnim(+0x4c0)) return O->texAnim;              // 已有就返回（不管是哪种包装）
t = O->baseMat(+0x498)->tex[0](+0xd0);
if (t && (t->flags & 4)) {
    A = new 0xf0;  A->vt = 0x140491168;  A+0x10 = ctx+0x1c88;  分配对象 id（FUN_1401a38f0）;
    FUN_140153760(A+0x60);                               // 描述符 / 监听表
    A->playing(+0xe0) = 1;  A->rate(+0xe4) = 1.0f;  A->frame(+0xe8) = 0;  A->time(+0xec) = 0;
    A->detached(+0x48) = 0;  A->layer(+0x58) = O;  A->tex(+0x50) = t;
    O->texAnim = A;
}
return O->texAnim;                                       // 槽 0 不是帧表时为空
```
- 槽 0 不是帧表又没建过视频包装：返回空。先调过 `getVideoTexture` 的图层上调 `getTextureAnimation` 会拿到视频包装（同一格），反之亦然。【确：代码；JS 侧表现归 dll】

### 3.2 字段与方法表（`FUN_1402131a0` 登记：属性表 `DAT_1404e8660`，方法表 `DAT_1404e86a0`）【确】

| 名字 | 种类 / 类型码 | exe 实现 | 语义 |
|---|---|---|---|
| `rate` | 属性 float（4），偏移 `+0xe4`，可写 | 写 `LAB_1401a49f0`（存值后尾调回调）、读 `LAB_1401a4a10`、回调 `LAB_1401fa4a0` | 见下 |
| `frameCount` | 属性 int（0），只读（描述符 `+0x60 = 2`，没有写函数；【推】是只读标志） | `LAB_1401fa2a0` | 现读：材质（`O+0x4a0` → `+0x4a8` → `+0x498` 第一个非空）槽 0 纹理是帧表时写 `(end − begin) >> 5`，否则不写输出 |
| `duration` | 属性 float（4），只读 | `LAB_1401fa2f0` | 同上取 `FT.total`（`tex+0xa8`，读入时 f32 逐帧累加） |
| `play()` | 方法，返回 1（无值） | `LAB_1401fa330` | `playing = 1`，**不改 `detached`** |
| `pause()` | 方法，返回 1 | `LAB_1401fa340` | 未脱离且当前槽 0 是帧表：`A.{frame,time} = tex.{frame,time}`（qword 拷 `+0x9c`）；然后 `playing = 0`、`detached = 1` |
| `stop()` | 方法，返回 1 | `LAB_1401fa3a0` | `A.{frame,time} = {0, 0}`、`detached = 1`、`playing = 0` |
| `isPlaying()` | 方法，返回 2（布尔） | `LAB_1401fa3d0` | `!(detached && !playing)` |
| `setFrame(n)` | 方法，参数类型码 8（整数），返回 1 | `LAB_1401fa400` | `A.frame = n`、`A.time = 0`；**未脱离时** `detached = 1`、`playing = 1`；已脱离时 `playing` 不变 |
| `getFrame()` | 方法，返回 8（整数） | `LAB_1401fa430` | 脱离：`A.frame`；未脱离且当前槽 0 是帧表：`tex.frame`；否则 `A.frame` |
| `join()` | 方法，返回 1 | `LAB_1401fa490` | `detached = 0`（其余不动） |

`rate` 回调 `LAB_1401fa4a0`：
```c
if (A->rate == 1.0f) return;                 // ucomiss + jp/je：恰好 1 时什么都不做（NaN 不算等于）
if (A->detached) return;
if (当前槽 0 是帧表) *(u64*)&A->frame = *(u64*)&tex->frame;   // 拷 {frame, time}
A->detached = 1;                             // playing 不变（初值 1，所以会接着播）
```
- `A` 的虚表 `0x140491168`：`+0x00` 析构 `FUN_140213130`（尾调基类 `FUN_1401a3b60`，它对 `+0x18` 起的监听表逐个调用，【推】dll 包装靠它失效），`+0x10/+0x18` 列属性 / 方法（`0x140213a00` / `0x140213dd0`，读 `DAT_1404e8660` / `DAT_1404e86a0`），`+0x20/+0x28` 按名找属性 / 方法（`0x140213880` / `0x140213ce0`）。JS 调这些方法走的是脚本对象的通用反射分派，不经宿主接口 `H` 的槽。【确】

### 3.3 私有状态怎么起作用【确】
- **每帧推进**：图像层每帧更新 `FUN_1401fdf90`（虚表 `+0x48`）末尾（`0x1402063b9`–`0x140206405`）：
  ```c
  A = O->texAnim;
  if (A) {
      if (A->tex->flags & 0x20) { … 视频包装（P9b）… }
      if (A->detached && (A->tex->flags & 4) && A->playing)
          advance(&A->frame, &A->tex->FT, ctx->dt(+0x14c) * A->rate);   // FUN_14015fdd0；mulss，f32
  }
  ```
  这段前面没有可见性判断、没有早退（函数只有一个 `return`）；`FUN_1401891a0`（帧函数第 2 步）对场景对象表**每个**对象无条件调 `+0x48`。所以脱离且在播的图层**不可见时照常推进**。用的是建 `A` 时的纹理 `A+0x50` 的帧表。
- **绘制覆盖**：图像层绘制 `FUN_140206430`（虚表 `+0x50`）尾部（`0x140206587`–`0x1402065bb`）：
  ```c
  if (A && A->detached) { ctx->frameOverride(+0x132c) = A->frame; FUN_1401e8aa0(O); ctx->frameOverride = -1; }
  else FUN_1401e8aa0(O);
  ```
  `ctx+0x132c` 全文件只有这里和 `ctx` 构造（初值 −1，`0x14017ceac`）写（`g_132c.txt`）。覆盖持续整个 `FUN_1401e8aa0`：基础 pass、合成 RT、effect 链、末 pass、puppet、反射 pass 里的这次绘制。于是：
  - 这段时间里绑定的**任何**帧表纹理（包括 effect 材质里别的槽、别的纹理）都画 `A->frame`（`≥ 该纹理帧数` 时画第 0 帧），都不推进各自的共享计时器；
  - `A->frame < 0` 时等于没覆盖：这段绘制走共享计时器并推进它（第 2.2 节的 `f >= 0` 判断）。
- `getFrame()` 返回的私有帧号不夹取，`setFrame(99)` 后读回 99，而画的是第 0 帧；在播时满一个 `frames[0].frametime` 后私有帧号变 0。【确】

### 3.4 并回与生命周期【确】
- `join()` 只清 `detached`：下一次绘制起用共享计时器当时的 `{frame, time}`（脱离期间共享计时器只在别的材质画到它时才走），私有状态留着不用。`playing`、`rate` 保留；之后再 `pause()` / 写 `rate` 会再次脱离。
- `A` 只由图层析构（`FUN_1401fb4e0` `0x1401fb4f8`：`O+0x4c0` 非空就 `vt[0](A, 1)`）和槽 0 纹理就绪回调 `FUN_140209360` 尾部（`0x14020950a`：`A->tex != 新纹理` 时 `A->vt[0](A, 1)`、`O+0x4c0 = 0`）释放。用户纹理（P11b）换掉槽 0 会走到后者，之后再 `getTextureAnimation()` 按新纹理重新判断、新建。
- 语料用法（`grep_texanim.json`，13 个场景）几乎都是「`init` 里 `pause()` 或 `stop()`，再 `setFrame(k)` 当按钮状态」（`3319542538`、`3286859278`、`3643916956` 等）；`3486806915` / `3516174947` / `3577990983` 在 `update` 里读 `getFrame()` 与 `frameCount`，到末帧时 `stop()`、延时后 `play()`；`3560756264` 写 `rate = 9` 后 `stop()`，之后 `play()` 播到末帧再 `stop()`。

## 4. 帧函数里的先后【确】

| 位置 | 动作 | 与帧表的关系 |
|---|---|---|
| `0x14017fca7` / `0x14017fcc1` | `ctx+0x144` 加 1、写 `ctx+0x14c` | 本帧的帧号与 dt |
| 第 2 步 `FUN_1401891a0`（`0x14017fd26`） | 每个对象 `+0x48` | 脱离且在播的图层推进私有状态（不看可见性、暂停与否只看 `playing`） |
| `0x14017fd2e` `FUN_140183a70` | 重算 `E0..E3` 与正交投影 | 第 7 节 |
| 第 6 步 | 光标命中与派发 | 回调里调 API 当场改 `A` |
| 第 7 步 `FUN_140171440` | 媒体 → 关键帧 → `animationEvent` → 计时器 → `update` | 同上；`setFrame` / `stop` 当帧就画出 |
| 第 8 步 渲染 | 绘制 → 材质应用 → `FUN_14015f0d0` | 共享计时器在本帧第一次绑定时推进，脱离图层用 `A->frame` |

- 未脱离时，`update` 里 `getFrame()` 读到的是上一帧渲染后的共享帧号；本帧渲染可能再进一帧，所以「读到末帧就 `stop()`」的脚本（`3486806915`）在 WPE 里最后一格只显示到读到它的那一帧。【推】
- 脱离后的私有推进在第 2 步、早于脚本：脚本在第 N 帧 `play()`，第 N 帧画的仍是 `A->frame`，第 N+1 帧第 2 步才开始走。写 `rate` 脱离的那一帧同理（画拷来的帧，不前进）。【推：由顺序推出】
- 壁纸暂停：暂停期间帧函数不跑，两种计时器都不走；暂停淡入淡出期间 `g_Frametime` 被乘了系数（rea-p11b）。【推：没在本次重读】
- 新建图层（P6d）第一帧没跑 `+0x48`，私有推进从下一帧开始；共享计时器只看绑定，不受影响。

## 5. `SPRITESHEET` 宏、UV 缩放、图层尺寸

### 5.1 宏从哪里来【确，有界】
- `"SPRITESHEET"`（`0x140490180`）的引用只有 `FUN_1401d2340`（粒子，rea-p4b 2.4）与 `FUN_140209540` `0x14020a27e`（puppet 纹理通道的 `materials/util/fullscreenlayer.json`，槽 0 `flags & 4` 时写 `SPRITESHEET = 1`，rea-p12-mdl / P12b2）。没有内联成立即数的写法（搜 8 字节立即数 `0x4853455449525053` 无命中）。
- 所以普通图像层与 effect 的 `SPRITESHEET` 只来自材质 JSON 的 `combos`（或对象 `instance.combos`，P5b）。编辑器模板 `shaders/declarations.json` 的 `animatedimageshaders*`（「Image (animated)」）写 `"SPRITESHEET": 1` 并配 `nonpoweroftwo`、`clampuvs`、`nomip`、`halfmip`；`dino_run` 的材质写 `"spritesheet": 1`（小写）。
- WPE 自带着色器里读 `g_Texture<n>Rotation/Translation` 的只有槽 0：`genericimage{,2,3,4}.vert`、`passthrough.vert`、`clippingmaskimage4.vert`（`grep` assets 全目录）；工坊散文件里没有别的读者（pkg 内的自定义着色器没扫）。引擎对每个用到的槽都算（第 2.2 节），自定义着色器声明 `g_Texture1Rotation` 也能拿到。
- 图像层路径没有混帧：`genericimage*` 没有 `SPRITESHEETBLEND`，引擎也只在粒子路径写它。
- puppet 用帧表时强制走合成路径、UV 不缩放（rea-p12-mdl 第 9 行，`FUN_140209540` 的 `bVar7`）；普通（非 puppet、非预光照材质）图像层不因帧表改走合成。【确：`FUN_140209540` 的分支条件】

### 5.2 四边形 UV 缩放：`FUN_140209360`（槽 0 纹理就绪回调）【确：`texready_140209360.asm`】
```c
uv = (imgW / texW, imgH / texH);                          // tex+0x2c/+0x20、+0x30/+0x24
if (((tex->flags & 4) && FT.version(+0xac) >= 3)          // 0x14020948c–0x140209499
    || O->effectCount(+0x320) > 0
    || (O->flags304 & 0x10))                              // colorBlendMode 合成
    uv = (1, 1);
O->vt[0xb0](O, uv, texW, texH, sizeW, sizeH);             // FUN_1402066a0 → FUN_1401ede30 建四边形
```
- `FUN_1401ede30`：四边形 UV 是 `[0.15/texW, uv.x − 0.15/texW] × [0.15/texH, uv.y − 0.15/texH]`（内缩位开时；`texW/texH` 是整张纹理的头尺寸），`flags & 4` 时 v 翻转。帧表的 `Rotation/Translation` 再把这个 `a_TexCoord` 映射进帧，所以帧内实际内缩是 `0.15/texW × (width/W)`（极小）。【确】
- 推论：TEXS 版本 < 3 的帧表、NPOT、又没有 effect 时，`a_TexCoord` 上界是 `imgW/texW` 而不是 1，画出的是帧的左下一部分。语料里图像层的帧表 51 张全是 TEXS0003（7.3），碰不到。【推】

### 5.3 尺寸【确】
- 合成 RT 尺寸 `FUN_1402091e0`（虚表 `+0x128`）：帧表纹理时取 `FT` 头 `(tex+0xb0, tex+0xb4)`，再整除全局降级系数 `ctx+0x1218`。版本 ≥ 3 是 TEXS 头里的帧宽高，版本 < 3 是 `TEXI` 的图像宽高（rea-p4b 2.1）。
- `autosize`（`+0x304 & 8`，`FUN_140209360` `0x1402093d2`）：帧表纹理时同样取 `(tex+0xb0, tex+0xb4)`，**不是**图像尺寸（补 P5b「`autosize` 覆盖成槽 0 图像尺寸」的帧表情形）。

## 6. 读入侧的补充

- `TEXB` 返回 1 的条件（rea-p4b 1.1 的【推】改【确】）：`FUN_14015c8d0` 的 mip 循环里，加载标志 `param_7 & 2`、第 0 张图像、mip 数 ≥ 2 时跳过第 0 级 mip（`dec-tex/functions/0x14015c8d0.c` 第 599–603 行的 `bVar4`，第 661 行置返回值 1）；容器 `FUN_14015e580` 读完全部块后把每帧 6 个坐标 ×0.5（TEXS 归一化时用的是跳过后的 mip0）。`param_7 & 2` 的来源【推】是降低纹理分辨率一类的设置。Kabegame 不跳 mip，碰不到。
- TEXS 读入（`texs_14015e1d0.asm`）与 rea-p4b 2.1 逐条一致：每帧先把 `+0x28..+0x3f` 清 0；`imageId` 用无符号比较判越界；版本 1 的 6 项是 int（`cvtdq2ps`），`frametime` 一律 float；`W/H` 是 `u32 → f32`。

## 7. `general.spritesheetrefreshsync`（顺带）【确：读入与路径；常量的寄存器归属【推】】
- 场景构造 `0x140187656`：`general.spritesheetrefreshsync` 是布尔真时 `G+0xe0 |= 0x40`。读者只有窗口层 `0x140114d0a`：加载场景后把它转成窗口标志 `+0x1b8 |= 4`。
- 主循环 `FUN_140111085` `0x140113510`：呈现之后，若 `+0x1b8 & 4`，在场景对象表里找第一个 `vt+0x60() == 1` 的对象（图像层），槽 0 是帧表时算 `rem = frames[cur].frametime − tex.time`，`rem > 0` 才用（否则 0），再除以窗口的 `+0x190`（大于 0.001 时），`min(·, 0.25)`，`×1000` 后 `Sleep`（导入 `0x140426170`）。即渲染节奏跟着这张帧表换帧，省电用。
- 语料 217 个场景 0 处（`grep_refreshsync.json`）。建议 Kabegame 照报或忽略（不影响画面，只影响帧数）。

### 7.3 语料里图像层的帧表（`scan_img_sheets.py`，`img_sheets.txt`）
- 51 张（16 个场景）：全部 TEXS0003，没有旋转帧（`widthY = heightX = 0`），每张帧表帧时长都一样（0.03 – 1.0 s）。
- 多图像 3 张：`3000562427` 的 `day_photoshop` / `night_photoshop`（DXT3，3 张图像，48 帧），`3486806915` 的 `鸟_00020`（DXT5，2 张图像，56 帧，7680×7920）。
- NPOT（纹理大于图像）只有 `dino_run` 的 `*_walk` / `*_jump`（256×32 / 144×24、64×32 / 48×24），TEXS0003、头 24×24，`uv = (1, 1)`。
- 1 s / 帧、2–4 帧的多是按钮（脚本 `pause` / `stop` + `setFrame`）。

## 8. 文本 `anchor` 的 `E0..E3`

### 8.1 复核结论【确】
- `FUN_140183a70`（`R`）独立重读，寄存器与写回（`0x140183e98`：`xmm11 → R+0x110`、`xmm12 → +0x114`、`xmm10 → +0x118`、`xmm13 → +0x11c`）、各分支公式、f32 顺序、`ortho(E0, W − E2, E3, H − E1)` 与 `alignmentfliph` 的 `ortho(W − E0, E2, E3, H − E1)`，都与 [rea-render-size.md](../rea-render-size.md) 第 1 节的伪代码一致，不再重复。四个比例来自 `FUN_140181f30`：`alignment` → `R+0x124`（`asInt`），`alignmentposition` / `alignmentx` / `alignmenty` / `alignmentz` × `f(0.01)` → `R+0x31c8` / `+0x31bc` / `+0x31c0` / `+0x31c4`（接受 jsoncpp 的 int / uint / real），`alignmentfliph` → `R+0x128` bit `0x800`；缺省 0.5 / 0.5 / 0.5 / 1.0（`FUN_14012b890` `0x14012b9d6` 起）。Kabegame `render/layout.ts` 的 `alignEdges` 是同一份公式（只做 0–3，比例取缺省）。
- **输入**：`W/H` = 场景正交宽高 `G+0x354/+0x358`；`Ww/Hw` = 窗口客户区 `R+0x84/+0x88`（下限 2，resize 时写，rea-render-size 第 7 节）。
- **何时重算**：帧函数每帧一次（`0x14017fd2e`，第 2 步之后、光标派发与脚本之前），resize（`FUN_14017f1b0` `0x14017f30b`）与加载（`FUN_140181af0` `0x140181ec1`）各一次。改窗口尺寸或对齐属性下一帧生效。
- **透视场景**：`G+0xe0 & 8` 为假时只建透视投影、清 `R+0x108`，`E0..E3` 不写，保持 `ctx` 构造时的 0（`0x14017c7c3`）。【确；「同一个 `R` 先跑正交场景再换透视」时残留旧值是【推】】
- **读者**：文本 `+0xa8` = `FUN_1402585c0`（rea-p6b 3.4 的表），在基类绘制乘世界矩阵之前、以及光标拾取时调用，做 `M.row3 += ax·M.row0 + ay·M.row1`（即在当前矩阵的坐标系里先平移 `(ax, ay, 0)`）。图像层同槽是 `0x1400a36d0`（`xor al, al; ret`），**只有文本有 `anchor`**。【确】

### 8.2 `anchor` 的含义【推：由公式推出】
- 可见矩形 = `[E0, W − E2] × [E3, H − E1]`（y 向上）。`left` 加 `E0`、`right` 减 `E2`、`top` 减 `E1`、`bottom` 加 `E3`、`center` 移 `((E0 − E2)/2, (E3 − E1)/2)`（可见中心减场景中心）：对象相对**可见矩形对应的边 / 中心**保持它在场景矩形里的相对位置。
- 各模式（缺省比例）：
  - 0 铺满：窗口更窄时裁左右（`E0 = E2 > 0`），更宽时裁上下；贴边的对象往里收。
  - 1 装下：`E` 为负（留边），贴边的对象往外推到窗口边。
  - 2 拉伸：全 0，中性。
  - 3 居中、4 自由（缺省 `az = 1`）：`E0 = E2 = (W − Ww)/2`、`E1 = E3 = (H − Hw)/2`，只要窗口不是场景同样大就不中性（同比例也一样，例如场景 1920×1080、窗口 960×540 → `E = (480, 270, 480, 270)`）。
- `alignmentfliph`：投影左右互换，`E` 与 `anchor` 表不变，所以「左贴边」的对象在翻转后的画面里不贴在屏幕左边。WPE 的设置界面有没有对场景开放翻转没查。
- 例（`edges.py`，场景 1920×1080，缺省参数）：

| 窗口 | 模式 | `E0, E1, E2, E3` | `topleft` 平移 | `bottomright` 平移 |
|---|---|---|---|---|
| 900×1600 | 0 铺满 | 656.25, 0, 656.25, 0 | (656.25, 0) | (−656.25, 0) |
| 900×1600 | 1 装下 | 0, −1166.667, 0, −1166.667 | (0, 1166.667) | (0, −1166.667) |
| 900×1600 | 3 居中 | 510, −260, 510, −260 | (510, 260) | (−510, −260) |
| 2560×1080 | 0 铺满 | 0, 135, 0, 135 | (0, −135) | (0, 135) |
| 2560×1080 | 1 装下 | −320, 0, −320, 0 | (−320, 0) | (320, 0) |
| 1280×1024 | 3 居中 | 320, 28, 320, 28 | (320, −28) | (−320, 28) |
| 960×540 | 3 居中 | 480, 270, 480, 270 | (480, −270) | (−480, 270) |

---

## 未查完 / 未解决

1. **dll 侧**：`setFrame` 的整数转换（小数、`NaN`、`undefined`、`true`）、只读的 `frameCount` / `duration` 被写时的行为、`frameCount` 在 exe 不写输出时 JS 拿到什么、`getTextureAnimation()` 多次调用是否同一个 JS 对象、`A` 析构后旧包装的表现。见 `rea-p6e-script.md`。
2. 纹理缓存的键（同名不同路径、同一 `.tex` 在不同材质里是否一定是同一个对象），以及场景重载时纹理对象（共享计时器）是否重建。
3. 第一帧的 `g_Frametime` 取值（`ctx+0x14c` 构造为 0，第一帧由帧函数算），决定开场第一格停多久。
4. `O+0x4a0` / `O+0x4a8` 变体与 `O+0x498` 的槽 0 是否总是同一个纹理（`frameCount` 等按变体取，建 `A` 按 `O+0x498` 取）。
5. 槽 0 在运行中被用户纹理换掉、`A` 被析构后，材质里的 `SPRITESHEET` 继续用残留的 `Rotation/Translation`（第 1 节推论）的画面后果没实测。
6. `spritesheetrefreshsync` 里 `xmm7` / `xmm10` / `xmm15` 的取值是按 `FUN_140111085` 的线性扫描推的（0、0.001、0.25），没逐条跟控制流；窗口 `+0x190` 是什么（播放速率？）没查。
7. 视频包装（`0x140491128`）与 `getTextureAnimation` 共用 `O+0x4c0` 时 JS 拿到的对象类型。
8. WPE 设置界面上 `alignmentposition` / `alignmentfliph` 对场景是否可调（影响 `anchor` 是否真会遇到非缺省比例）。

## 建议的确定性实验

通用：工程用 `kbp gen` 生成（带 FR 帧号图层），帧表纹理按 `texs.py` 的格式手写一张小的 TEXS0003（RGBA8888，每格一个纯色块并在角上画帧号像素，便于在抓帧里认）。脚本用 `console.error('[kbp] ' + 帧号 + …)` 写 WPE 日志（`log_mark` / `log_since`）。WPE 真值用 `wpe-renderdoc` 的 `capture_wallpaper` / `capture_sweep` 连抓多帧，读每帧该图层 draw 的常量缓冲 `g_Texture0Translation` / `g_Texture0Rotation` 与绑定的 SRV（多图像时看纹理尺寸 / 名字）。fps 用 `restart_wpe(settings)` 改，或在同一 fps 下用不同 `frametime` 造对照。

1. **推进节奏与「每帧最多一格」**：一个图像层，4 帧，`frametime` 分三份工程 0.1、0.02、0（三张纹理）。30 fps 与 60 fps 各连抓 40 帧。看：0.1 时每 3（6）个渲染帧换一格且余数累积方式符合 2.4；0.02 时在 30 fps 下**每帧正好一格**（不是每帧 1.67 格）；0 时每帧一格；末格之后回 0。
2. **共享计时器只在绑定时走**：同一张帧表给两个图层 A、B。B 在帧号 30–59 由脚本设 `visible = false`，A 一直可见；另做一份 A 也在 30–59 隐藏。看：第一份 B 回来时和 A 同格（A 一直在推）；第二份两者回来时停在隐藏前的那一格接着走（不补时间）。
3. **旋转帧与归一化**：TEXS 里一帧写 `widthY`、`heightX` 非零（例如 90° 旋转：`(x, y, 0, w, h, 0)`），读 `g_Texture0Rotation` 是否等于 `(width/W, widthY/H, heightX/W, height/H)`，画面是否旋转。
4. **NPOT 与 TEXS 版本**：照 `dino_run/doux_walk`（256×32 / 144×24）复制一份，再做一份把 TEXS 改成 0002（去掉头宽高）。看图层四边形顶点 UV 上界（v3 应为 1 − 内缩，v2 应为 144/256 − 内缩）与合成 RT / `autosize` 尺寸（v3 = 24×24，v2 = 144×24）。各加一个 effect 的版本，UV 上界应都回到 1。
5. **多图像**：两张图像尺寸不同（例如 256×256 与 128×128，各 4 格），帧序跨两张。看每帧绑定的 SRV 尺寸、`Translation/Rotation` 是否按各自图像尺寸归一化、`g_Texture0Resolution` 是否一直是头尺寸。
6. **effect 槽与覆盖范围**：图层带一个自定义 effect，effect 的第 2 个槽绑另一张帧表纹理 S，着色器声明并输出 `g_Texture1Rotation`（或用它取 UV）。看：S 的共享计时器只靠这个 effect 也在走；该图层脱离（`pause()` 后 `setFrame(2)`）时 S 也画第 2 格（覆盖作用于整个图层绘制），S 帧数 < 3 时画第 0 格。
7. **脚本 API 时间线**（最重要）：一个 8 帧、0.1 s / 格的图层，`update` 每帧记 `getFrame()`、`isPlaying()`，并在固定帧号依次调：10 `pause()`、20 `play()`、30 `setFrame(5)`、40 `stop()`、50 `play()`、60 `rate = 2`、70 `rate = -1`、80 `join()`、90 `setFrame(99)`、100 `setFrame(-1)`、110 `rate = 1; join()`；另一份在未脱离状态下直接 `setFrame(3)`（应接着播）和直接写 `rate = 1`（应不脱离）。抓帧核对每帧画的格（`Translation`）与日志：`pause` 停在当前共享格、`play` 不并回、`stop` 回 0、负 `rate` 倒播并回绕、`setFrame(99)` 读回 99 画第 0 格、`setFrame(-1)` 画共享格、`join` 立刻跳回共享格。
8. **脱离图层隐藏时仍推进**：脱离且在播的图层在 30–59 帧隐藏，回来时的格应等于一直可见的对照（私有推进不看可见性），与实验 2 相反。
9. **`rate` 与「每帧一格」叠加**：照 `3560756264`，0.03 s / 格、`rate = 9`，30 fps 下应每渲染帧一格。
10. **`anchor`**：正交场景 1920×1080，四个文本对象 `anchor` 分别 `none`、`topleft`、`bottomright`、`center`，放在场景四角附近。窗口 1920×1080、960×540、900×1600、2560×1080，`alignment` 依次 0、1、2、3（再各加一次 `alignmentfliph`、模式 3 加 `alignmentx = 0`）。读文本字形 draw 的 MVP 平移列，与 `edges.py` 的 `E` 和 8.1 的平移逐位比；同时核对 `g_ModelViewProjectionMatrix` 的投影部分就是 `ortho(E0, W − E2, E3, H − E1)`。
11. **第一帧**：上面实验 1 的工程从开窗起抓前 3 帧，看第一帧画的是第 0 格还是已经进到第 1 格（`frametime` 取 0.02 与 0.1 各一份），确定第一帧的 `g_Frametime`。
