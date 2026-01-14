<template>
  <div class="tip-article">
    <section class="section">
      <h3>入口：源管理</h3>
      <p>在侧边栏进入 <strong>源管理</strong> 页面，这里集中管理“源插件”（爬虫/导入等功能的来源）。</p>
    </section>

    <section class="section">
      <h3>已安装源 vs 商店源</h3>
      <ul>
        <li><strong>已安装源</strong>：你当前已经安装好的源插件列表，可在这里查看/卸载。</li>
        <li><strong>商店源</strong>：按“源名称”分 tab 展示远程可安装列表；支持安装/更新到本地。</li>
      </ul>
    </section>

    <section class="section">
      <h3>添加商店源（index.json）</h3>
      <p>源管理页面底部有一个 <strong>添加源</strong> 的 tab，用来添加“商店源”。</p>
      <p>商店源本质上是一个可访问的 <code>index.json</code> 地址（推荐指向 GitHub Releases 资产直链）。</p>
      <el-alert class="note" type="info" show-icon :closable="false">
        添加后会在顶部自动出现对应的商店 tab；进入该 tab 时会懒加载拉取该源的插件列表。
      </el-alert>
    </section>

    <section class="section">
      <h3>安装/更新插件</h3>
      <p>在某个商店源 tab 里选择插件进行安装/更新，安装成功后会同步到“已安装源”。</p>
      <p>如果你已经导入过某个插件（.kgpg），商店也会显示其已安装版本信息（用于判断是否需要更新）。</p>
    </section>

    <section class="section">
      <h3>插件编辑器</h3>
      <p>源管理页右上角有 <strong>插件编辑器</strong> 按钮，用于开发/调试插件。</p>
    </section>
  </div>
</template>

<style scoped lang="scss">
.tip-article {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section {
  padding: 10px 0;
  border-bottom: 1px solid var(--anime-border);

  h3 {
    margin: 0 0 8px 0;
    font-size: 14px;
    font-weight: 800;
    color: var(--anime-text-primary);
  }

  p {
    margin: 0 0 8px 0;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
  }

  ul {
    margin: 0 0 8px 18px;
    padding: 0;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
  }

  code {
    padding: 1px 6px;
    border-radius: 6px;
    border: 1px solid var(--anime-border);
    background: rgba(255, 255, 255, 0.5);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
  }
}

.note {
  margin-top: 6px;
}
</style>

