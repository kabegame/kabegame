#!/usr/bin/env node
/**
 * 清理 Nx 缓存，只保留最新的一个缓存条目
 * 使用方法：node scripts/clean-nx-cache.js
 */

import { readdir, stat, unlink, rmdir } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = dirname(__dirname);
const cacheDir = join(root, ".nx", "cache");

async function cleanNxCache() {
  try {
    // 检查缓存目录是否存在
    const entries = await readdir(cacheDir, { withFileTypes: true });

    if (entries.length === 0) {
      console.log("缓存目录为空，无需清理");
      return;
    }

    // 获取所有缓存条目的信息（文件名和修改时间）
    const cacheEntries = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filePath = join(cacheDir, entry.name);
          const stats = await stat(filePath);
          return {
            name: entry.name,
            path: filePath,
            mtime: stats.mtime.getTime(),
          };
        })
    );

    if (cacheEntries.length === 0) {
      console.log("没有找到缓存文件");
      return;
    }

    // 按修改时间排序，最新的在前
    cacheEntries.sort((a, b) => b.mtime - a.mtime);

    // 保留最新的一个，删除其他的
    const toKeep = cacheEntries[0];
    const toDelete = cacheEntries.slice(1);

    if (toDelete.length === 0) {
      console.log("只有一个缓存条目，无需清理");
      return;
    }

    // 删除旧缓存
    for (const entry of toDelete) {
      try {
        await unlink(entry.path);
        console.log(`已删除旧缓存: ${entry.name}`);
      } catch (error) {
        console.error(`删除缓存失败 ${entry.name}:`, error.message);
      }
    }

    console.log(
      `清理完成：保留了最新的缓存 ${toKeep.name}，删除了 ${toDelete.length} 个旧缓存`
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("缓存目录不存在，无需清理");
    } else {
      console.error("清理缓存失败:", error.message);
      process.exit(1);
    }
  }
}

cleanNxCache();
