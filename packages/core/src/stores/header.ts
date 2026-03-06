import { defineStore } from "pinia";
import type { Component } from "vue";

export enum HeaderFeatureId {
  Help = "help",
  QuickSettings = "quickSettings",
  Refresh = "refresh",
  StopTask = "stopTask",
  DeleteTask = "deleteTask",
  Organize = "organize",
  Collect = "collect",
  CreateAlbum = "createAlbum",
  OpenVirtualDrive = "openVirtualDrive",
  SetAsWallpaperCarousel = "setAsWallpaperCarousel",
  DeleteAlbum = "deleteAlbum",
  ImportSource = "importSource",
  ManageSources = "manageSources",
  TaskDrawer = "taskDrawer",
  AddToAlbum = "addToAlbum",
}

export interface HeaderFeatureDef {
  id: HeaderFeatureId;
  label?: string;     // fold 下拉菜单显示用；show 模式下作为 tooltip
  icon?: Component;   // fold 下拉菜单图标；无 comp 时用于 show 模式默认按钮
  comp?: Component;   // 自定义组件（show 模式专用）；缺失时自动用 icon+label 生成 HeaderActionButton
}

export const useHeaderStore = defineStore('header', () => {
  const features = new Map<string, HeaderFeatureDef>();

  function register(defs: HeaderFeatureDef[]) {
    for (const def of defs) {
      features.set(def.id, def);
    }
  }

  function get(id: HeaderFeatureId | string): HeaderFeatureDef | undefined {
    return features.get(id);
  }

  function has(id: HeaderFeatureId | string): boolean {
    return features.has(id);
  }

  return {
    register,
    get,
    has,
  };
});