<template>
    <div class="tip-article">
        <section class="section">
            <h3>原生模式 vs 窗口模式</h3>
            <p>Kabegame 提供两种壁纸显示模式：<strong>原生模式</strong>和<strong>窗口模式</strong>，各有优缺点。</p>

            <div class="mode-comparison">
                <div class="mode-card">
                    <h4>原生模式</h4>
                    <ul>
                        <li><strong>性能更好</strong>：直接使用系统 API 设置壁纸，资源占用低</li>
                        <li><strong>功能有限</strong>：受系统限制，过渡效果较少（仅支持无过渡和淡入淡出）</li>
                        <li><strong>兼容性好</strong>：所有系统都支持</li>
                        <li><strong>壁纸显示方式</strong>：根据系统支持显示可用样式（填充、适应、拉伸等）</li>
                    </ul>
                </div>

                <div class="mode-card">
                    <h4>窗口模式</h4>
                    <ul>
                        <li><strong>功能更灵活</strong>：类似 Wallpaper Engine，支持所有过渡效果</li>
                        <li><strong>性能稍差</strong>：需要创建一个透明窗口覆盖桌面，资源占用稍高</li>
                        <li><strong>仅 Windows</strong>：目前仅 Windows 系统支持</li>
                        <li><strong>壁纸显示方式</strong>：支持所有显示方式（填充、适应、拉伸、居中、平铺等）</li>
                    </ul>
                </div>
            </div>
        </section>

        <section class="section">
            <h3>如何切换模式</h3>
            <p>进入<strong>"设置" → "壁纸轮播"标签</strong>，找到<strong>"壁纸模式"</strong>选项：</p>
            <ul>
                <li>选择<strong>"原生模式"</strong>：使用系统 API 设置壁纸（推荐：性能好）</li>
                <li>选择<strong>"窗口模式"</strong>：使用透明窗口显示壁纸（推荐：功能更丰富）</li>
            </ul>
            <p>切换模式后，当前壁纸会立即重新应用，无需重启应用。</p>
            <TipImageCarousel v-if="modeSettingsImages.length > 0" :images="modeSettingsImages" />
        </section>

        <section class="section">
            <h3>过渡效果的区别</h3>
            <ul>
                <li><strong>原生模式</strong>：
                    <ul>
                        <li>仅支持<strong>无过渡</strong>和<strong>淡入淡出</strong></li>
                        <li>其他过渡效果（滑动、缩放等）在原生模式下不可用</li>
                    </ul>
                </li>
                <li><strong>窗口模式</strong>：
                    <ul>
                        <li>支持<strong>所有过渡效果</strong>：无过渡、淡入淡出、滑动、缩放等</li>
                        <li>过渡效果仅在<strong>轮播模式</strong>下生效（单张壁纸切换时）</li>
                    </ul>
                </li>
            </ul>
            <TipImageCarousel v-if="transitionImages.length > 0" :images="transitionImages" />
        </section>

        <section class="section">
            <h3>选择建议</h3>
            <ul>
                <li><strong>追求性能</strong>：选择原生模式，资源占用低，适合大部分电脑</li>
                <li><strong>追求效果</strong>：选择窗口模式，支持更多过渡效果，体验更丰富</li>
                <li><strong>仅使用单张壁纸</strong>：两种模式差异不大，原生模式更省资源</li>
                <li><strong>使用轮播</strong>：窗口模式可以体验更多过渡效果</li>
            </ul>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 模式设置示例图片
// 图片路径：/help-images/wallpaper/mode-settings-*.png
const modeSettingsImages = ref<TipImage[]>([]);

// 过渡效果示例图片
// 图片路径：/help-images/wallpaper/transition-*.png
const transitionImages = ref<TipImage[]>([]);
</script>

<style scoped lang="scss">
.tip-article {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.section {
    padding: 10px 0;
    border-bottom: 1px solid var(--anime-border);

    &:last-child {
        border-bottom: none;
    }

    h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
        font-weight: 800;
        color: var(--anime-text-primary);
    }

    h4 {
        margin: 0 0 6px 0;
        font-size: 13px;
        font-weight: 700;
        color: var(--anime-primary);
    }

    p {
        margin: 0 0 8px 0;
        color: var(--anime-text-primary);
        font-size: 13px;
        line-height: 1.7;
    }

    ul {
        margin: 8px 0;
        padding-left: 20px;
        color: var(--anime-text-primary);
        font-size: 13px;
        line-height: 1.7;

        li {
            margin: 4px 0;

            strong {
                color: var(--anime-primary);
                font-weight: 600;
            }

            ul {
                margin: 4px 0;
                padding-left: 18px;
            }
        }
    }
}

.mode-comparison {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin: 12px 0;
}

.mode-card {
    padding: 12px;
    border-radius: 8px;
    border: 1px solid var(--anime-border);
    background: rgba(255, 255, 255, 0.3);

    h4 {
        margin: 0 0 8px 0;
        font-size: 13px;
        font-weight: 700;
        color: var(--anime-primary);
    }

    ul {
        margin: 0;
        padding-left: 20px;
        font-size: 12px;
        line-height: 1.6;

        li {
            margin: 3px 0;
        }
    }
}

@media (max-width: 720px) {
    .mode-comparison {
        grid-template-columns: 1fr;
    }
}
</style>
