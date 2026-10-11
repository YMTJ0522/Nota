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
  Check,
  Loader2,
  ListTree,
  PanelRightClose,
  ChevronDown,
  ChevronUp,
  Search,
  X,
} from 'lucide-vue-next'
import { store } from '@/store'
import { baseExtensions } from '@/editor/setup'
import {
  SearchQuery,
  findNext,
  findPrevious,
  setSearchQuery,
} from '@codemirror/search'
import { notaThemeExtensions } from '@/editor/theme'
import { countWords, formatWordCount } from '@/editor/word-count'
import { createSlashCommandsExtension } from '@/editor/slash-commands'
import { runAi, type AiAction } from '@/editor/ai'
import type { SlashMenuRenderState, SlashCommandId } from '@/editor/slash-commands'
import {
  enhancePreview,
  renderMermaidInHtml,
  renderMathInHtml,
  stripFrontMatter,
  CODE_COLLAPSE_HEIGHT,
} from '@/editor/preview-rich'
import type { HeadingItem } from '@/editor/preview-rich'
import { highlightCode, langFromClass } from '@/editor/highlight-code'
import Toolbar from '@/components/Toolbar.vue'
import NotePickerDialog from '@/components/NotePickerDialog.vue'
import SlashMenu from '@/components/SlashMenu.vue'
import HeaderMenu from '@/components/HeaderMenu.vue'
import EditorOutline from '@/components/EditorOutline.vue'
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
/** 预览容器：既是正文容器，也是大纲的滚动参考；mermaid 也要在 DOM 挂载后往里填 SVG */
const previewRef = ref<HTMLDivElement | null>(null)
/** 视图模式放在 store 里，切换后重启应用也保持 */
const mode = computed(() => state.viewMode)
const html = ref('')
/** 预览渲染出的标题列表，交给右侧大纲 */
const headings = ref<HeadingItem[]>([])
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
  if (e.key === '1') { e.preventDefault(); store.setViewMode('write') }
  else if (e.key === '2') { e.preventDefault(); store.setViewMode('split') }
  else if (e.key === '3') { e.preventDefault(); store.setViewMode('read') }
}

let view: EditorView | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** 防止把程序化写入回灌成用户输入 */
let syncing = false

/** 字数统计直接从 draft 派生，避免手动同步漏更新 */
const statText = computed(() => formatWordCount(countWords(state.draft)))

/**
 * 保存状态文案。
 * 三种态：正在写盘 → 「保存中…」；有未落盘的改动 → 「未保存」；
 * 其余 → 「已保存」。比单纯一个圆点更能说明当前处境。
 */
const saveState = computed<'saving' | 'dirty' | 'saved'>(() => {
  if (state.saving) return 'saving'
  return store.dirty.value ? 'dirty' : 'saved'
})

const saveLabel = computed(() => {
  switch (saveState.value) {
    case 'saving':
      return '保存中…'
    case 'dirty':
      return state.autoSave ? '待保存' : '未保存'
    default:
      return '已保存'
  }
})

/** 预览（阅读模式） */
let markedMod: typeof import('marked') | null = null
async function render() {
  if (!markedMod) {
    markedMod = await import('marked')
    markedMod.marked.setOptions({ gfm: true, breaks: true })
  }
  const raw = markedMod.marked.parse(stripFrontMatter(state.draft), { async: false }) as string
  // 先补高亮与媒体路径，再做富块增强——顺序有讲究：
  // 富块会重新包裹 HTML 结构，先高亮能保证代码块（含 mermaid）已被标记成 language-*。
  const lit = await highlightFences(raw)
  const media = await resolveMediaInHtml(lit)
  const enhanced = enhancePreview(media)
  html.value = enhanced.html
  headings.value = enhanced.headings
  // 异步填料的两种「重资产」：mermaid 画图、katex 排公式
  await nextTick()
  const pane = previewRef.value
  if (pane) {
    void renderMathInHtml(pane)
    void renderMermaidInHtml(pane)
  }
}

/* ── 编辑区查找条 ──
   只做「找」不做「换」：替换在笔记场景里用得极少，却要占一整行控件。
   匹配逻辑仍交给 @codemirror/search（setSearchQuery + findNext/Previous），
   这样高亮和滚动行为与编辑器原生一致，画出来的只是上面那条输入框。 */
const findOpen = ref(false)
const findText = ref('')
const findTotal = ref(0)
const findAt = ref(0)
const findInput = ref<HTMLInputElement | null>(null)

const findCountText = computed(() => {
  if (!findText.value) return ''
  if (findTotal.value === 0) return '无匹配'
  return findAt.value ? `${findAt.value} / ${findTotal.value}` : `${findTotal.value} 处`
})

function openFind() {
  findOpen.value = true
  nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
    // 有选区就把选中内容带进搜索框——多数人按 Ctrl+F 时想找的就是刚选中的词
    const v = view
    if (v) {
      const sel = v.state.sliceDoc(
        v.state.selection.main.from,
        v.state.selection.main.to,
      )
      if (sel && !sel.includes('\n')) {
        findText.value = sel
        refreshFind()
      }
    }
  })
}

function closeFind() {
  findOpen.value = false
  findText.value = ''
  findTotal.value = 0
  findAt.value = 0
  const v = view
  if (v) v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) })
  v?.focus()
}

/** 重新计数，并标出光标当前停在第几个匹配上 */
function refreshFind() {
  const v = view
  if (!v) return
  const text = findText.value
  const query = new SearchQuery({ search: text, caseSensitive: false })
  v.dispatch({ effects: setSearchQuery.of(query) })

  if (!text) {
    findTotal.value = 0
    findAt.value = 0
    return
  }

  const head = v.state.selection.main.head
  let total = 0
  let at = 0
  const cursor = query.getCursor(v.state)
  for (;;) {
    const hit = cursor.next()
    if (hit.done) break
    total += 1
    if (hit.value.from <= head && head <= hit.value.to) at = total
  }
  findTotal.value = total
  findAt.value = at
}

function stepFind(dir: 1 | -1) {
  const v = view
  if (!v || !findText.value) return
  if (dir === 1) findNext(v)
  else findPrevious(v)
  refreshFind()
}

/* ── 笔记嵌入 ── */
const embedOpen = ref(false)

/** 把选中的笔记写成 `![[名字]]` 插到光标处 */
function embedNote(rel: string) {
  const v = view
  if (!v) return
  const name = rel.replace(/\.md$/i, '')
  const snippet = `![[${name}]]`
  const range = v.state.selection.main
  v.dispatch({
    changes: { from: range.from, to: range.to, insert: snippet },
    selection: { anchor: range.from + snippet.length },
    userEvent: 'input.toolbar',
  })
  v.focus()
}

/**
 * 预览区里代码块的复制 / 折叠。
 *
 * 走事件委托而不是给每个按钮挂 onclick：预览 HTML 每次渲染都会整块换掉，
 * 逐个元素绑定既绑不住（新节点没有监听）也容易漏，交给容器一个处理器就够了。
 */
function onPreviewClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(
    '[data-copy], [data-fold]',
  )
  const box = btn?.closest<HTMLElement>('.pv-code')
  if (!btn || !box) return

  if (btn.hasAttribute('data-copy')) {
    const code = box.querySelector('code')
    if (!code) return
    const copy = btn
    navigator.clipboard?.writeText(code.textContent ?? '').then(
      () => {
        copy.textContent = '已复制'
        copy.classList.add('done')
        window.setTimeout(() => {
          copy.textContent = '复制'
          copy.classList.remove('done')
        }, 1400)
      },
      () => {
        copy.textContent = '复制失败'
        copy.classList.add('done')
        window.setTimeout(() => {
          copy.textContent = '复制'
          copy.classList.remove('done')
        }, 1400)
      },
    )
    return
  }

  // 折叠：收起时压到固定高度，展开时先量出真实高度再放开，
  // 这样 max-height 有个确定的终值可以做过渡（none 是过渡不动的）。
  const body = box.querySelector<HTMLElement>('.pv-code-body')
  if (!body) return
  const lines = btn.dataset.lines ?? ''
  const folded = box.classList.toggle('is-folded')
  btn.textContent = folded ? `${lines} 行` : '收起'
  if (folded) {
    body.style.maxHeight = `${CODE_COLLAPSE_HEIGHT}px`
  } else {
    body.style.maxHeight = `${body.scrollHeight}px`
    window.setTimeout(() => {
      if (!box.classList.contains('is-folded')) body.style.maxHeight = ''
    }, 240)
  }
}

/**
 * 把预览 HTML 里的相对路径图片/视频换成可加载的 URL。
 *
 * 笔记里存的是 `attachments/x.png` 这种跟自己目录相对的路径，
 * 但渲染进程的 origin 是应用本身，相对路径指向的是应用而不是工作区，
 * 所以插图一直是个破图标。这里逐条交给主进程换算成 nota-media:// URL。
 *
 * 匹配 <img src> 与 <video src> 两种；顺带处理 <source src>。
 * 外链（http/https/data）主进程会原样返回，不做改动。
 */
async function resolveMediaInHtml(source: string): Promise<string> {
  const api = window.api
  if (!api?.resolveMedia) return source
  const base = state.root ?? ''

  const tags = [...source.matchAll(/<(img|video|source)\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
  if (tags.length === 0) return source

  const resolved = await Promise.all(
    tags.map(async (m) => {
      const url = await api.resolveMedia(base, m[2])
      return url ?? m[2]
    }),
  )

  let i = 0
  return source.replace(
    /<(img|video|source)\b[^>]*\bsrc="([^"]+)"[^>]*>/g,
    (whole, ...rest) => {
      const next = resolved[i++]
      // 只替换 src 的值，其余属性（alt/class/width…）原样保留
      return whole.replace(/(\bsrc=")([^"]+)(")/, `$1${next}$3`)
    },
  )
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
      // mermaid 不是代码：一旦按行包成 <span class="pv-line">，
      // 后面取图表源码时拿到的就是带标签的 HTML，画出来一片空白。
      // 原样放过去，交给 transformMermaid 处理。
      if (lang.toLowerCase() === 'mermaid') return m[0]
      const code = m[2]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        // marked 会在代码块末尾留一个换行。留着的话行容器会多出一个空行，
        // 底部凭空多一道空白，行数也对不上源码。
        .replace(/\n$/, '')
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

/* ── 自动保存 ──
   默认开启（用户要求「每次编辑完就自动保存」）。关掉后只留手动 Ctrl+S。
   600ms 的防抖：连续打字时只在停顿后落一次盘，不会每敲一个字写一次。 */
function scheduleSave() {
  if (!state.autoSave) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => store.saveNote({ silent: true }), 600)
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
    // 嵌入要挑具体哪一篇，光打一对 ![[]] 还得手动填名字，直接弹选择器
    case 'noteEmbed': embedOpen.value = true; break
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

/** 斜杠菜单里的 AI 组：映射到工具栏那四种动作 */
const SLASH_AI: Record<string, AiAction> = {
  aiSummarize: 'summarize',
  aiContinue: 'continue',
  aiTranslate: 'translate',
  aiOutline: 'summarize',
}

async function runSlashAi(id: SlashCommandId, v: EditorView) {
  const action = SLASH_AI[id]
  if (!action) return
  await runAi(v, action)
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
      onFind: openFind,
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
  window.addEventListener('nota:insert', onInsertRequest)
})

/**
 * 外部（附件库）要求往光标处插一段文本。
 *
 * 走事件而不是 prop：附件库挂在 App 层，跟编辑区隔了两层，
 * 为它专门开一条 props 通道会把两边的生命周期绑在一起。
 */
function onInsertRequest(e: Event) {
  const text = (e as CustomEvent<string>).detail
  const v = view
  if (!v || !text) return
  const range = v.state.selection.main
  v.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    userEvent: 'input.insert',
  })
  v.focus()
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  if (previewTimer) clearTimeout(previewTimer)
  view?.destroy()
  view = null
  ;(window as unknown as { __notaView?: EditorView | null }).__notaView = null
  window.removeEventListener('keydown', onViewKey)
  window.removeEventListener('nota:insert', onInsertRequest)
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
// 注意先判空——从「分栏」切回「编辑」时编辑器还在，
// 再 createEditor() 会把第二个实例叠进同一个容器，页面上就会出现两套编辑器。
watch(mode, async (m) => {
  if (m === 'read') {
    view?.destroy()
    view = null
    await render()
  } else {
    await nextTick()
    if (!view) {
      createEditor()
      pushDoc(state.draft)
    }
    await render()
  }
})

/* 边写边看：分栏/阅读下正文一变就重排预览。
   180ms 防抖——低于这个值每敲一个字都要重新解析整篇，
   长文里会明显掉帧；高于这个值又会觉得预览"跟不上手"。 */
let previewTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => state.draft,
  () => {
    if (mode.value === 'write') return
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => void render(), 180)
  },
)

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

        <!-- 保存状态：图标 + 文案，比一个圆点说得更清楚 -->
        <span class="ph-save" :class="saveState" :title="saveLabel">
          <Loader2 v-if="saveState === 'saving'" class="spin" :size="12" :stroke-width="2" />
          <Check v-else-if="saveState === 'saved'" :size="12" :stroke-width="2.1" />
          <span v-else class="ph-dot" />
          <span class="ph-save-text">{{ saveLabel }}</span>
        </span>

        <!-- 导出 / 版本历史 / 设置 -->
        <HeaderMenu />

        <!-- 大纲开关：只在有预览的时候才有意义 -->
        <button
          v-if="showPreview"
          class="ph-icon"
          :class="{ on: state.outline }"
          :title="state.outline ? '隐藏大纲' : '显示大纲'"
          @click="store.toggleOutline()"
        >
          <PanelRightClose v-if="state.outline" :size="14" :stroke-width="1.9" />
          <ListTree v-else :size="14" :stroke-width="1.9" />
        </button>

        <!-- 视图切换：编辑 / 分栏 / 预览 -->
        <div class="ph-seg" role="radiogroup" aria-label="视图模式">
          <button
            class="ph-seg-btn"
            role="radio"
            :aria-checked="mode === 'write'"
            aria-label="编辑模式 (Ctrl+1)"
            title="编辑模式 (Ctrl+1)"
            :class="{ on: mode === 'write' }"
            @click="store.setViewMode('write')"
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
            @click="store.setViewMode('split')"
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
            @click="store.setViewMode('read')"
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
      @embed="embedOpen = true"
    />

    <div class="stage" :data-layout="mode">
      <div v-show="showEditor" class="ed-wrap">
        <div ref="host" class="host" />

        <!-- 查找条。CodeMirror 原生面板带替换框和正则/整词一堆开关，
             这里只要「一个输入框 + 上/下 + 关闭」，所以自己画一条浮在上面。 -->
        <div v-if="findOpen" class="findbar">
          <Search class="fb-ico" :size="12" :stroke-width="2" />
          <input
            ref="findInput"
            v-model="findText"
            class="fb-input"
            type="text"
            placeholder="在当前笔记中查找…"
            spellcheck="false"
            @input="refreshFind"
            @keydown.enter.exact.prevent="stepFind(1)"
            @keydown.enter.shift.prevent="stepFind(-1)"
            @keydown.esc="closeFind"
          />
          <span class="fb-count">{{ findCountText }}</span>
          <button class="fb-btn" title="上一个 (Shift+Enter)" @click="stepFind(-1)">
            <ChevronUp :size="13" :stroke-width="2.1" />
          </button>
          <button class="fb-btn" title="下一个 (Enter)" @click="stepFind(1)">
            <ChevronDown :size="13" :stroke-width="2.1" />
          </button>
          <button class="fb-btn" title="关闭 (Esc)" @click="closeFind">
            <X :size="12" :stroke-width="2.2" />
          </button>
        </div>
      </div>
      <div v-if="showPreview" class="pvw">
        <div
          ref="previewRef"
          class="preview"
          v-html="html"
          @click="onPreviewClick"
        />
        <EditorOutline
          v-if="state.outline"
          :headings="headings"
          :scroller="previewRef"
        />
      </div>

      <NotePickerDialog
        :open="embedOpen"
        title="嵌入笔记"
        @pick="embedNote"
        @close="embedOpen = false"
      />

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

/* 顶栏里的小图标按钮（侧栏开关等） */
.ph-icon {
  width: 26px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.ph-icon svg {
  fill: none;
  stroke: currentColor;
}

.ph-icon:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.ph-icon.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

/* ── 保存状态 ──
   「已保存」刻意做得最安静（灰），只有真正需要注意时才提色：
   保存中走强调色，未保存走警示色。 */
.ph-save {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--n-fg-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ph-save svg {
  fill: none;
  stroke: currentColor;
  flex: none;
}

.ph-save.saving {
  color: var(--n-accent);
}

.ph-save.dirty {
  color: var(--n-fg-dim);
}

.ph-save.saved {
  color: var(--n-fg-faint);
}

/* 未保存 / 保存中用小圆点表示，保持和原来一致的克制 */
.ph-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--n-accent);
  flex: none;
  margin: 0 3px;
}

.spin {
  animation: ph-spin 900ms linear infinite;
}

@keyframes ph-spin {
  to { transform: rotate(360deg); }
}

/* 窄窗口下先把「已保存」这类次要文案收掉，保住标题和视图切换 */
@media (max-width: 720px) {
  .ph-save-text { display: none; }
  .ph-stat { display: none; }
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

/* 编辑侧：包一层是为了让查找条能浮在编辑器右上角 */
.ed-wrap {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 纯编辑：单栏占满 */
.stage[data-layout='write'] .ed-wrap {
  width: 100%;
}

/* 分栏：编辑在左、预览在右，中间一条分隔线 */
.stage[data-layout='split'] .ed-wrap {
  flex: 1 1 50%;
  min-width: 0;
  border-right: 1px solid var(--n-line);
}

/* ── 查找条 ── */
.findbar {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding: 0 5px 0 9px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-md);
  background: var(--n-raised);
  box-shadow: var(--n-shadow-md);
}
.findbar .fb-ico {
  color: var(--n-fg-faint);
  flex: none;
}
.fb-input {
  width: 168px;
  height: 100%;
  border: 0;
  background: none;
  font-family: var(--n-font-ui);
  font-size: 12.5px;
  color: var(--n-fg);
  outline: none;
}
.fb-input::placeholder {
  color: var(--n-fg-faint);
}
.fb-count {
  min-width: 44px;
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--n-fg-dim);
  flex: none;
}
.fb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  flex: none;
}
.fb-btn:hover {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

/* 预览侧：正文 + 右侧大纲并排。
   大纲是预览的附属信息，放在同一个滚动上下文之外，各自滚各自的。 */
.pvw {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
  flex-direction: row;
}

.host {
  flex: 1;
  min-height: 0;
  user-select: text;
  overflow: hidden;
}

/* ── 预览排版 ──
   与编辑区保持同一套「归左 + 列宽上限」的规则：左边距固定，
   正文列到 --n-measure 就停住。这样编辑/预览切换时正文左边缘是对齐的。 */
.preview {
  flex: 1;
  padding: 20px 24px 42vh;
  overflow-y: auto;
  user-select: text;
  line-height: var(--n-lh);
}

/* 预览正文列宽上限，和编辑区 .cm-content 用同一个变量 */
.preview > :deep(*) {
  max-width: var(--n-measure);
}

/* 分栏时每栏更窄，列宽上限交还给容器（否则又会窄一条） */
.stage[data-layout='split'] .preview {
  padding: 16px clamp(12px, 4%, 40px) 42vh;
}

.stage[data-layout='split'] .preview > :deep(*) {
  max-width: none;
}

/* 分栏时编辑区用固定左内边距，保持和预览对称 */
.stage[data-layout='split'] :deep(.cm-scroller) {
  padding-inline: 0;
}

.stage[data-layout='split'] :deep(.cm-content) {
  max-width: none;
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
/* 行内代码保持轻量；块级代码由 .pv-code 外层接管，pre 本身不再画边框 */
.preview :deep(pre) {
  margin: 0;
  padding: 11px 14px;
  border-radius: 0;
  background: none;
  border: 0;
  overflow-x: auto;
  tab-size: 2;
  line-height: 1.6;
}
.preview :deep(pre code) {
  padding: 0;
  background: none;
  color: inherit;
  font-size: 13px;
}

/* 笔记嵌入：还没做真正的正文内联，先给一个能认出来的卡片 */
.preview :deep(.pv-embed) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 9px 2px 7px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-sm);
  background: var(--n-surface);
  font-size: 0.92em;
  vertical-align: baseline;
}
.preview :deep(.pv-embed-ico) {
  font-size: 11px;
  line-height: 1;
}
.preview :deep(.pv-embed-name) {
  color: var(--n-accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 代码块外壳：语言 + 行数/折叠 + 复制 ── */
.preview :deep(.pv-code) {
  margin: 1em 0;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  background: var(--n-code-bg);
  overflow: hidden;
}
.preview :deep(.pv-code-head) {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 7px 0 12px;
  border-bottom: 1px solid var(--n-line);
  background: color-mix(in oklab, var(--n-code-bg) 60%, var(--n-bg));
}
.preview :deep(.pv-code-lang) {
  font-family: var(--n-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.05em;
  color: var(--n-fg-faint);
}
/* 折叠 / 复制靠右排；没折叠按钮时靠 margin-left:auto 顶到右边 */
.preview :deep(.pv-code-fold),
.preview :deep(.pv-code-copy) {
  padding: 0 7px;
  height: 20px;
  border-radius: var(--n-r-sm);
  font-size: 11px;
  color: var(--n-fg-dim);
  opacity: 0;
  transition:
    opacity var(--n-dur) var(--n-ease),
    background-color var(--n-dur) var(--n-ease),
    color var(--n-dur) var(--n-ease);
}
.preview :deep(.pv-code-fold) {
  margin-left: auto;
}
.preview :deep(.pv-code:hover .pv-code-fold),
.preview :deep(.pv-code:hover .pv-code-copy),
.preview :deep(.pv-code-fold:focus-visible),
.preview :deep(.pv-code-copy:focus-visible) {
  opacity: 1;
}
.preview :deep(.pv-code-fold:hover),
.preview :deep(.pv-code-copy:hover) {
  background: var(--n-surface);
  color: var(--n-fg);
}
/* 复制成功后短暂留着，不然用户根本看不到反馈 */
.preview :deep(.pv-code-copy.done) {
  opacity: 1;
  color: var(--n-ok);
}
.preview :deep(.pv-code-body) {
  position: relative;
  overflow: hidden;
  transition: max-height 220ms var(--n-ease);
}
.preview :deep(.pv-code.is-folded .pv-code-body::after) {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  height: 56px;
  background: linear-gradient(to bottom, transparent, var(--n-code-bg));
  pointer-events: none;
}
/* 行容器：行号和高亮行都要靠它定位 */
.preview :deep(.pv-line) {
  display: inline-block;
  width: 100%;
  min-height: 1.6em;
  vertical-align: top;
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
.preview :deep(video) {
  max-width: 100%;
  border-radius: var(--n-r-md);
  border: 1px solid var(--n-line);
}

/* ── 富块：Callout / 折叠 / 分栏 / Mermaid ──
   这些结构由 preview-rich.ts 在 marked 产出之后补出来。 */
.preview :deep(.pv-callout) {
  margin: 1em 0;
  border: 1px solid var(--n-block-line);
  border-left: 3px solid var(--n-accent);
  border-radius: var(--n-r-md);
  background: var(--n-block-bg);
  overflow: hidden;
}
.preview :deep(.pv-callout-head) {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  background: var(--n-block-head);
  font-size: 0.86em;
  font-weight: 600;
}
.preview :deep(.pv-callout-icon) {
  color: var(--n-accent);
}
.preview :deep(.pv-callout-body) {
  padding: 4px 12px;
}
.preview :deep(.pv-callout-body > :last-child) {
  margin-bottom: 0.5em;
}
.preview :deep(.pv-badge) {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 9px;
  border: 1px solid var(--n-block-line);
  background: var(--n-raised);
  font-size: 0.72em;
  font-weight: 600;
  color: var(--n-fg-dim);
}
.preview :deep(.pv-callout[data-type='note']),
.preview :deep(.pv-callout[data-type='info']) {
  border-left-color: var(--n-info);
  background: var(--n-info-soft);
}
.preview :deep(.pv-callout[data-type='note'] .pv-callout-icon),
.preview :deep(.pv-callout[data-type='info'] .pv-callout-icon) {
  color: var(--n-info);
}
.preview :deep(.pv-callout[data-type='tip']),
.preview :deep(.pv-callout[data-type='success']),
.preview :deep(.pv-callout[data-type='example']) {
  border-left-color: var(--n-ok);
  background: var(--n-ok-soft);
}
.preview :deep(.pv-callout[data-type='tip'] .pv-callout-icon),
.preview :deep(.pv-callout[data-type='success'] .pv-callout-icon),
.preview :deep(.pv-callout[data-type='example'] .pv-callout-icon) {
  color: var(--n-ok);
}
.preview :deep(.pv-callout[data-type='warning']),
.preview :deep(.pv-callout[data-type='caution']),
.preview :deep(.pv-callout[data-type='important']),
.preview :deep(.pv-callout[data-type='question']) {
  border-left-color: var(--n-warn);
  background: var(--n-warn-soft);
}
.preview :deep(.pv-callout[data-type='warning'] .pv-callout-icon),
.preview :deep(.pv-callout[data-type='caution'] .pv-callout-icon),
.preview :deep(.pv-callout[data-type='important'] .pv-callout-icon),
.preview :deep(.pv-callout[data-type='question'] .pv-callout-icon) {
  color: var(--n-warn);
}
.preview :deep(.pv-callout[data-type='danger']) {
  border-left-color: var(--n-danger);
  background: var(--n-danger-soft);
}
.preview :deep(.pv-callout[data-type='danger'] .pv-callout-icon) {
  color: var(--n-danger);
}

.preview :deep(.pv-details) {
  margin: 1em 0;
  border: 1px solid var(--n-block-line);
  border-radius: var(--n-r-md);
  background: var(--n-block-bg);
  overflow: hidden;
}
.preview :deep(.pv-details > summary) {
  padding: 8px 12px;
  background: var(--n-block-head);
  font-weight: 600;
  font-size: 0.92em;
  cursor: pointer;
  user-select: none;
}
.preview :deep(.pv-details[open] > summary) {
  border-bottom: 1px solid var(--n-block-line);
}
.preview :deep(.pv-details > *:not(summary)) {
  padding: 0 12px;
}
.preview :deep(.pv-details-body) {
  padding: 2px 12px;
}
.preview :deep(.pv-details-body > :first-child) {
  margin-top: 0.6em;
}
.preview :deep(.pv-details-body > :last-child) {
  margin-bottom: 0.6em;
}
.preview :deep(.pv-details > summary)::marker {
  color: var(--n-fg-faint);
}

.preview :deep(.pv-tabs) {
  margin: 1em 0;
  border: 1px solid var(--n-block-line);
  border-radius: var(--n-r-md);
  background: var(--n-block-bg);
  overflow: hidden;
}
.preview :deep(.pv-tabbar) {
  display: flex;
  gap: 2px;
  padding: 6px 10px 0;
  border-bottom: 1px solid var(--n-block-line);
}
.preview :deep(.pv-tab) {
  padding: 5px 12px;
  border-radius: var(--n-r-sm) var(--n-r-sm) 0 0;
  font-size: 0.88em;
  color: var(--n-fg-dim);
  cursor: default;
}
.preview :deep(.pv-tab.on) {
  background: var(--n-block-bg);
  color: var(--n-accent);
  font-weight: 600;
  box-shadow: inset 0 -2px var(--n-accent);
}
.preview :deep(.pv-tab-pane) {
  display: none;
  padding: 2px 12px;
}
.preview :deep(.pv-tab-pane.on) {
  display: block;
}

.preview :deep(.pv-mermaid) {
  margin: 1em 0;
  padding: 12px;
  border: 1px solid var(--n-block-line);
  border-radius: var(--n-r-md);
  background: var(--n-block-bg);
  text-align: center;
  overflow-x: auto;
}
.preview :deep(.pv-mermaid-graph svg) {
  max-width: 100%;
  height: auto;
}
.preview :deep(.pv-mermaid-src) {
  font-family: var(--n-font-mono);
  font-size: 0.84em;
  color: var(--n-fg-dim);
  white-space: pre;
  text-align: left;
}
.preview :deep(.pv-mermaid-graph.is-error) {
  color: var(--n-danger);
  font-family: var(--n-font-mono);
  font-size: 0.84em;
}
/* ── 高亮与公式 ── */
.preview :deep(.pv-mark) {
  padding: 0.08em 0.15em;
  border-radius: 3px;
  color: var(--n-fg);
  background: var(--n-mark);
}

/* 未渲染完成时先按等宽源码展示，避免一片空白让人以为丢了内容 */
.preview :deep(.pv-math-block) {
  margin: 1.1em 0;
  overflow-x: auto;
  overflow-y: hidden;
  font-family: var(--n-font-mono);
  font-size: 0.92em;
  color: var(--n-fg-dim);
}

.preview :deep(.pv-math:not(.is-rendered)) {
  font-family: var(--n-font-mono);
  font-size: 0.92em;
  color: var(--n-fg-dim);
}

.preview :deep(.pv-math.is-error),
.preview :deep(.pv-math-block.is-error) {
  color: var(--n-danger);
}

/* KaTeX 自带浅色，深色主题下要把公式本身和 $-符号一起翻过来 */
.preview :deep(.katex) {
  font-size: 1.02em;
  color: var(--n-fg);
}

.preview :deep(.katex-display) {
  margin: 0;
  padding: 0.3em 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.preview :deep(.pv-table-wrap) {
  overflow-x: auto;
  margin: 1em 0;
}
</style>
