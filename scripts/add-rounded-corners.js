import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const inputPath = join(__dirname, '../src-tauri/icons/icon.png');
const outputPath = join(__dirname, '../src-tauri/icons/icon.png');
const radius = 80; // 圆角半径

async function addRoundedCorners() {
  try {
    // 读取图片
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    // 创建圆角遮罩
    const roundedCorners = Buffer.from(
      `<svg width="${width}" height="${height}">
        <rect x="0" y="0" width="${width}" height="${height}" 
              rx="${radius}" ry="${radius}" fill="white"/>
      </svg>`
    );

    // 应用圆角遮罩
    const rounded = await image
      .composite([
        {
          input: roundedCorners,
          blend: 'dest-in'
        }
      ])
      .png()
      .toBuffer();

    // 保存结果
    await sharp(rounded).toFile(outputPath);
    
    console.log(`✅ 成功为图标添加 ${radius}px 圆角！`);
    console.log(`   输出文件: ${outputPath}`);
  } catch (error) {
    console.error('❌ 处理图片时出错:', error);
    process.exit(1);
  }
}

addRoundedCorners();


