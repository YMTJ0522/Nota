<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import type { EditorView } from '@codemirror/view'
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

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onEsc)
  document.addEventListener('keydown', onArrow)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onEsc)
  document.removeEventListener('keydown', onArrow)
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

/** 标题下拉按钮上显示当前档位（简单映射，非实时读光标） */
const headingBadge = computed(() => 'H1')

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
      <svg viewBox="0 0 24 24"><path d="M10 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12m0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8m4.6 9.2 1.4-1.4 4.3 4.3-1.4 1.4z"/></svg>
    </button>

    <span class="tb-sep" />

    <!-- 2. 标题 -->
    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn wide"
        :class="{ on: openMenu === 'heading' }"
        title="标题级别"
        @click="toggle('heading')"
      >
        <span>{{ headingBadge }}</span>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'heading'" class="tb-menu" style="min-width: 176px">
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
    </div>

    <span class="tb-sep" />

    <!-- 3. 行内格式 -->
    <div class="tb-group">
      <button class="tb-btn" title="加粗 (Ctrl+B)" @click="run((v) => toolbarInline(v, 'bold'))">
        <svg viewBox="0 0 24 24"><path d="M7 5h6.2a3.4 3.4 0 0 1 .6 6.7A3.7 3.7 0 0 1 13.6 19H7zM10 7.6v3h2.9a1.5 1.5 0 0 0 0-3zm0 5.2v3.6h3.4a1.8 1.8 0 0 0 0-3.6z"/></svg>
      </button>
      <button class="tb-btn" title="斜体 (Ctrl+I)" @click="run((v) => toolbarInline(v, 'italic'))">
        <svg viewBox="0 0 24 24"><path d="M10 5h8v2h-2.9l-3 10H15v2H7v-2h2.9l3-10H10z"/></svg>
      </button>
      <button class="tb-btn" title="删除线 (Ctrl+Shift+X)" @click="run((v) => toolbarInline(v, 'strikethrough'))">
        <svg viewBox="0 0 24 24"><path d="M4 11h16v2H4zM7.5 8.2C7.5 6 9.4 5 11.7 5c1.7 0 3.2.5 4.2 1.4l-1.3 1.6c-.7-.6-1.7-1-2.9-1-1.3 0-2.1.5-2.1 1.4 0 .8.6 1.2 2 1.6H8.1c-.4-.4-.6-1-.6-1.8zm.3 6.3c0 1.6 1.3 2.5 3.3 2.5 1.6 0 3-.5 4-1.4l-1.2-1.6c-.7.6-1.7 1-2.7 1-1.1 0-1.8-.4-1.8-1.1 0-.3.1-.5.3-.7h-2c0 .4-.1.8-.1 1.3z"/></svg>
      </button>
      <button class="tb-btn" title="高亮 (Ctrl+Shift+H)" @click="run((v) => toolbarInline(v, 'highlight'))">
        <svg viewBox="0 0 24 24"><path d="M6 14.5 11.5 9l3.5 3.5L9.5 18H6zM13 7.4l1.6-1.6a1.5 1.5 0 0 1 2.1 0l1.5 1.5a1.5 1.5 0 0 1 0 2.1L16.6 11zM4 20h11v2H4z"/></svg>
      </button>
      <button class="tb-btn" title="行内代码 (Ctrl+E)" @click="run((v) => toolbarInlineCode(v))">
        <svg viewBox="0 0 24 24"><path d="M9.4 16.6 4.8 12l4.6-4.6 1.4 1.4L7.6 12l3.2 3.2zM14.6 7.4 19.2 12l-4.6 4.6-1.4-1.4L16.4 12l-3.2-3.2z"/></svg>
      </button>
    </div>

    <span class="tb-sep" />

    <!-- 4. 列表与引用 -->
    <div class="tb-group">
      <button class="tb-btn" title="无序列表 (Ctrl+Shift+8)" @click="run((v) => toolbarBlockPrefix(v, 'bullet'))">
        <svg viewBox="0 0 24 24"><path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/></svg>
      </button>
      <button class="tb-btn" title="有序列表 (Ctrl+Shift+7)" @click="run((v) => toolbarBlockPrefix(v, 'ordered'))">
        <svg viewBox="0 0 24 24"><path d="M4 5h2v1.6H5.2v.9H6v1H4V7h.8v-.4H4zm0 5h1.6l-1.6 1.7v.8h2.2v-1H4.7l1.5-1.6V9H4zm0 5.2h1.7v.6H4v1h1.7v.6H4V19h2.2v-5H4zM8 6h12v2H8zm0 5h12v2H8zm0 5h12v2H8z"/></svg>
      </button>
      <button class="tb-btn" title="任务列表 (Ctrl+Shift+9)" @click="run((v) => toolbarBlockPrefix(v, 'task'))">
        <svg viewBox="0 0 24 24"><path d="M4 5h4v4H4zm1.5 2.6 1 1 2-2 .9.9-2.9 2.9-1.9-1.9zM10 6h10v2H10zm-6 7h4v4H4zm1.5 2.6 1 1 2-2 .9.9-2.9 2.9-1.9-1.9zM10 13h10v2H10z"/></svg>
      </button>
      <button class="tb-btn" title="引用块 (Ctrl+Shift+.)" @click="run((v) => toolbarBlockPrefix(v, 'quote'))">
        <svg viewBox="0 0 24 24"><path d="M6 5c-1.7 0-3 1.3-3 3s1.3 3 3 3c0 2-1 3.2-2.6 4l.9 1.7C7.1 15.2 9 12.9 9 9.5V8c0-1.7-1.3-3-3-3m10 0c-1.7 0-3 1.3-3 3s1.3 3 3 3c0 2-1 3.2-2.6 4l.9 1.7C17.1 15.2 19 12.9 19 9.5V8c0-1.7-1.3-3-3-3"/></svg>
      </button>
    </div>

    <span class="tb-sep" />

    <!-- 5. 链接 / 图片 / 笔记 -->
    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'reference' }"
        title="链接与引用"
        @click="toggle('reference')"
      >
        <svg viewBox="0 0 24 24"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l1.4-1.4a1 1 0 0 1 1.4 1.4l-1.4 1.4a1 1 0 0 1-1.4 0M7.8 16.2a3 3 0 0 1 0-4.2l3-3a3 3 0 0 1 4.2 0l-1.4 1.4a1 1 0 0 0-1.4 0l-3 3a1 1 0 0 0 0 1.4 1 1 0 0 0 1.4 0l1-1 1.4 1.4-1 1a3 3 0 0 1-4.2 0m8.4-8.4a3 3 0 0 1 0 4.2l-3 3a3 3 0 0 1-4.2 0l1.4-1.4a1 1 0 0 0 1.4 0l3-3a1 1 0 0 0 0-1.4 1 1 0 0 0-1.4 0l-1 1-1.4-1.4 1-1a3 3 0 0 1 4.2 0"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'reference'" class="tb-menu" style="min-width: 200px">
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
    </div>

    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'image' }"
        title="插入图片"
        @click="toggle('image')"
      >
        <svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zm2 2v7l3.2-3.2 2.6 2.6L14.4 10 18 13.6V7zm3 2.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'image'" class="tb-menu" style="min-width: 190px">
        <button class="tb-item" @click="uploadImage">
          <span>上传本地图片</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarImage(v))">
          <span>远程图片链接</span><span class="kbd">![]()</span>
        </button>
      </div>
    </div>

    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'note' }"
        title="笔记工具"
        @click="toggle('note')"
      >
        <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zm7 1.5V8h3.5zM8 11h8v1.6H8zm0 3.2h8v1.6H8zm0 3.2h5v1.6H8z"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'note'" class="tb-menu" style="min-width: 224px">
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
    </div>

    <span class="tb-sep" />

    <!-- 6. 代码 / 表格 / 数学 / 块 -->
    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'code' }"
        title="代码与图表"
        @click="toggle('code')"
      >
        <svg viewBox="0 0 24 24"><path d="M9.4 16.6 4.8 12l4.6-4.6 1.4 1.4L7.6 12l3.2 3.2zM14.6 7.4 19.2 12l-4.6 4.6-1.4-1.4L16.4 12l-3.2-3.2z"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'code'" class="tb-menu" style="min-width: 192px">
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
    </div>

    <button class="tb-btn" title="插入表格" @click="run((v) => toolbarTable(v, '| 列 1 | 列 2 | 列 3 |'))">
      <svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zm2 2v3h5V7zm7 0v3h5V7zM6 12v3h5v-3zm7 0v3h5v-3z"/></svg>
    </button>

    <div class="tb-group tb-menu-wrap tb-menu-wrap--end">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'math' }"
        title="数学公式"
        @click="toggle('math')"
      >
        <svg viewBox="0 0 24 24"><path d="M8 5h8v2h-5.3l2 4.2L10 18h6v2H7v-1.6l3.4-7.1L7 5z"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'math'" class="tb-menu" style="min-width: 176px">
        <button class="tb-item" @click="pick((v) => toolbarInline(v, 'inlineMath'))">
          <span>行内公式</span><span class="kbd">$ $</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarMathBlock(v))">
          <span>块级公式</span><span class="kbd">$$</span>
        </button>
      </div>
    </div>

    <div class="tb-group tb-menu-wrap tb-menu-wrap--end">
      <button
        class="tb-btn"
        :class="{ on: openMenu === 'block' }"
        title="内容块"
        @click="toggle('block')"
      >
        <svg viewBox="0 0 24 24"><path d="M4 5h7v6H4zm9 0h7v6h-7zM4 13h7v6H4zm9 0h7v6h-7z"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'block'" class="tb-menu" style="min-width: 176px">
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

.tb-btn.wide {
  font-size: 12px;
  font-weight: 600;
}

.tb-btn:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.tb-btn.on {
  background: var(--n-accent-soft);
  color: var(--n-accent);
}

.tb-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
  flex: none;
}

.tb-btn .caret {
  width: 12px;
  height: 12px;
  opacity: 0.6;
}

.tb-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  min-width: 176px;
  /* 下拉最多占窗口一半宽，防止菜单项长文本把菜单撑到窗外 */
  max-width: 50vw;
  padding: 4px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  box-shadow: var(--n-shadow-lg);
  animation: menu-in 120ms var(--n-ease);
}

/* 靠右的下拉改成右对齐，避免被窗口右边缘裁掉。
   :has 判定「这个按钮是 .tb 里最后几个之一」不可靠，
   改为按位置兜底：菜单用 right:0 会被左边缘裁，用 left:0 会被右裁，
   所以给靠右的 wrap 加 .tb-menu-wrap--end 类，在模板里手动标注。 */
.tb-menu-wrap--end > .tb-menu {
  left: auto;
  right: 0;
}

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
