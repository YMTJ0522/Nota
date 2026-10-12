<script setup lang="ts">
/**
 * 分栏之间的那道「线」。
 *
 * 用户要的是「这条线能拖着把栏拉宽拉窄」，所以它得是个真能抓的东西：
 * 本身占 0 宽度（不改变任何现有布局），只在左右各探出 2.5px 当作热区，
 * 原来那条 1px 描边仍然是看得见的分隔线；拖动时才在它上面压一道强调色。
 *
 * 用 pointer 事件而不是 mouse：按下后把监听挂到 window 上，
 * 指针划出热区、划到别的元素上面都不会中断拖动（鼠标事件到不了的地方
 * pointer 事件照样派发）。收尾一件事都不能漏——漏了 pointerup
 * 就会留下一个「鼠标一动栏就跟着变」的幽灵状态。
 */
import { ref } from 'vue'
import { store } from '@/store'

const props = withDefaults(
  defineProps<{
    /** 拖的是哪一栏 */
    target: 'sidebar' | 'column' | 'outline'
    /** 宽度随指针右移变大（+1）还是变小（-1）。大纲在最右边，取 -1 */
    sign?: 1 | -1
    label?: string
  }>(),
  { sign: 1, label: '拖动调整宽度' },
)

const dragging = ref(false)

function current() {
  if (props.target === 'sidebar') return store.state.sidebarWidth
  // 自适应状态下界面上量到的是算出来的宽度，不是 state.columnWidth ——
  // 从后者起算会让第一拖凭空跳一段
  if (props.target === 'column') return store.effectiveColumnWidth()
  return store.state.outlineWidth
}

function onDown(e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startW = current()
  dragging.value = true
  // 侧栏有 220ms 的宽度过渡，不关掉的话拖起来会像橡皮筋
  document.body.classList.add('n-dragging')

  const move = (ev: PointerEvent) => {
    store.setWidth(props.target, startW + props.sign * (ev.clientX - startX))
  }
  const up = () => {
    dragging.value = false
    document.body.classList.remove('n-dragging')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/** 双击复位：拖过头了不用一点点蹭回来。
    中间那一列复位到「自适应」（跟着窗口走），而不是某个写死的像素值 ——
    它的默认状态本来就是自适应，复位自然该回到那里。 */
function onDoubleClick() {
  if (props.target === 'column') {
    store.resetColumnWidth()
    return
  }
  const defaults = { sidebar: 232, outline: 176 }
  store.setWidth(props.target, defaults[props.target])
}
</script>

<template>
  <div
    class="sh"
    :class="[`sh-${target}`, { on: dragging }]"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :data-target="target"
    :title="`${label}（双击复位${target === 'column' ? '为自适应' : ''}）`"
    @pointerdown="onDown"
    @dblclick="onDoubleClick"
  />
</template>

<style scoped>
.sh {
  position: relative;
  z-index: 20;
  flex: none;
  width: 0;
  align-self: stretch;
}

/* 热区：比看得见的那条线宽，不然抓不住 */
.sh::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: col-resize;
}

/* 悬停 / 拖动时的高亮条：贴着原来的描边画，不额外占位置 */
.sh::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -1px;
  width: 2px;
  border-radius: 1px;
  background: var(--n-accent);
  opacity: 0;
  transition: opacity 120ms var(--n-ease);
  pointer-events: none;
}

.sh:hover::after,
.sh.on::after {
  opacity: 1;
}
</style>
