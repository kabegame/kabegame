# REA：正交场景的对齐方式怎么改投影（WPE 2.8.42 `wallpaper64.exe`）

> 只做静态分析，没有运行、附加或启动 WPE。地址是镜像基址 `0x140000000` 下的虚拟地址。
> 标记：「确」= 汇编逐条读到；「推」= 由代码推出、数值复算或引用旧结论，没再逐条读。
> 记号：`R` = 场景渲染器（`FUN_140183a70` 的 `rcx`），`ctx = R+0x10`（渲染上下文），`G = [R]`（场景对象）。`f(x)` = 舍入成 f32（JS 的 `Math.fround`）。

**方法与材料。** 没开 REA（Ghidra 导入此前两次超时）。全部结论来自全量反汇编 `ignore/p4/rea/wp.asm`（objdump Intel 语法，同一 exe，SHA-256 `40e2ce02…993b0`），按 `.pdata` 切函数。辅助脚本在 `ignore/prs/rea/`：`asm.py`（切片，沿用 rea-matrix-order 的那份，只改了 exe 路径）、`rd.py`（读常量）、`jt.py`（解 `FUN_1400d8300` 跳转表）、`find_pair*.py` / `ctxw.py` / `ereaders.py`（全文件找某偏移的写入点与读者）、`edges.py`（按读出的 f32 顺序复算 E0..E3）、`common.py`（常见分辨率同比例扫描）、`pct.py`（百分比换算）。已切好的片段沿用 `ignore/p5/rea/camera/`。

## 总结

- 对齐方式只改正交投影的 `l, r, b, t`：`ortho(E0, W − E2, E3, H − E1, −2000, 2000)`。E0..E3 每帧在 `FUN_140183a70` 里重算，输入只有窗口客户区 `Ww/Hw = R+0x84/0x88`、场景 `Ws/Hs = G+0x354/0x358`、模式 `R+0x124` 和四个比例 `R+0x31bc..0x31c8`。没有 DPI、偏移或别的比例字段。【确】
- 各分支（缺省比例都是 0.5、`alignmentz` 1）：
  - 0 与其它值（缺省分支）= 铺满裁切；1 = 装下留边；2 = 拉伸，E 全 0；3 = 居中，1 场景单位 = 1 窗口像素；4 = 自由（位置 + 缩放）。公式见第 1 节。【确】
- `alignmentposition` / `alignmentx` / `alignmenty` / `alignmentz` 分别落到 `R+0x31c8` / `0x31bc` / `0x31c0` / `0x31c4`，都是属性值 × f(0.01)。`alignmentposition` 只给 0、1 用；`x / y` 给 3、4 用；`z` 只给 4 用。`alignmentfliph` 是 `R+0x128` 的 `0x800` 位。【确】
- `G+0x114` 是相机当前的 zoom（相机图层 / 路径 / 脚本基准），不是 `alignmentz`。【确】
- 透视粒子（及图像层 `perspective`）用的是裁切、zoom 之后的 P（只取 `P[5]`）和由 E 算出的可见区中心比例 `R+0x108/0x10c`，宽高比取窗口。【确】
- `g_Screen` / `g_TexelSize` 只读 `ctx+0x74/0x78` = `R+0x84/0x88`，全文件只有构造和 resize 写它们，合成 RT、fbo、泛光里都是窗口尺寸。【确，有界搜索】
- `engine.screenResolution` 和 `R+0x84/0x88` 是同一个字段。【确】

---

## 1. 缩放模式 switch（`0x140183b47` 起）

### 结论

- 入口条件：`G+0xe0 & 8`（正交）。`0x140183aa2`。【确】
- 输入（`0x140183ab8`–`0x140183b43`）【确】：

| 量 | 来源 | 说明 |
|---|---|---|
| `Ww`、`Hw` | `R+0x84`、`R+0x88` | 窗口客户区，float，≥ 2（第 7 节） |
| `Ws`、`Hs` | `G+0x354`、`G+0x358` | 场景正交尺寸 |
| `mode` | `R+0x124` | `alignment` |
| `ax`、`ay`、`az` | `R+0x31bc`、`R+0x31c0`、`R+0x31c4` | `alignmentx/y/z` × 0.01 |
| `ap` | `R+0x31c8` | `alignmentposition` × 0.01 |
| 常量 | `0x1404926c0` = 0.5，`0x140492704` = 1.0，`0x14049284c` = 4.0，`0x1404929b0` = −0.99 | `rd.py` |

- 分派：`sub ecx,1; je` → 1；再 `sub; je` → 2；再 `sub; je` → 3；`cmp ecx,1; je` → 4；其余（0、负数、≥ 5）落到缺省分支 `0x140183b67`。【确】
- 寄存器与边的对应（看最后的写回 `0x140183e98`）：`xmm11` = E0（左）、`xmm12` = E1（上）、`xmm10` = E2（右）、`xmm13` = E3（下）。四个先 `xorps` 清 0。【确】
- E 为正 = 这条边裁掉的场景单位；为负 = 留出的场景单位（露出清屏色，第 2 节）。

### 伪代码（每步 f32，可逐位复现）【确；`powf` 的舍入是推】

```ts
const f = Math.fround;
// 返回 [E0 左, E1 上, E2 右, E3 下]
function alignEdges(mode, Ws, Hs, Ww, Hw, ax = 0.5, ay = 0.5, az = 1, ap = 0.5) {
  const sa = f(Ws / Hs), wa = f(Ww / Hw);                         // 0x140183b3e、0x140183b43
  let E0 = 0, E1 = 0, E2 = 0, E3 = 0;
  const halfX = () => f(f(Ws - f(f(Hs / Hw) * Ww)) * 0.5);        // 横向半差：可见宽 = Hs/Hw·Ww
  const halfY = () => f(f(Hs - f(f(Ws / Ww) * Hw)) * 0.5);        // 纵向半差：可见高 = Ws/Ww·Hw
  switch (mode) {
    case 1: {                                                     // 0x140183ce8：装下，留边
      const t = f(f(1 - ap) + f(1 - ap));
      if (wa > sa) { const h = halfX(), a = f(ap * h); E0 = f(a + a); E2 = f(t * h); }   // 窗口更宽：左右留边
      else         { const h = halfY(), a = f(ap * h); E1 = f(a + a); E3 = f(t * h); }   // 其余：上下留边
      break;
    }
    case 2: break;                                                // 直接跳 0x140183d57：拉伸，全 0
    case 3: {                                                     // 0x140183cab：居中
      const dx = f(Ws - Ww), dy = f(Hs - Hw);
      E0 = f(ax * dx); E2 = f(f(1 - ax) * dx);
      E1 = f(ay * dy); E3 = f(f(1 - ay) * dy);
      break;
    }
    case 4: {                                                     // 0x140183bbc：自由
      const sw = f(Ww + Ws), sh = f(Hw + Hs);
      E0 = f(Ws - f(ax * sw));  E2 = f(Ws - f(f(1 - ax) * sw));
      E1 = f(Hs - f(ay * sh));  E3 = f(Hs - f(f(1 - ay) * sh));
      const p1 = f(powf(f(f(1 - az) + 1), 4) - 1);               // 0x14041e350（CRT powf）
      const s = f(-0.99) > p1 ? f(-0.99) : p1;                    // maxss xmm2(−0.99), xmm0：NaN 取 p1
      const vh = f(f(f(Hs - E1) - E3) * s), vw = f(f(f(Ws - E2) - E0) * s);
      E2 = f(E2 - f(vw * f(1 - ax)));  E0 = f(E0 - f(vw * ax));
      E1 = f(E1 - f(vh * ay));         E3 = f(E3 - f(vh * f(1 - ay)));
      break;
    }
    default: {                                                    // 0x140183b67：0 与其它值，铺满裁切
      const t = f(f(1 - ap) + f(1 - ap));
      if (sa > wa) { const h = halfX(), a = f(ap * h); E2 = f(a + a); E0 = f(t * h); }   // 场景更宽：裁左右
      else         { const h = halfY(), a = f(ap * h); E1 = f(a + a); E3 = f(t * h); }   // 其余：裁上下
    }
  }
  return [E0, E1, E2, E3];
}

// 公共尾（0x140183d57–0x140183ed4）
R108 = f(f(f(Ws * 0.5) - f(f(E2 - E0) * 0.5)) / Ws);   // 可见区中心 x / Ws（透视覆盖用，第 5 节）
R10c = f(f(f(Hs * 0.5) - f(f(E1 - E3) * 0.5)) / Hs);   // 可见区中心 y / Hs（y 向上）
R120 = f(G148 * f(0.017453292));                         // fov 弧度；正交场景 = perspectiveoverridefov
if (!(R128 & 0x800)) P = orthoWpe(E0, f(Ws - E2), E3, f(Hs - E1), -2000, 2000);   // 设备 +0x18 = FUN_14009a630
else                  P = orthoWpe(f(Ws - E0), E2, E3, f(Hs - E1), -2000, 2000);   // alignmentfliph
R110 = E0; R114 = E1; R118 = E2; R11c = E3;              // 0x140183e98 起，调用之后才写
// 之后回帧函数：P 绕场景中心 (Ws/2, Hs/2) 乘 z = f(G154 * G114)（0x14017fd50，rea-matrix-order 2.2）
```

- `orthoWpe` 见 rea-matrix-order 第 7 节。`n = −2000`、`f = 2000` 是常量 `0x140492a1c` / `0x14049294c`。代码里有读 `G+0x14c/0x150` 的分支，但正交分支里走不到（`0x140183e34` 再测一次 `G+0xe0 & 8`）。【确】
- `f(a + a)` 是精确的 2a，`t` 也就是精确的 `2·f(1 − ap)`。写成加法只为照抄指令。
- 每帧都算（帧函数 `0x14017fd2e` 调 `FUN_140183a70`），改属性、改窗口尺寸都在下一帧生效，不重编译。【确】

### 汇编摘录【确】

缺省分支（铺满）：
```asm
140183b67: movss  xmm11, [0x140492704]   ; 1.0
140183b70: subss  xmm11, xmm4             ; 1 − ap
140183b75: comiss xmm5, xmm0              ; sa ? wa
140183b78: addss  xmm11, xmm11            ; t = (1−ap)+(1−ap)
140183b81: jbe    0x140183baf             ; sa ≤ wa（含 NaN）→ 纵向
140183b83: divss  xmm9, xmm3              ; Hs / Hw
140183b88: movaps xmm10, xmm4             ; ap
140183b8c: mulss  xmm9, xmm2              ; ·Ww
140183b91: subss  xmm0, xmm9              ; Ws − …
140183b96: mulss  xmm0, xmm15             ; ·0.5 = h
140183b9b: mulss  xmm10, xmm0             ; ap·h
140183ba0: mulss  xmm11, xmm0             ; E0 = t·h
140183ba5: addss  xmm10, xmm10            ; E2 = ap·h + ap·h
140183baf: movaps xmm13, xmm11            ; 纵向：E3 先放 t
140183bb3: xorps  xmm11, xmm11            ;        E0 = 0
140183d32: divss  xmm0, xmm2              ; Ws / Ww（纵向公共段，模式 1 也来这里）
140183d36: movaps xmm12, xmm4             ; ap
140183d3a: mulss  xmm0, xmm3              ; ·Hw
140183d3e: subss  xmm9, xmm0              ; Hs − …
140183d43: mulss  xmm9, xmm15             ; ·0.5 = h
140183d48: mulss  xmm12, xmm9             ; ap·h
140183d4d: addss  xmm12, xmm12            ; E1 = 2·ap·h
140183d52: mulss  xmm13, xmm9             ; E3 = t·h
```
模式 1（装下）横向：
```asm
140183cf4: comiss xmm0, xmm5              ; wa ? sa
140183cff: jbe    0x140183d2e             ; wa ≤ sa → 纵向（E3 = t 后进 0x140183d32）
140183d06: movaps xmm11, xmm4             ; ap        → E0
140183d0a: movaps xmm10, xmm1             ; t         → E2
140183d1d: mulss  xmm11, xmm0             ; ap·h
140183d22: mulss  xmm10, xmm0             ; E2 = t·h
140183d27: addss  xmm11, xmm11            ; E0 = 2·ap·h
```
模式 3（居中）：
```asm
140183cb4: subss  xmm9, xmm3              ; Hs − Hw
140183cc1: subss  xmm0, xmm2              ; Ws − Ww
140183cc5: movaps xmm11, xmm1             ; ax
140183cc9: subss  xmm10, xmm1             ; 1 − ax
140183cce: movaps xmm12, xmm6             ; ay
140183cd2: subss  xmm13, xmm6             ; 1 − ay
140183cd7: mulss  xmm12, xmm9             ; E1 = ay·(Hs−Hw)
140183cdc: mulss  xmm11, xmm0             ; E0 = ax·(Ws−Ww)
140183ce1: mulss  xmm10, xmm0             ; E2 = (1−ax)·(Ws−Ww)
140183d52: mulss  xmm13, xmm9             ; E3 = (1−ay)·(Hs−Hw)
```
模式 4（自由）关键几行：
```asm
140183bc4: addss  xmm2, xmm14             ; Ww + Ws
140183bfd: subss  xmm11, xmm0             ; E0 = Ws − ax·(Ww+Ws)
140183c2f: subss  xmm0, [rbx+0x31c4]      ; 1 − az
140183c37: addss  xmm0, xmm6              ; (1 − az) + 1
140183c3b: call   0x14041e350             ; powf(·, 4.0)
140183c48: subss  xmm0, xmm6              ; −1
140183c5a: maxss  xmm2, xmm0              ; s = max(−0.99, ·)
140183c63: subss  xmm1, xmm11             ; vw = (Ws − E2) − E0
140183c6d: mulss  xmm1, xmm2              ; vw·s
140183c85: subss  xmm11, xmm0             ; E0 −= vw·s·ax
140183c80: subss  xmm10, xmm1             ; E2 −= vw·s·(1−ax)
```
公共尾与调用：
```asm
140183d6b: subss  xmm0, xmm11             ; E2 − E0
140183d8b: divss  xmm1, xmm14             ; (Ws·0.5 − (E2−E0)·0.5) / Ws
140183d96: movss  [rbx+0x108], xmm1
140183dc1: movss  [rbx+0x10c], xmm3
140183e68: subss  xmm3, xmm10             ; r = Ws − E2
140183e6d: movaps xmm2, xmm11             ; l = E0
140183e7d: subss  xmm0, xmm12             ; t = Hs − E1
140183e8e: movss  [rsp+0x20], xmm13       ; b = E3
140183e95: call   r8                      ; 设备 +0x18
140183e98: movss  [rbx+0x110], xmm11      ; E0 … E3 写回 R+0x110..0x11c
```

### 方向（`alignmentposition`）【确，`edges.py` 复算】

`ap = 0` 时（场景 1920×1080）：

| 模式与方向 | E | 画面 |
|---|---|---|
| 铺满，裁上下（窗口 2560×1080） | E1 = 0，E3 = 270 | 场景**上沿**贴窗口上沿 |
| 铺满，裁左右（窗口 1920×1440） | E0 = 480，E2 = 0 | 场景**右沿**贴窗口右沿 |
| 装下，左右留边（窗口 2560×1080） | E0 = 0，E2 = −640 | 场景**左沿**贴窗口左沿 |
| 装下，上下留边（窗口 1920×1440） | E1 = 0，E3 = −360 | 场景**上沿**贴窗口上沿 |

- 只有「铺满、裁左右」反过来。这是指令本身的写法（缺省分支 E2 拿 `ap`、E0 拿 `1 − ap`；模式 1 正好相反），不是读错。缺省 0.5 时没有差别。

### 示例（`edges.py`，场景 1920×1080，缺省参数）【推：数值复算】

| 窗口 | 铺满 0 | 装下 1 | 居中 3 / 自由 4 |
|---|---|---|---|
| 1920×1200 | E = (96, 0, 96, 0) | (0, −60, 0, −60) | (0, −60, 0, −60) |
| 2560×1080 | (0, 135, 0, 135) | (−320, 0, −320, 0) | (−320, 0, −320, 0) |
| 1280×720 | 全 0 | 全 0 | (320, 180, 320, 180) |
| 3840×2160 | 全 0 | 全 0 | (−960, −540, −960, −540) |

---

## 2. 伪属性落在哪、怎么进公式

### 写入：`FUN_140181f30(R, props)`【确】

每个属性先取 `props[name]`，要求是对象（类型 7），再取 `value`。

| 伪属性 | 字段 | 取值规则 | 地址 |
|---|---|---|---|
| `alignment` | `R+0x124`（int） | `FUN_1400886e0` 判「整数值」才写：int/uint 在 int32 内、double 须无小数；`FUN_140085ee0` 取整 | `0x140181fbf` |
| `alignmentposition` | `R+0x31c8` | 类型 1–3（数字）→ `FUN_140086220` 转 f32 → `mulss 0.01`（`0x140492620`） | `0x140182030` |
| `alignmentx` | `R+0x31bc` | 同上 | `0x14018209b` |
| `alignmenty` | `R+0x31c0` | 同上 | `0x140182106` |
| `alignmentz` | `R+0x31c4` | 同上 | `0x140182171` |
| `alignmentfliph` | `R+0x128` 的 `0x800` 位 | 布尔（类型 5，`FUN_140086300`），否则清位 | `0x1401821d7` / `0x1401821e4` |
| `schemecolor` | `R+0x31b0..0x31b8` | 字符串 `strtod` 三次（`0x1402d06ac`），`cvtsd2ss` | `0x140182311` |

- 字符串常量：`0x140488490` `alignment`、`0x1404886e0` `alignmentposition`、`0x1404886b0` `alignmentx`、`0x1404886c0` `alignmenty`、`0x140488708` `alignmentz`、`0x1404886d0` `alignmentfliph`、`0x140474560` `schemecolor`。【确】
- 换算：`f(f(v) × f(0.01))`。50 → 0.5、100 → 1.0、75 → 0.75 精确；60 → 0.59999996（不是 `f(0.6)`）。【确：`pct.py`】
- 缺省：两个构造都给 `ax = ay = 0.5`、`az = 1.0`、`ap = 0.5`（`0x14012b9d6`–`0x14012b9f4` 直接写；`0x140110b5d` 经 `FUN_14005f580` 填同样四个值）。`R+0x124` 由 ctx 构造 `0x14017c7ca`（`mov qword [ctx+0x110], 0x3f800000`）置 0，即缺省铺满。【确】
- 调用点 5 处：`0x140114f10`、`0x140115449`（主循环的应用属性路径，同一段紧接着读 `cameraparallax`）、`0x14011f7f0`、`0x1401203ee`、`0x140120474`（初始化）。【确：地址；推：场合】

### 进公式的地方【确】

| 伪属性 | 用在哪 |
|---|---|
| `alignmentposition` | 只在模式 0（及缺省）和 1 |
| `alignmentx`、`alignmenty` | 只在模式 3、4 |
| `alignmentz` | 只在模式 4（缩放倍数，第 3 节） |
| `alignmentfliph` | 见下 |

所以测试里的 `{"alignment":1,"alignmentz":60}`，`alignmentz` 不起作用。

`alignmentfliph`（`R+0x128 & 0x800` = `ctx+0x118 & 0x800`）的全部读取点（全文件搜 `0x800` 位测试与 `bt …, 0xb`，按基址筛）：
- 正交投影：`l = f(Ws − E0)`、`r = E2`（`0x140183df5` 起）。等于先把场景绕自身中心左右镜像，再按同样的 E 裁。E0 ≠ E2 时它不等于把整个窗口画面镜像。
- 透视场景投影：P 第 0 列 ×(−1)（`0x140183f7d`）。
- 透视覆盖：P 第 0 列 ×(−1)（`0x1401e5c4a`）。
- 视差指针：x 取 `1 − x`（`0x140189bac`、`0x140189cd5`）。
- 脚本 `cursorScreenPosition`：x 取 `(1 − x)·Ww`（`0x14018e08c`）。rea-p6c-script 第 144 行说「来源没查」的就是这一位。

### `G+0x114`（zoom 的另一个因子）【确】

- 是相机当前 zoom，和 `G+0xf0` eye、`+0xfc` center、`+0x108` up 一组；基准值在 `G+0x13c`（脚本 `setCameraTransforms` 的 zoom）。
- 写入全在加载与相机更新：
  - `0x140186d46`：加载置 1.0。
  - `0x1401893b1`：有活动相机图层时取它的 zoom（当前条目 `+0x338` 或对象 `+0x2dc`）。
  - `0x14018948a`：没有相机图层、也没有路径时取基准 `G+0x13c`。
  - `0x140189a4e`：相机路径取关键帧的 zoom（条目 `+0x28`）。
- 帧函数 `0x14017fd50`：`z = f(G+0x154 × G+0x114)`，`G+0x154` 是 `general.zoom`。
- 和 `alignmentz` 无关：`R+0x31c4` 全文件只有第 1 节一个读者。

---

## 3. 居中（3）与自由（4）的单位

- **居中**：可见宽 = `Ws − E0 − E2 = Ww`，可见高 = `Hw`。**1 场景单位 = 1 窗口客户区像素**，不乘缩放系数，也不看 DPI（`Ww` 就是 `WM_SIZE` 的客户区宽，第 7 节）。窗口小于场景时裁、大于时留边；`ax`、`ay` 定裁 / 留的分配，0 = 场景左沿 / 上沿贴窗口。【确】
- 之后 `general.zoom × 相机 zoom` 照常在 P 上绕**场景中心**缩放（不是绕可见区中心）。【确】
- **自由**：
  - 先按位置放：`E0 = Ws − ax·(Ww + Ws)`。`ax = 0.5` 时 `E0 = (Ws − Ww)/2`，和居中相同；`ax = 0` 时可见区从 `x = Ws` 开始，场景整张在窗口左外；`ax = 1` 时整张在右外。`ay` 同理：0 时场景在窗口上外，1 时在下外。【确】
  - 再缩放：可见尺寸 × `(1 + s)`，`s = max(−0.99, (2 − az)⁴ − 1)`（按 `f(f(1 − az) + 1)` 算底数）。多出 / 少掉的部分按 `ax : (1 − ax)` 分给左右、按 `ay : (1 − ay)` 分给上下，所以缩放支点是可见区里按 `ax`、`ay` 分比例的那一点。【确】
  - 倍数（窗口与场景同大，`edges.py`）：`az` 0 → 可见 16 倍（场景缩成 1/16）；0.5 → 5.06；0.6 → 3.84；1 → 1（同居中）；1.5 → 0.0625（放大 16 倍）；2 → 0.01（放大 100 倍，触底）。`az > 2` 时底数变负、四次方又变大，3 → 1。【推：数值复算，`powf` 用 double 代替】
- 透视粒子在这两个模式下仍对得上（第 5 节），因为可见区宽高比等于窗口宽高比。【推】

---

## 4. 同比例时 E 是不是全 0

- **铺满（0）与装下（1）**：同比例时 `sa == wa`，两个模式都走纵向分支，`h = f(f(Hs − f(f(Ws/Ww)·Hw))·0.5)`。数学上为 0，但 `f(Ws/Ww)·Hw` 可能差半个 ulp：
  - 常见分辨率全 0：场景 1920×1080 / 3840×2160 / 2560×1440 / 1280×720 / 1600×900 / 2048×1152 / 4096×2304、竖屏 1080×1920 / 2160×3840、16:10 的 1920×1200 / 2560×1600，配同比例的常见窗口（含 3840×2130 配 896×497），逐位为 0（`common.py`）。【推：数值复算】
  - 不常见的组合会出非零：16:9 / 16:10 / 4:3 / 21:9 整数尺寸两两配对的扫描里约 9.4%（159466 组里 15050 组）。例：场景 320×180、窗口 560×315 → `E1 = E3 = −7.63e−6`。这时 `P[13]` 不再是精确的 −1。【推：数值复算】
  - 窗口比场景大或小都一样，只看比值能不能被 f32 精确还原。
- **拉伸（2）**：任何尺寸都全 0。【确】
- **居中（3）、自由（4，缺省参数）**：`E0 = E2 = (Ws − Ww)/2`、`E1 = E3 = (Hs − Hw)/2`。窗口小于场景时为正（裁），大于时为负（留边），只有窗口与场景同大时才全 0。【确】

---

## 5. 透视粒子用不用 E 或裁切后的 P

### 结论【确】

- 用。粒子系统 `flags & 4` 落到对象 `+0x120` bit7，绘制时（`0x140222770`：push P、push V）调 `FUN_1401e5b60(ctx)`，画完弹栈。图像层 `perspective` 走同一个函数（`0x1401e92b3`、`0x1401e9eb3`）。另有两份写局部矩阵的副本：`FUN_140184f00`（图层合成，`0x1401ed27a` / `0x1401ed5dc` 调；不处理翻转）、`FUN_14018fc40`（`G` 的虚函数，命中测试一类）。三份公式相同。
- 用到裁切的地方有两处：
  1. `d` 由**当前 P 的 `P[5]`** 算，P 已经是 `ortho(E…)` 并乘过 zoom。`1/P[5]` = 可见高 / 2 / z。
  2. 相机 xy 放在**可见区中心**：整数场景尺寸 × `R+0x108/0x10c`（第 1 节公共尾，由 E 算出）。
- 宽高比取**窗口** `ctx+0x74 / ctx+0x78` = `Ww / Hw`。rea-p4a 第 266 行的说法对；rea-p5-camera 第 7.2 节「aspect = Ws/Hs」不对。

```ts
// FUN_1401e5b60(ctx)（0x1401e5b60–0x1401e5cef），每步 f32
const fov = ctx110;                                 // = R+0x120 = radians(perspectiveoverridefov)
const tn  = tanf(f(fov * 0.5));                     // 0x14041b0d0（CRT tanf，推）
const d   = f(1 / f(tn / f(1 / P[5])));             // P = 投影栈顶（裁切 + zoom 之后）
let far = f(d + 1000); if (15000 > far) far = 15000;   // comiss + ja；常量 0x14049295c / 0x140492944
V[12] = f(V[12] - f(float(Wi) * ctxF8));            // Wi = ctx+0x84（int），ctxF8 = R+0x108
V[13] = f(V[13] - f(float(Hi) * ctxFC));            // Hi = ctx+0x88（int），ctxFC = R+0x10c
V[14] = -d;                                         // xorps 符号位
P = perspectiveFovRH(fov, f(Ww / Hw), 5, far);      // 设备 +0x10 = FUN_14009a360；near 常量 0x140492858
if (ctx118 & 0x800) P[0..3] *= -1;                  // alignmentfliph
```

- `Wi`、`Hi` 是加载时 `cvttss2si(G+0x354/0x358)`（`0x1401875eb`、`0x1401875fb`）。`V` 是视差平移之后的视图栈顶。【确】

```asm
1401e5bab: divss   xmm1, dword ptr [rsi + 0x14]   ; 1 / P[5]
1401e5bb0: divss   xmm0, xmm1                     ; tan / (1/P[5])
1401e5bb4: divss   xmm3, xmm0                     ; d
1401e5bd3: movd    xmm1, dword ptr [rbx + 0x84]   ; Wi（int）
1401e5beb: mulss   xmm1, dword ptr [rbx + 0xf8]   ; × 可见区中心比例
1401e5bf3: subss   xmm0, xmm1                     ; V[12] −=
1401e5c2d: movss   xmm3, dword ptr [rbx + 0x74]   ; Ww
1401e5c39: divss   xmm3, dword ptr [rbx + 0x78]   ; aspect = Ww / Hw
1401e5c47: call    qword ptr [rax + 0x10]         ; PerspectiveFovRH
```

### 什么时候和正交画面重合【推：由公式推导】

- z = 0 平面上，透视与正交逐点重合的条件：可见区宽高比 = 窗口宽高比，且 zoom 支点（场景中心）与可见区中心重合。
- 模式 0、1、3、4 的可见区宽高比都等于窗口比。模式 2（拉伸）可见区就是场景，宽高比和窗口不同时，透视部分横向比例对不上。
- zoom ≠ 1 且 E 不对称（`alignmentposition ≠ 50`、居中 / 自由的 `x / y ≠ 50`）时，正交绕场景中心缩放，透视相机却在可见区中心，两者错开。
- `alignmentfliph` 且 E0 ≠ E2 时，正交的可见区中心是 `(Ws − E0 + E2)/2`，透视相机仍在 `(Ws + E0 − E2)/2` 再镜像，也会错开。
- 对我们：`particleViewProjection`（`layout.ts`）现在用 `height / (2·zoom)` 和场景宽高比，相机在场景中心。按窗口直接画时要改成 `1/P[5]`、窗口宽高比、可见区中心（`Wi·R108`、`Hi·R10c`）。

---

## 6. 合成 RT / effect fbo 里的 `g_Screen`、`g_TexelSize`

- 取值（`FUN_1400d8300`，跳转表字节 `0x1400daaac`、偏移 `0x1400da984`，`jt.py`）【确】：
  - ID 6 `g_TexelSizeHalf`（`0x1400d84c3`）= `divps (0.5, 0.5) / (ctx+0x74, ctx+0x78)`。
  - ID 7 `g_TexelSize`（`0x1400d849f`）= `divps (1, 1) / (ctx+0x74, ctx+0x78)`。
  - ID 8 `g_Screen`（`0x1400d84e7`）= `(ctx+0x74, ctx+0x78, f(ctx+0x74 / ctx+0x78))`。
  - `[r14+8]` 是 ctx（同一处 `+0x30` 是模型栈）。
- 写入点：全文件找覆盖 `+0x74/+0x78`（ctx 基址）与 `+0x84/+0x88`（R 基址）的所有存储，再按函数是否碰 ctx / R 的特征字段（`+0x1ca`、`+0x1518`、`+0x1528`、`+0x31b0` 等）筛，并把 `0x1400d0000–0x140270000` 里的浮点存储不加筛选看一遍。**只有两处**：ctx 构造 `0x14017c76f` / `0x14017c776`（1.0）和 resize `FUN_14017f1b0` 的 `0x14017f222` / `0x14017f22d`。另几处同偏移的写入是别的对象（`0x140112f16` 等是音频频谱缓冲；`0x140180681` 是 `R+0x78`）。【确，有界：没覆盖经指针算术或 `memcpy` 的写法】
- 绑定 RT `FUN_1400d3920` 只调设备 +0x108（设目标）和 +0x88（视口 `0, 0, RT 宽, RT 高`），不碰这两个字段。【确】
- 所以合成 RT、effect fbo、泛光 pass 里 `g_Screen` / `g_TexelSize` / `g_TexelSizeHalf` **始终是窗口尺寸**，和 p2-REPORT 第 538 行的推断一致，现在升为确。

---

## 7. `R+0x84/0x88` 由谁写，和 `engine.screenResolution` 是不是同一个

### resize：`FUN_14017f1b0(R, w, h)`【确】

```asm
14017f1de: cmp     edx, r15d          ; r15d = 2
14017f1ec: cmovg   r15d, edx          ; w' = max(w, 2)
14017f1f6: mov     [rcx+0x8c], r15d   ; R+0x8c = w'（int）
14017f200: cmovg   r12d, r8d          ; h' = max(h, 2)
14017f207: mov     [rcx+0x90], r12d   ; R+0x90 = h'（int）
14017f222: movss   [rcx+0x84], xmm6   ; R+0x84 = float(w')
14017f22d: movss   [rcx+0x88], xmm7   ; R+0x88 = float(h')
14017f23f: call    [rax+0x88]         ; 设备视口，之后重建 RT 与泛光三角形
```

调用点：

| 地址 | 场合 | 实参 |
|---|---|---|
| `0x140115d2c` | 窗口过程 `FUN_140115b90` 的 `WM_SIZE`（消息 5，`wParam & ~2 == 0`，即还原或最大化），交换链 resize（`FUN_140099770`）成功之后 | `max(LOWORD(lParam), 8)`、`max(HIWORD(lParam), 8)`，同时存宿主 `+0x24c/+0x24e`（u16） |
| `0x140115d7e` | 同上，还没有交换链时 | 同上 |
| `0x140110c3c` | 初始化 `FUN_140110a11`，ctx 刚构造完 | 初始客户区尺寸（也存 `+0x24c/+0x24e`） |
| `0x140111299` | 主循环 `FUN_140111085`，按宿主 `+0x24c/+0x24e` 重设（推：设备重建后） | 上次的客户区尺寸 |
| `0x14012baa9` | 另一个构造 `FUN_14012b890` | 构造实参 |
| `0x14011ff92` | `materials/background.json` 一带的路径（场合没查） | `ebx`、`[rsp+0x11c]` |

所以 `R+0x84/0x88` = 窗口客户区像素（下限 8），没有别的换算。【确】

### `engine.screenResolution`【确】

- 脚本接口对象在 `G+0x48`（虚表 `0x14048ea50`）。虚表 `+0x80` = `0x14018dc50`：`return [this+0x90] + 0x74`，即 `[G+0xd8] + 0x74`。DLL 用 `+0x80` 取 `screenResolution` 引自 rea-p6c-script 第 144 行。
- `G+0xd8` 是场景构造 `FUN_140186c90` 的第 4 个实参（`0x140186d13`），唯一调用点 `0x140181b82` 传 `lea r9, [r14 + 0x10]`，`r14 = R`。所以 `[G+0xd8] = R+0x10 = ctx`，`screenResolution` 读的就是 `ctx+0x74` = `R+0x84/0x88`。旁证：`ctx = R+0x10` 也见于 `0x140110ae1`（`lea rcx, [rax+0x10]` 后调 ctx 构造 `FUN_14017c6d0`），以及 `[G+0xd8]+0x118 & 0x800` 正是 `R+0x128` 的翻转位。
- 和实测一致：phase-5d 第 686 行 `screen 1920 1080` 是测试窗口，`canvasSize 3840 2160` 是场景。
- 虚表 `+0x88` = `0x14018dc60` 返回 `ctx+0x84`（整数场景尺寸，第 5 节的 `Wi/Hi`）。它多半是 `canvasSize`。【推：没核对 DLL 用哪个槽】

---

## 附：顺带看到的

- **`orthogonalprojection.auto: true`**（`0x140187565`）：置 `G+0xe0 |= 0x18`，并跳过 `width` / `height` 的解析。之后加载时（`0x1401886a8`）与每帧相机更新（`0x140189d9b`，`G+0xe0 & 0x10` 时）调 `FUN_14018b2c0`：取第一个虚函数 +0x60 返回 1 的对象，用它的 `size`（`+0x2f0`）改写 `G+0x354/0x358` 和整数 `ctx+0x84/0x88`，并把它的原点设成 `size/2`。场景尺寸会随这个图层变。【确：代码；推：+0x60 返回 1 是哪类对象】
- **视差指针不经裁切**（`0x140189b5a`–`0x140189c24`）：取窗口归一化指针 `ctx+0x8c/0x90`，钳到 [0, 1]，y 取 `1 − y`，`alignmentfliph` 时 x 取 `1 − x`，再乘场景 `Ws`、`Hs`。不看 E。所以在装下 / 居中下，视差指针按「窗口 0..1 → 场景 0..W」直接拉伸，不是光标下的场景点。【确】
- **更正 rea-p6b-layout 第 195–196 行**：「缺省分支全为 0」「屏幕与场景同比例（或 stretch）时全为 0」。缺省分支是铺满裁切；全为 0 的是拉伸（2）。同比例时只有铺满 / 装下近似全为 0（第 4 节），居中 / 自由不是。
- **更正 rea-p5-camera 第 7.2 节**：透视覆盖的 aspect 是 `Ww/Hw`（窗口），不是 `Ws/Hs`。`Wi`、`Hi` 是整数场景尺寸。
- **E0..E3 的读者**：全文件找同一基址读 `+0x100/0x104/0x108/0x10c` 中至少三个的函数，场景与图层代码里只有文本 anchor（`FUN_1402585c0`、`0x1402587a6`），另两处是 `rbp` 栈帧。`R+0x108/0x10c` 只有三份透视覆盖读。【确，有界】

## 未查清

- `0x14041e350` 是 CRT `powf`、`0x14041b0d0` 是 CRT `tanf`：按形状判断（FMA 分派标志 `0x1404e4ee0`、`0x3f800000` / `0x3f490fdb` 的分段），没逐值核对舍入。自由模式的 `(2 − az)⁴` 与透视覆盖的 `tan` 在个别参数上可能差 1 ulp。
- `alignmentposition` 在「铺满、裁左右」时方向和其余三种相反（第 1 节）。读码确定，但没在 WPE 里实测；WPE 设置界面上这个滑块的名字和取值范围也没查。
- 自由模式 `ax = 0 / 1` 时场景整张在窗口外，`az > 2` 时又缩回去。这是公式的直接结果，WPE 界面是否把滑块限在某个范围内没查。
- `FUN_140181f30` 五个调用点的具体场合（哪个是 `applyProperties`、哪个是加载）只按上下文推，没逐个追到命令分派。
- `0x14011ff92`（`materials/background.json` 一带）调 resize 的场合；`0x140111299` 是否就是设备重建。
- `WM_SIZE` 的 `lParam` 是物理像素还是逻辑像素取决于进程的 DPI 感知设置，没查 manifest / `SetProcessDpiAwareness`。
- 建议实测（`wpe-renderdoc`）：同一测试工程开 1920×1200 与 2560×1080 两个窗口，`alignment` 依次取 0–4，读 `g_ModelViewProjectionMatrix` 的 `P` 部分与 `g_Screen`，和 `edges.py` 逐位比；再加 `alignmentposition = 0`、`alignmentz = 60`（模式 4）各一次；带一个 `flags 4` 的粒子系统，读它的 VP 核对第 5 节。
