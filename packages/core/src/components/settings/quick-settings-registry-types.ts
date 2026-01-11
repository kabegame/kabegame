import type { Component } from "vue";
import type { AppSettingKey } from "../../stores/settings";

export type QuickSettingItem<PageId extends string> = {
  key: AppSettingKey;
  label: string;
  description?: string;
  comp: Component;
  props?: Record<string, any>;
  pages: PageId[];
};

export type QuickSettingGroup<PageId extends string> = {
  id: string;
  title: string;
  description?: string;
  items: QuickSettingItem<PageId>[];
};
