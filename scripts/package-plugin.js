#!/usr/bin/env node

/**
 * 自动打包 test_plugin 目录下的所有插件到 test_plugin_packed 目录
 * 用法: node scripts/package-plugin.js
 */

import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import archiver from "archiver";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 写死的路径
const TEST_PLUGIN_DIR = path.join(__dirname, "..", "test_plugin");
const OUTPUT_DIR = path.join(__dirname, "..", "test_plugin_packed");

function packagePlugin(pluginDir, outputFile) {
  return new Promise((resolve, reject) => {
    // 检查 manifest.json 是否存在
    const manifestPath = path.join(pluginDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      reject(new Error(`manifest.json 不存在: ${manifestPath}`));
      return;
    }

    // 读取 manifest.json 获取插件名称
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch (error) {
      reject(new Error(`无法解析 manifest.json: ${error.message}`));
      return;
    }

    // 创建 ZIP 文件
    const output = createWriteStream(outputFile);
    const archive = archiver("zip", {
      zlib: { level: 9 }, // 最高压缩级别
    });

    output.on("close", () => {
      console.log(
        `✅ ${path.basename(outputFile)} (${archive.pointer()} 字节)`
      );
      resolve(outputFile);
    });

    archive.on("error", (err) => {
      reject(err);
    });

    archive.pipe(output);

    // 添加文件到 ZIP
    const files = fs.readdirSync(pluginDir);

    for (const file of files) {
      const filePath = path.join(pluginDir, file);
      const stat = fs.statSync(filePath);

      if (stat.isFile()) {
        archive.file(filePath, { name: file });
      } else if (stat.isDirectory()) {
        archive.directory(filePath, file);
      }
    }

    archive.finalize();
  });
}

async function packageAllPlugins() {
  console.log("📦 开始打包测试插件...\n");

  // 检查 test_plugin 目录是否存在
  if (!fs.existsSync(TEST_PLUGIN_DIR)) {
    console.error(`❌ 测试插件目录不存在: ${TEST_PLUGIN_DIR}`);
    process.exit(1);
  }

  // 确保输出目录存在
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  } else {
    // 清空输出目录
    const files = fs.readdirSync(OUTPUT_DIR);
    for (const file of files) {
      const filePath = path.join(OUTPUT_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && file.endsWith(".kgpg")) {
        fs.unlinkSync(filePath);
      }
    }
  }

  // 读取 test_plugin 目录下的所有文件夹
  const entries = fs.readdirSync(TEST_PLUGIN_DIR, { withFileTypes: true });
  const pluginDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (pluginDirs.length === 0) {
    console.log("⚠️  未找到任何插件目录");
    process.exit(0);
  }

  console.log(`找到 ${pluginDirs.length} 个插件目录:\n`);

  // 打包每个插件
  const promises = pluginDirs.map(async (pluginName) => {
    const pluginDir = path.join(TEST_PLUGIN_DIR, pluginName);
    const outputFile = path.join(OUTPUT_DIR, `${pluginName}.kgpg`);

    try {
      await packagePlugin(pluginDir, outputFile);
      return { name: pluginName, success: true };
    } catch (error) {
      console.error(`❌ ${pluginName}: ${error.message}`);
      return { name: pluginName, success: false, error: error.message };
    }
  });

  const results = await Promise.all(promises);

  // 输出总结
  console.log("\n📊 打包总结:");
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  console.log(`   ✅ 成功: ${successCount}`);
  if (failCount > 0) {
    console.log(`   ❌ 失败: ${failCount}`);
  }
  console.log(`\n📁 输出目录: ${OUTPUT_DIR}\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

packageAllPlugins().catch((error) => {
  console.error("❌ 打包失败:", error.message);
  process.exit(1);
});
