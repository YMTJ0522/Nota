<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { store } from '@/store'
import { marked } from 'marked'

const { state } = store

const editor = ref<HTMLTextAreaElement | null>(null)
const mode = ref<'write' | 'read'>('write')
const html = ref('')

marked.setOptions({ gfm: true, breaks: true })

function render() {
  html.value = marked.parse(state.draft, { async: false }) as string
}

watch(
  () => state.draft,
  () => {
    render()
    // 输入即自动存（防抖 600ms）
    scheduleSave()
  },
  { immediate: true }
)

let timer: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    store.saveNote()
  }, 600)
}

function onInput(e: Event) {
  state.draft = (e.target as HTMLTextAreaElement).value
}

/** Tab 插入两个空格，而不是切换焦点 */
function onTab(e: KeyboardEvent) {
  e.preventDefault()
  const el = e.target as HTMLTextAreaElement
  const { selectionStart: s, selectionEnd: en, value } = el
  state.draft = value.slice(0, s) + '  ' + value.slice(en)
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = s + 2
  })
}

/** 列表续行：回车自动补 - 或 1. */
function onEnter(e: KeyboardEvent) {
  const el = e.target as HTMLTextAreaElement
  const { selectionStart: s, value } = el
  const lineStart = value.lastIndexOf('\n', s - 1) + 1
  const line = value.slice(lineStart, s)
  const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
  if (!m) return
  if (m[3].trim() === '') return
  e.preventDefault()
  const bullet = /^\d+\.$/.test(m[2]) ? `${parseInt(m[2]) + 1}.` : m[2]
  const insert = `\n${m[1]}${bullet} `
  state.draft = value.slice(0, s) + insert + value.slice(el.selectionEnd)
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = s + insert.length
  })
}

onMounted(() => {
  render()
  editor.value?.focus()
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

// 切换笔记时把滚动位置归零
watch(
  () => state.activePath,
  () => {
    if (editor.value) editor.value.scrollTop = 0
    editor.value?.focus()
  }
)
</script>

<template>
  <div class="pane">
    <div class="tabs">
      <button :class="{ on: mode === 'write' }" @click="mode = 'write'">编辑</button>
      <button :class="{ on: mode === 'read' }" @click="mode = 'read'">预览</button>
      <span class="spacer" />
      <span class="stat">{{ state.draft.length }} 字</span>
    </div>

    <textarea
      v-if="mode === 'write'"
      ref="editor"
      class="editor"
      :value="state.draft"
      placeholder="开始写点什么…"
      spellcheck="false"
      @input="onInput"
      @keydown.tab="onTab"
      @keydown.enter="onEnter"
    />

    <div v-else class="preview" v-html="html" />
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
  height: 36px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--n-line);
}

.tabs button {
  height: 24px;
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

.editor {
  flex: 1;
  width: 100%;
  padding: 32px 48px;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: var(--n-font-ui);
  font-size: var(--n-fs-body);
  line-height: var(--n-lh);
  color: var(--n-fg);
  user-select: text;
  overflow-y: auto;
  caret-color: var(--n-accent);
}

.editor::placeholder {
  color: var(--n-fg-faint);
}

.preview {
  flex: 1;
  padding: 32px 48px;
  overflow-y: auto;
  user-select: text;
  line-height: var(--n-lh);
}

/* ── 预览排版 ── */
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
