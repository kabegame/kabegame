# L6b — 被依赖图层也走单对象重编译（L6 补丁）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L6」；前一块 [phase-l6-object-recompile.md](phase-l6-object-recompile.md)（`objectLive` 对 `dependedOn` 的图层退回整场，是 L5 定的）。2026-11-17 用户确认按下面的办法做。

## 总体设计思路

被依赖图层 A 的独占合成 RT 由 `layerTargets[A]` 持有，引用方 B 的 draw 建 bind group 时把这张 RT 的句柄烤了进去（只有 bind group 烤；`copy` / `subtree` 等 op 每帧 `resolveTexture` 现查 `layerTargets`）。单对象替换 A 时 `teardown(A, { replacing })` 销毁旧 RT、`installObject(A′)` 换一张新的，B 的 bind group 没人动，提交就是校验错误——所以 L5 起 `objectLive` 一看到 `dependedOn` 就退回整场。

补丁分两层，都在 `installCore` 的替换路径里、装完 A′ 的同一帧（`drain` 在 `beforeFrame` 开头，离 `encode` 还有整段脚本）：
1. **沿用**：新旧独占 RT 尺寸与格式相同时直接沿用旧的那张（同 L6 沿用粒子树的思路）：不销毁旧 RT、把 `prepareObject` 建的新那张放掉，B 不用重绑，也没有「B 排在 A 前面时读到一帧空 RT」。被依赖的只有图像层，重编原因里 `colorBlendMode`、effect 开关都不改尺寸，多数落在这条。
2. **重绑**：尺寸变了（`size` 重编）时沿用 P11b 的现成原语：`layerTargets` 前后句柄不同 → 对 `this.draws` 里 `refersToLayer(ref, { A })` 命中的 draw 调 `rebindUserDraw`（只重建 bind group、重写 `g_Texture<n>Resolution`，不重建顶点与管线）。**不能**走 L7 的 `changed` → `restructureLayer`：引用方的计划签名和组归属都没变，`rebuildLayer` 会直接返回。

之后 `objectLive` 去掉 `dependedOn` 的退回。`fragmentBlocker` 的 `depended`（克隆缓存：模板的 `dependedOn` 不该带给克隆）与此无关，照旧。

## 现状锚点

**a.** `host.ts` `objectLive`：
```ts
// 被依赖的图层（别的图层按名字绑它的独占合成 RT）：GPU 替换会放掉旧 RT，引用方的 draw 不重绑（L5 定），照旧整场
if (live === this.live && this.registry?.bundle.layers.find((item) => item.object === object)?.dependedOn) return null;
```
**b.** `render/scene.ts` `installCore`：`if (previous) this.teardown(object, { replacing: true });` → `teardown` 里 `const own = this.layerTargets.get(object); if (own) { this.releaseTarget(own); this.layerTargets.delete(object); }`；装时 `if (prepared.layerTarget) this.layerTargets.set(object, prepared.layerTarget);`。
**c.** `render/scene.ts` `syncUserTextures`：`resized` 集合 + `refersToLayer` + `rebindUserDraw`（P11b 步骤 2 的第 2、3 条）。

## 点 1 — `installCore` 替换被依赖图层（`render/scene.ts`）
- **修改** 替换路径：`teardown` 之前记下 `previousTarget = this.layerTargets.get(object)`；若 `prepared.layerTarget` 与它尺寸、格式相同 → 把 `prepared.layerTarget` 换成 `previousTarget`（新那张 `releaseTarget`），`teardown` 对 `own` 的释放跳过（加选项 `keepTarget`）；否则照旧释放，装完后对引用 `object` 的 draw `rebindUserDraw(draw, state, worlds)`（同 `syncUserTextures` 第 3 条，不含本对象自己的 draw）。
- **核对** `reflectionCopies`（反射 pass 的副本 bind group）是否也按新句柄重建；不是就在重绑里一起做。

## 点 2 — 宿主（`host.ts`）
- **删除** `objectLive` 的 `dependedOn` 退回与注释；L5 / L6 文档里相应的「被依赖的图层照旧整场」改掉。

## 验收
- 单测：`l4` / `l6`：替换被依赖层、尺寸相同 → 沿用同一张 RT（句柄相同、引用方 bind group 不重建）；尺寸不同 → 新 RT、引用方 draw 重绑且 `g_Texture<n>Resolution` 换新尺寸、旧 RT 释放；`host.l6`：被依赖层走单对象重编译、`recompiled` 不增。
- 变异：尺寸不同也沿用（引用方读到旧尺寸）；不重绑；`objectLive` 退回不删（用例失败）。
- 全库画面哈希不变（加载路径不变，只保险）；`p8-dep` 类工程真机：脚本改被依赖层的 `size` / effect 开关，引用方画面跟着变、一次「开始渲染」。
