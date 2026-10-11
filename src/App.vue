<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { store } from '@/store'
import TitleBar from '@/components/TitleBar.vue'
import SidePanel from '@/components/SidePanel.vue'
import NoteListPanel from '@/components/NoteListPanel.vue'
import EditorPane from '@/components/EditorPane.vue'
import AiChatPanel from '@/components/AiChatPanel.vue'
import WelcomeView from '@/components/WelcomeView.vue'
import AttachDialog from '@/components/AttachDialog.vue'
import TrashDialog from '@/components/TrashDialog.vue'
import ToastHost from '@/components/ToastHost.vue'

const { state } = store

/** 附件库与回收站是两个独立窗口，各自一个开合状态（见各自的组件注释） */
const attachOpen = ref(false)
const trashOpen = ref(false)

function onLibrary(e: Event) {
  const which = (e as CustomEvent<'attach' | 'trash'>).detail
  if (which === 'trash') trashOpen.value = true
  else attachOpen.value = true
}

/** 库里有增删（删了附件 / 恢复了笔记 / 清空了回收站），侧栏的计数要跟着变 */
function closeLibrary() {
  attachOpen.value = false
  trashOpen.value = false
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
      <!-- 列表栏只在「笔记」视图里有意义：AI 编写页没有笔记可列 -->
      <NoteListPanel v-if="state.root && state.mainView === 'note' && state.list" />
      <main class="main">
        <WelcomeView v-if="!state.root" />
        <AiChatPanel v-else-if="state.mainView === 'ai'" />
        <EditorPane v-else-if="state.activePath" />
        <div v-else class="idle">
          <p>从左侧选一篇笔记，或者<button class="link" @click="store.newNote()">新建一篇</button></p>
        </div>
      </main>
    </div>

    <AttachDialog :open="attachOpen" @close="closeLibrary" />
    <TrashDialog :open="trashOpen" @close="closeLibrary" />

    <!-- 全应用共用的轻提示：把各处抛出的 nota:toast 接住 -->
    <ToastHost />
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
