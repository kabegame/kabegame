/*
 * wpefont 的 MSDF 字形：msdfgen v1.13 + WPE 的外围流程（rea-p6f-msdf 第 2 节），逐字节对上 WPE 的 MSDF 图集
 * （P6f 步骤 0b：9 张图集、148 个格子、约 101 万字节全部相同）。算法一行都不自己写，只是把 FreeType 轮廓喂给 msdfgen：
 *   1. FT_Load_Glyph(NO_BITMAP [| FORCE_AUTOHINT])：带 hinting、按字体当前的 300 DPI 字号取轮廓；
 *   2. FT_Glyph_Get_CBox(PIXELS) 得整数像素包围盒；
 *   3. 轮廓经 FT_Outline_Decompose（缩放 1/64）进 Shape，normalize、orientContours（msdfgen 缺省流程不调，WPE 调）、
 *      edgeColoringSimple(3.0)；
 *   4. 格子 = max(1, trunc(bbox · f32(32 / y_ppem))) + 24，投影与范围全在 float32 里算再转 double；
 *   5. generateMSDF(…, MSDFGeneratorConfig(true))，转字节 ×256 截断、钳到 [0, 255]、上下翻转、alpha 写 255。
 */
#include <stdint.h>
#include <stdlib.h>

#include "wpefont.h"
#include FT_GLYPH_H
#include FT_OUTLINE_H

#include "msdfgen.h"

using namespace msdfgen;

namespace {

struct FtContext {
  double scale;
  Point2 position;
  Shape *shape;
  Contour *contour;
};

Point2 ftPoint2(const FT_Vector &v, double scale) { return Point2(scale * v.x, scale * v.y); }

int ftMoveTo(const FT_Vector *to, void *user) {
  FtContext *c = (FtContext *)user;
  if (!(c->contour && c->contour->edges.empty())) c->contour = &c->shape->addContour();
  c->position = ftPoint2(*to, c->scale);
  return 0;
}

int ftLineTo(const FT_Vector *to, void *user) {
  FtContext *c = (FtContext *)user;
  Point2 e = ftPoint2(*to, c->scale);
  if (e != c->position) {
    c->contour->addEdge(EdgeHolder(c->position, e));
    c->position = e;
  }
  return 0;
}

int ftConicTo(const FT_Vector *control, const FT_Vector *to, void *user) {
  FtContext *c = (FtContext *)user;
  Point2 e = ftPoint2(*to, c->scale);
  if (e != c->position) {
    c->contour->addEdge(EdgeHolder(c->position, ftPoint2(*control, c->scale), e));
    c->position = e;
  }
  return 0;
}

int ftCubicTo(const FT_Vector *c1, const FT_Vector *c2, const FT_Vector *to, void *user) {
  FtContext *c = (FtContext *)user;
  Point2 e = ftPoint2(*to, c->scale);
  if (e != c->position || crossProduct(ftPoint2(*c1, c->scale) - e, ftPoint2(*c2, c->scale) - e)) {
    c->contour->addEdge(EdgeHolder(c->position, ftPoint2(*c1, c->scale), ftPoint2(*c2, c->scale), e));
    c->position = e;
  }
  return 0;
}

}  // namespace

/* out[8]：x0 y0 x1 y1（FT_Glyph_Get_CBox PIXELS，y 向上）、cellW cellH、生成了没有（0/1）、y_ppem。
 * 返回 cellW·cellH·4 字节 RGBA（第 0 行在上、alpha 255），调用方用 wpefont_free 释放。
 * 包围盒为空（空格等）时返回全 0 的 24×24 格子、out[6] = 0；加载失败或不是轮廓字形返回 0，out 全写 0。
 * 加载标志同 wpefont_glyph_box。生成用字体当前的字号（WPE：第一个用到这个字形的对象的字号），按字号取格子大小。 */
extern "C" __attribute__((export_name("wpefont_msdf"))) uint8_t *wpefont_msdf(WpeFont *font, int gid, int32_t *out) {
  for (int i = 0; i < 8; i++) out[i] = 0;
  FT_Face F = font->face;
  if (FT_Load_Glyph(F, gid, FT_LOAD_NO_BITMAP | (font->load_flags & FT_LOAD_FORCE_AUTOHINT))) return 0;
  if (F->glyph->format != FT_GLYPH_FORMAT_OUTLINE) return 0;
  FT_Glyph g;
  if (FT_Get_Glyph(F->glyph, &g)) return 0;
  FT_BBox bb;
  FT_Glyph_Get_CBox(g, FT_GLYPH_BBOX_PIXELS, &bb);
  FT_Done_Glyph(g);
  int x0 = (int)bb.xMin, y0 = (int)bb.yMin, x1 = (int)bb.xMax, y1 = (int)bb.yMax;
  int bw = x1 - x0, bh = y1 - y0;
  int ppem = (int)F->size->metrics.y_ppem;
  out[0] = x0;
  out[1] = y0;
  out[2] = x1;
  out[3] = y1;
  out[7] = ppem;
  int innerW = 0, innerH = 0;
  if (bw > 0 && bh > 0) {
    int p = ppem < 2 ? 1 : ppem;
    float k = 32.0f / (float)p;
    innerW = (int)((float)bw * k);
    if (innerW < 1) innerW = 1;
    innerH = (int)((float)bh * k);
    if (innerH < 1) innerH = 1;
  }
  int cellW = innerW + 24, cellH = innerH + 24;
  out[4] = cellW;
  out[5] = cellH;
  uint8_t *rgba = (uint8_t *)calloc((size_t)cellW * cellH * 4, 1);
  if (!rgba || !(innerW > 0 && innerH > 0)) return rgba;

  Shape shape;
  FtContext ctx = {1 / 64.0, Point2(), &shape, nullptr};
  FT_Outline_Funcs funcs = {ftMoveTo, ftLineTo, ftConicTo, ftCubicTo, 0, 0};
  FT_Outline_Decompose(&F->glyph->outline, &funcs, &ctx);
  if (!shape.contours.empty() && shape.contours.back().edges.empty()) shape.contours.pop_back();
  shape.normalize();
  shape.orientContours();
  edgeColoringSimple(shape, 3.0, 0);

  float s = (float)(innerW > innerH ? innerW : innerH) / ((float)bh > (float)bw ? (float)bh : (float)bw);
  float tx = 12.0f / s - (float)x0;
  float ty = 12.0f / s - (float)y0;
  float r = 24.0f / s;
  SDFTransformation T(Projection(Vector2((double)s, (double)s), Vector2((double)tx, (double)ty)),
                      DistanceMapping(Range((double)r)));
  float *px = new float[(size_t)cellW * cellH * 3];
  generateMSDF(BitmapSection<float, 3>(px, cellW, cellH, Y_UPWARD), shape, T, MSDFGeneratorConfig(true));
  for (int row = 0; row < cellH; ++row)
    for (int col = 0; col < cellW; ++col) {
      const float *m = px + ((size_t)(cellH - 1 - row) * cellW + col) * 3;
      uint8_t *d = rgba + ((size_t)row * cellW + col) * 4;
      for (int k = 0; k < 3; ++k) {
        float f = m[k] * 256.0f;
        /* cvttss2si：NaN 与越界得 0x80000000，钳到 0 */
        int v = f != f ? 0 : (f >= 2147483648.0f || f < -2147483648.0f ? (int)0x80000000 : (int)f);
        d[k] = (uint8_t)(v >= 255 ? 255 : (v < 0 ? 0 : v));
      }
      d[3] = 255;
    }
  delete[] px;
  out[6] = 1;
  return rgba;
}
