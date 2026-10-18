<script setup lang="ts">
/**
 * 新手引导：一步指一块区域，不是一页说明书。
 *
 * 做法是「挖洞」——在目标元素的位置盖一个透明框，用超大的 box-shadow 把
 * 其余部分压暗。这样高亮出来的就是**真的那个元素**，不是截图、不是示意图，
 * 跟着主题走、跟布局走，窗口一缩也还是准的。
 *
 * 步骤里只写 selector，不写坐标：坐标是每帧现算的，写死一次布局就废。
 * 目标找不到就跳过这一步（比如「大纲」页签被设置关掉了），
 * 不能让引导卡在一个不存在的元素上。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ArrowRight, ArrowLeft, X } from 'lucide-vue-next'

interface Step {
  /** 要高亮的元素，找不到就跳过这一步 */
  target: string
  title: string
  body: string
  /** 气泡优先放哪边；放不下会自动换 */
  prefer?: 'right' | 'bottom' | 'left'
}

const STEPS: Step[] = [
  {
    target: '.panel',
    title: '这里是资料库',
    body: '你打开的那个目录，原样长在这里：文件夹还是文件夹，文件还是 .md。上面是目录树，下面是「全部 / 收藏 / 最近编辑 / 标签」几种看法。右键文件可以改名、移动、加星。',
    prefer: 'right',
  },
  {
    target: '.col',
    title: '中间这栏换个角度看',
    body: '顶上三个页签：笔记是列表，大纲是当前这篇的标题树（点一下跳过去），引用是「谁提到了这一篇」。宽度能拖，窗口窄了它会自己让位。',
    prefer: 'right',
  },
  {
    target: '.main',
    title: '右边是写东西的地方',
    body: '左半写 Markdown 源码，右半实时看排版。顶部那排按钮里，分栏键在「只看源码」和「边写边看」之间切，导出也在那儿。',
    prefer: 'left',
  },
  {
    target: '.nav.nav-group',
    title: '这几枚是「去别处」',
    body: '附件库集中看引用过的图片文件；回收站里删掉的还能还原；关系图（Ctrl+Shift+G）把双链织成一张网。AI 编写要现在设置里接上模型才会出现。',
    prefer: 'right',
  },
  {
    target: '.foot',
    title: '底部是总开关',
    body: '左边显示这个工作区一共多少篇。问号随时能把这段引导再放一遍，右边是设置 —— 外观、编辑器、AI、云同步都在里面。',
    prefer: 'right',
  },
]

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const idx = ref(0)
const rect = ref<{ left: number; top: number; width: number; height: number } | null>(null)

const PAD = 8
const BUBBLE_W = 320
const GAP = 14

/** 去掉找不到目标的步骤，索引就不会指到空元素上 */
const steps = computed(() => STEPS)

const cur = computed(() => steps.value[Math.min(idx.value, steps.value.length - 1)])

function measure(): void {
  const el = cur.value ? document.querySelector(cur.value.target) : null
  if (!el) {
    rect.value = null
    return
  }
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) {
    rect.value = null
    return
  }
  rect.value = { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * 洞的几何：目标框住、四周留一点余量，再夹进视口。
 *
 * 压暗不用 box-shadow 那一套（`0 0 0 9999px` 是常见写法）—— 实测在深色主题下
 * 半透明黑压在本来就接近黑的背景上，几乎看不出边界，等于没高亮。
 * 改成四块遮板把洞围出来：边界清清楚楚，也不依赖阴影能不能画出去。
 */
const geo = computed(() => {
  const r = rect.value
  if (!r) return null
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(0, r.left - PAD)
  const top = Math.max(0, r.top - PAD)
  const right = Math.min(vw, r.left + r.width + PAD)
  const bottom = Math.min(vh, r.top + r.height + PAD)
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top), vw, vh }
})

const px = (n: number) => `${Math.round(n)}px`

/** 四块遮板的样式：上 / 下 / 左 / 右 */
const dims = computed(() => {
  const g = geo.value
  if (!g) return null
  return {
    top: { left: '0px', top: '0px', width: px(g.vw), height: px(g.top) },
    bottom: { left: '0px', top: px(g.bottom), width: px(g.vw), height: px(g.vh - g.bottom) },
    left: { left: '0px', top: px(g.top), width: px(g.left), height: px(g.height) },
    right: { left: px(g.right), top: px(g.top), width: px(g.vw - g.right), height: px(g.height) },
  }
})

const holeStyle = computed(() => {
  const g = geo.value
  if (!g) return { display: 'none' }
  return { left: px(g.left), top: px(g.top), width: px(g.width), height: px(g.height) }
})

/**
 * 气泡位置：先按 prefer 试，装不下就换边，最后兜底居中。
 * 不靠 CSS 的自适应 —— 这里必须知道确切坐标才能避开被压暗的区域。
 */
const bubbleStyle = computed(() => {
  const g = geo.value
  const vw = window.innerWidth
  const vh = window.innerHeight
  const M = 16
  if (!g) {
    return { left: `${Math.round(vw / 2 - BUBBLE_W / 2)}px`, top: `${Math.round(vh / 2 - 90)}px`, width: `${BUBBLE_W}px` }
  }

  const holeL = g.left
  const holeT = g.top
  const holeR = g.right
  const holeB = g.bottom
  const canRight = holeR + GAP + BUBBLE_W <= vw - M
  const canLeft = holeL - GAP - BUBBLE_W >= M
  const canBottom = holeB + GAP + 150 <= vh - M
  const canTop = holeT - GAP - 150 >= M

  let place: 'right' | 'bottom' | 'left' = cur.value?.prefer ?? 'right'
  if (place === 'right' && !canRight && canBottom) place = 'bottom'
  if (place === 'right' && !canRight && canLeft) place = 'left'
  if (place === 'left' && !canLeft) place = canBottom ? 'bottom' : 'right'

  if (place === 'right' && canRight) {
    return {
      left: `${Math.round(holeR + GAP)}px`,
      top: `${Math.round(clamp(holeT + g.height / 2 - 80, M, vh - 220))}px`,
      width: `${BUBBLE_W}px`,
    }
  }
  if (place === 'left' && canLeft) {
    return {
      left: `${Math.round(holeL - GAP - BUBBLE_W)}px`,
      top: `${Math.round(clamp(holeT + g.height / 2 - 80, M, vh - 220))}px`,
      width: `${BUBBLE_W}px`,
    }
  }
  if (place === 'bottom' && canBottom) {
    return {
      left: `${Math.round(clamp(holeL + g.width / 2 - BUBBLE_W / 2, M, vw - BUBBLE_W - M))}px`,
      top: `${Math.round(holeB + GAP)}px`,
      width: `${BUBBLE_W}px`,
    }
  }
  if (canTop) {
    return {
      left: `${Math.round(clamp(holeL + g.width / 2 - BUBBLE_W / 2, M, vw - BUBBLE_W - M))}px`,
      top: `${Math.round(holeT - GAP - 170)}px`,
      width: `${BUBBLE_W}px`,
    }
  }
  return { left: `${Math.round(vw / 2 - BUBBLE_W / 2)}px`, top: `${Math.round(vh / 2 - 90)}px`, width: `${BUBBLE_W}px` }
})

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

const isLast = computed(() => idx.value >= steps.value.length - 1)

function next(): void {
  if (isLast.value) {
    emit('close')
    return
  }
  idx.value += 1
}

function prev(): void {
  if (idx.value > 0) idx.value -= 1
}

function close(): void {
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    e.preventDefault()
    next()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prev()
  }
}

/* 布局一变就得重量：窗口缩放、任何一层（资料库/资料栏/正文）滚动、
   侧边栏收起展开，都会让坐标失效。capture 是为了接住内部容器的滚动。 */
function remeasure(): void {
  if (props.open) measure()
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      idx.value = 0
      await nextTick()
      measure()
    }
  },
)

watch(idx, async () => {
  await nextTick()
  measure()
})

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', remeasure)
  document.addEventListener('scroll', remeasure, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', remeasure)
  document.removeEventListener('scroll', remeasure, true)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="tour">
      <!-- 四块遮板围出一个洞。目标找不到时退化成整屏压暗、气泡居中。 -->
      <template v-if="dims">
        <div class="tour-dim" :style="dims.top" />
        <div class="tour-dim" :style="dims.bottom" />
        <div class="tour-dim" :style="dims.left" />
        <div class="tour-dim" :style="dims.right" />
        <div class="tour-hole" :style="holeStyle" />
      </template>
      <div v-else class="tour-dim" style="inset: 0" />

      <!-- 挡掉底下的交互。点空白处不关闭 —— 引导中途被误关掉，
           用户就再也找不到自己走到第几步了。 -->
      <div class="tour-block" @pointerdown.prevent />

      <div class="tour-card" :style="bubbleStyle">
        <div class="tour-head">
          <span class="tour-step">{{ idx + 1 }} / {{ steps.length }}</span>
          <button class="tour-x" title="跳过 (Esc)" @click="close">
            <X :size="13" :stroke-width="2" />
          </button>
        </div>
        <h3 class="tour-title">{{ cur?.title }}</h3>
        <p class="tour-body">{{ cur?.body }}</p>
        <div class="tour-foot">
          <div class="tour-dots">
            <i v-for="(s, i) in steps" :key="s.target" :class="{ on: i === idx }" />
          </div>
          <div class="tour-btns">
            <button v-if="idx > 0" class="tour-btn ghost" @click="prev">
              <ArrowLeft :size="12" :stroke-width="2.2" />
              <span>上一步</span>
            </button>
            <button class="tour-btn solid" @click="next">
              <span>{{ isLast ? '开始用' : '下一步' }}</span>
              <ArrowRight v-if="!isLast" :size="12" :stroke-width="2.2" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  z-index: 900;
}

/* 遮板：只负责压暗，不接收点击（拦截交给 .tour-block） */
.tour-dim {
  position: fixed;
  background: rgb(12 11 9 / 0.58);
  pointer-events: none;
  transition: left 180ms var(--n-ease), top 180ms var(--n-ease),
    width 180ms var(--n-ease), height 180ms var(--n-ease);
}

/* 洞：透明 + 一圈强调色。深色主题下光靠压暗分不出边界，
   这圈线才是「看这儿」的准头所在。 */
.tour-hole {
  position: fixed;
  border-radius: 10px;
  border: 1.5px solid var(--n-accent);
  box-shadow: 0 0 0 4px var(--n-accent-soft);
  pointer-events: none;
  transition: left 180ms var(--n-ease), top 180ms var(--n-ease),
    width 180ms var(--n-ease), height 180ms var(--n-ease);
}

.tour-block {
  position: fixed;
  inset: 0;
  z-index: 901;
}

.tour-card {
  position: fixed;
  z-index: 902;
  padding: 14px 16px 12px;
  background: var(--n-raised);
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  box-shadow: var(--n-shadow-xl);
  animation: tour-in 160ms var(--n-ease);
}

@keyframes tour-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

.tour-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.tour-step {
  font-family: var(--n-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--n-accent);
}

.tour-x {
  padding: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--n-r-sm);
  color: var(--n-fg-faint);
}

.tour-x svg {
  fill: none;
  stroke: currentColor;
}

.tour-x:hover {
  background: var(--n-sunken);
  color: var(--n-fg);
}

.tour-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 650;
  color: var(--n-fg);
}

.tour-body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--n-fg-dim);
}

.tour-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
}

.tour-dots {
  display: flex;
  gap: 5px;
}

.tour-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--n-line-strong, var(--n-line));
  transition: background var(--n-dur) var(--n-ease), width var(--n-dur) var(--n-ease);
}

.tour-dots i.on {
  width: 14px;
  border-radius: 3px;
  background: var(--n-accent);
}

.tour-btns {
  display: flex;
  gap: 6px;
}

.tour-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 11px;
  border-radius: var(--n-r-md);
  font-size: 12px;
  font-weight: 500;
}

.tour-btn svg {
  fill: none;
  stroke: currentColor;
}

.tour-btn.solid {
  background: var(--n-accent);
  color: var(--n-on-accent);
}

.tour-btn.solid:hover {
  opacity: 0.9;
}

.tour-btn.ghost {
  color: var(--n-fg-dim);
  background: var(--n-sunken);
}

.tour-btn.ghost:hover {
  color: var(--n-fg);
}
</style>
