/*
 * wpefont：FreeType 2.14.3 + HarfBuzz 15.0.0 编成的 wasm（wasm32-wasip1 reactor）的 C 胶水，给场景宿主栅格化、排字。
 * 由 P6b 1a 探针的 kbfont.c 改名而来，只暴露 WPE 文本用到的几步（rea-p6b-raster 2–5、rea-p6b-layout 2）：
 *   - wpefont_font_new：FT_New_Memory_Face(face 0)、Unicode 字符表、FT_Set_Char_Size(0, size26_6, 300, 300)、
 *     hb_ft_font_create；
 *   - wpefont_font_has：FT_Get_Char_Index（回退链逐码点查）；
 *   - wpefont_font_metrics：size->metrics 的 ascender / descender / height（26.6）与 units_per_EM；
 *   - wpefont_shape：hb_buffer_add_utf32 + guess_segment_properties + hb_shape（无 features），每个字形 6 个 int；
 *   - wpefont_glyph：FT_Load_Glyph(gid, RENDER | COLOR [| FORCE_AUTOHINT])，返回位图指针与位图的 6 个 int；
 *   - wpefont_glyph_box：FT_Load_Glyph(gid, NO_BITMAP [| FORCE_AUTOHINT]) → FT_Get_Glyph →
 *     FT_Glyph_Get_CBox(PIXELS)，即 WPE 取字形框的 FUN_1401addb0（四边形、断行、包围盒用它，图集格子用位图）。
 * hinting 规则（2026-11-12 实测，和 WPE 图集一致）：TrueType（有 glyf）没有 fpgm 时强制自动 hinting；CFF 走原生引擎。
 * 排版规则一条都不放在这里，见 apps/wpe-scene/src/wpefont/ 与 README.md。
 */
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_GLYPH_H
#include FT_TRUETYPE_TAGS_H
#include FT_TRUETYPE_TABLES_H

#include <hb.h>
#include <hb-ft.h>

#include <stdint.h>
#include <stdlib.h>

#define EXPORT(name) __attribute__((export_name(#name)))

typedef struct {
  FT_Face face;
  hb_font_t *hb;
  FT_Int32 load_flags;
  unsigned char *data;
} WpeFont;

static FT_Library library;

EXPORT(wpefont_alloc) void *wpefont_alloc(size_t size) { return malloc(size); }
EXPORT(wpefont_free) void wpefont_free(void *ptr) { free(ptr); }

static int has_table(FT_Face face, FT_ULong tag) {
  FT_ULong length = 0;
  return FT_Load_Sfnt_Table(face, tag, 0, NULL, &length) == 0 && length > 0;
}

/* data 由调用方 wpefont_alloc 分配并交给字体，wpefont_font_free 时释放。失败返回 0（data 已释放）。 */
EXPORT(wpefont_font_new) WpeFont *wpefont_font_new(unsigned char *data, int length, int size26_6) {
  if (!library && FT_Init_FreeType(&library)) {
    free(data);
    return 0;
  }
  WpeFont *font = calloc(1, sizeof *font);
  if (!font) {
    free(data);
    return 0;
  }
  font->data = data;
  if (FT_New_Memory_Face(library, data, length, 0, &font->face)) {
    free(data);
    free(font);
    return 0;
  }
  FT_Select_Charmap(font->face, FT_ENCODING_UNICODE);
  FT_Set_Char_Size(font->face, 0, size26_6, 300, 300);
  font->hb = hb_ft_font_create(font->face, NULL);
  font->load_flags = FT_LOAD_RENDER | FT_LOAD_COLOR;
  /* 实测规则：TrueType 没有 fpgm 就强制自动 hinting；CFF 不强制（走原生 CFF 引擎）。
   * FreeType 自己判「没有 hinting」时还要看 prep，所以要在这里补，不能交给 FreeType。 */
  if (has_table(font->face, TTAG_glyf) && !has_table(font->face, TTAG_fpgm))
    font->load_flags |= FT_LOAD_FORCE_AUTOHINT;
  return font;
}

EXPORT(wpefont_font_free) void wpefont_font_free(WpeFont *font) {
  if (!font) return;
  hb_font_destroy(font->hb);
  FT_Done_Face(font->face);
  free(font->data);
  free(font);
}

EXPORT(wpefont_font_has) int wpefont_font_has(WpeFont *font, uint32_t codepoint) {
  return FT_Get_Char_Index(font->face, codepoint) != 0;
}

/* out[5]：ascender、descender、height（26.6）、units_per_EM、load_flags */
EXPORT(wpefont_font_metrics) void wpefont_font_metrics(WpeFont *font, int32_t *out) {
  FT_Size_Metrics *m = &font->face->size->metrics;
  out[0] = (int32_t)m->ascender;
  out[1] = (int32_t)m->descender;
  out[2] = (int32_t)m->height;
  out[3] = font->face->units_per_EM;
  out[4] = font->load_flags;
}

/* out：每个字形 gid、cluster、x_advance、y_advance、x_offset、y_offset（26.6），最多写 cap 个；
 * 返回实际字形数（可能大于 cap，调用方按返回值放大缓冲重排） */
EXPORT(wpefont_shape) int wpefont_shape(WpeFont *font, const uint32_t *text, int length, int32_t *out, int cap) {
  hb_buffer_t *buffer = hb_buffer_create();
  hb_buffer_add_utf32(buffer, text, length, 0, length);
  hb_buffer_guess_segment_properties(buffer);
  hb_shape(font->hb, buffer, NULL, 0);
  unsigned int count = 0;
  hb_glyph_info_t *info = hb_buffer_get_glyph_infos(buffer, &count);
  hb_glyph_position_t *pos = hb_buffer_get_glyph_positions(buffer, &count);
  int n = (int)count < cap ? (int)count : cap;
  for (int i = 0; i < n; i++) {
    int32_t *o = out + 6 * i;
    o[0] = (int32_t)info[i].codepoint;
    o[1] = (int32_t)info[i].cluster;
    o[2] = pos[i].x_advance;
    o[3] = pos[i].y_advance;
    o[4] = pos[i].x_offset;
    o[5] = pos[i].y_offset;
  }
  hb_buffer_destroy(buffer);
  return (int)count;
}

/* out[6]：width、rows、pitch、bitmap_left、bitmap_top、pixel_mode。图集格子取位图宽高（WPE 的 FUN_1401ae080
 *         对这次加载的位图字形取 FT_Glyph_Get_CBox，就是位图框）。
 * 返回位图缓冲（字形槽里的，同一字体下次加载前有效；空字形可能为 0）。
 * 失败（gid 越界、字形坏，或 FT_Get_Glyph 失败，同 WPE 两步都要成功）时返回 0，out 除 pixel_mode 外全写 0，
 * pixel_mode 写 -1。 */
EXPORT(wpefont_glyph) unsigned char *wpefont_glyph(WpeFont *font, uint32_t gid, int32_t *out) {
  for (int i = 0; i < 6; i++) out[i] = 0;
  out[5] = -1;
  if (FT_Load_Glyph(font->face, gid, font->load_flags)) return 0;
  FT_GlyphSlot slot = font->face->glyph;
  FT_Glyph glyph;
  if (FT_Get_Glyph(slot, &glyph)) return 0;
  FT_Done_Glyph(glyph);
  out[0] = (int32_t)slot->bitmap.width;
  out[1] = (int32_t)slot->bitmap.rows;
  out[2] = slot->bitmap.pitch;
  out[3] = slot->bitmap_left;
  out[4] = slot->bitmap_top;
  out[5] = slot->bitmap.pixel_mode;
  return slot->bitmap.buffer;
}

/* WPE 的取框（FUN_1401addb0）：FT_Load_Glyph(gid, FT_LOAD_NO_BITMAP) → FT_Get_Glyph →
 * FT_Glyph_Get_CBox(FT_GLYPH_BBOX_PIXELS)，即轮廓框向外取整到整像素，y 向上。强制自动 hinting 的规则同
 * wpefont_glyph（WPE 那份 FreeType 两次加载的 hinting 一样，P6b 1c 实验）。
 * out[4]：xMin、yMin、xMax、yMax。成功返回 0；加载或 FT_Get_Glyph 失败返回非 0，out 不写（同 WPE）。
 * 会覆盖字形槽：wpefont_glyph 返回的位图指针在这之后失效。 */
EXPORT(wpefont_glyph_box) int wpefont_glyph_box(WpeFont *font, uint32_t gid, int32_t *out) {
  if (FT_Load_Glyph(font->face, gid, FT_LOAD_NO_BITMAP | (font->load_flags & FT_LOAD_FORCE_AUTOHINT))) return 1;
  FT_Glyph glyph;
  if (FT_Get_Glyph(font->face->glyph, &glyph)) return 2;
  FT_BBox box;
  FT_Glyph_Get_CBox(glyph, FT_GLYPH_BBOX_PIXELS, &box);
  FT_Done_Glyph(glyph);
  out[0] = (int32_t)box.xMin;
  out[1] = (int32_t)box.yMin;
  out[2] = (int32_t)box.xMax;
  out[3] = (int32_t)box.yMax;
  return 0;
}
