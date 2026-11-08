<script setup lang="ts">
/**
 * 主区的「思维导图」：把当前笔记的结构画成一张横向树图。
 *
 * 为什么铺在主区而不是中间那一列：一张四层的结构图宽约九百像素，
 * 在 300px 的资料栏里只能缩到 0.28 倍 —— 节点上的字糊成一片，等于没做。
 * 关系图也是同一个理由住在主区。
 *
 * 和大纲同源（同一棵 `OutlineTree`），所以两处看到的永远是一批东西：
 * 大纲里折起来的那一节点开导图也是折着的。
 *
 * 布局是确定性的 tidy-tree（见 outline-layout.ts），不用力导向：
 * 同一篇笔记今天和明天必须长得一模一样，否则「我上次在右下角看到的那一节」
 * 就再也找不回来了。
 *
 * 渲染用绝对定位的 div + 一层 SVG 折线，不用 canvas：
 * 文字要能被系统字体渲染、能被选中、能带 title 提示，canvas 全都得自己实现。
 * 节点上限 400，超了如实写在角上 —— 一屏糊成一片比截断更糟。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ChevronsDown, ListCollapse, Maximize2, Network, X } from 'lucide-vue-next'
import { store } from '@/store'
import { buildOutlineTree, type OutlineNode } from '@/editor/outline-tree'
import { layoutTree, type LayoutEdge } from '@/editor/outline-layout'
import { jumpToOutlineNode } from '@/editor/outline-jump'
import { loadFolds, saveFolds } from '@/editor/outline-fold'

const { state } = store

const stage = ref<HTMLElement | null>(null)

const tree = computed(() =>
  state.activePath ? buildOutlineTree(state.draft, store.activeName.value) : null,
)

const folds = ref<Set<string>>(loadFolds(state.activePath))

const layout = computed(() => {
  const t = tree.value
  return t ? layoutTree(t.root, folds.value) : null
})

/** 相机：平移 + 缩放。分开存是为了算缩放锚点时不丢精度 */
const cam = reactive({ k: 1, x: 0, y: 0 })
const dragging = ref(false)

/** 正在拖/缩时给合成器提个醒（提升成独立图层，手势不掉帧）。
    只能在交互进行中开着：常驻 will-change 会把整层按旧缩放缓存住
    不重排版，松手之后文字就是糊的 —— 导图发糊的另一半是它。 */
const live = ref(false)
let liveTimer: ReturnType<typeof setTimeout> | null = null

function wake() {
  live.value = true
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = setTimeout(() => (live.value = false), 180)
}

const worldStyle = computed(() => {
  const l = layout.value
  /* 平移取整：小数偏移会让整个世界亚像素采样，字发虚 */
  return {
    width: `${l?.width ?? 0}px`,
    height: `${l?.height ?? 0}px`,
    transform: `translate(${Math.round(cam.x)}px, ${Math.round(cam.y)}px) scale(${cam.k})`,
  }
})

const total = computed(() => (tree.value ? tree.value.count + 1 : 0))
const shown = computed(() => layout.value?.nodes.length ?? 0)

function edgePath(e: LayoutEdge) {
  // 折线：出门横走一半、竖着对齐、再横进去
  const mid = (e.x1 + e.x2) / 2
  return `M${e.x1} ${e.y1}H${mid}V${e.y2}H${e.x2}`
}

function toggleFold(id: string) {
  const next = new Set(folds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  folds.value = next
  saveFolds(state.activePath, next)
  nextTick(() => afterLayoutChange())
}

/** 视野整块换过一次：内容比视口大了就缩放回去，否则只重新居中 */
function afterLayoutChange() {
  const l = layout.value
  const el = stage.value
  if (!l || !el) return
  const r = el.getBoundingClientRect()
  const tooBig = l.width * cam.k > r.width - 56 || l.height * cam.k > r.height - 48
  if (tooBig) fit()
  else recenter()
}

function recenter() {
  const l = layout.value
  const el = stage.value
  if (!l || !el) return
  const r = el.getBoundingClientRect()
  cam.x = (r.width - l.width * cam.k) / 2
  cam.y = (r.height - l.height * cam.k) / 2
}

function fit() {
  const l = layout.value
  const el = stage.value
  if (!l || !el) return
  const r = el.getBoundingClientRect()
  if (r.width < 40 || r.height < 40) return
  const sx = (r.width - 72) / Math.max(l.width, 1)
  const sy = (r.height - 56) / Math.max(l.height, 1)
  /* 上限给到 1.3 而不是 1：只剩两级时内容只有几百像素宽，
     卡在 1 会让整张图缩在正中一小块，四周全是空的。 */
  cam.k = Math.max(0.3, Math.min(sx, sy, 1.3))
  cam.x = (r.width - l.width * cam.k) / 2
  cam.y = (r.height - l.height * cam.k) / 2
}

function expandAll() {
  folds.value = new Set()
  saveFolds(state.activePath, folds.value)
  nextTick(fit)
}

/**
 * 只留两级：先按「全展开」排一次，再收起第一层。
 *
 * 不能拿当前 layout 里 depth >= 1 的节点去收 —— 那时很多分支本来就是折着
 * 的，里面几层根本没出现在 layout 里，收出来的结果会变成「展开一层后
 * 里面还是折的」，要点三四次才见得到叶子。
 */
function twoLevels() {
  const t = tree.value
  if (!t) return
  const full = layoutTree(t.root, new Set())
  const next = new Set<string>()
  for (const ln of full.nodes) {
    if (ln.depth === 1 && ln.hasChildren) next.add(ln.node.id)
  }
  folds.value = next
  saveFolds(state.activePath, next)
  nextTick(fit)
}

/* ── 拖动与缩放 ── */
let drag: { x: number; y: number; ox: number; oy: number } | null = null

function onDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('.mm-node')) return
  drag = { x: e.clientX, y: e.clientY, ox: cam.x, oy: cam.y }
  dragging.value = true
  wake()
  stage.value?.setPointerCapture(e.pointerId)
}

function onMove(e: PointerEvent) {
  if (!drag) return
  wake()
  cam.x = drag.ox + (e.clientX - drag.x)
  cam.y = drag.oy + (e.clientY - drag.y)
}

function onUp(e: PointerEvent) {
  if (!drag) return
  drag = null
  dragging.value = false
  wake() /* 180ms 后落回普通层，浏览器按最终位置重新排版 */
  try {
    stage.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* 指针已经不在这个元素上了，没什么好收的 */
  }
}

function onWheel(e: WheelEvent) {
  const el = stage.value
  if (!el) return
  wake()
  const r = el.getBoundingClientRect()
  const cx = e.clientX - r.left
  const cy = e.clientY - r.top
  const k2 = Math.max(0.25, Math.min(2.4, cam.k * (e.deltaY < 0 ? 1.09 : 1 / 1.09)))
  // 光标底下那个世界坐标在缩放前后必须停在原地
  const wx = (cx - cam.x) / cam.k
  const wy = (cy - cam.y) / cam.k
  cam.k = k2
  cam.x = cx - wx * k2
  cam.y = cy - wy * k2
}

/**
 * 点一个节点 = 回正文的那一行。
 *
 * 主区被这张图占着的时候正文根本没挂载，所以「只高亮、留在图上」是看不见
 * 任何变化的 —— 点了像没反应。这里反过来：先关图，等编辑区挂上来再派发
 * 跳转事件。导图因此是一个「结构导航器」：看一眼全貌，点一下就落回正文。
 */
async function go(n: OutlineNode) {
  store.toggleMap(false)
  await nextTick()
  requestAnimationFrame(() => jumpToOutlineNode(n))
}

function close() {
  store.toggleMap(false)
}

let ro: ResizeObserver | null = null

onMounted(() => {
  nextTick(fit)
  const el = stage.value
  if (!el) return
  ro = new ResizeObserver(() => {
    // 窗口一改，先保住「看得见」这件事；比例不动，免得每拖一下窗口就跳一次缩放
    afterLayoutChange()
  })
  ro.observe(el)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (liveTimer) clearTimeout(liveTimer)
})

watch(
  () => state.activePath,
  (p) => {
    folds.value = loadFolds(p)
    nextTick(fit)
  },
)
</script>

<template>
  <div class="mm">
    <header class="mm-bar">
      <span class="mm-title"><Network :size="14" :stroke-width="1.9" />思维导图</span>
      <span class="mm-meta">
        <template v-if="layout">
          {{ shown === total ? `${total} 个节点` : `${shown} / ${total} 个节点` }}
          · 点节点回到正文
        </template>
      </span>
      <span class="mm-spacer" />
      <template v-if="layout">
        <button class="mm-act" title="适应窗口" aria-label="适应窗口" @click="fit">
          <Maximize2 :size="13" :stroke-width="1.9" />
        </button>
        <button class="mm-act" title="全部展开" aria-label="全部展开" @click="expandAll">
          <ChevronsDown :size="14" :stroke-width="1.9" />
        </button>
        <button class="mm-act" title="只留两级" aria-label="只留两级" @click="twoLevels">
          <ListCollapse :size="14" :stroke-width="1.9" />
        </button>
      </template>
      <button class="mm-act" title="关闭导图，回到正文" aria-label="关闭导图" @click="close">
        <X :size="14" :stroke-width="1.9" />
      </button>
    </header>

    <p v-if="!state.activePath" class="mm-empty">先打开一篇笔记，导图才有东西可画。</p>
    <p v-else-if="!layout || !layout.nodes.length" class="mm-empty">
      这篇还没有结构。用 <code>## 标题</code> 起一个小节，或用 <code>-</code> 列出条目，导图就会长出来。
    </p>
    <div
      v-else
      ref="stage"
      class="mm-stage"
      :class="{ dragging }"
      @wheel.prevent="onWheel"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <div class="mm-world" :class="{ live }" :style="worldStyle">
        <svg
          class="mm-links"
          :width="layout.width"
          :height="layout.height"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
        >
          <path v-for="(e, i) in layout.edges" :key="i" :d="edgePath(e)" />
        </svg>

        <div
          v-for="ln in layout.nodes"
          :key="ln.node.id"
          class="mm-node"
          :class="{ on: ln.node.id === state.activeHeading }"
          :data-depth="Math.min(ln.depth, 4)"
          :data-kind="ln.node.kind"
          :style="{
            left: `${ln.x}px`,
            top: `${ln.y}px`,
            width: `${ln.w}px`,
            height: `${ln.h}px`,
          }"
          @click="go(ln.node)"
        >
          <span
            v-if="ln.node.kind === 'item' && ln.node.checked !== null"
            class="mm-box"
            :class="{ done: ln.node.checked }"
          />
          <span v-else-if="ln.node.kind === 'item'" class="mm-dot" />
          <span class="mm-text" :title="ln.node.text">{{ ln.node.text }}</span>
          <span v-if="ln.node.tag" class="mm-tag">#{{ ln.node.tag }}</span>
          <button
            v-if="ln.hasChildren && ln.depth > 0"
            class="mm-fold"
            tabindex="-1"
            :aria-label="ln.collapsed ? '展开' : '收起'"
            @click.stop="toggleFold(ln.node.id)"
          >
            {{ ln.collapsed ? `+${ln.hidden}` : '−' }}
          </button>
        </div>
      </div>

      <p class="mm-hint">拖动平移 · 滚轮缩放 · 点节点回到正文那一行</p>
      <p v-if="layout.dropped" class="mm-warn">节点太多，已省略 {{ layout.dropped }} 个</p>
    </div>
  </div>
</template>

<style scoped>
.mm {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--n-bg);
}

/* 主区顶栏，和关系图那条同高同色 —— 主区换看法时这一条不跳 */
.mm-bar {
  flex: none;
  height: var(--n-topbar, 38px);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 12px;
  border-bottom: 1px solid var(--n-line);
}

.mm-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
  white-space: nowrap;
}

.mm-title svg {
  color: var(--n-accent);
  fill: none;
  stroke: currentColor;
}

.mm-meta {
  min-width: 0;
  font-size: 11px;
  color: var(--n-fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.mm-spacer {
  flex: 1;
}

.mm-act {
  flex: none;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-dim);
}

.mm-act:hover {
  background: var(--n-raised);
  color: var(--n-fg);
}

.mm-act svg {
  fill: none;
  stroke: currentColor;
}

.mm-empty {
  margin: 0;
  padding: 40px 20px;
  text-align: center;
  font-size: 12px;
  line-height: 1.8;
  color: var(--n-fg-faint);
}

.mm-empty code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--n-code-bg);
  font-family: var(--n-font-mono);
  font-size: 11px;
}

.mm-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  background-image: radial-gradient(circle at 1px 1px, var(--n-line) 1px, transparent 0);
  background-size: 22px 22px;
}

.mm-stage.dragging {
  cursor: grabbing;
}

.mm-world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
}

/* 只在手势进行中提升图层；松手落回来，浏览器按最终缩放重新排版，
   文字恢复锐利 —— 常驻 will-change 会把旧缩放的位图缓存住不放。 */
.mm-world.live {
  will-change: transform;
}

.mm-links {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
}

.mm-links path {
  fill: none;
  /* 纯 --n-line-strong 在深色底上（#45464d / #16161a）只有 2:1 左右，
     缩到 0.5 倍再细一档就基本看不见了。往 faint 里掺一点提亮，
     浅色下同时变深一点，两头都够。 */
  stroke: color-mix(in oklab, var(--n-line-strong) 62%, var(--n-fg-faint));
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.mm-node {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  border-radius: 8px;
  background: var(--n-raised);
  border: 1px solid var(--n-line-strong);
  cursor: pointer;
  transition: border-color 130ms var(--n-ease), background 130ms var(--n-ease),
    box-shadow 130ms var(--n-ease);
}

.mm-node:hover {
  border-color: var(--n-fg-faint);
}

.mm-node.on {
  border-color: var(--n-accent);
  box-shadow: 0 0 0 3px var(--n-accent-soft);
}

/* 根：整张图只该有一个实心块，就是这一篇的名字 */
.mm-node[data-depth='0'] {
  background: var(--n-accent);
  border-color: var(--n-accent);
  border-radius: 10px;
  padding: 0 12px;
}

.mm-node[data-depth='0'] .mm-text {
  color: var(--n-on-accent);
  font-size: 13.5px;
  font-weight: 500;
}

.mm-node[data-depth='3'],
.mm-node[data-depth='4'] {
  border-color: var(--n-line);
}

.mm-dot {
  flex: none;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--n-fg-faint);
}

.mm-box {
  flex: none;
  position: relative;
  width: 9px;
  height: 9px;
  border: 1px solid var(--n-line-strong);
  border-radius: 2px;
}

.mm-box.done {
  background: var(--n-accent);
  border-color: var(--n-accent);
}

.mm-box.done::after {
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

.mm-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--n-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mm-node[data-depth='1'] .mm-text {
  font-size: 13px;
}

.mm-tag {
  flex: none;
  padding: 1px 5px;
  border-radius: 20px;
  font-size: 10px;
  color: var(--n-accent);
  background: var(--n-accent-soft);
}

.mm-node[data-depth='0'] .mm-tag {
  color: var(--n-on-accent);
  background: rgb(255 255 255 / 22%);
}

.mm-fold {
  flex: none;
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--n-line);
  border-radius: 9px;
  background: var(--n-bg);
  color: var(--n-fg-dim);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.mm-node[data-depth='2'] .mm-fold,
.mm-node[data-depth='3'] .mm-fold,
.mm-node[data-depth='4'] .mm-fold {
  min-width: 16px;
  height: 16px;
  font-size: 11px;
}

.mm-fold:hover {
  border-color: var(--n-accent);
  color: var(--n-accent);
}

.mm-node[data-depth='0'] .mm-fold {
  background: rgb(255 255 255 / 18%);
  border-color: transparent;
  color: var(--n-on-accent);
}

.mm-hint {
  position: absolute;
  right: 16px;
  bottom: 12px;
  margin: 0;
  font-size: 11px;
  color: var(--n-fg-faint);
  pointer-events: none;
}

.mm-warn {
  position: absolute;
  left: 16px;
  bottom: 12px;
  margin: 0;
  font-size: 11px;
  color: var(--n-warn);
  pointer-events: none;
}
</style>
