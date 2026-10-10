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
  toolbarFind,
  pickImageAndInsert,
} from '@/editor/toolbar-commands'

const props = defineProps<{ getView: () => EditorView | null }>()
const emit = defineEmits<{ (e: 'toast', text: string): void }>()

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
   链接·图片·笔记 │ 代码块·表格·数学·块 */
type MenuId =
  | 'heading'
  | 'reference'
  | 'image'
  | 'note'
  | 'code'
  | 'math'
  | 'block'
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

/** 各下拉的宽度（原来写在模板 style 上，Teleport 后需要提前知道才好定位） */
const menuWidths: Record<string, number> = {
  heading: 176,
  reference: 200,
  image: 190,
  note: 224,
  code: 192,
  math: 176,
  block: 176,
}

/** 按当前打开的菜单，量出锚点位置并算 fixed 坐标 */
function placeMenu() {
  const id = openMenu.value
  if (!id) return
  const wrap = wrapEls.value[id]
  if (!wrap) return
  const btn = wrap.querySelector<HTMLElement>('.tb-btn')
  if (!btn) return
  const r = btn.getBoundingClientRect()
  const MENU_W = menuWidths[id]
  const GAP = 4

  /* 水平：默认左对齐按钮；若右边会超出窗口，则改成右对齐到按钮右边 */
  const vw = window.innerWidth
  let left = r.left
  if (left + MENU_W > vw - 8) left = r.right - MENU_W
  if (left < 8) left = 8

  menuStyle.value = {
    position: 'fixed',
    top: `${Math.round(r.bottom + GAP)}px`,
    left: `${Math.round(left)}px`,
    width: `${MENU_W}px`,
  }
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
})

/** 菜单项点击：先关菜单，再执行命令（避免焦点被菜单吃掉） */
function pick(fn: (view: EditorView) => void) {
  close()
  run(fn)
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
    'heading', 'reference', 'image', 'note', 'code', 'math', 'block',
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

/* ── 图片：本地上传走原生文件选择 ── */
async function uploadImage() {
  close()
  const view = v()
  if (!view) return
  const ok = await pickImageAndInsert(view)
  if (!ok) emit('toast', '未选择图片，已取消')
}
</script>

<template>
  <div class="tb">
    <!-- 1. 搜索 -->
    <button class="tb-btn" title="在本文中查找 (Ctrl+F)" @click="run((v) => toolbarFind(v))">
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
          class="tb-menu tb-menu--float"
          :style="menuStyle"
        >
          <template v-for="(h, i) in headingItems" :key="h.level">
            <span v-if="i === 1" class="tb-sep-h" />
            <button class="tb-item" @click="pick((v) => toolbarHeading(v, h.level))">
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
          class="tb-menu tb-menu--float"
          :style="menuStyle"
        >
          <button class="tb-item" @click="pick((v) => toolbarLink(v))">
            <span>链接</span><span class="kbd">[]()</span>
          </button>
          <span class="tb-sep-h" />
          <button class="tb-item" @click="pick((v) => toolbarWrap(v, '[[', ']]'))">
            <span>双链笔记</span><span class="kbd">[[ ]]</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarWrap(v, '![[', ']]'))">
            <span>笔记嵌入</span><span class="kbd">![[ ]]</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarWrap(v, '[[#^', ']]'))">
            <span>块引用</span><span class="kbd">[[#^ ]]</span>
          </button>
          <span class="tb-sep-h" />
          <button class="tb-item" @click="pick((v) => toolbarFootnote(v))">
            <span>脚注</span><span class="kbd">[^1]</span>
          </button>
        </div>
      </Teleport>
    </div>

    <div :ref="wrapRef('image')" class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'image' }"
        title="插入图片"
        @click="toggle('image')"
      >
        <ImageIcon :size="ICON" :stroke-width="STROKE" />
        <ChevronDown class="caret" :size="10" :stroke-width="2" />
      </button>
      <Teleport to="body">
        <div
          v-if="openMenu === 'image'"
          class="tb-menu tb-menu--float"
          :style="menuStyle"
        >
          <button class="tb-item" @click="uploadImage">
            <span>上传本地图片</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarImage(v))">
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
          class="tb-menu tb-menu--float"
          :style="menuStyle"
        >
          <button class="tb-item" @click="pick((v) => toolbarTag(v))">
            <span>插入标签</span><span class="kbd">#</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarBlockId(v))">
            <span>块 ID</span><span class="kbd">^</span>
          </button>
          <span class="tb-sep-h" />
          <button class="tb-item" @click="pick((v) => toolbarFrontMatter(v))">
            <span>Front Matter</span><span class="kbd">---</span>
          </button>
          <span class="tb-sep-h" />
          <button class="tb-item" @click="pick((v) => toolbarInline(v, 'comment'))">
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
          class="tb-menu tb-menu--float"
          :style="menuStyle"
        >
          <button class="tb-item" @click="pick((v) => toolbarCodeBlock(v))">
            <span>代码块</span><span class="kbd">```</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarAdvancedCodeBlock(v))">
            <span>高级代码块</span><span class="tag">标题/行号</span>
          </button>
          <span class="tb-sep-h" />
          <button class="tb-item" @click="pick((v) => toolbarMermaid(v))">
            <span>Mermaid 图表</span>
          </button>
        </div>
      </Teleport>
    </div>

    <button class="tb-btn" title="插入表格" @click="run((v) => toolbarTable(v, '| 列 1 | 列 2 | 列 3 |'))">
      <Table :size="ICON" :stroke-width="STROKE" />
    </button>

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
          class="tb-menu tb-menu--float"
          :style="menuStyle"
        >
          <button class="tb-item" @click="pick((v) => toolbarInline(v, 'inlineMath'))">
            <span>行内公式</span><span class="kbd">$ $</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarMathBlock(v))">
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
          class="tb-menu tb-menu--float"
          :style="menuStyle"
        >
          <button class="tb-item" @click="pick((v) => toolbarCallout(v))">
            <span>Callout 提示块</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarDetails(v))">
            <span>折叠详情块</span>
          </button>
          <button class="tb-item" @click="pick((v) => toolbarTabs(v, '标签一', '标签二'))">
            <span>分栏标签</span>
          </button>
          <span class="tb-sep-h" />
          <button class="tb-item" @click="pick((v) => toolbarHorizontalRule(v))">
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

/* 下拉菜单内的分组分隔线 */
.tb-sep-h {
  display: block;
  height: 1px;
  margin: 4px 6px;
  background: var(--n-line);
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

.tb-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  min-width: 176px;
  padding: 4px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  box-shadow: var(--n-shadow-lg);
  animation: menu-in 120ms var(--n-ease);
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

@keyframes menu-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}

.tb-item {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 0 9px;
  border-radius: var(--n-r-sm);
  font-size: 13px;
  color: var(--n-fg);
  text-align: left;
  white-space: nowrap;
}

.tb-item:hover {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.kbd {
  font-family: var(--n-font-mono);
  font-size: 10.5px;
  color: var(--n-fg-faint);
}

.tb-item:hover .kbd {
  color: var(--n-accent);
  opacity: 0.75;
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
