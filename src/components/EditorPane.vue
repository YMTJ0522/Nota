<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick, computed } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import {
  /* 顶部区域与 inkstone 对齐：标题可编辑、右侧一段式视图切换。
     图标同样取自 Lucide（ISC），不碰 inkstone 的 LGPL 源码。 */
  Pencil,
  Columns2,
  Eye,
  Check,
  Loader2,
  Moon,
  Sun,
  ChevronDown,
  ChevronUp,
  Search,
  X,
} from 'lucide-vue-next'
import { store } from '@/store'
import { useFitTiers } from '@/composables/fit-tiers'
import { baseExtensions, editorViewPrefs } from '@/editor/setup'
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
  outlineFromSource,
} from '@/editor/preview-rich'
import type { HeadingItem } from '@/editor/preview-rich'
import { getMarked, highlightFences } from '@/editor/markdown'
import Toolbar from '@/components/Toolbar.vue'
import NotePickerDialog from '@/components/NotePickerDialog.vue'
import SlashMenu from '@/components/SlashMenu.vue'
import EditorActions from '@/components/EditorActions.vue'
import WindowControls from '@/components/WindowControls.vue'
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
import EditorContextMenu from '@/components/EditorContextMenu.vue'
import type { EditorMenuTarget } from '@/components/EditorContextMenu.vue'

const { state } = store

const host = ref<HTMLDivElement | null>(null)
/** 编辑侧那一格（v-show 控制），切回写作/分栏时要给它补一段淡入 */
const edWrap = ref<HTMLElement | null>(null)
/** 预览容器：既是正文容器，也是大纲的滚动参考；mermaid 也要在 DOM 挂载后往里填 SVG */
const previewRef = ref<HTMLDivElement | null>(null)
/** 视图模式放在 store 里，切换后重启应用也保持 */
const mode = computed(() => state.viewMode)
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

/** 顶栏第二行显示的相对路径：从工作区根算起，一眼能看出这篇在哪 */
const relPath = computed(() => {
  const p = state.activePath ?? ''
  const root = state.root ?? ''
  const rel = root && p.startsWith(root) ? p.slice(root.length) : p
  return rel.replace(/^[\\/]+/, '') || p
})

/**
 * 中间那一列「大纲」的数据源。
 *
 * 用源码提取的这一份，而不是等预览渲染后再取：分栏模式下两份都能有，
 * 但纯写作模式预览根本没渲染过，那样大纲会一直是空的。而且从源码走的
 * 好处是标题一改大纲立刻跟着改，不必等 600ms 的渲染防抖。
 */
watch(
  () => [state.activePath, state.draft] as const,
  ([p, raw]) => {
    state.headings = p ? outlineFromSource(raw) : []
    // 标题结构一变，高亮回到第一个标题，再看滚动到哪再说
    state.activeHeading = state.headings[0]?.id ?? null
    requestAnimationFrame(markActiveHeading)
  },
  { immediate: true },
)

/**
 * 给任意滚动容器做一次缓动滚动。
 *
 * 自己写而不是用 `scrollTo({behavior:'smooth'})`：编辑区那个滚动容器是
 * CodeMirror 的 scrollDOM，得由我们自己一帧一帧写 scrollTop；而且同步滚动
 * 那套「回音」判断必须知道这段动画什么时候结束（见 onFrame）。
 *
 * 中途用户自己滚（滚轮 / 按住滚动条）立刻让位 —— 抢在动画里跟人较劲最招人烦。
 */
/**
 * 每个滚动容器各自记账。
 *
 * 一开始这里是一个全局变量存「上一次动画的终止函数」，想的是「新跳转掐掉旧的」。
 * 结果大纲点一下要同时动两栏 —— 第二次调用顺手就把预览那一段掐死了，
 * 表现就是「预览区纹丝不动、只有编辑区滑了一下」。
 * 要掐的是**同一个容器**上的上一段动画，别的容器跟自己无关。
 */
const tweenStops = new WeakMap<HTMLElement, () => void>()

function tweenScroll(
  el: HTMLElement,
  to: number,
  opts: { ms?: number; onFrame?: () => void; redo?: () => number } = {},
) {
  const clamp = (v: number) => Math.max(0, Math.min(v, Math.max(0, el.scrollHeight - el.clientHeight)))
  const from = el.scrollTop
  const target = clamp(to)
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  tweenStops.get(el)?.()

  let dead = false
  const clean = () => {
    el.removeEventListener('wheel', giveUp)
    el.removeEventListener('pointerdown', giveUp)
    if (tweenStops.get(el) === stop) tweenStops.delete(el)
  }
  const stop = () => {
    dead = true
    clean()
  }
  const giveUp = () => stop()

  /** easeOutCubic：起步快、收尾稳，长距离也不晕 */
  const run = (a: number, b: number, dur: number) =>
    new Promise<void>((resolve) => {
      if (dur <= 0 || Math.abs(b - a) < 2) {
        el.scrollTop = b
        opts.onFrame?.()
        resolve()
        return
      }
      const t0 = performance.now()
      const step = (now: number) => {
        if (dead) return resolve()
        const p = Math.min(1, (now - t0) / dur)
        el.scrollTop = a + (b - a) * (1 - Math.pow(1 - p, 3))
        opts.onFrame?.()
        if (p < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })

  el.addEventListener('wheel', giveUp, { passive: true })
  el.addEventListener('pointerdown', giveUp)
  tweenStops.set(el, stop)

  void (async () => {
    await run(from, target, reduced ? 0 : (opts.ms ?? 300))
    if (dead) return
    /**
     * 落位之后的补正。
     *
     * CodeMirror 对「视口外那些行」只有估算高度。动画刚结束时它还没重新
     * measure，等它量完，行高被修正掉，那一行就不在预期位置上了 ——
     * 第一跳尤其容易偏，因为那时它连文档总高都还是估的。
     * 所以收尾时再问一次目标，差得明显就补一段极短的动画过去。
     * 只补一次，不递归：补到第三次说明偏的是别的东西，在动画里无限
     * 追下去只会变成抖动。
     */
    if (opts.redo) {
      const next = clamp(opts.redo())
      if (Math.abs(next - el.scrollTop) > 6) await run(el.scrollTop, next, reduced ? 0 : 150)
    }
    clean()
  })()
}

/**
 * 大纲点的那一项在预览里对应哪个元素。
 *
 * 先按 id 找；找不到就按文字找。id 是两边各自按文字生成的 slug（见
 * headingSlug），绝大多数情况对得上，但 setext 标题只存在于渲染后的 HTML 里、
 * 引用块里的 `#` 标题又只存在于源码里 —— 这两种情况下某一侧会多出一项，
 * 按文字兜底至少不会「点了没反应」。
 */
function findHeadingEl(box: HTMLElement, h: HeadingItem): HTMLElement | null {
  const byId = box.querySelector<HTMLElement>(`#${CSS.escape(h.id)}`)
  if (byId) return byId
  const all = [...box.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
  return (
    all.find((e) => (e.textContent ?? '').trim() === h.text) ??
    all.find((e) => (e.textContent ?? '').trim().includes(h.text)) ??
    null
  )
}

/**
 * 中间那一列的「大纲」里点了某个标题：两栏都滚过去。
 *
 * 两处都要小心：
 *  - 位置一律用「两个矩形的差」算，不用 offsetTop。offsetTop 是相对最近的
 *    定位祖先的，预览里那些卡片、代码块一旦有 position，读出来就是错的，
 *    点第三项会飞到别的地方去。
 *  - 动画期间要把同步滚动的回音窗口一直往后推。那个窗口原本只有 160ms，
 *    平滑动画要走 300ms，走到一半窗口就过期了，于是这一栏自己滚的那一路
 *    被当成「用户滚的」，反手又写回另一栏，两边互相拽，最后停在谁都没点过
 *    的地方（2.2.2 之前「点了乱跳」就是这个）。
 */
function onHeadingRequest(e: Event) {
  const h = (e as CustomEvent<HeadingItem>).detail
  if (!h) return
  state.activeHeading = h.id

  const box = previewRef.value
  if (box) {
    const el = findHeadingEl(box, h)
    if (el) {
      const r = el.getBoundingClientRect()
      const br = box.getBoundingClientRect()
      const top = box.scrollTop + (r.top - br.top) - 12
      tweenScroll(box, top, { onFrame: () => { echo.preview = performance.now() + 90 } })
    }
  }

  if (!view) return
  // 编辑区按行号滚：带源码行号的用现成的，没有才退回按文字找
  const lines = state.draft.split('\n')
  const line =
    h.line ??
    lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s*/, '').trim() === h.text)
  if (line < 0) return
  const max = view.state.doc.length
  const pos = Math.min(lines.slice(0, line).reduce((a, l) => a + l.length + 1, 0), max)
  // 目标 scrollTop 由 CodeMirror 的行块几何算出来：lineBlockAt 给的是
  // 「相对文档顶端」的偏移，加上 documentTop 才是屏幕坐标，再减掉
  // scrollDOM 自己的视口顶端，就是这一行要落到的滚动位置。
  // 写成函数是因为动画收尾还要再问一次（CM 量完会把行高修正掉）。
  const v = view
  const editorTarget = () => {
    const block = v.lineBlockAt(pos)
    const rect = v.scrollDOM.getBoundingClientRect()
    return v.scrollDOM.scrollTop + (v.documentTop + block.top - rect.top) - 10
  }
  tweenScroll(v.scrollDOM, editorTarget(), {
    onFrame: () => {
      echo.editor = performance.now() + 90
    },
    redo: editorTarget,
  })
}

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
async function render() {
  const { marked } = await getMarked()
  const raw = marked.parse(stripFrontMatter(state.draft), { async: false }) as string
  // 先补高亮与媒体路径，再做富块增强——顺序有讲究：
  // 富块会重新包裹 HTML 结构，先高亮能保证代码块（含 mermaid）已被标记成 language-*。
  const lit = await highlightFences(raw)
  const media = await resolveMediaInHtml(lit)
  const enhanced = enhancePreview(media)
  html.value = enhanced.html
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

/* ── 编辑 / 预览同步滚动 ──
   分栏时两边看的是同一篇，各滚各的会立刻「对不上号」：左边读到第三节，
   右边还停在开头。

   对齐用的不是像素比例，而是「在文档里的位置」：编辑区取当前看向的文档
   偏移，预览区取自己的滚动比例，两边互换着写。
   为什么不直接比像素：CodeMirror 是虚拟滚动的，离屏行的高度它自己也只
   是估算，一滚动就会重新测量并把 scrollHeight 改掉（实测同一篇文章能从
   3402 长到 4557），拿像素比例去同步，两边会互相追着跑。

   还得能认出「这一下是我自己写进去的」：两个方向都监听，各自判断这一下
   是不是自己的回音，是的话直接忽略，不然会来回弹。

   回音之所以要按「时间段」而不是按「落点值」来认：`view.dispatch()` 抛出
   来的滚动效果 CodeMirror 不会当场落到 DOM 上，它要等自己的 measure 阶段
   （下一帧）才真的挪动滚动条，所以 dispatch 完立刻读 scrollTop 读到的还
   是旧值 —— 拿它去比对等于没判。大纲点击用的是平滑滚动，会被这种「没判
   住的回音」在半路上写回预览区，结果就是点了大纲却跳不过去。 */
const ECHO_MS = 160
const echo = { editor: 0, preview: 0 }
const landed = { editor: -1, preview: -1 }

/** 编辑区当前看向文档的哪个位置（0~1） */
function editorRatio() {
  const v = view
  if (!v || v.state.doc.length === 0) return 0
  const from = v.visibleRanges[0]?.from ?? 0
  return from / v.state.doc.length
}

function syncFromEditor() {
  if (mode.value !== 'split') return
  const p = previewRef.value
  if (!p) return
  const max = p.scrollHeight - p.clientHeight
  if (max <= 0) return
  const next = Math.round(editorRatio() * max)
  if (Math.abs(p.scrollTop - next) <= 1) return
  landed.preview = next
  echo.preview = performance.now() + ECHO_MS
  p.scrollTop = next
}

function syncFromPreview() {
  if (mode.value !== 'split') return
  const v = view
  const p = previewRef.value
  if (!v || !p) return
  const max = p.scrollHeight - p.clientHeight
  if (max <= 0) return
  const pos = Math.round((p.scrollTop / max) * v.state.doc.length)
  // 用 scrollIntoView 效果而不是直接写 scrollTop：让 CodeMirror 自己
  // 决定要滚到哪（它知道内边距、也知道视口外那一行有多高）
  echo.editor = performance.now() + ECHO_MS
  v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) })
}

/**
 * 当前读到哪一节：给中间那一列的「大纲」高亮用。
 *
 * 两条来源，谁在就信谁：
 *  - 有预览（分栏 / 阅读）时按预览里标题元素的真实位置算，最准，
 *    setext 那种写在下一行的标题也能对上；
 *  - 纯写作模式没有预览，就按编辑区视口里靠顶那一行的行号往前找最近的标题。
 *    这条路读的是源码行号，所以标题一改大纲立刻跟着动，不用等 180ms 的渲染防抖。
 */
function markActiveHeading() {
  const heads = state.headings
  if (!heads.length) {
    state.activeHeading = null
    return
  }

  const p = previewRef.value
  if (p) {
    // 标题相对滚动容器顶部的位置：用两个矩形的差，不用 offsetTop ——
    // 预览里那些卡片、代码块一旦带 position，offsetTop 量的就是另一个父级，
    // 结果就是「明明滚到第三节了，大纲还高亮着第二节」。
    const base = p.getBoundingClientRect().top - p.scrollTop
    let cur: string | null = heads[0]?.id ?? null
    for (const h of heads) {
      const el = findHeadingEl(p, h)
      if (!el) continue
      if (el.getBoundingClientRect().top - base <= 64) cur = h.id
      else break
    }
    state.activeHeading = cur
    return
  }

  const v = view
  if (!v) return
  const scroller = v.scrollDOM
  const block = v.lineBlockAtHeight(scroller.scrollTop + scroller.clientHeight * 0.2)
  // line 是 0 起算的源码行号，CM 的行号从 1 起
  const line = v.state.doc.lineAt(block.from).number - 1
  let cur: string | null = heads[0]?.id ?? null
  for (const h of heads) {
    if (h.line == null || h.line > line) break
    cur = h.id
  }
  state.activeHeading = cur
}

const onEditorScroll = () => {
  const v = view
  if (!v) return
  const top = v.scrollDOM.scrollTop
  // 时间窗先兜住：我刚抛出去的滚动效果，可能要隔一帧才真的落到 DOM 上。
  // 平滑动画期间这个窗每帧都在往后推（见 tweenScroll 的 onFrame），
  // 所以「读到哪一节」也一并跳过 —— 动画一路上的中间位置不该点亮别的标题。
  if (performance.now() < echo.editor) {
    landed.editor = top
    return
  }
  markActiveHeading()
  // 之后再落到位附近的，也算我自己那一次搬运的余波
  if (Math.abs(top - landed.editor) <= 4) return
  syncFromEditor()
}

const onPreviewScroll = () => {
  const p = previewRef.value
  if (!p) return
  if (performance.now() < echo.preview) {
    landed.preview = p.scrollTop
    return
  }
  markActiveHeading()
  if (Math.abs(p.scrollTop - landed.preview) <= 4) return
  syncFromPreview()
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
 * 编辑区专用的媒体路径换算（代码高亮那部分已抽到 @/editor/markdown，
 * 预览与 AI 对话页共用同一套渲染管线）。
 */

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

/* ── 右键菜单 ── */

/** 菜单的落点与可用状态。为 null 时菜单不渲染 */
const menu = ref<EditorMenuTarget | null>(null)

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  const v = view
  if (!v) return
  const { from, to } = v.state.selection.main
  menu.value = {
    x: e.clientX,
    y: e.clientY,
    hasSelection: from !== to,
    canUndo: undoDepth(v.state) > 0,
    canRedo: redoDepth(v.state) > 0,
  }
}

function closeMenu() {
  menu.value = null
}

function undoEdit() {
  if (view) undo(view)
}

function redoEdit() {
  if (view) redo(view)
}

function selectAll() {
  if (!view) return
  view.dispatch({
    selection: { anchor: 0, head: view.state.doc.length },
    scrollIntoView: true,
  })
  view.focus()
}

/** 有选区就复制它；没有选区时「复制」无从谈起，直接返回 */
function selectedText() {
  const v = view
  if (!v) return ''
  const { from, to } = v.state.selection.main
  return from === to ? '' : v.state.sliceDoc(from, to)
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    onToolbarToast('剪贴板不可用')
    return false
  }
}

async function copySel() {
  const t = selectedText()
  if (t) await writeClipboard(t)
}

async function cutSel() {
  const v = view
  if (!v) return
  const t = selectedText()
  if (!t) return
  if (!(await writeClipboard(t))) return
  const { from, to } = v.state.selection.main
  v.dispatch({ changes: { from, to }, selection: { anchor: from } })
  v.focus()
}

async function pasteFrom() {
  const v = view
  if (!v) return
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    onToolbarToast('读取剪贴板失败')
    return
  }
  if (!text) return
  const { from, to } = v.state.selection.main
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  })
  v.focus()
}

/** 菜单里的 AI 动作：对选中的那段下手 */
async function onMenuAi(kind: 'expand' | 'polish' | 'summarize' | 'translate') {
  const v = view
  if (!v) return
  const MAP: Record<string, AiAction> = {
    expand: 'continue',
    polish: 'polish',
    summarize: 'summarize',
    translate: 'translate',
  }
  await runAi(v, MAP[kind] ?? 'polish')
}

/** 工具栏提示：模板里拿不到 window，统一从这里转发 */
function onToolbarToast(text: string) {
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: text }))
}

/* ── 创建 / 销毁编辑器 ── */

/** 行号 / 自动换行要能运行时开关，走 Compartment 重配置而不是重建编辑器 */
const prefsCompartment = new Compartment()

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
    prefsCompartment.of(
      editorViewPrefs({ lineWrap: state.lineWrap, lineNumbers: state.lineNumbers }),
    ),
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

  // 分栏时的同步滚动：编辑区这一侧要监听它的滚动容器
  view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })

  // 供自动化验证脚本访问（无副作用，不参与业务逻辑）
  ;(window as unknown as { __notaView?: EditorView | null }).__notaView = view
}

/** 销毁编辑器：顺手把滚动监听摘掉，否则重启编辑器会挂上第二个 */
function destroyEditor() {
  if (!view) return
  view.scrollDOM.removeEventListener('scroll', onEditorScroll)
  view.destroy()
  view = null
  ;(window as unknown as { __notaView?: EditorView | null }).__notaView = null
}

// 设置里改了行号 / 换行：直接重配置视图偏好，滚动位置与撤销历史都不受影响
watch(
  () => [state.lineWrap, state.lineNumbers] as const,
  ([lineWrap, lineNumbers]) => {
    view?.dispatch({
      effects: prefsCompartment.reconfigure(editorViewPrefs({ lineWrap, lineNumbers })),
    })
  },
)

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

/* ── 顶行的「挤窄降级」 ──
   这一行里住着八样东西，靠 flex 让它们自己挤的结果一定是两败俱伤：
   标题被压到十几像素（它是这篇文档的名字，最不该吃亏），
   而右边那堆永远不让步，最后把窗口按钮顶到屏幕外边去。
   所以按主人不在也无所谓 → 有事时才需要看的顺序，定三档让位。
   档位看的是**编辑区自己**有多宽，不是窗口有多宽 —— 中间那一列
   换成 AI 面板时能吃掉三成窗口，同样的窗口宽度，编辑区只剩一半。 */
const paneEl = ref<HTMLElement | null>(null)
const phEl = ref<HTMLElement | null>(null)
// 0 档＝什么都不收；每升一档，让位的是其中离「非看不可」最远的那一样（见下面 CSS）
const { tier: crammed } = useFitTiers(phEl, paneEl, 4)

onMounted(() => {
  render()
  nextTick(() => {
    createEditor()
    // 笔记内容可能晚于组件挂载到达，这里补一次同步
    pushDoc(state.draft)
  })
  window.addEventListener('keydown', onViewKey)
  window.addEventListener('nota:insert', onInsertRequest)
  window.addEventListener('nota:tag', onTagRequest)
  window.addEventListener('nota:heading', onHeadingRequest)
})

/* 预览容器是 v-if 出来的：从「编辑」切到「分栏」时它才出现，
   所以监听要挂在 ref 本身的变化上，光在 onMounted 挂会漏掉这半程。 */
watch(previewRef, (el, old) => {
  old?.removeEventListener('scroll', onPreviewScroll)
  el?.addEventListener('scroll', onPreviewScroll, { passive: true })
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

/**
 * 侧栏「新建标签」要求给当前这篇加上一个标签。
 *
 * 标签在 Nota 里没有单独的库，它的唯一来源就是笔记开头的 frontmatter，
 * 所以「新建标签」＝改这篇笔记：有 frontmatter 就并进 tags，没有就补一段。
 * 改动走 view.dispatch 进历史栈 —— Ctrl+Z 能撤销，自动保存也会照常落盘，
 * 不用另外开一条写文件的通道（那样会绕过正在编辑的缓冲区）。
 */
function onTagRequest(e: Event) {
  const raw = (e as CustomEvent<string>).detail
  const v = view
  if (!v || !raw) return
  const tag = raw.trim().replace(/^#+/, '')
  if (!tag) return

  const doc = v.state.doc.toString()
  const next = withTag(doc, tag)
  if (next === doc) {
    window.dispatchEvent(new CustomEvent('nota:toast', { detail: `这篇已经有 #${tag} 了` }))
    return
  }
  const at = v.state.selection.main.head
  v.dispatch({
    changes: { from: 0, to: doc.length, insert: next },
    // 尽量把光标留在原处：frontmatter 变长/变短多少就补多少
    selection: { anchor: Math.max(0, Math.min(next.length, at + (next.length - doc.length))) },
    userEvent: 'input.insert',
  })
  window.dispatchEvent(new CustomEvent('nota:toast', { detail: `已加上标签 #${tag}` }))
  // 标签虽然只是在正文里加了一行，但侧栏那份标签清单是从目录树读出来的。
  // 等这一笔落盘（自动保存 600ms 防抖）后重读一次树，不然新标签要等到
  // 下次开关工作区才在侧栏出现 —— 加了却看不见，等于没加。
  window.setTimeout(() => {
    void store.saveNote({ silent: true }).then(() => store.refreshTree())
  }, 700)
}

/** 把标签并进 frontmatter。返回原文表示「已经有了」 */
function withTag(doc: string, tag: string): string {
  const fm = doc.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (!fm) return `---\ntags: [${tag}]\n---\n\n${doc}`

  const head = fm[1]
  const tagsLine = /^(tags|tag)\s*:\s*(.*)$/m
  const m = head.match(tagsLine)
  let body: string
  if (!m) {
    body = `${head}\ntags: [${tag}]`
  } else {
    // 两种写法都认：`tags: [a, b]` 和 `tags:` 下面挂一串 `- a`
    const inline = m[2].trim()
    if (/^\[.*\]$/.test(inline)) {
      const cur = inline
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      if (cur.includes(tag)) return doc
      cur.push(tag)
      body = head.replace(tagsLine, `${m[1]}: [${cur.join(', ')}]`)
    } else if (inline === '') {
      // 块状写法：在紧跟其后的那串 `- x` 里补一行
      const lines = head.split('\n')
      const idx = lines.findIndex((l) => tagsLine.test(l))
      let end = idx + 1
      while (end < lines.length && /^\s*-\s+/.test(lines[end])) end += 1
      const pad = (lines[idx + 1]?.match(/^\s*/) ?? [''])[0] || '  '
      lines.splice(end, 0, `${pad}- ${tag}`)
      body = lines.join('\n')
    } else {
      // `tags: 随笔` 这种单值写法
      if (inline.replace(/^["']|["']$/g, '') === tag) return doc
      body = head.replace(tagsLine, `${m[1]}: [${inline}, ${tag}]`)
    }
  }
  return `---\n${body}\n---\n${doc.slice(fm[0].length)}`
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  if (previewTimer) clearTimeout(previewTimer)
  previewRef.value?.removeEventListener('scroll', onPreviewScroll)
  destroyEditor()
  window.removeEventListener('keydown', onViewKey)
  window.removeEventListener('nota:insert', onInsertRequest)
  window.removeEventListener('nota:tag', onTagRequest)
  window.removeEventListener('nota:heading', onHeadingRequest)
})

// 切笔记：重排预览，并把这一篇的内容交给编辑器
watch(
  () => state.activePath,
  async () => {
    render()
    await nextTick()
    pushDoc(state.draft)
    view?.focus()
  }
)

/**
 * draft 是内容的唯一真相：它一变就把编辑器对齐过去。
 *
 * 只盯 activePath 是不够的——openNote 是「先读盘再赋值」，读盘那一下是异步的，
 * 只在 activePath 变化时灌内容，灌进去的可能是上一篇还没换掉的旧 draft，
 * 于是编辑器里装的永远是上一篇（前一篇是空的新笔记时，看起来就是「笔记消失了」）。
 * 这里补一条兜底：不管 draft 是谁在什么时候改的（切笔记、导入、AI 写入、
 * 历史回溯、收藏打的 frontmatter），只要和编辑器不一致就同步一次。
 *
 * 用户自己打字那条路径不会打架：CM 先把 draft 写成自己那份，
 * 于是这里读到的就是编辑器里已有的内容，pushDoc 直接跳过（syncing 也只是双保险）。
 */
watch(
  () => state.draft,
  (text) => {
    pushDoc(text)
  },
)

// 阅读模式：销毁编辑器省内存；回到编辑/分栏再重建。
// 注意先判空——从「分栏」切回「编辑」时编辑器还在，
// 再 createEditor() 会把第二个实例叠进同一个容器，页面上就会出现两套编辑器。
watch(mode, async (m) => {
  if (m === 'read') {
    destroyEditor()
    await render()
  } else {
    await nextTick()
    if (!view) {
      createEditor()
      pushDoc(state.draft)
    }
    // 阅读模式下编辑区整块是隐藏的，重建后让 CM 立刻量一次尺寸，
    // 不量它会沿用旧的视口高度，首屏可能只画出半屏甚至一片空白
    view?.requestMeasure()
    await render()
    await nextTick()
    flashPaneIn()
  }
})

/**
 * 从「阅读」切回写作 / 分栏时给编辑侧补一段淡入。
 *
 * 它是 v-show 的（编辑器不能真卸载），没有「刚挂载」这一刻可以挂动画，
 * 只能手动补：先摘掉 class、读一次 offsetWidth 强制回流、再加回去 ——
 * 少了中间那步，同一个 class 连着加两次浏览器不会重放动画。
 */
function flashPaneIn() {
  const el = edWrap.value
  if (!el) return
  el.classList.remove('pane-in')
  void el.offsetWidth
  el.classList.add('pane-in')
}

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

/** 深浅色一键切换：窗口按钮旁边那一枚，不打开设置也能换 */
function toggleTheme() {
  store.setTheme(state.theme === 'light' ? 'dark' : 'light')
}

/** 工具栏调用入口：把 EditorView 暴露给子组件 */
defineExpose({ getView: () => view })
</script>

<template>
  <div ref="paneEl" class="pane" :data-crammed="crammed || null">
    <!-- 顶部：左边是可编辑的标题，下面一行是它在工作区里的位置；
         右边是字数、保存状态、动作、视图切换，最右是三颗窗口按钮。
         这一整条也是拖动窗口的地方（按钮自己声明不参与拖动）。 -->
    <header ref="phEl" class="ph" :data-crammed="crammed || null">
      <div class="ph-id">
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
        <span class="ph-path" :title="state.activePath ?? ''">{{ relPath }}</span>
      </div>

      <div class="ph-right">
        <span class="ph-stat">{{ statText }}</span>

        <!-- 保存状态：图标 + 文案，比一个圆点说得更清楚 -->
        <span class="ph-save" :class="saveState" :title="saveLabel">
          <Loader2 v-if="saveState === 'saving'" class="spin" :size="12" :stroke-width="2" />
          <Check v-else-if="saveState === 'saved'" :size="12" :stroke-width="2.1" />
          <span v-else class="ph-dot" />
          <span class="ph-save-text">{{ saveLabel }}</span>
        </span>

        <!-- 只留「对当前这一篇做什么」：导出、版本历史。
             新建 / 导入管的是「工作区里有哪些笔记」，2.2.3 起搬到资料栏右上角。 -->
        <EditorActions />

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

        <!-- 深浅色切换：紧贴窗口按钮，是「窗口级」的开关，
             跟视图切换那种「这篇文档怎么看」不是一类东西。
             1.9 之前它在旧的全局标题栏里，2.0 重划顶部时弄丢了，这里补回来。 -->
        <button
          class="ph-icon"
          data-role="theme-toggle"
          :title="state.theme === 'light' ? '切到深色' : '切到浅色'"
          @click="toggleTheme"
        >
          <Moon v-if="state.theme === 'light'" :size="14" :stroke-width="1.9" />
          <Sun v-else :size="14" :stroke-width="1.9" />
        </button>
      </div>

      <WindowControls />
    </header>

    <Toolbar
      v-if="showEditor"
      :get-view="() => view"
      @toast="onToolbarToast"
      @embed="embedOpen = true"
      @find="openFind"
    />

    <div class="stage" :data-layout="mode">
      <div ref="edWrap" v-show="showEditor" class="ed-wrap">
        <div ref="host" class="host" @contextmenu="onContextMenu" />

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
          class="preview md-body"
          v-html="html"
        />
        <!-- 大纲已经挪到中间那一列的「大纲」页签里，右边不再重复出一份 -->
      </div>

      <NotePickerDialog
        :open="embedOpen"
        title="嵌入笔记"
        @pick="embedNote"
        @close="embedOpen = false"
      />

      <!-- 右键菜单：挂在 body 上，不受编辑区滚动与裁剪影响 -->
      <EditorContextMenu
        :target="menu"
        :ai-enabled="state.ai.enabled"
        :ai-busy="state.aiBusy"
        @close="closeMenu"
        @undo="undoEdit"
        @redo="redoEdit"
        @cut="cutSel"
        @copy="copySel"
        @paste="pasteFrom"
        @select-all="selectAll"
        @ai="onMenuAi"
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

/* ── 顶部区域 ──
   和侧栏、中间栏的顶栏同高（--n-topbar），三栏的分隔线才能连成一条。
   左边是标题 + 它的位置，右边是动作与视图切换，最右是三颗窗口按钮。
   整条是窗口拖动区，藏在这里比单开一条横贯整窗的标题栏省一行。 */
.ph {
  flex: none;
  height: var(--n-topbar);
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 12px;
  border-bottom: 1px solid var(--n-line);
  background: var(--n-surface);
  -webkit-app-region: drag;
}

/* 标题与路径竖着叠：参考图里标题下面那行就是「这篇在哪儿」 */
.ph-id {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.ph-path {
  padding: 0 8px;
  font-size: 10.5px;
  line-height: 1.3;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ph-title {
  width: 100%;
  min-width: 0;
  height: 20px;
  padding: 0 8px;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--n-fg);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--n-r-sm);
  outline: none;
  /* 标题栏是拖动区，但标题本身要能点进去改——别把编辑也一起拖走 */
  -webkit-app-region: no-drag;
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

/* ── 挤窄时的让位顺序 ──
   这一排住着八样东西，谁都不肯让一步的结果就是两败俱伤：标题被压到十几像素，
   右边那堆把窗口按钮顶到屏幕外面去。所以按「少了它多久会被发现」排序让位：
     1 档 字数收掉 —— 它只是个数字
     2 档 保存只留那颗灯 —— 颜色照样说得清状态，文案退到 tooltip
     3 档 导出收掉 —— 笔记卡片右键菜单里四种格式都在
     4 档 连视图切换也收 —— Ctrl+1 / 2 / 3 还在
   什么时候升档不写阈值，由 useFitTiers 逐档试到「这一排装得下」为止。 */
.ph-id {
  /* 标题是这篇文档的名字，给它留一条底线：再挤也不能压成一横杠 */
  min-width: 88px;
}

.ph[data-crammed="1"],
.ph[data-crammed="2"],
.ph[data-crammed="3"],
.ph[data-crammed="4"] {
  gap: 6px;
  padding-left: 10px;
}

.ph[data-crammed="1"] .ph-stat,
.ph[data-crammed="2"] .ph-stat,
.ph[data-crammed="3"] .ph-stat,
.ph[data-crammed="4"] .ph-stat,
.ph[data-crammed="2"] .ph-save-text,
.ph[data-crammed="3"] .ph-save-text,
.ph[data-crammed="4"] .ph-save-text,
.ph[data-crammed="3"] .ea .ea-anchor,
.ph[data-crammed="4"] .ea .ea-anchor,
.ph[data-crammed="4"] .ph-seg {
  display: none;
}

.ph[data-crammed="2"] .ph-right,
.ph[data-crammed="3"] .ph-right,
.ph[data-crammed="4"] .ph-right {
  gap: 7px;
  padding-right: 8px;
}

.ph-right {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 10px;
  /* 里面的按钮都要能点，不能跟着顶栏一起拖 */
  -webkit-app-region: no-drag;
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
   一眼分清「有没有存上」比安静更重要，所以走交通灯：
   未保存亮红（要你处理）、保存中强调色、已保存亮绿（可以放心走）。 */
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
  color: var(--n-danger);
}

.ph-save.saved {
  color: var(--n-ok);
}

/* 未保存 / 保存中用小圆点表示，保持和原来一致的克制 */
.ph-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--n-fg-faint);
  flex: none;
  margin: 0 3px;
}

.ph-save.dirty .ph-dot {
  background: var(--n-danger);
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
  padding: 0;
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
  /* 切到分栏 / 阅读时这一块是刚挂载的，淡一下，别突然拍在脸上 */
  animation: n-pane-in 180ms var(--n-ease);
}

/* 编辑侧是 v-show（不能真的卸载，CodeMirror 得留着），
   所以没有「挂载」这一刻可以挂动画，只能切回写作/分栏时补一个 class。
   只淡不位移：位移会让 CodeMirror 在这两百毫秒里量到的坐标全是偏的。 */
.ed-wrap.pane-in {
  animation: n-pane-in 180ms var(--n-ease);
}

@keyframes n-pane-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
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
</style>
