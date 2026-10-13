<script setup lang="ts">
import { computed } from 'vue'
import { Folder } from 'lucide-vue-next'
import { store } from '@/store'

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
      <div class="logo">
        <!-- 与侧栏顶栏同一套记号：页面 + 折角 + 两条文字行。
             这里用细描边而非实心，跟应用内其它图标保持一致的克制感。
             （应用图标是那张奶油底手写体的位图，见 build/icon-source.png，
             不用在界面上：一张彩色位图放进正文里会跟这一页的描边语言打架。） -->
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 3.5A1.5 1.5 0 0 1 6.5 2h8L20 7.5v13A1.5 1.5 0 0 1 18.5 22h-12A1.5 1.5 0 0 1 5 20.5z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h4" />
        </svg>
      </div>

      <h1>Nota</h1>
      <p class="sub">一个只做笔记的笔记应用</p>

      <button class="cta" @click="pick">打开一个目录</button>
      <p class="tip">或者按 <kbd>Ctrl</kbd> + <kbd>O</kbd></p>

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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--n-r-lg);
  background: var(--n-accent-soft);
  color: var(--n-accent);
  margin-bottom: 18px;
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
  margin: 12px 0 30px;
  font-size: 12px;
  color: var(--n-fg-faint);
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
