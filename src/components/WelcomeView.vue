<script setup lang="ts">
import { store } from '@/store'

const features = [
  ['纯本地', '文件躺在你自己的目录里，不联网、不上传'],
  ['Markdown', '源码即文件，随时能用别的工具打开'],
  ['轻', '没有插件市场，没有账号，没有云'],
]

function pick() {
  store.openWorkspace()
}
</script>

<template>
  <div class="welcome">
    <div class="inner">
      <div class="logo">
        <!-- 与 build/icon.svg 同一套语言：页面 + 折角 + 两条文字行。
            这里用细描边而非实心，跟应用内其它图标保持一致的克制感。 -->
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
  margin: 12px 0 36px;
  font-size: 12px;
  color: var(--n-fg-faint);
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
