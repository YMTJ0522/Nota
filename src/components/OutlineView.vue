<script setup lang="ts">
/**
 * 中间那一列的「大纲」视图。
 *
 * 2.12 之前这里只列标题：一条 H2、一条 H3，正文里的条目一概看不见。
 * 写长笔记时最想知道的其实是「这一节里到底有什么」，只给骨架等于只给一半。
 * 现在改成结构树 —— 标题是枝干，列表项是枝叶，按缩进与标题级别挂在一起。
 *
 * 树不是在这里扫的：`buildOutlineTree` 同时喂给大纲和导图，两处对「什么
 * 算一节」的认定必须一模一样，否则大纲点第 5 条、导图亮第 6 个。
 *
 * 跳转不自己滚：抛 `nota:heading` 给编辑区，该滚的是正文，分栏模式下
 * 预览和编辑区还要一起过去。
 */
import { computed, ref, watch } from 'vue'
import { ChevronsDown, ChevronsUp, ListTree, Network } from 'lucide-vue-next'
import { store } from '@/store'
import { buildOutlineTree, visibleRows, type OutlineNode } from '@/editor/outline-tree'
import { jumpToOutlineNode } from '@/editor/outline-jump'
import { loadFolds, saveFolds } from '@/editor/outline-fold'

const { state } = store

const tree = computed(() =>
  state.activePath ? buildOutlineTree(state.draft, store.activeName.value) : null,
)

const collapsed = ref<Set<string>>(loadFolds(state.activePath))

/* 换一篇 → 换一套折叠状态。同一篇里改标题会让个别 id 失效，那些节点
   自然回到「展开」，比记住一个已经不存在的 id 更合理。 */
watch(
  () => state.activePath,
  (p) => {
    collapsed.value = loadFolds(p)
  },
)

function toggleFold(id: string) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
  saveFolds(state.activePath, next)
}

const view = computed(() => {
  const t = tree.value
  if (!t) return { rows: [], truncated: false }
  return visibleRows(t.root, collapsed.value)
})

const rows = computed(() => view.value.rows)
const total = computed(() => tree.value?.count ?? 0)

/**
 * 高亮哪一行。
 *
 * `activeHeading` 通常就是一个标题的 slug，直接对得上。但开头那个唯一的 H1
 * 会被提升成根（见 outline-tree 的 liftTitleHeading），它本身不在列表里 ——
 * 刚打开笔记时 activeHeading 正好是它，于是整栏一条高亮都没有，看着像坏了。
 * 这种情况落到它的第一棵子树。
 */
const activeId = computed(() => {
  const t = tree.value
  const a = state.activeHeading
  if (!t || !a) return null
  if (a === t.root.id) return t.root.children[0]?.id ?? null
  return a
})

/** 所有「有子节点」的 id，用于一键收起 */
function parentIds(root: OutlineNode): string[] {
  const out: string[] = []
  const walk = (n: OutlineNode) => {
    for (const c of n.children) {
      if (c.children.length) out.push(c.id)
      walk(c)
    }
  }
  walk(root)
  return out
}

const allOpen = computed(() => rows.value.every((r) => !r.hasChildren || r.open))

function toggleAll() {
  const t = tree.value
  if (!t) return
  const next = allOpen.value ? new Set(parentIds(t.root)) : new Set<string>()
  collapsed.value = next
  saveFolds(state.activePath, next)
}

function go(n: OutlineNode) {
  jumpToOutlineNode(n)
}
</script>

<template>
  <div class="ov">
    <div class="pn-head">
      <span class="pn-ico"><ListTree :size="13" :stroke-width="1.9" /></span>
      <span class="pn-title">大纲</span>
      <span class="pn-sub">{{ total ? `${total} 个节点` : '' }}</span>
      <button
        v-if="total"
        class="pn-x"
        :title="allOpen ? '全部收起' : '全部展开'"
        :aria-label="allOpen ? '全部收起' : '全部展开'"
        @click="toggleAll"
      >
        <component :is="allOpen ? ChevronsUp : ChevronsDown" :size="14" :stroke-width="1.9" />
      </button>
      <button
        v-if="state.activePath"
        class="pn-x"
        title="用思维导图看（Ctrl+Shift+M）"
        aria-label="打开思维导图"
        @click="store.toggleMap()"
      >
        <Network :size="14" :stroke-width="1.9" />
      </button>
    </div>

    <div class="pn-body ov-body">
      <div v-if="!state.activePath" class="pn-empty">先打开一篇笔记</div>
      <div v-else-if="!rows.length" class="pn-empty">
        这篇还没有结构。用 <code>## 标题</code> 起一个小节，或用 <code>-</code> 列出条目，
        大纲就会长出来。
      </div>
      <nav v-else class="ov-list" aria-label="笔记大纲">
        <div
          v-for="r in rows"
          :key="r.node.id"
          class="ov-row"
          :class="{ on: r.node.id === activeId }"
          :data-depth="Math.min(r.depth, 3)"
          :data-kind="r.node.kind"
          :style="{ paddingLeft: 6 + (r.depth - 1) * 13 + 'px' }"
          :title="r.node.text"
          @click="go(r.node)"
        >
          <button
            class="ov-fold"
            :class="{ open: r.open, leaf: !r.hasChildren }"
            tabindex="-1"
            aria-label="折叠"
            @click.stop="toggleFold(r.node.id)"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>

          <!-- 选中底色只包「标记 + 文字 + 标签」这一小段。
               原来铺满整行、左边再压一道竖杠：竖杠贴的是行首，而文字在缩进
               之后，中间空出一大截，看着像一段悬着的短杠；栏一宽整条色带又长
               又空。胶囊跟着内容走，缩进多少它跟到哪。 -->
          <span class="ov-hit">
            <span v-if="r.node.kind === 'heading'" class="ov-lv">H{{ r.node.level }}</span>
            <span
              v-else-if="r.node.checked !== null"
              class="ov-box"
              :class="{ done: r.node.checked }"
            />
            <span v-else class="ov-dot" />

            <span class="ov-text">{{ r.node.text }}</span>
            <span v-if="r.node.tag" class="ov-tag">#{{ r.node.tag }}</span>
            <span v-if="r.node.children.length && !r.open" class="ov-more">+{{ r.hidden }}</span>
          </span>
        </div>

        <div v-if="view.truncated" class="ov-cut">后面还有更多，已截断显示</div>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.ov {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* 通用 .pn-body 是 10px 的通栏内边距，大纲要的是行内自带的左右留白 ——
   不然 hover / 选中那一块会离栏边太远，看着像浮在中间。 */
.ov-body {
  padding: 4px 0 40px;
  overflow-x: hidden;
}

.ov-list {
  display: flex;
  flex-direction: column;
}

.ov-row {
  display: flex;
  align-items: center;
  gap: 1px;
  height: 26px;
  margin: 0 6px;
  padding-right: 6px;
  border-radius: var(--n-r-sm);
  cursor: pointer;
  user-select: none;
  min-width: 0;
}

.ov-row:hover {
  background: color-mix(in oklab, var(--n-surface) 70%, transparent);
}

.ov-fold {
  flex: none;
  width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--n-fg-faint);
  cursor: pointer;
  transition: transform 130ms var(--n-ease), background 130ms var(--n-ease);
}

.ov-fold.open {
  transform: rotate(90deg);
}

.ov-fold.leaf {
  visibility: hidden;
}

.ov-fold:hover {
  background: var(--n-line);
  color: var(--n-fg);
}

.ov-hit {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 9px 2px 4px;
  border-radius: 6px;
  transition: background 130ms var(--n-ease);
}

.ov-row.on .ov-hit {
  background: var(--n-accent-soft);
}

.ov-lv {
  flex: none;
  min-width: 17px;
  font-family: var(--n-font-mono);
  font-size: 9.5px;
  color: var(--n-fg-faint);
  font-variant-numeric: tabular-nums;
}

.ov-dot {
  flex: none;
  width: 4px;
  height: 4px;
  margin: 0 7px 0 5px;
  border-radius: 50%;
  background: var(--n-fg-faint);
}

.ov-box {
  flex: none;
  position: relative;
  width: 10px;
  height: 10px;
  margin: 0 4px 0 2px;
  border: 1px solid var(--n-line-strong);
  border-radius: 2.5px;
}

.ov-box.done {
  background: var(--n-accent);
  border-color: var(--n-accent);
}

.ov-box.done::after {
  content: '';
  position: absolute;
  left: 2.5px;
  top: 0.5px;
  width: 3px;
  height: 5px;
  border: solid var(--n-on-accent);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.ov-text {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--n-fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ov-row[data-depth='1'] .ov-text {
  font-size: 12.5px;
  color: var(--n-fg);
  font-weight: 500;
}

.ov-row[data-depth='2'] .ov-text {
  font-size: 12.5px;
  color: var(--n-fg);
}

.ov-row:hover .ov-text,
.ov-row.on .ov-text {
  color: var(--n-fg);
}

.ov-row.on .ov-text {
  font-weight: 500;
}

.ov-row.on .ov-dot,
.ov-row.on .ov-lv {
  color: var(--n-accent);
}

.ov-row.on .ov-dot {
  background: var(--n-accent);
}

.ov-tag {
  flex: none;
  max-width: 84px;
  padding: 1px 6px;
  border-radius: 20px;
  font-size: 10px;
  color: var(--n-accent);
  background: var(--n-accent-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-more {
  flex: none;
  padding: 1px 6px;
  border-radius: 20px;
  font-size: 10px;
  color: var(--n-fg-faint);
  background: var(--n-surface);
  font-variant-numeric: tabular-nums;
}

.ov-cut {
  padding: 10px 16px;
  font-size: 11px;
  color: var(--n-fg-faint);
}
</style>
