/*
 * wpefont 的 FreeType 模块表（构建时 -DFT_CONFIG_MODULES_H="ftmodule.h" 代替 FreeType 缺省的
 * include/freetype/config/ftmodule.h）。顺序同缺省表，去掉用不到的驱动：只留 TrueType、CFF（OpenType 的 otf）、
 * 自动 hinter 与 smooth 栅格化器，以及它们依赖的 psaux / psnames / pshinter / sfnt。
 * 和这里对应的编译单元列表在 scripts/build-wpefont.ts（FT_UNITS），两边要一起改。
 */
FT_USE_MODULE( FT_Module_Class, autofit_module_class )
FT_USE_MODULE( FT_Driver_ClassRec, tt_driver_class )
FT_USE_MODULE( FT_Driver_ClassRec, cff_driver_class )
FT_USE_MODULE( FT_Module_Class, psaux_module_class )
FT_USE_MODULE( FT_Module_Class, psnames_module_class )
FT_USE_MODULE( FT_Module_Class, pshinter_module_class )
FT_USE_MODULE( FT_Module_Class, sfnt_module_class )
FT_USE_MODULE( FT_Renderer_Class, ft_smooth_renderer_class )
