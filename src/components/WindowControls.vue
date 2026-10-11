<script setup lang="ts">
/**
 * 窗口控制按钮：最小化 / 最大化 / 关闭。
 *
 * 以前它们住在一条横贯整窗的标题栏里，那条栏同时还得放应用名和当前文件名 ——
 * 结果是三栏的顶部都被这一条压住，侧栏和编辑区各自没有自己的头部。
 * 现在顶部按区域划分（侧栏 / 中间栏 / 右侧各有一条自己的顶栏），
 * 于是按钮从那条全局栏里摘出来，跟着右侧编辑区走，落在它顶行最右边。
 *
 * 自绘窗口（frame: false）离不开这三颗，所以它是独立组件，
 * 欢迎页那种「还没有工作区」的空态也能直接摆上。
 */
import { ref, onMounted } from 'vue'

const maximized = ref(false)

onMounted(() => {
  window.api?.onMaximizeChange?.((v) => (maximized.value = v))
})

const winMinimize = () => window.api.minimize()
const winMaximize = () => window.api.toggleMaximize()
const winClose = () => window.api.closeWindow()
</script>

<template>
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
</template>

<style scoped>
.wctl {
  flex: none;
  display: flex;
  align-items: stretch;
  align-self: stretch;
  -webkit-app-region: no-drag;
}

.wbtn {
  width: 42px;
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
