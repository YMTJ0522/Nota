<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick, computed } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  /* 顶部区域与 inkstone 对齐：标题可编辑、右侧一段式视图切换。
     图标同样取自 Lucide（ISC），不碰 inkstone 的 LGPL 源码。 */
  Pencil,
  Columns2,
  Eye,
} from 'lucide-vue-next'
import { store } from '@/store'
import { baseExtensions } from '@/editor/setup'
import { notaThemeExtensions } from '@/editor/theme'
import { countWords, formatWordCount } from '@/editor/word-count'
import { createSlashCommandsExtension } from '@/editor/slash-commands'
import type { SlashMenuRenderState, SlashCommandId } from '@/editor/slash-commands'
import { highlightCode, langFromClass } from '@/editor/highlight-code'
import Toolbar from '@/components/Toolbar.vue'
import SlashMenu from '@/components/SlashMenu.vue'
import {
  toolbarInline,
  toolbarWrap,
  toolbarInlineCode,
  toolbarBlockPrefix,
  toolbarHeading,
  toolbarLink,
  toolbarImage,
  toolbarTag,
  toolbarBlockId,
  toolbarFootnote,
  toolbarCallout,
  toolbarDetails,
  toolbarTabs,
  toolbarMermaid,
  toolbarCodeBlock,
  toolbarAdvancedCodeBlock,
  toolbarTable,
  toolbarHorizontalRule,
  toolbarMathBlock,
  toolbarFrontMatter,
} from '@/editor/toolbar-commands'

const { state } = store

const host = ref<HTMLDivElement | null>(null)
/** 视图模式：编辑 / 分栏 / 预览（对齐 inkstone 的三段式切换） */
type ViewMode = 'write' | 'split' | 'read'
const mode = ref<ViewMode>('write')
const html = ref('')
const slash = ref<SlashMenuRenderState | null>(null)

/** 编辑区是否可见 / 预览区是否可见，由模式派生 */
const showEditor = computed(() => mode.value !== 'read')
const showPreview = computed(() => mode.value !== 'write')

/** 标题（不含扩展名），可编辑 */
const titleDraft = ref('')
watch(
  () => store.activeName.value,
  (n) => {
    titleDraft.value = n
  },
  { immediate: true },
)

/** 标题回车 / 失焦时改名 */
async function commitTitle() {
  const next = titleDraft.value.trim()
  const path = state.activePath
  if (!path) return
  if (!next || next === store.activeName.value) {
    titleDraft.value = store.activeName.value
    return
  }
  await store.renameNote(path, next)
}

function onTitleKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    ;(e.target as HTMLInputElement).blur()
  } else if (e.key === 'Escape') {
    titleDraft.value = store.activeName.value
    ;(e.target as HTMLInputElement).blur()
  }
}

/** 快捷键 Ctrl+1/2/3 切视图，和多数编辑器一致 */
function onViewKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
  if (e.key === '1') { e.preventDefault(); mode.value = 'write' }
  else if (e.key === '2') { e.preventDefault(); mode.value = 'split' }
  else if (e.key === '3') { e.preventDefault(); mode.value = 'read' }
}

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
  const raw = markedMod.marked.parse(state.draft, { async: false }) as string
  html.value = await highlightFences(raw)
}

/**
 * 给 marked 产出的代码块补高亮。
 *
 * marked 只输出 `<pre><code class="language-js">原文</code></pre>`，
 * 没有 token 信息；这里把它换成带 class 的 span，颜色和编辑区同源。
 * 语言没写、或写了不认识的语言，就保持原样——不猜、不报错。
 */
async function highlightFences(source: string): Promise<string> {
  const blocks = [...source.matchAll(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g)]
  if (blocks.length === 0) return source

  const rendered = await Promise.all(
    blocks.map(async (m) => {
      const lang = langFromClass(m[1])
      const code = m[2]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
      const inner = await highlightCode(code, lang)
      const cls = lang ? ` class="language-${lang}"` : ''
      return `<pre><code${cls}>${inner}</code></pre>`
    }),
  )

  let i = 0
  return source.replace(
    /<pre><code([^>]*)>[\s\S]*?<\/code><\/pre>/g,
    () => rendered[i++],
  )
}

/* ── 自动保存 ── */
function scheduleSave() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => store.saveNote(), 600)
}

/* ── 斜杠命令 → 具体动作 ── */
function runSlashFormat(id: SlashCommandId, v: EditorView) {
  switch (id) {
    // 文本
    case 'heading1': toolbarHeading(v, 1); break
    case 'heading2': toolbarHeading(v, 2); break
    case 'heading3': toolbarHeading(v, 3); break
    case 'bold': toolbarInline(v, 'bold'); break
    case 'italic': toolbarInline(v, 'italic'); break
    case 'strikethrough': toolbarInline(v, 'strikethrough'); break
    case 'highlight': toolbarInline(v, 'highlight'); break
    case 'inlineCode': toolbarInlineCode(v); break
    // 列表
    case 'bulletList': toolbarBlockPrefix(v, 'bullet'); break
    case 'numberedList': toolbarBlockPrefix(v, 'ordered'); break
    case 'taskList': toolbarBlockPrefix(v, 'task'); break
    case 'quote': toolbarBlockPrefix(v, 'quote'); break
    // 链接与引用
    case 'link': toolbarLink(v); break
    case 'wikiLink': toolbarWrap(v, '[[', ']]'); break
    case 'noteEmbed': toolbarWrap(v, '![[', ']]'); break
    case 'blockReference': toolbarWrap(v, '[[#^', ']]'); break
    case 'footnote': toolbarFootnote(v); break
    case 'image': toolbarImage(v); break
    // 笔记
    case 'tag': toolbarTag(v); break
    case 'blockId': toolbarBlockId(v); break
    case 'frontMatter': toolbarFrontMatter(v); break
    case 'comment': toolbarInline(v, 'comment'); break
    // 代码 / 表格 / 数学
    case 'codeBlock': toolbarCodeBlock(v); break
    case 'advancedCodeBlock': toolbarAdvancedCodeBlock(v); break
    case 'mermaid': toolbarMermaid(v); break
    case 'table': toolbarTable(v, '| 列 1 | 列 2 | 列 3 |'); break
    case 'inlineMath': toolbarInline(v, 'inlineMath'); break
    case 'mathBlock': toolbarMathBlock(v); break
    // 内容块
    case 'callout': toolbarCallout(v); break
    case 'details': toolbarDetails(v); break
    case 'tabs': toolbarTabs(v, '标签一', '标签二'); break
    case 'divider': toolbarHorizontalRule(v); break
    default: break
  }
}

async function runSlashAi(_id: SlashCommandId, _v: EditorView) {
  // AI 能力属于后续里程碑，先在 UI 上给出明确反馈
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: 'AI 命令尚未接入，敬请期待' }))
}

/** 工具栏提示：模板里拿不到 window，统一从这里转发 */
function onToolbarToast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
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
  window.addEventListener('keydown', onViewKey)
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  view?.destroy()
  view = null
  ;(window as unknown as { __notaView?: EditorView | null }).__notaView = null
  window.removeEventListener('keydown', onViewKey)
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

// 阅读模式：销毁编辑器省内存；回到编辑/分栏再重建。
// 分栏模式两边都要在，所以只有纯预览才销毁。
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
    <!-- 顶部标题栏：左边可编辑标题，右边视图切换 + 字数。
         顺序与 inkstone 一致——标题栏在工具栏之上。 -->
    <header class="ph">
      <input
        v-model="titleDraft"
        class="ph-title"
        type="text"
        placeholder="未命名笔记"
        aria-label="笔记标题"
        spellcheck="false"
        @keydown="onTitleKey"
        @blur="commitTitle"
      />

      <div class="ph-right">
        <span class="ph-stat">{{ statText }}</span>
        <span v-if="store.dirty.value" class="dot" title="有未保存的修改" />

        <!-- 视图切换：编辑 / 分栏 / 预览 -->
        <div class="ph-seg" role="radiogroup" aria-label="视图模式">
          <button
            class="ph-seg-btn"
            role="radio"
            :aria-checked="mode === 'write'"
            aria-label="编辑模式 (Ctrl+1)"
            title="编辑模式 (Ctrl+1)"
            :class="{ on: mode === 'write' }"
            @click="mode = 'write'"
          >
            <Pencil :size="12.5" :stroke-width="1.9" />
          </button>
          <button
            class="ph-seg-btn"
            role="radio"
            :aria-checked="mode === 'split'"
            aria-label="分栏视图 (Ctrl+2)"
            title="分栏视图 (Ctrl+2)"
            :class="{ on: mode === 'split' }"
            @click="mode = 'split'"
          >
            <Columns2 :size="12.5" :stroke-width="1.9" />
          </button>
          <button
            class="ph-seg-btn"
            role="radio"
            :aria-checked="mode === 'read'"
            aria-label="阅读模式 (Ctrl+3)"
            title="阅读模式 (Ctrl+3)"
            :class="{ on: mode === 'read' }"
            @click="mode = 'read'"
          >
            <Eye :size="12.5" :stroke-width="1.9" />
          </button>
        </div>
      </div>
    </header>

    <Toolbar
      v-if="showEditor"
      :get-view="() => view"
      @toast="onToolbarToast"
    />

    <div class="stage" :data-layout="mode">
      <div
        v-show="showEditor"
        ref="host"
        class="host"
      />
      <div v-if="showPreview" class="preview" v-html="html" />

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

/* ── 顶部标题栏 ──
   44px，和 inkstone 一致。标题做成「平时像纯文本、悬停/聚焦才显形」的输入框，
   避免一排边框把界面切得太碎。 */
.ph {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--n-line);
  background: var(--n-surface);
}

.ph-title {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--n-r-sm);
  outline: none;
  transition: background var(--n-dur) var(--n-ease), border-color var(--n-dur) var(--n-ease);
}

.ph-title::placeholder {
  font-weight: 500;
  color: var(--n-fg-faint);
}

.ph-title:hover {
  background: var(--n-raised);
  border-color: var(--n-line);
}

.ph-title:focus {
  background: var(--n-bg);
  border-color: var(--n-accent);
}

.ph-right {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 未保存标记：一个小圆点，比文字更安静 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--n-accent);
  opacity: 0.75;
}

/* ── 视图切换（分段控件） ──
   和 inkstone 的 Segmented 同构：外层凹陷底槽，选中项浮起成白块。 */
.ph-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--n-r-md);
  background: var(--n-bg);
  border: 1px solid var(--n-line);
}

.ph-seg-btn {
  width: 30px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: color var(--n-dur) var(--n-ease), background var(--n-dur) var(--n-ease);
}

.ph-seg-btn svg {
  fill: none;
  stroke: currentColor;
}

.ph-seg-btn:hover {
  color: var(--n-fg);
}

.ph-seg-btn.on {
  background: var(--n-raised);
  color: var(--n-accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

.ph-stat {
  font-size: 11.5px;
  color: var(--n-fg-faint);
  font-variant-numeric: tabular-nums;
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}

/* 纯编辑 / 纯预览：单栏占满 */
.stage[data-layout='write'] .host,
.stage[data-layout='read'] .preview {
  width: 100%;
}

/* 分栏：编辑在左、预览在右，中间一条分隔线 */
.stage[data-layout='split'] .host {
  flex: 1 1 50%;
  min-width: 0;
  border-right: 1px solid var(--n-line);
}

.stage[data-layout='split'] .preview {
  flex: 1 1 50%;
  min-width: 0;
}

.host {
  flex: 1;
  min-height: 0;
  user-select: text;
  overflow: hidden;
}

/* ── 预览排版 ──
   与编辑器用同一套居中公式：左右各留 (容器 - 正文列) / 2，
   这样「编辑」和「预览」两个模式切换时正文列是完全对齐的。 */
.preview {
  flex: 1;
  padding: 20px max(20px, calc((100% - var(--n-measure)) / 2)) 42vh;
  overflow-y: auto;
  user-select: text;
  line-height: var(--n-lh);
}

/* 分栏时每栏只有半宽，正文列的居中留白要相应收窄，
   否则 (100% - measure)/2 会算出负值，正文被挤到贴边。 */
.stage[data-layout='split'] .preview {
  padding: 16px clamp(12px, 4%, 40px) 42vh;
}

/* 同理，分栏时编辑区的居中留白也要收窄。
   .cm-scroller 的 padding 设在 theme.ts 里，这里用 :deep 覆盖。 */
.stage[data-layout='split'] :deep(.cm-scroller) {
  padding-inline: clamp(12px, 4%, 40px);
}
.preview :deep(h1),
.preview :deep(h2),
.preview :deep(h3),
.preview :deep(h4),
.preview :deep(h5),
.preview :deep(h6) {
  line-height: 1.34;
  margin: 1.5em 0 0.5em;
  font-weight: 700;
  letter-spacing: -0.015em;
}
.preview :deep(h1) {
  font-size: 1.62em;
  margin-top: 0;
}
.preview :deep(h2) {
  font-size: 1.34em;
}
.preview :deep(h3) {
  font-size: 1.16em;
}
.preview :deep(h4) {
  font-size: 1.04em;
}
.preview :deep(h5) {
  font-size: 0.96em;
  color: var(--n-fg-dim);
}
.preview :deep(h6) {
  font-size: 0.92em;
  color: var(--n-fg-faint);
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
  font-size: 0.9em;
  padding: 0.15em 0.4em;
  border-radius: 4px;
  color: var(--n-code-fg);
  background: var(--n-code-bg);
}
.preview :deep(pre) {
  padding: 12px 16px;
  border-radius: var(--n-r-md);
  background: var(--n-code-bg);
  border: 1px solid var(--n-line);
  overflow-x: auto;
}
.preview :deep(pre code) {
  padding: 0;
  background: none;
  color: inherit;
}
.preview :deep(blockquote) {
  margin: 1em 0;
  padding: 0.45em 0 0.45em 14px;
  border-left: 3px solid var(--n-accent);
  border-radius: 0 4px 4px 0;
  background: var(--n-accent-soft);
  color: var(--n-fg-dim);
  font-style: italic;
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
