# 示例插件

这是一个用于测试的示例插件。

## 文件结构

```
sample-collector/
├── manifest.json    # 插件元数据
├── config.json      # 插件配置
├── doc.md          # 用户文档
└── README.md       # 开发文档
```

## 打包

使用以下命令打包插件：

```bash
npm run package-plugin test_plugin/sample-collector
```

打包后的文件将生成在 `test_plugin/sample-collector.kgpg`

