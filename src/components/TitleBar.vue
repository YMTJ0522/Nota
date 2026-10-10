<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { store } from '@/store'

const { state, dirty, activeName } = store
const maximized = ref(false)

onMounted(() => {
  window.api?.onMaximizeChange?.((v) => (maximized.value = v))
})

function toggleTheme() {
  store.setTheme(state.theme === 'light' ? 'dark' : 'light')
}

const winMinimize = () => window.api.minimize()
const winMaximize = () => window.api.toggleMaximize()
const winClose = () => window.api.closeWindow()
</script>

<template>
  <header class="bar">
    <div class="left">
      <span class="mark">Nota</span>
      <span v-if="state.activePath" class="sep">/</span>
      <span v-if="state.activePath" class="file">
        {{ activeName }}<span v-if="dirty" class="dot" title="未保存">•</span>
      </span>
    </div>

    <div class="right">
      <button
        class="icon"
        :title="state.theme === 'light' ? '切到深色' : '切到浅色'"
        @click="toggleTheme"
      >
        <svg v-if="state.theme === 'light'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      </button>

      <button v-if="state.root" class="icon" title="保存 (Ctrl+S)" @click="store.saveNote()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <path d="M17 21v-8H7v8M7 3v5h8" />
        </svg>
      </button>

      <button class="icon" title="打开目录 (Ctrl+O)" @click="store.openWorkspace()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </button>

      <!-- 窗口控制：完全自绘 -->
      <div class="wctl">
        <button class="wbtn" title="最小化" @click="winMinimize()">
          <svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.2">
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        </button>
        <button class="wbtn" :title="maximized ? '还原' : '最大化'" @click="winMaximize()">
          <svg v-if="!maximized" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
          </svg>
          <svg v-else width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="2.5" y="4" width="5.5" height="5.5" rx="1" />
            <path d="M4.5 4V3a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H8" />
          </svg>
        </button>
        <button class="wbtn danger" title="关闭" @click="winClose()">
          <svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
            <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
            <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
          </svg>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.bar {
  height: var(--n-titlebar);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 0 16px;
  background: var(--n-surface);
  border-bottom: 1px solid var(--n-line);
  -webkit-app-region: drag;
}

.left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.right {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 100%;
}

.mark {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--n-fg);
}

.sep {
  color: var(--n-fg-faint);
  font-size: 13px;
}

.file {
  font-size: 13px;
  color: var(--n-fg-dim);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot {
  color: var(--n-accent);
  font-size: 16px;
  line-height: 1;
}

.icon {
  -webkit-app-region: no-drag;
  width: 30px;
  height: 30px;
  margin-right: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.icon:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.icon:active {
  transform: scale(0.96);
}

/* ── 窗口控制按钮 ── */
.wctl {
  display: flex;
  align-items: stretch;
  height: 100%;
  margin-left: 6px;
}

.wbtn {
  -webkit-app-region: no-drag;
  width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.wbtn:hover {
  background: var(--n-bg);
  color: var(--n-fg);
}

.wbtn.danger:hover {
  background: #d9534f;
  color: #fff;
}
</style>
