<script setup lang="ts">
/**
 * 关系图：把「哪篇提到了哪篇」画成一张图。
 *
 * 它回答的是一个列表回答不了的问题：**我的笔记是怎么连在一起的**。
 * 列表能告诉你有 60 篇，但看不出哪一篇是枢纽、哪几篇是孤岛。
 * 孤立的笔记是最该被发现的 —— 写了却没跟任何东西连上，多半也就想不起来再看了。
 *
 * 三个刻意的决定：
 *  1. **自己算布局，不引图论库**。节点数是笔记数（几十到几百），
 *     一个 O(n²) 的斥力 + 弹簧迭代就够收敛，为它塞一个几百 KB 的依赖不值；
 *  2. **画在 canvas 上**。几百个节点各带一个标签，用 DOM 会有几百个元素，
 *     拖拽和缩放都会掉帧；canvas 一帧画完，缩放平移都是重画一次的事；
 *  3. **边只认 `[[…]]` 这一种**。正文里出现的裸文件名太容易误判，
 *     双链是明确的「我指向它」，也只有它值得画成一条线。
 *
 * 读正文是异步的（可能几百篇），所以图是「先画出来，边慢慢长出来」：
 * 一开始只有节点，扫完一批就补一批边并重排，不等全部读完才给看。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2, Maximize2, Network, RefreshCw } from 'lucide-vue-next'
import { store } from '@/store'
import { searchBody } from '@/editor/body-search'

const { state } = store

/** 一次最多读多少篇。再多首次打开就要等好几秒，宁可照实说扫了多少 */
const MAX_FILES = 400
const POOL = 8

interface Node {
  id: string
  name: string
  folder: string
  x: number
  y: number
  vx: number
  vy: number
  deg: number
  /** 是不是当前打开的那篇 */
  active: boolean
}
interface Edge {
  a: number
  b: number
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
const wrapEl = ref<HTMLElement | null>(null)
const nodes = ref<Node[]>([])
const edges = ref<Edge[]>([])
const loading = ref(false)
const scanned = ref(0)
const total = ref(0)
const hover = ref(-1)
const tip = ref({ x: 0, y: 0, text: '' })

let raf = 0
let scale = 1
let panX = 0
let panY = 0
let dragging = false
let dragNode = -1
let lastX = 0
let lastY = 0
let alpha = 1

function rel(p: string) {
  const root = state.root ?? ''
  const s = root && p.startsWith(root) ? p.slice(root.length) : p
  return s.replace(/^[\\/]+/, '')
}

function folderOf(p: string) {
  const parts = rel(p).split(/[\\/]/)
  parts.pop()
  return parts.join(' / ') || '根目录'
}

/** `[[名字]]` / `![[名字]]` / `[[名字#^块]]` —— 只要名字那一段 */
const WIKI_RE = /!?\[\[([^\]\n#|]+)/g

function nameKey(p: string) {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.md$/i, '')
    .toLowerCase()
}

/**
 * 把链接名字对应到文件。
 *
 * 只认「整个工作区里这个名字唯一」的情况：两个文件夹下各有一篇「README」
 * 时不去猜 —— 猜错了图就画错，而画错的关系图比没有更糟，它会让人以为
 * 那两篇真的连着。
 */
function resolveLink(name: string, byName: Map<string, number[]>, byPath: Map<string, number>) {
  const want = name.replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\/+/, '')
  const direct = byPath.get(`${state.root}\\${want.replace(/\//g, '\\')}.md`.replace(/\\\\/g, '\\'))
  if (direct !== undefined) return direct
  const base = want.split('/').pop()!.toLowerCase()
  const hits = byName.get(base)
  return hits && hits.length === 1 ? hits[0] : -1
}

async function build() {
  loading.value = true
  const files = store.allFiles.value.slice(0, MAX_FILES)
  total.value = store.allFiles.value.length
  const list: Node[] = files.map((f, i) => {
    const a = (i / Math.max(1, files.length)) * Math.PI * 2
    const rad = 120 + (i % 5) * 40
    return {
      id: f.path,
      name: f.name.replace(/\.md$/i, ''),
      folder: folderOf(f.path),
      x: Math.cos(a) * rad,
      y: Math.sin(a) * rad,
      vx: 0,
      vy: 0,
      deg: 0,
      active: f.path === state.activePath,
    }
  })
  nodes.value = list
  edges.value = []

  const byName = new Map<string, number[]>()
  const byPath = new Map<string, number>()
  list.forEach((n, i) => {
    byPath.set(n.id, i)
    const k = nameKey(n.id)
    const arr = byName.get(k)
    if (arr) arr.push(i)
    else byName.set(k, [i])
  })

  const seen = new Set<string>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(POOL, files.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= files.length) return
      const text = await window.api.readNote(files[i].path)
      if (!text) continue
      for (const m of text.matchAll(WIKI_RE)) {
        const to = resolveLink(m[1].trim(), byName, byPath)
        if (to < 0 || to === i) continue
        // 连线是无向的：甲提到丙、丙也提到甲，画出来还是同一条线。
        // 不这么并的话互相引用的两篇之间会画两条，看着像有两条关系。
        const key = i < to ? `${i}-${to}` : `${to}-${i}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.value = [...edges.value, { a: i, b: to }]
        list[i].deg += 1
        list[to].deg += 1
      }
      scanned.value += 1
      alpha = Math.max(alpha, 0.45)
    }
  })
  await Promise.all(workers)
  loading.value = false
  alpha = 1
}

/* ── 力导向：斥力 + 弹簧 + 往中心的一点引力 ──
   收敛之后就把 alpha 衰减到 0 停手，别让几百个节点一直在那儿微微抖动 ——
   一张永远不静下来的图会让人以为它还没算完。 */
function step() {
  const ns = nodes.value
  const es = edges.value
  const n = ns.length
  if (!n) return
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let dx = ns[j].x - ns[i].x
      let dy = ns[j].y - ns[i].y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        dx = (Math.random() - 0.5) * 2
        dy = (Math.random() - 0.5) * 2
        d2 = 4
      }
      if (d2 > 260000) continue
      const f = (2600 / d2) * alpha
      const d = Math.sqrt(d2)
      ns[i].vx -= (dx / d) * f
      ns[i].vy -= (dy / d) * f
      ns[j].vx += (dx / d) * f
      ns[j].vy += (dy / d) * f
    }
  }
  for (const e of es) {
    const a = ns[e.a]
    const b = ns[e.b]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.max(1, Math.hypot(dx, dy))
    const f = ((d - 130) / d) * 0.035 * alpha
    a.vx += dx * f
    a.vy += dy * f
    b.vx -= dx * f
    b.vy -= dy * f
  }
  for (const p of ns) {
    p.vx -= p.x * 0.0016 * alpha
    p.vy -= p.y * 0.0016 * alpha
    p.vx *= 0.86
    p.vy *= 0.86
    p.x += p.vx
    p.y += p.vy
  }
  alpha *= 0.994
  if (alpha < 0.02) alpha = 0.02
}

function radiusOf(deg: number) {
  return 5 + Math.min(9, Math.sqrt(deg) * 3.2)
}

function css(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function draw() {
  const cv = canvasEl.value
  if (!cv) return
  const ctx = cv.getContext('2d')
  if (!ctx) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr
    cv.height = h * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const fg = css('--n-fg', '#222')
  const dim = css('--n-fg-faint', '#888')
  const line = css('--n-line', '#ddd')
  const accent = css('--n-accent', '#3f6f5a')

  ctx.save()
  ctx.translate(w / 2 + panX, h / 2 + panY)
  ctx.scale(scale, scale)

  ctx.strokeStyle = line
  ctx.lineWidth = 1
  for (const e of edges.value) {
    const a = nodes.value[e.a]
    const b = nodes.value[e.b]
    if (!a || !b) continue
    ctx.globalAlpha = a.active || b.active ? 0.85 : 0.4
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  const ns = nodes.value
  for (let i = 0; i < ns.length; i += 1) {
    const p = ns[i]
    const r = radiusOf(p.deg)
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    if (p.active) {
      ctx.fillStyle = accent
      ctx.globalAlpha = 1
    } else if (p.deg === 0) {
      // 孤立的点画成空心：它们正是这张图最想让人看见的东西
      ctx.fillStyle = css('--n-surface', '#fff')
      ctx.globalAlpha = 1
    } else {
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.55
    }
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.lineWidth = p.active ? 2 : 1.2
    ctx.strokeStyle = p.deg === 0 && !p.active ? dim : accent
    ctx.stroke()

    if (scale > 0.55 || p.active || i === hover.value) {
      ctx.fillStyle = p.active ? accent : fg
      ctx.globalAlpha = p.active ? 1 : 0.8
      ctx.font = `${p.active ? 600 : 400} 11px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(p.name, p.x, p.y + r + 13)
      ctx.globalAlpha = 1
    }
  }
  ctx.restore()
}

function loop() {
  if (alpha > 0.021 || dragging) step()
  draw()
  raf = requestAnimationFrame(loop)
}

function toLocal(e: MouseEvent) {
  const cv = canvasEl.value
  if (!cv) return { x: 0, y: 0 }
  const r = cv.getBoundingClientRect()
  return {
    x: (e.clientX - r.left - r.width / 2 - panX) / scale,
    y: (e.clientY - r.top - r.height / 2 - panY) / scale,
  }
}

function hitTest(e: MouseEvent) {
  const { x, y } = toLocal(e)
  let best = -1
  let bestD = 1e9
  nodes.value.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y)
    const r = radiusOf(p.deg) + 6
    if (d < r && d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

function onDown(e: MouseEvent) {
  const i = hitTest(e)
  dragNode = i
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
}

function onMove(e: MouseEvent) {
  const cv = canvasEl.value
  if (!cv) return
  if (dragging) {
    if (dragNode >= 0) {
      const p = nodes.value[dragNode]
      p.x += (e.clientX - lastX) / scale
      p.y += (e.clientY - lastY) / scale
      p.vx = 0
      p.vy = 0
      alpha = Math.max(alpha, 0.3)
    } else {
      panX += e.clientX - lastX
      panY += e.clientY - lastY
    }
    lastX = e.clientX
    lastY = e.clientY
    return
  }
  const i = hitTest(e)
  hover.value = i
  const r = cv.getBoundingClientRect()
  if (i >= 0) {
    tip.value = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      text: `${nodes.value[i].name} · ${nodes.value[i].folder} · ${nodes.value[i].deg} 条连线`,
    }
  } else {
    tip.value = { x: 0, y: 0, text: '' }
  }
}

function onUp() {
  dragging = false
  dragNode = -1
}

/**
 * 双击才打开那一篇，单击不跳。
 *
 * 原来写成单击就打开，结果是想拖动节点时必然先按下再松开，手一抖就少了像素以内
 * 的位移、判断成「没拖」，图还没摆好就被踢到另一篇去了。双击留了容错，
 * 也跟系统里「双击打开」的习惯一致。
 */
function onDblClick(e: MouseEvent) {
  const i = hitTest(e)
  if (i < 0) return
  // 只调 openNote 是不够的：它只换 activePath，主区还停在图上，
  // 用户双击完看见的还是这张图，以为没反应。先把图收起来，再打开那一篇。
  store.state.graphOpen = false
  void store.openNote(nodes.value[i].id)
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const k = e.deltaY < 0 ? 1.12 : 1 / 1.12
  scale = Math.max(0.25, Math.min(3, scale * k))
}

function fit() {
  scale = 1
  panX = 0
  panY = 0
  alpha = 1
}

onMounted(() => {
  void build()
  loop()
})
onBeforeUnmount(() => cancelAnimationFrame(raf))

/* 换主题要重画：颜色是从 CSS 变量里读出来画进 canvas 的，
   它不像 DOM 那样自己跟着 --n-* 变。 */
watch(() => state.theme, () => draw())
watch(
  () => state.activePath,
  (p) => {
    for (const n of nodes.value) n.active = n.id === p
    draw()
  },
)
</script>

<template>
  <div ref="wrapEl" class="gv">
    <header class="gv-bar">
      <span class="gv-title">
        <Network :size="14" :stroke-width="1.9" />
        关系图
      </span>
      <span class="gv-meta">
        {{ nodes.length }} 篇 · {{ edges.length }} 条连线
        <template v-if="loading">
          <Loader2 class="spin" :size="11" :stroke-width="2" />
          正在读正文 {{ scanned }}/{{ Math.min(total, MAX_FILES) }}
        </template>
        <template v-else-if="total > MAX_FILES"> · 只画了前 {{ MAX_FILES }} 篇</template>
      </span>
      <span class="gv-spacer" />
      <button class="gv-act" title="重新读取并布局" @click="build()">
        <RefreshCw :size="13" :stroke-width="1.9" />
      </button>
      <button class="gv-act" title="回到中心与原始大小" @click="fit">
        <Maximize2 :size="13" :stroke-width="1.9" />
      </button>
    </header>

    <div class="gv-stage">
      <canvas
        ref="canvasEl"
        class="gv-canvas"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @dblclick="onDblClick"
        @pointerleave="hover = -1; tip.text = ''"
        @wheel="onWheel"
      />
      <p v-if="!nodes.length && !loading" class="gv-empty">这个工作区里还没有 .md 文件</p>
      <div v-if="tip.text" class="gv-tip" :style="{ left: tip.x + 12 + 'px', top: tip.y + 12 + 'px' }">
        {{ tip.text }}
      </div>
      <p class="gv-hint">滚轮缩放 · 拖动空白平移 · 拖节点挪位置 · 双击节点打开那一篇</p>
    </div>
  </div>
</template>

<style scoped>
.gv {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--n-bg);
}
.gv-bar {
  flex: none;
  height: var(--n-topbar, 38px);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--n-line);
}
.gv-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--n-fg);
}
.gv-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--n-fg-faint);
}
.gv-spacer {
  flex: 1;
}
.gv-act {
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--n-fg-dim);
  cursor: pointer;
}
.gv-act:hover {
  background: var(--n-hover);
  color: var(--n-fg);
}
.gv-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.gv-canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
}
.gv-canvas:active {
  cursor: grabbing;
}
.gv-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  font-size: 13px;
  color: var(--n-fg-faint);
}
.gv-tip {
  position: absolute;
  z-index: 2;
  max-width: 260px;
  padding: 4px 8px;
  border: 1px solid var(--n-line);
  border-radius: 6px;
  background: var(--n-raised);
  box-shadow: var(--n-shadow-sm, 0 2px 8px rgb(0 0 0 / 12%));
  font-size: 11.5px;
  color: var(--n-fg);
  pointer-events: none;
  white-space: nowrap;
}
.gv-hint {
  position: absolute;
  left: 12px;
  bottom: 10px;
  margin: 0;
  font-size: 11px;
  color: var(--n-fg-faint);
  pointer-events: none;
}
.spin {
  animation: gv-spin 0.9s linear infinite;
}
@keyframes gv-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
