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
  CaseSensitive,
  WholeWord,
  Regex,
  Replace,
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
  replaceAll,
  replaceNext,
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
  prepareMarkdown,
  outlineFromSource,
  findTaskLine,
} from '@/editor/preview-rich'
import type { HeadingItem } from '@/editor/preview-rich'
import { getMarked, highlightFences } from '@/editor/markdown'
import Toolbar from '@/components/Toolbar.vue'
import NotePickerDialog, { type PickMode } from '@/components/NotePickerDialog.vue'
import SlashMenu from '@/components/SlashMenu.vue'
import EditorActions from '@/components/EditorActions.vue'
import WindowControls from '@/components/WindowControls.vue'
import {
  toolbarInline,
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
 * 预览里每个标题的纵向位置。
 *
 * 它同时是「源码行号 ↔ 预览纵坐标」这条折线插值函数的**断点表**：
 * 编辑区→预览按行号插值出纵坐标，预览→编辑区按纵坐标反插值出行号。
 * 两个方向必须共用这一套断点 —— 这不是洁癖，是不共用就一定会出事：
 * 两边不互逆时，任何一次多余的同步都会把另一栏拽走一大截
 * （实测：点大纲落位后预览只多滚 6px，编辑区被甩出去十个百分点）。
 *
 * 只在内容 / 标题结构 / 预览宽度变了才重建一次 —— 每帧去读三十个 rect
 * 会强制浏览器布局，太重。
 */
interface HeadingMark {
  id: string
  line: number
  /** 这个标题在预览内容坐标系里的纵坐标（不是视口坐标） */
  pTop: number
}
/* 这两个必须声明在**第一次用到它们的 watcher 之前**。
   下面那个算标题的 watcher 带 `immediate: true`，它在 setup 阶段就跑，
   而 `let` 在声明语句执行之前一直处于 TDZ —— 声明要是写在文件后面，
   那句 `marksDirty = true` 会在启动时直接抛
   「Cannot access 'marksDirty' before initialization」，整个界面白屏。
   `marksRo` 同理，一起放这儿。 */
let headingMarks: HeadingMark[] = []
let marksDirty = true
let marksRo: ResizeObserver | null = null

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
    // 标题结构一变，之前量好的位置就不再对应了
    marksDirty = true
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
  // 落点用同步滚动那套换算（`editorTopForLine`），不在这里另写一份 ——
  // 两份算法只要有一处不一致，点大纲和滚编辑区就会落到两个不同的位置。
  const v = view
  const editorTarget = () => {
    const raw = editorTopForLine(line) - 10
    return Math.max(0, Math.min(editorMaxScroll(), raw))
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

/**
 * 顶栏那个字数。
 *
 * 以前是 `computed(() => countWords(state.draft))` —— 于是每敲一个字都对整篇
 * 跑一遍统计。它是 CPU profile 里排名第一的热点函数（远在大纲抽词之上）：
 * 2400 行的笔记上，光这一项就吃掉每次按键的一大块预算，打字手感直接受影响。
 *
 * 现在给它 250ms 的防抖。「这篇多少字」是个给人看的数字，
 * 没必要精确到你刚按下那个键；而「滞后 0.25 秒」是没人感觉得到的。
 * 切笔记/首屏则立刻给准数 —— 那才是有可能被人盯着看的时刻。
 */
const statText = ref(formatWordCount(countWords(state.draft)))
let statTimer: ReturnType<typeof setTimeout> | null = null

function applyStat() {
  statText.value = formatWordCount(countWords(state.draft))
}

function scheduleStat(immediate = false) {
  if (statTimer) {
    clearTimeout(statTimer)
    statTimer = null
  }
  if (immediate) {
    applyStat()
    return
  }
  statTimer = setTimeout(() => {
    statTimer = null
    applyStat()
  }, 250)
}

watch(
  () => state.draft,
  () => scheduleStat(false),
)
/* 切笔记（含「新打开一篇」）要立刻刷新：这时候数字会被盯着看 */
watch(
  () => state.activePath,
  () => scheduleStat(true),
)

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
  const raw = marked.parse(prepareMarkdown(state.draft), { async: false }) as string
  // 先补高亮与媒体路径，再做富块增强——顺序有讲究：
  // 富块会重新包裹 HTML 结构，先高亮能保证代码块（含 mermaid）已被标记成 language-*。
  const lit = await highlightFences(raw)
  const media = await resolveMediaInHtml(lit)
  const enhanced = enhancePreview(media)
  /* 重排会把整个正文 DOM 换掉，滚动高度瞬间归零再长回来 —— 点个待办、
     勾个勾整个预览抖一下就是这么来的。换 DOM 前记住滚到哪，换完再放回去；
     mermaid / 公式画完把高度撑起来之后还要再放一次，否则那一下还是会跳。 */
  const paneEl = previewRef.value
  const keepTop = paneEl?.scrollTop ?? 0
  html.value = enhanced.html
  // 预览换了一批 DOM，标题的纵向位置缓存作废
  marksDirty = true
  // 异步填料的两种「重资产」：mermaid 画图、katex 排公式
  await nextTick()
  const pane = previewRef.value
  if (pane) {
    pane.scrollTop = keepTop
    markWikiLinks(pane)
    /**
     * 这两样都是**画完之后才把高度撑起来**的：公式从占位符变成排版好的
     * 行内盒子，图表从一段灰色源码变成一张 SVG。画完之前量出来的标题
     * 纵坐标全是早的，同步会照着旧坐标走。
     */
    void Promise.all([renderMathInHtml(pane), renderMermaidInHtml(pane)]).then(() => {
      pane.scrollTop = keepTop
      marksDirty = true
    })
  }
}

/* ── 编辑区查找条 ──
   匹配逻辑仍交给 @codemirror/search（setSearchQuery + findNext/Previous），
   这样高亮和滚动行为与编辑器原生一致，画出来的只是上面那条输入框。

   三个开关（大小写 / 全字 / 正则）和一个替换行都是后补的：原来只有「找」，
   于是「把整篇里的 Nota 改成 nota」这种事得手工一个个改，
   而「只找单词 foo、不要 foobar」根本做不到。默认都关着 ——
   多数时候人只想找一串字，不该先去关掉三个开关。 */
const findOpen = ref(false)
const findText = ref('')
const findTotal = ref(0)
const findAt = ref(0)
const findInput = ref<HTMLInputElement | null>(null)
/** 区分大小写。关着时 Nota 能匹配 nota */
const findCase = ref(false)
/** 全字匹配：只找「两边都不是字母数字」的那些 */
const findWord = ref(false)
/** 正则。开着时输入框交给 RegExp，写坏了就地提示，不让整条查找崩掉 */
const findRegex = ref(false)
const findError = ref('')
/** 替换行：默认收着，点那个 A→B 图标才展开 */
const replaceOpen = ref(false)
const replaceText = ref('')

const findCountText = computed(() => {
  if (findError.value) return '条件有误'
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
  findError.value = ''
  // 替换行跟着收：留着的话下次打开会先看到一整行空输入框
  replaceOpen.value = false
  replaceText.value = ''
  const v = view
  if (v) v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) })
  v?.focus()
}

/**
 * 按当前三个开关造一条查询。
 *
 * 替换文本也一并塞进去 —— replaceNext / replaceAll 取的是查询对象上的
 * replace 字段，不是自己的参数；只建查询不填它，替换会变成「删掉」。
 *
 * 正则写坏时构造函数不抛异常，而是给一个 `valid: false` 的对象，
 * 所以要看 valid，不能靠 try/catch。
 */
function buildQuery(text: string): SearchQuery {
  const q = new SearchQuery({
    search: text,
    caseSensitive: findCase.value,
    wholeWord: findWord.value,
    regexp: findRegex.value,
    replace: replaceText.value,
  })
  return q.valid ? q : new SearchQuery({ search: '' })
}

function queryOk(text: string) {
  return new SearchQuery({
    search: text,
    caseSensitive: findCase.value,
    wholeWord: findWord.value,
    regexp: findRegex.value,
    replace: replaceText.value,
  }).valid
}

/** 重新计数，并标出光标当前停在第几个匹配上 */
function refreshFind() {
  const v = view
  if (!v) return
  const text = findText.value
  const query = buildQuery(text)
  if (text && !queryOk(text)) {
    findError.value = '正则表达式有误'
    findTotal.value = 0
    findAt.value = 0
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) })
    return
  }
  findError.value = ''
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
  if (!v || !findText.value || findError.value) return
  if (dir === 1) findNext(v)
  else findPrevious(v)
  refreshFind()
}

/** 三个开关任何一个动了都要整条重算：高亮、计数、当前项全都跟着变 */
function onFindOption() {
  refreshFind()
}

/**
 * 替换当前这一处。replaceNext 自带「换完顺带跳到下一处」，正好是想要的。
 *
 * 先 refreshFind 一次：替换文本是绑在输入框上的，不重算的话查询里带的
 * 还是上一次的替换内容。
 */
function doReplaceOne() {
  const v = view
  if (!v || !findText.value || findError.value) return
  refreshFind()
  if (findError.value) return
  replaceNext(v)
  refreshFind()
}

/** 全文替换。改的是文档而不是草稿字符串，所以撤销（Ctrl+Z）能一次退回来 */
function doReplaceAll() {
  const v = view
  if (!v || !findText.value || findError.value) return
  refreshFind()
  if (findError.value) return
  replaceAll(v)
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

/**
 * 编辑区当前顶到哪一行（小数行号，0 起）。
 *
 * 这里必须是一个**连续**的量。早先取 `visibleRanges[0].from`（视口起点），
 * 想法没错 —— 视口之外的行没有精确高度，只能拿到估算值。但视口是
 * CodeMirror 按块维护的，要滚过一整个 viewportMargin 才会更新一次，
 * 于是同步出来的预览是「滚了半天纹丝不动，然后猛跳一截」：
 * 实测滚 25 格滚轮，预览前 24 帧全是 0，第 25 帧一次性跳 554px。
 *
 * 改成「滚动位置落在哪一行 + 这一行走过几成」：scrollTop 是连续的，
 * 行块高度取自 CM 已经量好的数据，两者相除得到行内比例。
 * 小数部分留着，别取整 —— 取整会让两端各丢掉不到一行的余量，
 * 来回同步时那点余量会变成来回抖。
 */
function editorLineAtTop(): number {
  const v = view
  if (!v || v.state.doc.length === 0) return 0
  const scroller = v.scrollDOM
  const block = v.lineBlockAtHeight(scroller.scrollTop)
  const h = block.bottom - block.top
  const inside = h > 0 ? Math.min(1, Math.max(0, (scroller.scrollTop - block.top) / h)) : 0
  // CM 的行号从 1 起，大纲记的是 0 起
  return Math.max(0, v.state.doc.lineAt(block.from).number - 1 + inside)
}

/**
 * 反过来：要把某一行（小数，0 起）顶到编辑区视口顶端，scrollTop 该是多少。
 *
 * 跟上一个函数互为逆运算 —— 都走 CodeMirror 自己的行块几何，
 * 所以「编辑区滚到 X → 预览滚到 Y → 预览再写回编辑区」能回到 X。
 *
 * 返回值用的是**内容纵坐标**：CM 的 `lineBlockAt` 给的是相对文档顶端的偏移，
 * 加上 `documentTop`（文档顶端在屏幕上的位置）才是屏幕坐标，
 * 再减掉滚动容器自己的视口顶端、加回当前 scrollTop，就换算到了滚动坐标系 ——
 * 也就是「这一行落在视口顶端时的 scrollTop」。这个换算跟当前滚到哪无关，
 * 所以在动画中途反复问它都是安全的。
 */
function editorTopForLine(fracLine: number): number {
  const v = view
  if (!v || v.state.doc.lines === 0) return 0
  const line = Math.max(0, Math.min(v.state.doc.lines - 1, Math.floor(fracLine)))
  const frac = Math.min(1, Math.max(0, fracLine - line))
  const block = v.lineBlockAt(v.state.doc.line(line + 1).from)
  const rect = v.scrollDOM.getBoundingClientRect()
  const contentY = v.scrollDOM.scrollTop + (v.documentTop + block.top - rect.top)
  return contentY + (block.bottom - block.top) * frac
}

/** 编辑区能滚到的最大值 */
function editorMaxScroll(): number {
  const v = view
  if (!v) return 0
  return Math.max(0, v.scrollDOM.scrollHeight - v.scrollDOM.clientHeight)
}

/**
 * 标题在预览里的纵向位置（相对预览**内容**顶端，不是视口）。
 *
 * 每帧去读三十个标题的 rect 太重 —— 读 rect 会强制浏览器布局。而预览
 * 内容不变时这些位置根本不会动，所以只在内容或标题结构变了之后重建一次。
 */
function rebuildMarks() {
  headingMarks = []
  marksDirty = false
  const p = previewRef.value
  if (!p) return
  const base = p.getBoundingClientRect().top - p.scrollTop
  for (const h of state.headings) {
    if (h.line == null) continue
    const el = findHeadingEl(p, h)
    if (!el) continue
    headingMarks.push({ id: h.id, line: h.line, pTop: el.getBoundingClientRect().top - base })
  }
  // 断点必须按行号递增，反插值才找得到区间
  headingMarks.sort((a, b) => a.line - b.line)
}

/**
 * 源码行号 → 预览里应该滚到的纵坐标。
 *
 * 拿「字符比例 × 预览总高」直接算是错的：源码里一个标题只占十来个字符，
 * 渲染出来却是一整块带上下留白的区域。实测按字符比例同步，编辑区滚到底
 * 时预览才走到 65%。
 *
 * 所以拿标题当锚点：找到这一行夹在哪两个标题之间，按行号在它们的实际
 * 渲染位置之间插值。两端因此严格对齐 —— 第 0 行落在 0，最后一行落在底部。
 * 没有标题可依时（比如一篇纯正文）才退回滚动比例。
 */
function previewTopForLine(line: number): number {
  const p = previewRef.value
  if (!p) return 0
  if (marksDirty) rebuildMarks()
  const total = p.scrollHeight
  if (headingMarks.length === 0) {
    // 没有标题做锚点：编辑区走到文档的几成，预览就走到自己的几成
    const lines = view ? view.state.doc.lines : 1
    return total * Math.min(1, Math.max(0, line / Math.max(1, lines - 1)))
  }

  for (let i = 0; i < headingMarks.length; i++) {
    const m = headingMarks[i]
    if (m.line > line) {
      const prev = i > 0 ? headingMarks[i - 1] : null
      if (!prev) return m.line > 0 ? (line / m.line) * m.pTop : 0
      const span = m.line - prev.line
      const r = span > 0 ? (line - prev.line) / span : 0
      return prev.pTop + (m.pTop - prev.pTop) * r
    }
  }
  // 落在最后一个标题之后：从它插值到内容底部
  const last = headingMarks[headingMarks.length - 1]
  const totalLines = view ? view.state.doc.lines : last.line + 1
  const span = Math.max(1, totalLines - last.line)
  const r = Math.min(1, (line - last.line) / span)
  return last.pTop + (total - last.pTop) * r
}

/**
 * 上面的逆运算：预览里的纵坐标 → 源码行号（小数）。
 *
 * 断点和插值方式必须跟 `previewTopForLine` 逐段一致，两个方向才是互逆的。
 * 以前这一路是拿「预览滚动比例 × 文档字符数」直接算的，跟那边完全不是一回事，
 * 结果就是：编辑区 50% → 预览 26.9% → 预览再把编辑区写到 36.6%，
 * 来回滚一次就跑掉十几个百分点。表现到界面上，就是点完大纲之后
 * 编辑区被莫名其妙地拽走一大截。
 */
function previewLineForTop(top: number): number {
  const p = previewRef.value
  if (!p) return 0
  if (marksDirty) rebuildMarks()
  const total = p.scrollHeight
  const lines = view ? view.state.doc.lines : 1
  if (headingMarks.length === 0) {
    return Math.min(1, Math.max(0, top / Math.max(1, total))) * Math.max(0, lines - 1)
  }

  for (let i = 0; i < headingMarks.length; i++) {
    const m = headingMarks[i]
    if (top < m.pTop) {
      const prev = i > 0 ? headingMarks[i - 1] : null
      if (!prev) return m.pTop > 0 ? (top / m.pTop) * m.line : 0
      const span = m.pTop - prev.pTop
      const r = span > 0 ? (top - prev.pTop) / span : 0
      return prev.line + (m.line - prev.line) * r
    }
  }
  const last = headingMarks[headingMarks.length - 1]
  const span = Math.max(1, total - last.pTop)
  const r = Math.min(1, (top - last.pTop) / span)
  return last.line + (lines - last.line) * r
}

/**
 * 同步里那点固定的余量。
 *
 * 编辑区→预览时减掉它（让标题离顶边 12px，不至于贴着边），
 * 预览→编辑区时就必须**加回来**，不然反插值会偏掉这一截，
 * 两个方向又不再互逆了。
 */
const SYNC_INSET = 12

function syncFromEditor() {
  if (mode.value !== 'split') return
  const p = previewRef.value
  if (!p) return
  const max = p.scrollHeight - p.clientHeight
  if (max <= 0) return
  const next = Math.round(
    Math.max(0, Math.min(max, previewTopForLine(editorLineAtTop()) - SYNC_INSET)),
  )
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
  // 预览视口顶端看的是哪一行的位置 → 那一行在编辑区该有的 scrollTop
  const line = previewLineForTop(p.scrollTop + SYNC_INSET)
  const next = Math.round(Math.max(0, Math.min(editorMaxScroll(), editorTopForLine(line))))
  const scroller = v.scrollDOM
  if (Math.abs(scroller.scrollTop - next) <= 1) return
  landed.editor = next
  echo.editor = performance.now() + ECHO_MS
  scroller.scrollTop = next
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
    /* 直接读缓存好的纵坐标，别再逐个去读 rect。
       这个函数挂在 scroll 上，一秒能被叫几十次 —— 每叫一次就把二三十个
       标题的 rect 全读一遍，等于每帧强制浏览器布局好几十回，
       滚起来就是一格一格地顿。位置没变的时候读出来也是同一个数。 */
    if (marksDirty) rebuildMarks()
    if (headingMarks.length) {
      // 视口顶端往下 64px 之内最后一个过去的标题，就是当前这一节
      const at = p.scrollTop + 64
      let cur: string | null = headingMarks[0].id
      for (const m of headingMarks) {
        if (m.pTop <= at) cur = m.id
        else break
      }
      state.activeHeading = cur
      return
    }
    // 缓存空（还没渲染完）才退回逐个量
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

/* ── 指向另一篇笔记的三种写法（嵌入 / 双链 / 块引用）──
   都是同一个选择器，只是选完拼出来的那一串不一样。
   以前这里只留笔记嵌入用选择器，「双链」「块引用」是把一对空括号塞给人，
   名字得自己打 —— 而同一份工作区里重名的笔记很常见，打出来的常常不是想指的那篇。 */
const pickerOpen = ref(false)
const pickerMode = ref<PickMode>('embed')

function openNotePicker(mode: PickMode) {
  pickerMode.value = mode
  pickerOpen.value = true
}

/** 选完按 mode 拼那一串，光标落在它在正文里的位置 */
function insertNoteRef(rel: string) {
  const v = view
  if (!v) return
  const name = rel.replace(/\.md$/i, '')
  const snippet =
    pickerMode.value === 'embed' ? `![[${name}]]` : pickerMode.value === 'link' ? `[[${name}]]` : `[[${name}#^]]`
  const range = v.state.selection.main
  v.dispatch({
    changes: { from: range.from, to: range.to, insert: snippet },
    // 块引用还没写完：选完要接着填块 ID，光标得停在 `^` 后面让人接着打
    selection: { anchor: range.from + snippet.length },
    userEvent: 'input.toolbar',
  })
  v.focus()
}

/**
 * `[[名字]]` 里的名字对应工作区里哪一篇。
 *
 * 名字不带目录，所以按 Obsidian 那套顺次试：
 *  1. 名字本身就是相对路径（`日记/2026-01`）—— 选择器给的正是这种，必中；
 *  2. 全库只有一个叫这个名字的笔记 —— 就是它；
 *  3. 重名且不止一个 —— 不许猜。猜错了跳到别的笔记上去，
 *     人得回头翻半天才知道自己刚才去了哪儿，还不如明着说找不着。
 */
function resolveWikiNote(name: string): string | null {
  const want = name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '')
  const root = (state.root ?? '').replace(/\\/g, '')
  const files = store.allFiles.value
  const full = root ? `${root}\\${want.replace(/\//g, '\\')}.md` : ''
  if (full) {
    const hit = files.find((f) => f.path === full || f.path.replace(/\//g, '\\') === full)
    if (hit) return hit.path
  }
  const base = want.slice(want.lastIndexOf('/') + 1).toLowerCase()
  const sameBase = files.filter((f) => f.name.replace(/\.md$/i, '').toLowerCase() === base)
  return sameBase.length === 1 ? sameBase[0].path : null
}

/** 双链指向的那篇存不存在，要等 DOM 挂上去才好判断（参数带不过去，见 transformWikiLinks）。
    找不到的标成虚线并给 title：链接照样写着名字，但它这会儿指向空处 ——
    让人在按下去之前就知道，而不是按了之后莫名其妙什么都没发生。 */
function markWikiLinks(pane: HTMLElement) {
  for (const el of Array.from(pane.querySelectorAll<HTMLElement>('.pv-wlink, .pv-embed'))) {
    const note = el.dataset.note
    if (!note) continue
    const missing = !resolveWikiNote(note)
    el.classList.toggle('is-missing', missing)
    if (missing) el.title = `工作区里还没有「${note}」这篇笔记`
    else el.removeAttribute('title')
  }
}

/**
 * 预览里点一下分栏标签 → 切到那一页。
 *
 * 之前标签只是几段静态 HTML：长得像页签，点下去却什么都没有，
 * 因为它压根没接点击。切换只改 `.on` 落在第几个上 —— 序号存在 data-i 里，
 * 标签和内容页按同一个号配对。
 */
function onTabClick(tab: HTMLElement) {
  const box = tab.closest('.pv-tabs')
  if (!box) return
  const i = tab.dataset.i ?? '0'
  for (const n of Array.from(box.querySelectorAll<HTMLElement>('.pv-tab'))) {
    n.classList.toggle('on', (n.dataset.i ?? '') === i)
  }
  for (const n of Array.from(box.querySelectorAll<HTMLElement>('.pv-tab-pane'))) {
    n.classList.toggle('on', (n.dataset.i ?? '') === i)
  }
}

/**
 * 预览里勾掉（或取消）一条待办 → 改的是**源码**，不是预览里的那个 span。
 *
 * 只改预览等于改了个影子：一滚动重渲染就复原，文件里也从来没变过。
 * 所以这里照着序号回源码找到那一行，把 `[ ]` 和 `[x]` 互换一笔。
 * 改动走 view.dispatch，于是 Ctrl+Z 能撤销、自动保存也会照常落盘。
 */
function onTaskClick(el: HTMLElement) {
  const v = view
  if (!v) return
  const i = Number(el.dataset.task ?? -1)
  if (!Number.isFinite(i) || i < 0) return
  const doc = v.state.doc.toString()
  const hit = findTaskLine(doc, i)
  if (!hit) return
  const done = !hit.done
  v.dispatch({
    changes: { from: hit.from, to: hit.from + 1, insert: done ? 'x' : ' ' },
    userEvent: 'input.toggleTask',
  })
  // 预览是防抖重渲染的，这里先自己把勾画上，不等那一下 ——
  // 否则点了要等零点几秒才有反应，手感像卡了。
  el.classList.toggle('on', done)
  el.setAttribute('aria-checked', done ? 'true' : 'false')
}

/** 在预览里点双链 / 嵌入卡 → 打开那一篇 */
function onPreviewClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null
  const tab = el?.closest?.('.pv-tab') as HTMLElement | null
  if (tab) {
    onTabClick(tab)
    return
  }
  const task = el?.closest?.('.pv-task') as HTMLElement | null
  if (task) {
    e.preventDefault()
    onTaskClick(task)
    return
  }
  const link = el?.closest?.('.pv-wlink, .pv-embed') as HTMLElement | null
  if (!link) return
  const note = link.dataset.note
  if (!note) return
  e.preventDefault()
  const target = resolveWikiNote(note)
  if (!target) {
    window.dispatchEvent(
      new CustomEvent('nota:toast', { detail: `没有找到笔记「${note}」` }),
    )
    return
  }
  void store.openNote(target)
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
    // 三种「指向另一篇」的写法都弹选择器：除了 noteEmbed，斜杠菜单里也有它们
    case 'wikiLink': openNotePicker('link'); break
    case 'noteEmbed': openNotePicker('embed'); break
    case 'blockReference': openNotePicker('block'); break
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
  const doc = view.state.doc
  /* 绝大多数情况下这条探测器是被「CM 改了 → 写回 draft」这一步触发的，
     内容本来就是编辑器自己的。以前它每次都把整篇 toString 一遍再比对 ——
     对长文来说那是每次按键一次 O(N) 的全文化，白跑。
     先拿长度挡一道：长度不同才值得真取全文。 */
  if (doc.length !== text.length) {
    applyDoc(text)
    return
  }
  if (doc.sliceString(0) === text) return
  applyDoc(text)
}

function applyDoc(text: string) {
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
/** 预览里的图片/视频加载完：内容被撑高了，标题的位置缓存作废 */
const onPreviewMediaLoad = () => {
  marksDirty = true
}

watch(previewRef, (el, old) => {
  old?.removeEventListener('scroll', onPreviewScroll)
  old?.removeEventListener('load', onPreviewMediaLoad, true)
  el?.addEventListener('scroll', onPreviewScroll, { passive: true })
  /**
   * 图片是最后到的。它没到之前浏览器按 0 高占位，等它 load 完才把下面的
   * 内容整体推下去 —— 那之后所有标题的纵坐标都得重算。
   * `load` 不冒泡，只能挂捕获阶段。
   */
  el?.addEventListener('load', onPreviewMediaLoad, true)

  // 预览栏宽度一变（拖分栏、改窗宽），正文重新折行，标题的纵向位置
  // 也跟着变 —— 缓存必须作废，否则同步会照着旧坐标走。
  if (old && marksRo) marksRo.unobserve(old)
  if (el) {
    marksDirty = true
    marksRo ??= new ResizeObserver(() => {
      marksDirty = true
    })
    marksRo.observe(el)
  }
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
  if (statTimer) clearTimeout(statTimer)
  previewRef.value?.removeEventListener('scroll', onPreviewScroll)
  previewRef.value?.removeEventListener('load', onPreviewMediaLoad, true)
  marksRo?.disconnect()
  destroyEditor()
  window.removeEventListener('keydown', onViewKey)
  window.removeEventListener('nota:insert', onInsertRequest)
  window.removeEventListener('nota:tag', onTagRequest)
  window.removeEventListener('nota:heading', onHeadingRequest)
})
/** 切笔记：先暗下去 → 在暗的时候换内容 → 再亮回来。见下面 watch 里的说明 */
const pvwEl = ref<HTMLElement | null>(null)
/** 连续切笔记时用来认领「最后一次」，前面的那几次直接让位 */
let swapSeq = 0
/** 正在跑的动画，下一次切换前要收掉 */
let swapping: Animation[] = []

const DIM_MS = 90
const BACK_MS = 200
const SWAP_EASE = 'cubic-bezier(.4, 0, .2, 1)'
const noMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** 从「当前实际透明度」开始压暗 —— 上一次还没演完就切走时，这样不会先闪回全亮 */
function dimTo(el: HTMLElement, to: number): Animation | null {
  if (noMotion()) return null
  const from = Number.parseFloat(getComputedStyle(el).opacity)
  return el.animate([{ opacity: Number.isFinite(from) ? from : 1 }, { opacity: to }], {
    duration: DIM_MS,
    easing: SWAP_EASE,
    fill: 'forwards',
  })
}

function backTo(el: HTMLElement, from: number, rise: boolean): Animation | null {
  if (noMotion()) return null
  return el.animate(
    rise
      ? [
          { opacity: from, transform: 'translateY(5px)' },
          { opacity: 1, transform: 'none' },
        ]
      : [{ opacity: from }, { opacity: 1 }],
    { duration: BACK_MS, easing: SWAP_EASE, fill: 'forwards' },
  )
}

/**
 * 切笔记：先暗下去 → 在暗的时候换内容 → 再亮回来。
 *
 * 为什么不用「CSS 过渡 + 挂 class」：试过，不成立。class 挂上到摘掉只隔两帧，
 * 浏览器还没来及重算样式就变回去了，透明度从头到尾都是 1 —— 屏幕上什么都没发生。
 * 这不是「时长没调够」，而是「挂 class 这个动作本身不保证被看见」。
 *
 * 所以改用 Web Animations：`animation.finished` 走真实时间轴，不依赖某一帧
 * 恰好被画出来，也就能确定地停在暗处把重活干完。真正的卡在 render()——
 * 它同步重解析整篇、重画公式和图表。让这件事发生在暗的这段时间里，
 * 眼睛看到的是「暗一下 → 亮回来，内容已经换了」，而不是「停一下 → 啪地跳成新的」。
 * 遮住的不是耗时，是那一下突兀。
 *
 * 编辑器侧只动透明度：CodeMirror 这段时间会量坐标，位移会让它量到偏的值。
 * 预览侧不归它管，所以亮回来时可以带一点上浮。
 */
watch(
  () => state.activePath,
  async () => {
    const my = ++swapSeq
    const ed = edWrap.value
    const pv = pvwEl.value

    const outs = [ed ? dimTo(ed, 0.35) : null, pv ? dimTo(pv, 0.3) : null].filter(
      (a): a is Animation => !!a,
    )
    for (const a of swapping) if (!outs.includes(a)) a.cancel()
    swapping = outs

    if (outs.length) await Promise.all(outs.map((a) => a.finished.catch(() => {})))
    // 这期间又切到别的笔记了：让后一次去换内容，这次别插手
    if (my !== swapSeq) return

    render()
    await nextTick()
    pushDoc(state.draft)
    view?.focus()
    await nextTick()

    const backs = [ed ? backTo(ed, 0.35, false) : null, pv ? backTo(pv, 0.3, true) : null].filter(
      (a): a is Animation => !!a,
    )
    if (!backs.length) return
    swapping = swapping.concat(backs)
    await Promise.all(backs.map((a) => a.finished.catch(() => {})))
    if (my !== swapSeq) return
    // 撤掉 forwards 留下的最终值，别让它一直压着样式
    for (const a of swapping) a.cancel()
    swapping = []
  }
)

/**
 * 换主题时重排预览。
 *
 * 界面那层换个 `data-theme` 就跟着变了，可**已经画出来的图表是烙 SVG 里的**：
 * mermaid 的配色在 `render()` 那一刻就写死进了那一堆 `fill="rgb(...)"`，
 * 之后 CSS 变量再怎么动都追不回来。于是切到深色之后正文是暗的、
 * 图上的底色还停在浅色那一档，看着像别的软件里贴进来的一块。
 *
 * 所以要重画一遍，而不是把它交给 CSS。
 */
watch(
  () => state.theme,
  () => {
    if (showPreview.value) void render()
  },
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
      @pick-note="openNotePicker"
      @find="openFind"
    />

    <div class="stage" :data-layout="mode">
      <div ref="edWrap" v-show="showEditor" class="ed-wrap">
        <div ref="host" class="host" @contextmenu="onContextMenu" />

        <!-- 查找条。CodeMirror 原生面板把替换框和一堆开关全摊开，占两行还
             带英文文案，所以自己画一条：上面「输入框 + 计数 + 上/下」，
             三个匹配开关收成图标，替换行按需展开。 -->
        <div v-if="findOpen" class="findbar" :class="{ 'with-rep': replaceOpen }">
          <div class="fb-row">
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
            <span class="fb-count" :class="{ bad: findError || (findText && !findTotal) }">
              {{ findCountText }}
            </span>

            <button
              class="fb-btn opt"
              :class="{ on: findCase }"
              title="区分大小写"
              :aria-pressed="findCase"
              @click="findCase = !findCase; onFindOption()"
            >
              <CaseSensitive :size="13" :stroke-width="2.1" />
            </button>
            <button
              class="fb-btn opt"
              :class="{ on: findWord }"
              title="全字匹配"
              :aria-pressed="findWord"
              @click="findWord = !findWord; onFindOption()"
            >
              <WholeWord :size="13" :stroke-width="2.1" />
            </button>
            <button
              class="fb-btn opt"
              :class="{ on: findRegex }"
              title="正则表达式"
              :aria-pressed="findRegex"
              @click="findRegex = !findRegex; onFindOption()"
            >
              <Regex :size="13" :stroke-width="2.1" />
            </button>
            <button
              class="fb-btn opt"
              :class="{ on: replaceOpen }"
              title="替换"
              :aria-pressed="replaceOpen"
              @click="replaceOpen = !replaceOpen"
            >
              <Replace :size="13" :stroke-width="2.1" />
            </button>

            <span class="fb-sep" />
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

          <div v-if="replaceOpen" class="fb-row">
            <Replace class="fb-ico" :size="12" :stroke-width="2" />
            <input
              v-model="replaceText"
              class="fb-input"
              type="text"
              placeholder="替换为…"
              spellcheck="false"
              @keydown.enter.exact.prevent="doReplaceOne"
              @keydown.esc="closeFind"
            />
            <button
              class="fb-btn wide"
              title="替换当前这一处，并跳到下一处"
              :disabled="!findTotal"
              @click="doReplaceOne"
            >
              替换
            </button>
            <button
              class="fb-btn wide"
              :title="`把全部 ${findTotal} 处替换掉`"
              :disabled="!findTotal"
              @click="doReplaceAll"
            >
              全部
            </button>
          </div>
        </div>
      </div>
      <div v-if="showPreview" ref="pvwEl" class="pvw">
        <div
          ref="previewRef"
          class="preview md-body"
          @click="onPreviewClick"
          v-html="html"
        />
        <!-- 大纲已经挪到中间那一列的「大纲」页签里，右边不再重复出一份 -->
      </div>

      <NotePickerDialog
        :open="pickerOpen"
        :mode="pickerMode"
        @pick="insertNoteRef"
        @close="pickerOpen = false"
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

/* ── 查找条 ──
   展开替换行时是两行，所以高度不能再写死成 30px —— 用 padding + 行高撑，
   一行 30、两行 60，浮在编辑区右上角不会盖掉正文第一行。 */
.findbar {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 3px 5px;
  border: 1px solid var(--n-line-strong);
  border-radius: var(--n-r-md);
  background: var(--n-raised);
  box-shadow: var(--n-shadow-md);
}
.fb-row {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 26px;
}
.findbar .fb-ico {
  color: var(--n-fg-faint);
  flex: none;
  margin: 0 2px 0 3px;
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
/* 「无匹配」和「正则写坏了」都是要人去看的信息，给淡红 */
.fb-count.bad {
  color: var(--n-danger);
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
.fb-btn:hover:not(:disabled) {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}
.fb-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 三个匹配开关 + 替换开关：开着时是强调色，一眼能看出这一轮是按什么规则找的 */
.fb-btn.opt.on {
  background: color-mix(in srgb, var(--n-accent) 14%, transparent);
  color: var(--n-accent);
}
.fb-btn.wide {
  width: auto;
  padding: 0 8px;
  font-size: 11.5px;
}
.fb-sep {
  width: 1px;
  height: 15px;
  margin: 0 3px;
  background: var(--n-line);
  flex: none;
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

/* ── 切笔记的暗-换-亮 ──
   全部交给 Web Animations（见 script 里那段 watch），这里不再留 CSS 规则：
   之前用 transition + class 试过，class 存活时间短于一次样式重算，
   浏览器压根没看见中间状态，屏幕上什么都没发生 —— 留着只会误导下一个人。 */

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
