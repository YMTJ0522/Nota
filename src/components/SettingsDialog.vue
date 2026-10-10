<script setup lang="ts">
import { X, Sun, Moon, Monitor } from 'lucide-vue-next'
import { store } from '@/store'

/**
 * 设置面板。
 *
 * 只放真正生效的项，不留空白选项——设置里出现「点了没反应」的开关
 * 比没有设置更伤信任。目前三项：主题、自动保存、侧栏。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { state } = store

const themes = [
  { id: 'light' as const, label: '浅色', Icon: Sun },
  { id: 'dark' as const, label: '深色', Icon: Moon },
]
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="st-mask" @click.self="emit('close')">
      <div class="st" role="dialog" aria-modal="true" aria-label="设置">
        <header class="st-head">
          <span class="st-title">设置</span>
          <button class="st-x" title="关闭" @click="emit('close')">
            <X :size="15" :stroke-width="1.9" />
          </button>
        </header>

        <div class="st-body">
          <!-- 外观 -->
          <section class="st-sec">
            <h4 class="st-h">外观</h4>
            <div class="st-row">
              <div class="st-label">
                <span class="st-name">主题</span>
                <span class="st-desc">浅色适合白天，深色适合夜间写作</span>
              </div>
              <div class="st-seg" role="radiogroup" aria-label="主题">
                <button
                  v-for="t in themes"
                  :key="t.id"
                  class="st-seg-btn"
                  role="radio"
                  :aria-checked="state.theme === t.id"
                  :class="{ on: state.theme === t.id }"
                  @click="store.setTheme(t.id)"
                >
                  <component :is="t.Icon" :size="13" :stroke-width="1.9" />
                  <span>{{ t.label }}</span>
                </button>
              </div>
            </div>
          </section>

          <!-- 编辑 -->
          <section class="st-sec">
            <h4 class="st-h">编辑</h4>

            <div class="st-row">
              <div class="st-label">
                <span class="st-name">自动保存</span>
                <span class="st-desc">停止输入后自动写入磁盘</span>
              </div>
              <button
                class="st-switch"
                role="switch"
                :aria-checked="state.autoSave"
                :class="{ on: state.autoSave }"
                @click="store.setAutoSave(!state.autoSave)"
              >
                <span class="st-knob" />
              </button>
            </div>

            <div class="st-row">
              <div class="st-label">
                <span class="st-name">显示侧边栏</span>
                <span class="st-desc">左侧的资料库目录树</span>
              </div>
              <button
                class="st-switch"
                role="switch"
                :aria-checked="state.sidebar"
                :class="{ on: state.sidebar }"
                @click="store.toggleSidebar()"
              >
                <span class="st-knob" />
              </button>
            </div>
          </section>

          <!-- 快捷键 -->
          <section class="st-sec">
            <h4 class="st-h">快捷键</h4>
            <div class="st-keys">
              <div class="st-key"><span>保存</span><kbd>Ctrl + S</kbd></div>
              <div class="st-key"><span>新建笔记</span><kbd>Ctrl + N</kbd></div>
              <div class="st-key"><span>打开目录</span><kbd>Ctrl + O</kbd></div>
              <div class="st-key"><span>编辑 / 分栏 / 预览</span><kbd>Ctrl + 1 / 2 / 3</kbd></div>
              <div class="st-key"><span>在本文中查找</span><kbd>Ctrl + F</kbd></div>
              <div class="st-key"><span>命令菜单</span><kbd>/</kbd></div>
            </div>
          </section>

          <section class="st-sec">
            <h4 class="st-h">关于</h4>
            <p class="st-about">
              Nota —— 一个轻量的本地 Markdown 笔记应用。<br />
              笔记就是普通的 <code>.md</code> 文件，直接放在你选的目录里。
            </p>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.st-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--n-mask);
  backdrop-filter: blur(2px);
  animation: st-fade 120ms var(--n-ease);
}

.st {
  width: 480px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  overflow: hidden;
  animation: st-in 140ms var(--n-ease);
}

.st-head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 18px;
  border-bottom: 1px solid var(--n-line);
}

.st-title {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--n-fg);
}

.st-x {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.st-x:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.st-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 18px 18px;
}

.st-sec {
  padding: 14px 0;
  border-bottom: 1px solid var(--n-line);
}

.st-sec:last-child {
  border-bottom: none;
}

.st-h {
  margin: 0 0 10px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--n-fg-faint);
}

.st-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
}

.st-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.st-name {
  font-size: 13px;
  color: var(--n-fg);
}

.st-desc {
  font-size: 11.5px;
  color: var(--n-fg-faint);
}

/* 主题：和顶栏视图切换同款的分段控件，保持语言一致 */
.st-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  border: 1px solid var(--n-line);
  flex: none;
}

.st-seg-btn {
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: var(--n-r-sm);
  font-size: 12.5px;
  color: var(--n-fg-dim);
}

.st-seg-btn svg {
  fill: none;
  stroke: currentColor;
}

.st-seg-btn:hover {
  color: var(--n-fg);
}

.st-seg-btn.on {
  background: var(--n-raised);
  color: var(--n-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

/* 开关 */
.st-switch {
  flex: none;
  width: 38px;
  height: 22px;
  padding: 2px;
  border-radius: 999px;
  background: var(--n-line);
  transition: background var(--n-dur) var(--n-ease);
}

.st-switch.on {
  background: var(--n-accent);
}

.st-knob {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
  transition: transform var(--n-dur) var(--n-ease);
}

.st-switch.on .st-knob {
  transform: translateX(16px);
}

/* 快捷键表 */
.st-keys {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.st-key {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 0;
  font-size: 12.5px;
  color: var(--n-fg-dim);
}

.st-key kbd {
  font-family: var(--n-font-mono);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--n-bg);
  border: 1px solid var(--n-line);
  color: var(--n-fg-faint);
}

.st-about {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--n-fg-dim);
}

.st-about code {
  font-family: var(--n-font-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--n-code-bg);
  color: var(--n-code-fg);
}

@keyframes st-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes st-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
</style>
