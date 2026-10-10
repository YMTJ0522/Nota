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
} from '@/editor/toolbar-commands'

const props = defineProps<{ getView: () => EditorView | null }>()

function v(): EditorView | null {
  return props.getView()
}

/** 包装：view 可能为 null（预览模式/未挂载） */
function run(fn: (view: EditorView) => void) {
  const view = v()
  if (!view) return
  fn(view)
}

/* ── 下拉菜单 ── */
type MenuId = 'heading' | 'list' | 'block' | 'insert' | null
const openMenu = ref<MenuId>(null)

function toggle(id: Exclude<MenuId, null>) {
  openMenu.value = openMenu.value === id ? null : id
}

function close() {
  openMenu.value = null
}

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

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onEsc)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onEsc)
})

const headingItems = [1, 2, 3, 4, 5, 6] as const
const headingLabel = computed(() => '标题')
</script>

<template>
  <div class="tb">
    <!-- 组 1：历史 / 格式 -->
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
      <button class="tb-btn" title="数学公式" @click="run((v) => toolbarInline(v, 'inlineMath'))">
        <svg viewBox="0 0 24 24"><path d="M8 5h8v2h-5.3l2 4.2L10 18h6v2H7v-1.6l3.4-7.1L7 5z" opacity=".9"/></svg>
      </button>
    </div>

    <span class="tb-sep" />

    <!-- 组 2：标题 -->
    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn wide"
        :class="{ on: openMenu === 'heading' }"
        title="标题级别 (Ctrl+1..6)"
        @click="toggle('heading')"
      >
        <span>H1</span>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'heading'" class="tb-menu">
        <button
          v-for="lv in headingItems"
          :key="lv"
          class="tb-item"
          @click="pick((v) => toolbarHeading(v, lv))"
        >
          <span :style="{ fontSize: `${20 - lv * 1.2}px`, fontWeight: 600 }">标题 {{ lv }}</span>
          <span class="kbd">Ctrl+{{ lv }}</span>
        </button>
      </div>
    </div>

    <!-- 组 3：列表 -->
    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn wide"
        :class="{ on: openMenu === 'list' }"
        title="列表 / 引用"
        @click="toggle('list')"
      >
        <svg viewBox="0 0 24 24"><path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'list'" class="tb-menu">
        <button class="tb-item" @click="pick((v) => toolbarBlockPrefix(v, 'bullet'))">
          <span>无序列表</span><span class="kbd">Ctrl+Shift+8</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarBlockPrefix(v, 'ordered'))">
          <span>有序列表</span><span class="kbd">Ctrl+Shift+7</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarBlockPrefix(v, 'task'))">
          <span>任务列表</span><span class="kbd">Ctrl+Shift+9</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarBlockPrefix(v, 'quote'))">
          <span>引用块</span><span class="kbd">Ctrl+Shift+.</span>
        </button>
      </div>
    </div>

    <span class="tb-sep" />

    <!-- 组 4：块级元素 -->
    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn wide"
        :class="{ on: openMenu === 'block' }"
        title="块级元素"
        @click="toggle('block')"
      >
        <svg viewBox="0 0 24 24"><path d="M4 5h16v2H4zm0 6h10v2H4zm0 6h16v2H4z"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'block'" class="tb-menu">
        <button class="tb-item" @click="pick((v) => toolbarCodeBlock(v))">
          <span>代码块</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarAdvancedCodeBlock(v))">
          <span>高级代码块</span><span class="tag">标题/行号</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarMermaid(v))">
          <span>Mermaid 图表</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarMathBlock(v))">
          <span>数学块</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarTable(v, '| 列 1 | 列 2 | 列 3 |'))">
          <span>表格</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarCallout(v))">
          <span>Callout 提示块</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarDetails(v))">
          <span>折叠详情块</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarTabs(v, '标签一', '标签二'))">
          <span>分栏标签</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarHorizontalRule(v))">
          <span>分割线</span>
        </button>
      </div>
    </div>

    <span class="tb-sep" />

    <!-- 组 5：插入 -->
    <div class="tb-group tb-menu-wrap">
      <button
        class="tb-btn wide"
        :class="{ on: openMenu === 'insert' }"
        title="插入"
        @click="toggle('insert')"
      >
        <svg viewBox="0 0 24 24"><path d="M11 5h2v14h-2zM5 11h14v2H5z"/></svg>
        <svg class="caret" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>
      </button>
      <div v-if="openMenu === 'insert'" class="tb-menu">
        <button class="tb-item" @click="pick((v) => toolbarLink(v))">
          <span>链接</span><span class="kbd">[]()</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarImage(v))">
          <span>图片</span><span class="kbd">![]()</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarFootnote(v))">
          <span>脚注</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarTag(v))">
          <span>标签</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarWrap(v, '[['))">
          <span>双链</span><span class="kbd">[[ ]]</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarBlockId(v))">
          <span>块 ID</span>
        </button>
        <button class="tb-item" @click="pick((v) => toolbarFrontMatter(v))">
          <span>Front Matter</span>
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
  width: 1px;
  height: 18px;
  margin: 0 5px;
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
  min-width: 190px;
  padding: 4px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-md);
  box-shadow: var(--n-shadow-lg);
  animation: menu-in 120ms var(--n-ease);
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
