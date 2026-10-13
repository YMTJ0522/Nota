<script setup lang="ts">
/**
 * 目录树 / 卡片上的节点图标。
 *
 * 三种形态：
 *  · 默认 —— 文件夹 / 文档两枚 Lucide 描边图标，和别处保持一致；
 *  · 品牌 —— 编程语言与技术栈的真实图标（simple-icons，CC0）；
 *  · 表情 —— 工作向 emoji。
 *
 * 品牌图标的深色处理是必须的：GitHub、GitLab 这类品牌色本来就是近黑，
 * 深色模式下照原色画出来等于一块看不见的黑。判据是相对亮度，
 * 低于阈值的在深色主题里改用前景色（描边变实心，形状还在，身份靠形状认）。
 */
import { computed } from 'vue'
import { FileText, Folder, FolderOpen } from 'lucide-vue-next'
import { store } from '@/store'
import { brandIcon } from '@/assets/brand-icons'

const props = withDefaults(
  defineProps<{
    /** 绝对路径。图标表按「相对工作区的路径」记，换算在 store 里做 */
    path: string
    /** 目录还是笔记——决定没有自定义图标时画哪一枚 */
    type: 'dir' | 'file'
    /** 目录展开时换成打开的那枚 */
    open?: boolean
    size?: number
    /**
     * 没有自定义图标时是否画默认那枚。
     * 目录树要（那一行得有个东西撑着），卡片不要（见 NoteListView：
     * 一行窄卡片挂一枚无意义的描边文档只会挤标题）。
     */
    fallback?: boolean
  }>(),
  { open: false, size: 14, fallback: true },
)

const { state } = store

const icon = computed(() => store.iconOf(props.path))
const brand = computed(() =>
  icon.value?.kind === 'brand' ? brandIcon(icon.value.id) : null,
)

/** 相对亮度（0 黑 ~ 1 白）。够用就行，不做 gamma 精确换算 */
function luminance(hex: string) {
  const h = hex.replace('#', '')
  if (h.length !== 6) return 0.5
  const n = parseInt(h, 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const brandColor = computed(() => {
  const b = brand.value
  if (!b) return ''
  const dark = state.theme === 'dark'
  // 深色下太暗的、浅色下太亮的，都换成前景色，免得整枚消失在底色里
  const lum = luminance(b.hex)
  if (dark && lum < 0.3) return 'currentColor'
  if (!dark && lum > 0.86) return 'currentColor'
  return `#${b.hex}`
})
</script>

<template>
  <!-- 品牌 -->
  <svg
    v-if="brand"
    class="ni ni-brand"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :style="{ color: brandColor }"
    aria-hidden="true"
  >
    <path :d="brand.path" fill="currentColor" />
  </svg>

  <!-- 表情：用字体渲染，字号比同尺寸的描边图标略大一号才显得一样大 -->
  <span
    v-else-if="icon?.kind === 'emoji'"
    class="ni ni-emoji"
    :style="{ fontSize: `${Math.round(size * 1.15)}px` }"
    >{{ icon.id }}</span
  >

  <!-- 默认 -->
  <template v-else-if="fallback">
    <FolderOpen v-if="type === 'dir' && open" :size="size" :stroke-width="1.9" />
    <Folder v-else-if="type === 'dir'" :size="size" :stroke-width="1.9" />
    <FileText v-else :size="size" :stroke-width="1.9" />
  </template>
</template>

<style scoped>
.ni {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ni-brand path {
  fill: currentColor;
}

.ni-emoji {
  line-height: 1;
  /* 彩色 emoji 在深浅两色下都自带描边感，不需要再压亮度 */
  color: inherit;
}
</style>
