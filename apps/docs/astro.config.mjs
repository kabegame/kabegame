import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://kabegame.com',
  redirects: {
    '/guide/shortcuts': '/reference/shortcuts/',
    '/guide/command-line': '/reference/cli/',
    // Rhai 后端已移除，旧脚本文档重定向到 V8 对应页
    '/dev/rhai-api': '/dev/v8-api/',
    '/reference/rhai-dictionary': '/reference/kabegame-api/',
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
            { label: '爬虫后端选择', slug: 'dev/crawler-backends' },
            { label: 'V8 脚本', slug: 'dev/v8-api' },
            { label: 'WebView 脚本', slug: 'dev/webview-api' },
            { label: 'plugin-sdk 工具库', slug: 'dev/plugin-sdk' },
            { label: '插件格式', slug: 'dev/format' },
            { label: '打包与发布', slug: 'dev/packaging' },
          ],
        },
        {
          label: '参与开发',
          items: [
            { label: '从源码构建', slug: 'dev-contrib/building' },
            { label: 'Android 开发', slug: 'dev-contrib/android-build' },
            { label: '架构与项目结构', slug: 'dev-contrib/architecture' },
            { label: '致谢与内嵌依赖', slug: 'dev-contrib/acknowledgements' },
          ],
        },
        {
          label: '参考',
          items: [
            { label: '快捷键一览', slug: 'reference/shortcuts' },
            { label: '命令行工具', slug: 'reference/cli' },
            { label: 'MCP URI / 工具', slug: 'reference/mcp' },
            { label: '插件清单字段', slug: 'reference/plugin-schema' },
            { label: 'Kabegame API 字典', slug: 'reference/kabegame-api' },
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
