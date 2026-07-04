const SETTINGS_PREFIX = "kabegame-setting-";

type LocalMigration = {
  /** 简短说明，调试 localStorage 迁移时用于定位具体规则。 */
  description: string;
  run(storage: Storage): void;
};

function moveKeyOnce(from: string, to: string): LocalMigration {
  return {
    description: `${from} -> ${to}`,
    run(storage) {
      if (storage.getItem(to) !== null) return;
      const legacy = storage.getItem(from);
      if (legacy === null) return;
      storage.setItem(to, legacy);
      storage.removeItem(from);
    },
  };
}

const migrations: LocalMigration[] = [
  moveKeyOnce("kabegame-galleryPageSize", `${SETTINGS_PREFIX}galleryPageSize`),
  moveKeyOnce("kabegame-gallery-hide", "pathRoute.hide"),
];

/**
 * 运行前端本地设置迁移。
 *
 * 迁移是互相独立且幂等的：每条规则只检查自己关心的旧键，
 * 新键已存在就跳过，因此可以在每次应用启动时安全执行。
 *
 * @param storage - 默认使用浏览器 `localStorage`；测试时可传入兼容 Storage 的对象。
 *
 * @example
 * ```ts
 * // App/store 初始化阶段执行一次即可；重复执行不会覆盖新值。
 * runLocalSettingsMigrations();
 * ```
 */
export function runLocalSettingsMigrations(storage: Storage | undefined = globalThis.localStorage) {
  if (!storage) return;
  for (const migration of migrations) {
    try {
      migration.run(storage);
    } catch (error) {
      console.warn(`[settings migration] ${migration.description} failed:`, error);
    }
  }
}
