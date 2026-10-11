<script setup lang="ts">
/**
 * 通用右键菜单。
 *
 * 挂在 <body> 上（Teleport）而不是就地渲染：就地渲染会被祖先的
 * overflow:hidden 裁掉，编辑区、侧栏、滚动容器里都会出问题。
 *
 * 关闭条件按「用户已经不想看菜单了」来判断：点别处、按 Esc、
 * 滚动、窗口失焦、窗口尺寸变化。少一个都会留下甩不掉的菜单。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    x: number
    y: number
    label?: string
  }>(),
  { label: '菜单' },
)

const emit = defineEmits<{ (e: 'close'): void }>()

const root = ref<HTMLDivElement | null>(null)
/** 菜单实际尺寸，用来把它顶回视口内——贴着屏幕右/下边缘弹出时会被裁 */
const box = ref({ w: 0, h: 0 })

/** 计算后不越界的左上角坐标 */
const pos = ref({ left: 0, top: 0 })

function place() {
  const el = root.value
  if (!el) return
  box.value = { w: el.offsetWidth, h: el.offsetHeight }
  const pad = 8
  const maxX = window.innerWidth - box.value.w - pad
  const maxY = window.innerHeight - box.value.h - pad
  pos.value = {
    left: Math.max(pad, Math.min(props.x, maxX)),
    top: Math.max(pad, Math.min(props.y, maxY)),
  }
}

function onDocDown(e: MouseEvent) {
  if (!root.value) return
  if (!root.value.contains(e.target as Node)) emit('close')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

function onWin() {
  emit('close')
}

watch(
  () => [props.open, props.x, props.y],
  async () => {
    if (!props.open) return
    // 等内容渲染出来再量尺寸，否则量到的是 0
    await new Promise((r) => requestAnimationFrame(r))
    place()
  },
  { immediate: true },
)

onMounted(() => {
  // capture 阶段监听：有些组件会 stopPropagation，冒泡阶段就收不到了
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onWin)
  window.addEventListener('resize', place)
  // 捕获阶段才能听到内层滚动容器的滚动
  window.addEventListener('scroll', onWin, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('blur', onWin)
  window.removeEventListener('resize', place)
  window.removeEventListener('scroll', onWin, true)
})

/** 点中任意子项就关掉。子项的 select 事件仍会先派发给父级 */
function onItem() {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      class="ctx-menu"
      role="menu"
      :aria-label="label"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      @click="onItem"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 400;
  min-width: 172px;
  padding: 5px;
  border: 1px solid var(--n-line);
  border-radius: var(--n-r-lg);
  background: var(--n-surface);
  box-shadow:
    0 1px 2px color-mix(in oklab, #000 8%, transparent),
    0 10px 28px -8px color-mix(in oklab, #000 26%, transparent);
  animation: ctx-in 110ms var(--n-ease);
}

@keyframes ctx-in {
  from {
    opacity: 0;
    transform: translateY(-3px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
