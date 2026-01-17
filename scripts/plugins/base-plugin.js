#!/usr/bin/env node
/**
 * 插件基类
 * 所有插件都应该继承此类或实现相同的接口
 */

export class BasePlugin {
  constructor(name) {
    this.name = name;
  }

  /**
   * 插件应用（同步）
   */
  apply(buildSystem) {
    throw new Error(`Plugin ${this.name} must implement apply method`);
  }

  /**
   * 获取插件名称
   */
  getName() {
    return this.name;
  }
}
