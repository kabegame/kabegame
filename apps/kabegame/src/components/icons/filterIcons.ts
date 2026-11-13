/**
 * 查询 chip 的维度图标（设计稿那套 16px 线性图标）。
 * 原在 vendored 图标包（@kabegame/element-plus-icons 的 Filter*），P3 搬进 app：图标包随 element-plus
 * 在 P9 删除，这一套是专门画的、和 lucide 观感接近，保留。
 * 由 packages/kabegame-element-plus-icons/svg/filter-*.svg 原样转写（根属性 + 内部标记）。
 */
import { defineComponent, h } from "vue";

function svgIcon(name: string, attrs: Record<string, string>, inner: string) {
  return defineComponent({
    name,
    setup() {
      return () => h("svg", { xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", ...attrs, innerHTML: inner });
    },
  });
}

export const FilterAspect = svgIcon(
  "FilterAspect",
  {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
  '<path d="M1.6 3.4h12.8v9.2H1.6z"></path><path d="M4.6 6.2h6.8v3.6H4.6z"></path>',
);

export const FilterColor = svgIcon(
  "FilterColor",
  {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
  '<path d="M8 14.2a6.2 6.2 0 1 1 0-12.4c3.5 0 6.3 2.4 6.3 5.5 0 1.9-1.5 3.3-3.4 3.3H9.5a1.1 1.1 0 0 0-.9 1.8l.2.3a1.1 1.1 0 0 1-.8 1.5z"></path><path d="M4.9 8.5h.01"></path><path d="M6.4 5.3h.01"></path><path d="M9.7 4.7h.01"></path><path d="M11.6 7.3h.01"></path>',
);

export const FilterDate = svgIcon(
  "FilterDate",
  {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
  '<path d="M3 4.6h10a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1z"></path><path d="M2 7.6h12"></path><path d="M5.4 2.6v3"></path><path d="M10.6 2.6v3"></path>',
);

export const FilterMedia = svgIcon(
  "FilterMedia",
  {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
  '<path d="M2.4 3.4h11.2a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2.4a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9z"></path><path d="M1.8 11.2 5.3 7.7l2.4 2.4 2.1-2.1 3.9 3.9"></path><circle cx="10.7" cy="6.1" r=".95"></circle>',
);

export const FilterName = svgIcon(
  "FilterName",
  {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
  '<path d="M1.9 12.4 5 3.6l3.1 8.8"></path><path d="M3 9.7h4"></path><path d="M10.2 7.6h3.9"></path><path d="M10.2 11.2h3.9"></path>',
);

export const FilterPlugin = svgIcon(
  "FilterPlugin",
  { viewBox: "0 0 1024 1024" },
  '<path fill="currentColor" d="M576 32A160 160 0 0 1 736 192H896a64 64 0 0 1 64 64v640a64 64 0 0 1-64 64h-234.24v-104.32a87.68 87.68 0 0 0-79.232-87.296L574.08 768a87.68 87.68 0 0 0-87.68 87.68V960H256a64 64 0 0 1-64-64v-160a160 160 0 1 1 0-320V256a64 64 0 0 1 64-64h160A160 160 0 0 1 576 32z m0 74.24c-47.36 0-85.76 38.4-85.76 85.76v74.24h-211.2a12.8 12.8 0 0 0-12.8 12.8v211.2H192a85.76 85.76 0 0 0 0 171.52h74.24v211.2c0 7.04 5.76 12.8 12.8 12.8h133.12v-30.08c0-85.824 66.816-156.096 154.368-161.472l11.072-0.384 11.968 0.64A161.92 161.92 0 0 1 736 855.68v30.08h136.96a12.8 12.8 0 0 0 12.8-12.8V279.04a12.8 12.8 0 0 0-12.8-12.8h-211.2V192c0-47.36-38.4-85.76-85.76-85.76z"/>',
);

export const FilterSize = svgIcon(
  "FilterSize",
  {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
  '<path d="M8 2.2 14 5 8 7.8 2 5z"></path><path d="M2 8.1l6 2.8 6-2.8"></path><path d="M2 11.1l6 2.8 6-2.8"></path>',
);

export const FilterWallpaper = svgIcon(
  "FilterWallpaper",
  {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.35",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
  '<path d="M2.1 3.5h11.8a.6.6 0 0 1 .6.6v5.8a.6.6 0 0 1-.6.6H2.1a.6.6 0 0 1-.6-.6V4.1a.6.6 0 0 1 .6-.6z"></path><path d="M3.6 9 6.2 6.4l1.8 1.8 1.6-1.6 2.8 2.8"></path><path d="M8 10.5v2.9"></path><path d="M5.8 13.6h4.4"></path>',
);
