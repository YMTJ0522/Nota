<script setup lang="ts">
/**
 * 一枚标签。
 *
 * 有归属图标时画图标不画 `#` —— 图标是给「认形状」用的，一眼扫过去的场景
 * （侧栏标签清单、卡片上一排标签）里，形状比同一个 `#` 字快得多。
 * 没配图标的仍然是一枚 `#`，跟以前一样，不强求用户给每个标签都挑图标。
 *
 * 这也是「标签」跟「图标」合起来的那笔账：素材库共用，
 * 但`# + 文字`这个最低限度的形态必须留着，否则一个顺手的分类动作
 * 就变成「先去挑个图标才能打标签」的两步活。
 */
import { computed } from 'vue'
import { Hash } from 'lucide-vue-next'
import { store } from '@/store'
import BrandGlyph from '@/components/BrandGlyph.vue'

const props = withDefaults(
  defineProps<{
    name: string
    /** 是否显示右侧计数 */
    count?: number | null
    size?: number
  }>(),
  { count: null, size: 12 },
)

const icon = computed(() => store.tagIconOf(props.name))
</script>

<template>
  <span class="tc" :title="`#${name}`">
    <BrandGlyph v-if="icon?.kind === 'brand'" :id="icon.id" :size="size" />
    <span v-else-if="icon?.kind === 'emoji'" class="tc-e" :style="{ fontSize: `${size + 2}px` }">{{
      icon.id
    }}</span>
    <Hash v-else :size="size - 2" :stroke-width="2.2" />
    <span class="tc-n">{{ name }}</span>
    <span v-if="count !== null" class="tc-c">{{ count }}</span>
  </span>
</template>

<style scoped>
.tc {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: inherit;
}

/* 品牌图标不用描边：它是实心的形状 */
.tc svg:not(.bg-glyph) {
  fill: none;
  stroke: currentColor;
}

.tc-e {
  line-height: 1;
}

.tc svg {
  flex: none;
}

.tc-n {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tc-c {
  flex: none;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}
</style>
