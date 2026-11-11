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

/** 删掉不再使用的旧键：没有就什么都不做。 */
function removeKey(key: string, reason: string): LocalMigration {
  return {
    description: `remove ${key} (${reason})`,
    run(storage) {
      storage.removeItem(key);
    },
  };
}

/**
 * Web 版的应用背景图：原先是单独的本地键 `currentWallpaperImageId`（裸 id 字符串），现在并入本地的
 * 壁纸目标 map，记在 `multiple` 目标的 `currentImageId` 上。桌面 / Android 的这个值一直在后端设置里
 * （由后端迁移处理），本地没有旧键，这条规则对它们什么都不做。
 */
function moveWebBackgroundIntoTargets(): LocalMigration {
  const from = `${SETTINGS_PREFIX}currentWallpaperImageId`;
  const to = `${SETTINGS_PREFIX}wallpaperTargets`;
  return {
    description: `${from} -> ${to}`,
    run(storage) {
      const legacy = storage.getItem(from);
      if (legacy === null) return;
      const imageId = legacy.trim();
      if (storage.getItem(to) === null && imageId && imageId !== "null") {
        const multiple = {
          rotationPath: null,
          rotationPosition: 0,
          style: {},
          transition: {},
          currentImageId: imageId,
        };
        storage.setItem(to, JSON.stringify({ multiple }));
      }
      storage.removeItem(from);
    },
  };
}

const migrations: LocalMigration[] = [
  moveKeyOnce("kabegame-galleryPageSize", `${SETTINGS_PREFIX}galleryPageSize`),
  moveKeyOnce("kabegame-gallery-hide", "pathRoute.hide"),
  // 画廊不再保存 / 恢复上次浏览路径（gallery-path 全平台改走 URL query，常用视图改用收藏视图）
  removeKey("kabegame-gallery-path", "gallery last path"),
  removeKey(`${SETTINGS_PREFIX}gallery-path`, "gallery last path"),
  // 工具条 chip 不再可隐藏（⋯ 菜单只留轮播与收藏视图），显隐开关的设置键作废；
  // Compact / PageSize 是更早版本留下、早已无人读取的同族键，一并清掉
  ...["Search", "Date", "Plugin", "MediaType", "Aspect", "Size", "SortField", "SortOrder", "Compact", "PageSize"].map(
    (name) => removeKey(`${SETTINGS_PREFIX}galleryChip${name}`, "toolbar chip visibility"),
  ),
  moveWebBackgroundIntoTargets(),
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
