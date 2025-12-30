import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const inputPath = join(__dirname, '../src-tauri/icons/icon.png');
const outputPath = join(__dirname, '../src-tauri/icons/icon-transparent.png');

async function makeTransparent() {
  try {
    // 读取图片
    const image = sharp(inputPath);
    const { data, info } = await image
      .ensureAlpha() // 确保有 alpha 通道
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    
    // 处理每个像素，将白色（或接近白色）设为透明
    const threshold = 240; // RGB 阈值，大于此值认为是白色
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // 如果 RGB 值都大于阈值，则设为透明
      if (r >= threshold && g >= threshold && b >= threshold) {
        data[i + 3] = 0; // 设置 alpha 为 0（透明）
      }
    }

    // 创建新图片并保存
    await sharp(data, {
      raw: {
        width,
        height,
        channels: 4
      }
    })
      .png()
      .toFile(outputPath);
    
    console.log(`✅ 成功将图标白色部分设为透明！`);
    console.log(`   输出文件: ${outputPath}`);
  } catch (error) {
    console.error('❌ 处理图片时出错:', error);
    process.exit(1);
  }
}

makeTransparent();

