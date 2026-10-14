<script setup lang="ts">
/**
 * 一枚品牌图标（Python 那条蟒、GitHub 那只猫…）。
 *
 * 抽成一个组件只有一个理由：**深色下的可读性处理必须只有一份**。
 *
 * GitHub、GitLab 这类品牌色本来就接近纯黑，照原色画在深色底上等于
 * 一枚看不见的图标。判据是相对亮度，低于阈值就改用前景色（实心形状还在，
 * 身份靠轮廓认得出来）。这段逻辑以前写在 NodeIcon 里，
 * 现在标签也能挂图标了 —— 要是 TagChip 自己再抄一遍，
 * 迟早出现「换了主题后标签图标消失、文件图标没事」这种只有一半修好的 bug。
 */
import { computed } from 'vue'
import { store } from '@/store'
import { brandIcon } from '@/assets/brand-icons'

const props = withDefaults(defineProps<{ id: string; size?: number }>(), { size: 14 })

const { state } = store

const b = computed(() => brandIcon(props.id))

/** 相对亮度（0 黑 ~ 1 白）。够用就行，不做 gamma 精确换算 */
function luminance(hex: string) {
  const h = hex.replace('#', '')
  if (h.length !== 6) return 0.5
  const n = parseInt(h, 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const bl = (n & 255) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl
}

const color = computed(() => {
  const it = b.value
  if (!it) return ''
  const l = luminance(it.hex)
  const dark = state.theme === 'dark'
  // 深色下太暗的、浅色下太亮的，都换成前景色，免得整枚消失在底色里
  if (dark && l < 0.3) return 'currentColor'
  if (!dark && l > 0.86) return 'currentColor'
  return `#${it.hex}`
})
</script>

<template>
  <svg
    v-if="b"
    class="bg-glyph"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :style="{ color }"
    aria-hidden="true"
  >
    <path :d="b.path" fill="currentColor" />
  </svg>
</template>

<style scoped>
.bg-glyph {
  display: block;
  flex: none;
}
</style>
