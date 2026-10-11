<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { EditorView } from '@codemirror/view'
import {
  /* 图标全部取自 Lucide（lucide-vue-next，ISC 许可）。
     这里刻意不自己手画：Lucide 是 inkstone 工具栏图标的上游来源，
     同源、同几何、同观感，但许可宽松（ISC + 部分 MIT），
     只要求保留版权声明，不产生任何 copyleft 牵连。
     inkstone 自身是 LGPL-3.0，其源码不能照抄——所以走「用它的上游」而不是「用它的代码」。 */
  Search,
  Heading,
  Bold,
  Italic,
  Strikethrough,
  Highlighter,
  Code,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Link2,
  Image as ImageIcon,
  FileText,
  Braces,
  Table,
  Sigma,
  Blocks,
  ChevronDown,
} from 'lucide-vue-next'
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
  pickImageAndInsert,
} from '@/editor/toolbar-commands'

const props = defineProps<{ getView: () => EditorView | null }>()
const emit = defineEmits<{
  (e: 'toast', text: string): void
  /** 笔记嵌入：要弹选择器，这件事编辑器才知道怎么做，交给外层 */
  (e: 'embed'): void
  /** 查找：面板画在编辑区里（外层知道滚动容器在哪），工具栏只负责喊一声 */
  (e: 'find'): void
}>()

/** Lucide 图标统一尺寸。inkstone 用 14，这里跟按钮 26px 的高度配 15 更稳，
    视觉粗细与原来那套手绘图标接近，不会显得发飘。 */
const ICON = 15
/** Lucide 原生线宽是 2（24 视口）。缩到 15px 后按比例看略粗，
    压到 1.75 更接近 inkstone 那种克制的细线。 */
const STROKE = 1.75

function v(): EditorView | null {
  return props.getView()
}

/** 包装：view 可能为 null（预览模式 / 未挂载） */
function run(fn: (view: EditorView) => void) {
  const view = v()
  if (!view) return
  fn(view)
}

/* ── 下拉菜单 ──
   顺序与分组对齐 inkstone 参考实现：
   搜索 │ 标题 │ 加粗/斜体/删除线/高亮/行内代码 │ 无序/有序/任务/引用 │
   链接·图片·笔记 │ 代码块·表格·数学·块
   AI 那一组已移除：写作之外的 AI 动作归「AI 编写」页和编辑区右键菜单，
   工具栏里再挂一个入口只会让人以为它跟「加粗」是一类东西。 */
type MenuId =
  | 'heading'
  | 'reference'
  | 'image'
  | 'note'
  | 'code'
  | 'math'
  | 'block'
  | 'table'
  | null

const openMenu = ref<MenuId>(null)

function toggle(id: Exclude<MenuId, null>) {
  openMenu.value = openMenu.value === id ? null : id
}

function close() {
  openMenu.value = null
}

/* ── 菜单定位（关键） ──
   .tb 是横向滚动容器（overflow-x: auto），而 overflow 不为 visible 的元素
   会把所有溢出的子节点裁掉——包括绝对定位的下拉。
   表现很迷惑：DOM 里菜单明明在（所以「点了没反应」用肉眼和 DOM 断言都查不出来，
   按钮的高亮态也正常），getBoundingClientRect() 也返回真实尺寸，
   但视觉上被 .tb 裁成 0 高度，只剩编辑器露出来。

   所以菜单必须「逃出」工具栏的裁剪。做法是 Teleport 到 body，
   用 fixed 定位按锚点按钮的坐标摆放——这样既保住了 .tb 的横向滚动，
   又让菜单能盖在编辑器之上。 */
/** 每个 wrap 的 DOM 引用，用来量锚点位置 */
const wrapEls = ref<Record<string, HTMLElement | null>>({})

const menuStyle = ref<Record<string, string>>({})

/** 已渲染的浮层菜单元素，用来量它自己的真实宽度 */
const menuEls = ref<Record<string, HTMLElement | null>>({})

/** 浮层与锚点之间的垂直间距 */
const GAP = 4
/** 距视口边缘的最小留白 */
const EDGE = 8

/**
 * 按当前打开的菜单，量出锚点位置并算 fixed 坐标。
 *
 * 宽度不再是写死的数字——写死会「要么太宽显得空、要么太窄挤成两行」，
 * 用户明确要求「按字的长度来，刚刚好」。做法是先让菜单按内容自然排布
 * （CSS 里 width: max-content），挂上去之后再量它的真实宽度，
 * 然后据此决定左右定位。这样每个菜单都正好裹住自己最宽的那一项。
 */
function placeMenu() {
  const id = openMenu.value
  if (!id) return
  const wrap = wrapEls.value[id]
  if (!wrap) return
  const btn = wrap.querySelector<HTMLElement>('.tb-btn')
  if (!btn) return

  const r = btn.getBoundingClientRect()
  const menu = menuEls.value[id]
  // 首帧还没量到（菜单刚挂载）时先用一个保守值，下一帧会再摆一次
  const menuW = menu ? Math.ceil(menu.getBoundingClientRect().width) : 0
  const vw = window.innerWidth

  /* 水平：默认左对齐按钮；右边会超出窗口就翻成右对齐到按钮右边 */
  let left = r.left
  if (menuW > 0) {
    if (left + menuW > vw - EDGE) left = r.right - menuW
    if (left < EDGE) left = EDGE
  }

  menuStyle.value = {
    position: 'fixed',
    top: `${Math.round(r.bottom + GAP)}px`,
    left: `${Math.round(left)}px`,
    // 宽度交给 CSS 的 max-content，这里不写死
  }

  // 挂载后第一帧量到的宽度可能是 0（还没布局完），补一次
  if (!menu) {
    requestAnimationFrame(() => {
      if (openMenu.value === id) placeMenu()
    })
  }
}

function setMenuEl(id: Exclude<MenuId, null>, el: unknown) {
  menuEls.value[id] = (el as HTMLElement) ?? null
}

function menuRef(id: Exclude<MenuId, null>) {
  return (el: unknown) => setMenuEl(id, el)
}

function setWrap(id: Exclude<MenuId, null>, el: unknown) {
  wrapEls.value[id] = (el as HTMLElement) ?? null
}

/** 供模板调用：给 wrap 绑 ref */
function wrapRef(id: Exclude<MenuId, null>) {
  return (el: unknown) => setWrap(id, el)
}

watch(openMenu, async (id) => {
  if (!id) return
  await nextTick()
  placeMenu()
  // 字体/图标可能晚一帧才定尺寸，再摆一次保证位置稳
  requestAnimationFrame(() => {
    if (openMenu.value === id) placeMenu()
  })
})

/** 菜单项点击：先关菜单，再执行命令（避免焦点被菜单吃掉） */
function pick(fn: (view: EditorView) => void) {
  close()
  run(fn)
}

/** 嵌入要挑具体哪一篇，光打一对 ![[]] 还得手填名字，直接让外层弹选择器 */
function pickEmbed() {
  close()
  emit('embed')
}

function onDocPointer(e: PointerEvent) {
  const el = e.target as HTMLElement
  if (!el.closest('.tb-menu') && !el.closest('.tb-btn')) close()
}

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

/** 菜单打开时按左右方向键可在相邻下拉之间切换（和原生菜单栏行为一致） */
function onArrow(e: KeyboardEvent) {
  if (!openMenu.value) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const ids: Exclude<MenuId, null>[] = [
    'heading', 'reference', 'image', 'note', 'code', 'table', 'math', 'block',
  ]
  const at = ids.indexOf(openMenu.value)
  if (at < 0) return
  e.preventDefault()
  const step = e.key === 'ArrowRight' ? 1 : -1
  openMenu.value = ids[(at + step + ids.length) % ids.length]
}

/** 窗口尺寸或工具栏滚动变化时，菜单要跟着锚点重新摆位，
    否则 fixed 坐标会跟按钮脱节（fixed 不随滚动容器一起走）。 */
function onReposition() {
  if (openMenu.value) placeMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onEsc)
  document.addEventListener('keydown', onArrow)
  window.addEventListener('resize', onReposition)
  window.addEventListener('scroll', onReposition, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onEsc)
  document.removeEventListener('keydown', onArrow)
  window.removeEventListener('resize', onReposition)
  window.removeEventListener('scroll', onReposition, true)
})

/* ── 标题下拉：正文 + H1–H6 ── */
const headingItems = [
  { level: 0 as const, label: '正文', kbd: 'Ctrl+0' },
  { level: 1 as const, label: '一级标题', kbd: 'Ctrl+1' },
  { level: 2 as const, label: '二级标题', kbd: 'Ctrl+2' },
  { level: 3 as const, label: '三级标题', kbd: 'Ctrl+3' },
  { level: 4 as const, label: '四级标题', kbd: 'Ctrl+4' },
  { level: 5 as const, label: '五级标题', kbd: 'Ctrl+5' },
  { level: 6 as const, label: '六级标题', kbd: 'Ctrl+6' },
]

/** 标题下拉按钮上曾显示当前档位（H1 徽标），但换上 Lucide 的 Heading 图标后
    两者语义重复，挤在一起反而看不清，已去掉徽标只留图标。 */

/* ── 图片 / 视频：本地上传走原生文件选择 ── */
async function uploadMedia(kind: 'image' | 'video' | 'any') {
  close()
  const view = v()
  if (!view) return
  const ok = await pickImageAndInsert(view, kind)
  if (!ok) {
    emit('toast', kind === 'video' ? '未选择视频，已取消' : '未选择文件，已取消')
  }
}

/* ── 表格：8×8 九宫格选尺寸 ──
   点「插入表格」不再直接插一个死板的 3 列，而是弹出一张网格：
   鼠标划过时高亮 "行 × 列" 的区域，同时在右上角显示 `3 × 4`，
   点下去就按选中的行列数生成表头（含分隔行）。 */
const GRID_MAX = 8

/** 当前 hover 到的行列（0 表示没选中任何格） */
const gridRow = ref(0)
const gridCol = ref(0)

function onGridEnter(r: number, c: number) {
  gridRow.value = r
  gridCol.value = c
}

function onGridLeave() {
  gridRow.value = 0
  gridCol.value = 0
}

/** 生成 rows×cols 的 Markdown 表格，光标落在第一个表头格内 */
function insertTable(rows: number, cols: number) {
  const view = v()
  close()
  if (!view) return
  const header = `| ${Array.from({ length: cols }, (_, i) => `列 ${i + 1}`).join(' | ')} |`
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
  const body = Array.from({ length: Math.max(0, rows - 1) }, () =>
    `| ${Array.from({ length: cols }, () => '   ').join(' | ')} |`,
  )
  // 第 3 个参数传分隔行（字符串）即走上「三行都由调用方给」的路径
  toolbarTable(view, header, sep, cols, body)
}
</script>

<template>
  <div class="tb">
    <!-- 1. 搜索 -->
    <button class="tb-btn" title="在本文中查找 (Ctrl+F)" @click="emit('find')">
      <Search :size="ICON" :stroke-width="STROKE" />
    </button>

    <span class="tb-sep" />

    <!-- 2. 标题 -->
    <div :ref="wrapRef('heading')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'heading' }"
        title="标题级别"
        @click="toggle('heading')"
      >
        <Heading :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'heading'"
          :ref="menuRef('heading')"
          class="tb-menu tb-menu--float n-menu"
          :style="menuStyle"
        >
          <template v-for="(h, i) in headingItems" :key="h.level">
            <span v-if="i === 1" class="tb-sep-h n-menu-sep" />
            <button class="tb-item n-menu-item" @click="pick((v) => toolbarHeading(v, h.level))">
              <span :style="{ fontSize: `${17 - Math.min(h.level, 4) * 1.1}px`, fontWeight: 600 }">
                {{ h.label }}
              </span>
              <span class="kbd">{{ h.kbd }}</span>
            </button>
          </template>
        </div>
      </Teleport>
    </div>

    <span class="tb-sep" />

    <!-- 3. 行内格式 -->
    <div class="tb-group">
      <button class="tb-btn" title="加粗 (Ctrl+B)" @click="run((v) => toolbarInline(v, 'bold'))">
        <Bold :size="ICON" :stroke-width="STROKE" />
      </button>
      <button class="tb-btn" title="斜体 (Ctrl+I)" @click="run((v) => toolbarInline(v, 'italic'))">
        <Italic :size="ICON" :stroke-width="STROKE" />
      </button>
      <button class="tb-btn" title="删除线 (Ctrl+Shift+X)" @click="run((v) => toolbarInline(v, 'strikethrough'))">
        <Strikethrough :size="ICON" :stroke-width="STROKE" />
      </button>
      <button class="tb-btn" title="高亮 (Ctrl+Shift+H)" @click="run((v) => toolbarInline(v, 'highlight'))">
        <Highlighter :size="ICON" :stroke-width="STROKE" />
      </button>
      <button class="tb-btn" title="行内代码 (Ctrl+E)" @click="run((v) => toolbarInlineCode(v))">
        <Code :size="ICON" :stroke-width="STROKE" />
      </button>
    </div>

    <span class="tb-sep" />

    <!-- 4. 列表与引用 -->
    <div class="tb-group">
      <button class="tb-btn" title="无序列表 (Ctrl+Shift+8)" @click="run((v) => toolbarBlockPrefix(v, 'bullet'))">
        <List :size="ICON" :stroke-width="STROKE" />
      </button>
      <button class="tb-btn" title="有序列表 (Ctrl+Shift+7)" @click="run((v) => toolbarBlockPrefix(v, 'ordered'))">
        <ListOrdered :size="ICON" :stroke-width="STROKE" />
      </button>
      <button class="tb-btn" title="任务列表 (Ctrl+Shift+9)" @click="run((v) => toolbarBlockPrefix(v, 'task'))">
        <ListTodo :size="ICON" :stroke-width="STROKE" />
      </button>
      <button class="tb-btn" title="引用块 (Ctrl+Shift+.)" @click="run((v) => toolbarBlockPrefix(v, 'quote'))">
        <Quote :size="ICON" :stroke-width="STROKE" />
      </button>
    </div>

    <span class="tb-sep" />

    <!-- 5. 链接 / 图片 / 笔记 -->
    <div :ref="wrapRef('reference')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'reference' }"
        title="链接与引用"
        @click="toggle('reference')"
      >
        <Link2 :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'reference'"
          :ref="menuRef('reference')"
          class="tb-menu tb-menu--float n-menu"
          :style="menuStyle"
        >
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarLink(v))">
            <span>链接</span><span class="kbd">[]()</span>
          </button>
          <span class="tb-sep-h n-menu-sep" />
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarWrap(v, '[[', ']]'))">
            <span>双链笔记</span><span class="kbd">[[ ]]</span>
          </button>
          <button class="tb-item n-menu-item" @click="pickEmbed">
            <span>笔记嵌入</span><span class="kbd">![[ ]]</span>
          </button>
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarWrap(v, '[[#^', ']]'))">
            <span>块引用</span><span class="kbd">[[#^ ]]</span>
          </button>
          <span class="tb-sep-h n-menu-sep" />
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarFootnote(v))">
            <span>脚注</span><span class="kbd">[^1]</span>
          </button>
        </div>
      </Teleport>
    </div>

    <div :ref="wrapRef('image')" class="tb-group tb-menu-wrap">
        <button class="tb-btn" :class="{ on: openMenu === 'image' }" title="插入图片或视频" @click="toggle('image')">
          <ImageIcon :size="ICON" :stroke-width="STROKE" />
          <ChevronDown class="caret" :size="10" :stroke-width="2" />
        </button>
        <Teleport to="body">
          <div
            v-if="openMenu === 'image'"
            :ref="menuRef('image')"
            class="tb-menu tb-menu--float n-menu"
            :style="menuStyle"
          >
            <button class="tb-item n-menu-item" @click="uploadMedia('any')">
              <span>上传本地图片或视频</span>
            </button>
            <span class="tb-sep-h n-menu-sep" />
            <button class="tb-item n-menu-item" @click="uploadMedia('image')">
              <span>从本地插入图片</span>
            </button>
            <button class="tb-item n-menu-item" @click="uploadMedia('video')">
              <span>从本地插入视频</span>
            </button>
            <span class="tb-sep-h n-menu-sep" />
            <button class="tb-item n-menu-item" @click="pick((v) => toolbarImage(v))">
              <span>远程图片链接</span><span class="kbd">![]()</span>
            </button>
          </div>
        </Teleport>
    </div>

    <div :ref="wrapRef('note')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'note' }"
        title="笔记工具"
        @click="toggle('note')"
      >
        <FileText :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'note'"
          :ref="menuRef('note')"
          class="tb-menu tb-menu--float n-menu"
          :style="menuStyle"
        >
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarTag(v))">
            <span>插入标签</span><span class="kbd">#</span>
          </button>
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarBlockId(v))">
            <span>块 ID</span><span class="kbd">^</span>
          </button>
          <span class="tb-sep-h n-menu-sep" />
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarFrontMatter(v))">
            <span>Front Matter</span><span class="kbd">---</span>
          </button>
          <span class="tb-sep-h n-menu-sep" />
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarInline(v, 'comment'))">
            <span>隐藏注释</span><span class="kbd">%% %%</span>
          </button>
        </div>
      </Teleport>
    </div>

    <span class="tb-sep" />

    <!-- 6. 代码 / 表格 / 数学 / 块 -->
    <div :ref="wrapRef('code')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'code' }"
        title="代码与图表"
        @click="toggle('code')"
      >
        <Braces :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'code'"
          :ref="menuRef('code')"
          class="tb-menu tb-menu--float n-menu"
          :style="menuStyle"
        >
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarCodeBlock(v))">
            <span>代码块</span><span class="kbd">```</span>
          </button>
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarAdvancedCodeBlock(v))">
            <span>高级代码块</span><span class="tag">标题/行号</span>
          </button>
          <span class="tb-sep-h n-menu-sep" />
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarMermaid(v))">
            <span>Mermaid 图表</span>
          </button>
        </div>
      </Teleport>
    </div>

    <div :ref="wrapRef('table')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'table' }"
        title="插入表格"
        @click="toggle('table')"
      >
        <Table :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'table'"
          :ref="menuRef('table')"
          class="tb-menu tb-menu--float tb-grid-menu n-menu"
          :style="menuStyle"
        >
          <div class="tb-grid-size">
            {{ gridRow > 0 ? `${gridRow} × ${gridCol}` : '选择表格大小' }}
          </div>
          <div class="tb-grid" @pointerleave="onGridLeave">
            <template v-for="r in GRID_MAX" :key="r">
              <button
                v-for="c in GRID_MAX"
                :key="`${r}-${c}`"
                class="tb-grid-cell"
                :class="{ on: r <= gridRow && c <= gridCol }"
                :title="`${r} 行 × ${c} 列`"
                @pointerenter="onGridEnter(r, c)"
                @click="insertTable(r, c)"
              />
            </template>
          </div>
          <div class="tb-grid-foot">{{ gridRow > 0 ? `${gridRow} 行 ${gridCol} 列` : '默认 3 × 3' }}</div>
        </div>
      </Teleport>
    </div>

    <div :ref="wrapRef('math')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'math' }"
        title="数学公式"
        @click="toggle('math')"
      >
        <Sigma :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'math'"
          :ref="menuRef('math')"
          class="tb-menu tb-menu--float n-menu"
          :style="menuStyle"
        >
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarInline(v, 'inlineMath'))">
            <span>行内公式</span><span class="kbd">$ $</span>
          </button>
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarMathBlock(v))">
            <span>块级公式</span><span class="kbd">$$</span>
          </button>
        </div>
      </Teleport>
    </div>

    <div :ref="wrapRef('block')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'block' }"
        title="内容块"
        @click="toggle('block')"
      >
        <Blocks :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'block'"
          :ref="menuRef('block')"
          class="tb-menu tb-menu--float n-menu"
          :style="menuStyle"
        >
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarCallout(v))">
            <span>Callout 提示块</span>
          </button>
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarDetails(v))">
            <span>折叠详情块</span>
          </button>
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarTabs(v, '标签一', '标签二'))">
            <span>分栏标签</span>
          </button>
          <span class="tb-sep-h n-menu-sep" />
          <button class="tb-item n-menu-item" @click="pick((v) => toolbarHorizontalRule(v))">
            <span>分割线</span>
          </button>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.tb {
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px;
  border-bottom: 1px solid var(--n-line);
  background: var(--n-surface);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.tb::-webkit-scrollbar {
  display: none;
}

.tb-group {
  display: flex;
  align-items: center;
  gap: 1px;
}

.tb-menu-wrap {
  position: relative;
}

.tb-sep {
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 5px;
  background: var(--n-line);
}

/* 下拉菜单内的分组分隔线：长相在 styles/menu.css 的 .n-menu-sep 里，
   这里留个类名给测试与定位用 */
.tb-sep-h {
  display: block;
}

.tb-btn {
  height: 26px;
  min-width: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
  transition: background var(--n-dur) var(--n-ease), color var(--n-dur) var(--n-ease);
}

.tb-btn:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.tb-btn.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

/* Lucide 图标是「描边」画的（fill="none" + stroke），不是「填充」画的。
   原来那套手绘图标是填充路径，所以这里有 fill: currentColor。
   现在必须去掉它：给描边图标强加 fill 会把它们糊成实心黑块。
   统一用 stroke: currentColor，颜色才跟着 .tb-btn 的 color 走。 */
.tb-btn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  flex: none;
}

.tb-btn .caret {
  width: 12px;
  height: 12px;
  opacity: 0.6;
  fill: none;
  stroke: currentColor;
}

/* 菜单本体的长相统一在 styles/menu.css 的 .n-menu 里，
   这里只保留工具栏特有的定位与宽度策略。 */
.tb-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  /* 宽度按内容走：max-content 正好裹住最宽的那一项；
     min/max 只做兜底，防止极端内容把菜单撑爆或压扁。
     用户要的「跟字的长度刚刚好」就是这个。 */
  width: max-content;
  min-width: 132px;
  max-width: 260px;
}

/* 菜单被 Teleport 到 body 后，工具栏的 overflow 就裁不到它了。
   位置由 placeMenu() 按锚点按钮实时算出，这里只需要保证层级够高
   （要盖过编辑器与侧栏），并且坐标用 fixed。 */
.tb-menu--float {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 999;
}

/* 说明：原来靠 .tb-menu-wrap--end 做右边缘避让，
   现在改由 placeMenu() 在算坐标时判断（左对齐会超出窗口就翻成右对齐），
   这个类已不再需要。 */

/* ── 表格九宫格 ──
   宽度由格子决定，不能被 .tb-menu 的 max-width 压扁。 */
.tb-grid-menu {
  width: auto;
  min-width: 0;
  max-width: none;
  padding: 8px;
}

.tb-grid-size {
  height: 18px;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--n-fg-dim);
  text-align: center;
}

.tb-grid {
  display: grid;
  grid-template-columns: repeat(8, 15px);
  grid-auto-rows: 15px;
  gap: 3px;
}

.tb-grid-cell {
  border: 1px solid var(--n-line-strong);
  border-radius: 2px;
  background: var(--n-raised);
  transition: background 80ms linear, border-color 80ms linear;
}

.tb-grid-cell.on {
  background: var(--n-accent-soft);
  border-color: var(--n-accent);
}

.tb-grid-foot {
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--n-fg-faint);
  text-align: center;
}

@keyframes menu-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}

/* 一行菜单项：颜色、悬停、圆角、字号统一走 .n-menu-item，
   这里只管这一处特有的排版——「标签在左、快捷键贴右」 */
.tb-item {
  width: 100%;
  height: 30px;
  justify-content: space-between;
  /* 标签与快捷键之间给一段固定间距，菜单窄的时候也不会贴在一起。
     auto 的左边距把 kbd 推到右侧，菜单宽度由最长的那一行决定。 */
  gap: 18px;
  font-size: 13px;
  white-space: nowrap;
}

.kbd {
  font-family: var(--n-font-mono);
  font-size: 10.5px;
  color: var(--n-fg-faint);
}

.tb-item:hover .kbd {
  color: inherit;
  opacity: 0.8;
}

.tag {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--n-surface);
  color: var(--n-fg-faint);
  border: 1px solid var(--n-line);
}
</style>
