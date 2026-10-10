<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick, computed } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { store } from '@/store'
import { baseExtensions } from '@/editor/setup'
import { notaThemeExtensions } from '@/editor/theme'
import { countWords, formatWordCount } from '@/editor/word-count'
import { createSlashCommandsExtension } from '@/editor/slash-commands'
import type { SlashMenuRenderState, SlashCommandId } from '@/editor/slash-commands'
import Toolbar from '@/components/Toolbar.vue'
import SlashMenu from '@/components/SlashMenu.vue'
import {
  toolbarInline,
  toolbarBlockPrefix,
  toolbarHeading,
  toolbarCodeBlock,
  toolbarTable,
  toolbarMermaid,
  toolbarFrontMatter,
  toolbarHorizontalRule,
  toolbarMathBlock,
} from '@/editor/toolbar-commands'

const { state } = store

const host = ref<HTMLDivElement | null>(null)
const mode = ref<'write' | 'read'>('write')
const html = ref('')
const slash = ref<SlashMenuRenderState | null>(null)

let view: EditorView | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** 防止把程序化写入回灌成用户输入 */
let syncing = false

/** 字数统计直接从 draft 派生，避免手动同步漏更新 */
const statText = computed(() => formatWordCount(countWords(state.draft)))

/** 预览（阅读模式） */
let markedMod: typeof import('marked') | null = null
async function render() {
  if (!markedMod) {
    markedMod = await import('marked')
    markedMod.marked.setOptions({ gfm: true, breaks: true })
  }
  html.value = markedMod.marked.parse(state.draft, { async: false }) as string
}

/* ── 自动保存 ── */
function scheduleSave() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => store.saveNote(), 600)
}

/* ── 斜杠命令 → 具体动作 ── */
function runSlashFormat(id: SlashCommandId, v: EditorView) {
  switch (id) {
    case 'heading1': toolbarHeading(v, 1); break
    case 'heading2': toolbarHeading(v, 2); break
    case 'heading3': toolbarHeading(v, 3); break
    case 'bold': toolbarInline(v, 'bold'); break
    case 'italic': toolbarInline(v, 'italic'); break
    case 'bulletList': toolbarBlockPrefix(v, 'bullet'); break
    case 'numberedList': toolbarBlockPrefix(v, 'ordered'); break
    case 'taskList': toolbarBlockPrefix(v, 'task'); break
    case 'quote': toolbarBlockPrefix(v, 'quote'); break
    case 'codeBlock': toolbarCodeBlock(v); break
    case 'table': toolbarTable(v, '| 列 1 | 列 2 | 列 3 |'); break
    case 'divider': toolbarHorizontalRule(v); break
    default: break
  }
}

async function runSlashAi(_id: SlashCommandId, _v: EditorView) {
  // AI 能力属于后续里程碑，先在 UI 上给出明确反馈
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: 'AI 命令尚未接入，敬请期待' }))
}

/* ── 创建 / 销毁编辑器 ── */
function createEditor() {
  if (!host.value) return

  const extensions = [
    ...baseExtensions({
      placeholder: '开始写点什么… / 唤出命令',
      onDocChanged: (doc) => {
        if (syncing) return
        state.draft = doc
        scheduleSave()
      },
    }),
    ...notaThemeExtensions,
    ...createSlashCommandsExtension({
      onStateChange: (s) => { slash.value = s },
      onExecuteFormat: runSlashFormat,
      onExecuteAi: runSlashAi,
    }),
  ]

  view = new EditorView({
    state: EditorState.create({ doc: state.draft, extensions }),
    parent: host.value,
  })

  // 供自动化验证脚本访问（无副作用，不参与业务逻辑）
  ;(window as unknown as { __notaView?: EditorView | null }).__notaView = view
}

/** 外部改动了 draft（切笔记等），把内容灌进 CM */
function pushDoc(text: string) {
  if (!view) return
  const current = view.state.doc.toString()
  if (current === text) return
  syncing = true
  view.dispatch({
    changes: { from: 0, to: current.length, insert: text },
    selection: { anchor: 0 },
  })
  syncing = false
}

onMounted(() => {
  render()
  nextTick(() => {
    createEditor()
    // 笔记内容可能晚于组件挂载到达，这里补一次同步
    pushDoc(state.draft)
  })
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  view?.destroy()
  view = null
  ;(window as unknown as { __notaView?: EditorView | null }).__notaView = null
})

// 切笔记：activePath 变化时把 draft 灌进 CM。
// draft 的赋值发生在 openNote 的 await 之后，所以同时监听 draft，
// 只要 CM 里的内容和 draft 不一致就同步（用户输入路径由 syncing 挡住）。
watch(
  () => state.activePath,
  async () => {
    render()
    await nextTick()
    pushDoc(state.draft)
    view?.focus()
  }
)

// 阅读模式：销毁编辑器省内存；返回编辑模式再重建
watch(mode, async (m) => {
  if (m === 'read') {
    view?.destroy()
    view = null
    await render()
  } else {
    await nextTick()
    createEditor()
    pushDoc(state.draft)
  }
})

/** 工具栏调用入口：把 EditorView 暴露给子组件 */
defineExpose({ getView: () => view })
</script>

<template>
  <div class="pane">
    <Toolbar v-if="mode === 'write'" :get-view="() => view" />

    <div class="tabs">
      <button :class="{ on: mode === 'write' }" @click="mode = 'write'">编辑</button>
      <button :class="{ on: mode === 'read' }" @click="mode = 'read'">预览</button>
      <span class="spacer" />
      <span class="stat">{{ statText }}</span>
    </div>

    <div class="stage">
      <div
        v-show="mode === 'write'"
        ref="host"
        class="host"
      />
      <div v-if="mode === 'read'" class="preview" v-html="html" />

      <SlashMenu
        v-if="slash && mode === 'write'"
        :state="slash"
        @pick="(id: SlashCommandId) => {
          const v = view
          if (!v) return
          // 菜单已由扩展关闭，这里只负责执行
          if (id.startsWith('ai')) runSlashAi(id, v)
          else runSlashFormat(id, v)
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tabs {
  flex: none;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--n-line);
}

.tabs button {
  height: 22px;
  padding: 0 10px;
  font-size: 12.5px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.tabs button:hover {
  color: var(--n-fg);
  background: var(--n-surface);
}

.tabs button.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
  font-weight: 500;
}

.spacer {
  flex: 1;
}

.stat {
  font-size: 11.5px;
  color: var(--n-fg-faint);
  font-variant-numeric: tabular-nums;
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.host {
  flex: 1;
  min-height: 0;
  user-select: text;
  overflow: hidden;
}

/* ── 预览排版 ── */
.preview {
  flex: 1;
  padding: 32px 48px;
  overflow-y: auto;
  user-select: text;
  line-height: var(--n-lh);
  max-width: calc(var(--n-measure) + 96px);
  margin: 0 auto;
  width: 100%;
}

.preview :deep(h1),
.preview :deep(h2),
.preview :deep(h3),
.preview :deep(h4) {
  line-height: 1.35;
  margin: 1.6em 0 0.6em;
  font-weight: 600;
}
.preview :deep(h1) {
  font-size: 1.7em;
  margin-top: 0;
}
.preview :deep(h2) {
  font-size: 1.35em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--n-line);
}
.preview :deep(h3) {
  font-size: 1.15em;
}
.preview :deep(p) {
  margin: 0.8em 0;
}
.preview :deep(a) {
  color: var(--n-accent);
  text-underline-offset: 3px;
}
.preview :deep(code) {
  font-family: var(--n-font-mono);
  font-size: 0.88em;
  padding: 0.15em 0.4em;
  border-radius: 4px;
  background: var(--n-surface);
}
.preview :deep(pre) {
  padding: 14px 16px;
  border-radius: var(--n-r-md);
  background: var(--n-surface);
  overflow-x: auto;
}
.preview :deep(pre code) {
  padding: 0;
  background: none;
}
.preview :deep(blockquote) {
  margin: 1em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--n-accent-soft);
  color: var(--n-fg-dim);
}
.preview :deep(ul),
.preview :deep(ol) {
  padding-left: 1.4em;
  margin: 0.8em 0;
}
.preview :deep(li) {
  margin: 0.3em 0;
}
.preview :deep(hr) {
  border: none;
  border-top: 1px solid var(--n-line);
  margin: 2em 0;
}
.preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
  font-size: 0.94em;
}
.preview :deep(th),
.preview :deep(td) {
  border: 1px solid var(--n-line);
  padding: 7px 11px;
  text-align: left;
}
.preview :deep(th) {
  background: var(--n-surface);
  font-weight: 600;
}
.preview :deep(img) {
  max-width: 100%;
  border-radius: var(--n-r-md);
}
</style>
