/*
 * wpefont 的字体结构，wpefont.c（排字、位图）与 msdf.cpp（距离场）共用。
 */
#ifndef WPEFONT_H
#define WPEFONT_H

#include <ft2build.h>
#include FT_FREETYPE_H

#include <hb.h>

typedef struct {
  FT_Face face;
  hb_font_t *hb;
  FT_Int32 load_flags;
  unsigned char *data;
} WpeFont;

#endif
