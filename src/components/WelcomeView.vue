<script setup lang="ts">
import { computed, ref } from 'vue'
import { CircleHelp, Folder } from 'lucide-vue-next'
import { store } from '@/store'
import appIcon from '@/assets/app-icon.png'
import GuideDialog from '@/components/GuideDialog.vue'

/**
 * 首屏是新人唯一一定会看见的地方，所以指南在这里留一个入口。
 * 不做「首次自动弹出」：他这会儿连目录都没开，弹一页说明书只会挡住「打开一个目录」。
 */
const guideOpen = ref(false)

const features = [
  ['纯本地', '文件躺在你自己的目录里，不联网、不上传'],
  ['Markdown', '源码即文件，随时能用别的工具打开'],
  ['轻', '没有插件市场，没有账号，没有云'],
]

const { state } = store

/** 最近打开过的文件夹。首屏就能直接进去，不用每次从盘符开始点 */
const roots = computed(() => state.recentRoots)

function tail(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function pick() {
  store.openWorkspace()
}

async function pickRoot(dir: string) {
  await store.switchWorkspace(dir)
}
</script>

<template>
  <div class="welcome">
    <div class="inner">
      <!-- 首屏这枚标用**应用图标本身**（奶油底手写体那张）。
           它够大（52px）不会糊，而这里是人第一次看到这个应用的地方，
           应当让他一眼认出「这就是我在桌面点开的那个东西」。
           侧栏顶栏仍留描边版 —— 那儿只有 18px，位图会糊成一格色块。 -->
      <img class="logo" :src="appIcon" width="52" height="52" alt="Nota" />

      <h1>Nota</h1>
      <p class="sub">一个只做笔记的笔记应用</p>

      <button class="cta" @click="pick">打开一个目录</button>
      <p class="tip">或者按 <kbd>Ctrl</kbd> + <kbd>O</kbd></p>

      <button class="howto" @click="guideOpen = true">
        <CircleHelp :size="12" :stroke-width="1.9" />
        <span>第一次用？看看各个区域是干什么的</span>
      </button>

      <!-- 最近打开过的文件夹。
           侧栏底部也有同一份列表，但那儿得先开着一个工作区才看得见 ——
           首屏是最需要它的时候（不想每次都从盘符开始点）。 -->
      <div v-if="roots.length" class="recent">
        <span class="recent-label">最近打开</span>
        <div class="recent-list">
          <button v-for="d in roots" :key="d" class="recent-item" :title="d" @click="pickRoot(d)">
            <Folder :size="12" :stroke-width="1.9" />
            <span>{{ tail(d) }}</span>
          </button>
        </div>
      </div>

      <ul class="feats">
        <li v-for="[t, d] in features" :key="t">
          <strong>{{ t }}</strong>
          <span>{{ d }}</span>
        </li>
      </ul>
    </div>

    <GuideDialog :open="guideOpen" @close="guideOpen = false" />
  </div>
</template>

<style scoped>
.welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.inner {
  width: 100%;
  max-width: 380px;
  text-align: center;
}

.logo {
  display: block;
  width: 52px;
  height: 52px;
  margin: 0 auto 16px;
  border-radius: var(--n-r-lg);
}

h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.sub {
  margin: 6px 0 28px;
  font-size: 13.5px;
  color: var(--n-fg-dim);
}

.cta {
  height: 38px;
  padding: 0 22px;
  border-radius: var(--n-r-md);
  background: var(--n-accent);
  color: var(--n-on-accent);
  font-size: 13.5px;
  font-weight: 500;
  transition: opacity var(--n-dur) var(--n-ease), transform var(--n-dur) var(--n-ease);
}

.cta:hover {
  opacity: 0.9;
}

.cta:active {
  transform: scale(0.985);
}

.tip {
  margin: 12px 0 14px;
  font-size: 12px;
  color: var(--n-fg-faint);
}

/* 指向使用指南的那一行。做成低调的文字按钮而不是第二枚实心按钮：
   首屏只该有一个「下一步」，其余都是旁支。 */
.howto {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 26px;
  padding: 2px 2px;
  font-size: 12px;
  color: var(--n-fg-faint);
  border-radius: var(--n-r-sm);
  transition: color var(--n-dur) var(--n-ease);
}

.howto svg {
  fill: none;
  stroke: currentColor;
}

.howto:hover {
  color: var(--n-accent);
}

/* ── 最近打开 ── */
.recent {
  margin: 0 0 30px;
  text-align: left;
}

.recent-label {
  display: block;
  margin-bottom: 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--n-fg-faint);
}

.recent-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.recent-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--n-line);
  border-radius: 999px;
  background: var(--n-surface);
  font-size: 12px;
  color: var(--n-fg-dim);
  transition: border-color var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.recent-item svg {
  flex: none;
  fill: none;
  stroke: currentColor;
  color: var(--n-accent);
}

.recent-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-item:hover {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

kbd {
  font-family: var(--n-font-mono);
  font-size: 11px;
  padding: 1px 5px;
  border: 1px solid var(--n-line-strong);
  border-radius: 4px;
  background: var(--n-surface);
}

.feats {
  list-style: none;
  margin: 0;
  padding: 0;
  text-align: left;
  border-top: 1px solid var(--n-line);
}

.feats li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 11px 2px;
  border-bottom: 1px solid var(--n-line);
  font-size: 12.5px;
}

.feats strong {
  flex: none;
  width: 72px;
  font-weight: 500;
  color: var(--n-fg);
}

.feats span {
  color: var(--n-fg-dim);
}
</style>
