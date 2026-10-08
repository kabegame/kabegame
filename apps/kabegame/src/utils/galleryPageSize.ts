import { IS_WEB } from "@/env";

/**
 * 画廊类列表每页条数的候选与默认值（设置项、工具条、安卓 picker 共用）。
 * web 模式是公开 demo，单页拉取量压小：20 / 50 / 100，默认 20。
 */
export const GALLERY_PAGE_SIZE_OPTIONS: readonly number[] = IS_WEB ? [20, 50, 100] : [100, 500, 1000];

export const DEFAULT_GALLERY_PAGE_SIZE: number = IS_WEB ? 20 : 100;

export function isGalleryPageSizeOption(n: number): boolean {
  return GALLERY_PAGE_SIZE_OPTIONS.includes(n);
}

/** 候选之外的值（如切换模式前留下的旧设置）回退到默认值。 */
export function normalizeGalleryPageSize(n: number | undefined): number {
  return n !== undefined && isGalleryPageSizeOption(n) ? n : DEFAULT_GALLERY_PAGE_SIZE;
}
