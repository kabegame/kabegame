// UnoCSS 按 cwd 查找本文件。vitest 以本包为 cwd 运行（见 vitest.config.ts），
// 没有它就会每次刷一行 config-not-found 并退回默认配置；将来在这里写组件测试时，
// 也需要它来保证类名解析与应用一致。内容与 apps/kabegame/uno.config.ts 同源。
import config from "../../uno.config.pub";
export default config;
