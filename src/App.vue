<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { store } from '@/store'
import TitleBar from '@/components/TitleBar.vue'
import SidePanel from '@/components/SidePanel.vue'
import EditorPane from '@/components/EditorPane.vue'
import AiChatPanel from '@/components/AiChatPanel.vue'
import WelcomeView from '@/components/WelcomeView.vue'
import LibraryDialog from '@/components/LibraryDialog.vue'

const { state } = store

/** 附件库 + 回收站：由侧边栏抛事件打开，detail 决定停在哪个页签 */
const libraryOpen = ref(false)
const libraryTab = ref<'attach' | 'trash'>('attach')

function onLibrary(e: Event) {
  const tab = (e as CustomEvent<'attach' | 'trash'>).detail
  libraryTab.value = tab === 'trash' ? 'trash' : 'attach'
  libraryOpen.value = true
}

function closeLibrary() {
  libraryOpen.value = false
  // 库里可能删了附件或清了回收站，侧栏的计数要跟着变
  window.dispatchEvent(new CustomEvent('nota:library-changed'))
}

// AI 入口被关掉时不能停在聊天页——那样既出不去也进不来
watch(
  () => [state.ai.enabled, state.mainView] as const,
  ([enabled, view]) => {
    if (!enabled && view === 'ai') store.setMainView('note')
  },
  { immediate: true },
)

function onKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return

  if (e.key === 's') {
    e.preventDefault()
    store.saveNote()
  } else if (e.key === 'n') {
    e.preventDefault()
    store.newNote()
  } else if (e.key === 'o') {
    e.preventDefault()
    store.openWorkspace()
  } else if (e.key === '\\') {
    // 侧边栏折叠/展开
    e.preventDefault()
    store.toggleSidebar()
  }
}

onMounted(() => {
  store.initTheme()
  store.initPrefs()
  window.addEventListener('keydown', onKey)
  window.addEventListener('nota:library', onLibrary)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('nota:library', onLibrary)
})
</script>

<template>
  <div class="shell">
    <TitleBar />
    <div class="body">
      <SidePanel v-if="state.root" />
      <main class="main">
        <WelcomeView v-if="!state.root" />
        <AiChatPanel v-else-if="state.mainView === 'ai'" />
        <EditorPane v-else-if="state.activePath" />
        <div v-else class="idle">
          <p>从左侧选一篇笔记，或者<button class="link" @click="store.newNote()">新建一篇</button></p>
        </div>
      </main>
    </div>

    <LibraryDialog :open="libraryOpen" :tab="libraryTab" @close="closeLibrary" />
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--n-bg);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--n-bg);
}

.idle {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--n-fg-dim);
  font-size: 14px;
}

.link {
  color: var(--n-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
  padding: 0 2px;
}
</style>
