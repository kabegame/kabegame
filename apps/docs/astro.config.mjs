import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Kabegame',
      description: '让桌面充满二次元气息的壁纸管理器',
      logo: {
        src: './src/assets/icon.png',
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/kabegame/kabegame',
        },
      ],
      sidebar: [
        {
          label: '用户指南',
          items: [
            { label: '画廊', slug: 'guide/gallery' },
            { label: '画册', slug: 'guide/albums' },
            { label: '壁纸', slug: 'guide/wallpaper' },
            { label: '插件使用', slug: 'guide/plugins-usage' },
            { label: '任务', slug: 'guide/tasks' },
            { label: '托盘', slug: 'guide/tray' },
            { label: '虚拟盘', slug: 'guide/virtual-drive' },
            { label: '命令行', slug: 'guide/command-line' },
          ],
        },
        {
          label: '快捷键参考',
          items: [
            { label: '快捷键一览', slug: 'guide/shortcuts' },
          ],
        },
        {
          label: '插件开发',
          items: [
            { label: '开发指南', slug: 'dev/overview' },
            { label: '插件格式', slug: 'dev/format' },
            { label: 'Rhai API', slug: 'dev/rhai-api' },
          ],
        },
      ],
      defaultLocale: 'root',
      locales: {
        root: {
          label: '中文',
          lang: 'zh-CN',
        },
      },
      customCss: [],
    }),
  ],
});
