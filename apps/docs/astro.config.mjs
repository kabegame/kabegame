import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  redirects: {
    '/guide/shortcuts': '/reference/shortcuts/',
    '/guide/command-line': '/reference/cli/',
  },
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
            { label: '安装与首次启动', slug: 'guide/installation' },
            { label: '快速上手', slug: 'guide/quickstart' },
            { label: '画廊', slug: 'guide/gallery' },
            { label: '画册', slug: 'guide/albums' },
            { label: '畅游', slug: 'guide/surf' },
            { label: '任务', slug: 'guide/tasks' },
            { label: '壁纸', slug: 'guide/wallpaper' },
            { label: '虚拟盘', slug: 'guide/virtual-drive' },
            { label: '托盘', slug: 'guide/tray' },
            { label: '插件使用', slug: 'guide/plugins-usage' },
            { label: 'MCP 总览', slug: 'guide/mcp' },
            { label: '安装 MCP Bundle', slug: 'guide/mcp-bundle' },
            { label: 'Android 专版', slug: 'guide/android' },
            { label: '设置概览', slug: 'guide/settings' },
            { label: '故障排查', slug: 'guide/troubleshooting' },
          ],
        },
        {
          label: '插件开发',
          items: [
            { label: '开发总览', slug: 'dev/overview' },
            { label: '插件格式', slug: 'dev/format' },
            { label: 'Rhai 脚本', slug: 'dev/rhai-api' },
            { label: '爬虫后端选择', slug: 'dev/crawler-backends' },
            { label: '打包与发布', slug: 'dev/packaging' },
          ],
        },
        {
          label: '参考',
          items: [
            { label: '快捷键一览', slug: 'reference/shortcuts' },
            { label: '命令行工具', slug: 'reference/cli' },
            { label: 'MCP URI / 工具', slug: 'reference/mcp' },
            { label: '插件清单字段', slug: 'reference/plugin-schema' },
            { label: 'Rhai API 字典', slug: 'reference/rhai-dictionary' },
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
